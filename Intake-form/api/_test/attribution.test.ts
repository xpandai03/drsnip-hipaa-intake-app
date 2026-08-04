// Tests for Phase 2 attribution + the dormant conversion hook.
//
//   • extractAttribution — reads the attribution object, the insurance
//     top-level `source` fallback, gclid>fbclid precedence, length caps,
//     and PROVES patient_id is never captured as attribution.
//   • conversion (server) — the inertness proof: with the flag off (or GA4
//     unset), fireConversion makes ZERO outbound fetch calls; buildGa4Payload
//     carries no PII; conversionReady gates correctly.
//   • conversion (client, pure) — shouldPostConversion off→false and the
//     message shape is exactly { event, form_type }.
//
// No PHI in this file (fake tokens only). validateSource's catalog lookup needs
// Postgres; its null-source branch (no DB) is covered here, and the
// known/unknown paths are verified against the deployed DB in the smoke test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAttribution, validateSource } from "../_lib/attribution";
import {
  fireConversion,
  buildGa4Payload,
  conversionReady,
  readConversionConfig,
  type ConversionConfig,
} from "../../lib/conversion/track";
import {
  shouldPostConversion,
  buildConversionMessage,
  CONVERSION_EVENT,
} from "../../artifacts/intake-form/src/lib/conversion";

// ── extractAttribution ─────────────────────────────────────────────────────
describe("extractAttribution", () => {
  it("reads a full attribution object", () => {
    const a = extractAttribution({
      attribution: {
        source: "google",
        utmSource: "google",
        utmMedium: "cpc",
        utmCampaign: "seattle",
        utmTerm: "vasectomy",
        utmContent: "ad1",
        gclid: "GCL123",
      },
    });
    assert.equal(a.source, "google");
    assert.equal(a.utmSource, "google");
    assert.equal(a.utmMedium, "cpc");
    assert.equal(a.utmCampaign, "seattle");
    assert.equal(a.clickId, "GCL123");
    assert.equal(a.clickIdType, "gclid");
  });

  it("gclid takes precedence over fbclid for the primary click id", () => {
    const a = extractAttribution({
      attribution: { gclid: "G1", fbclid: "F1" },
    });
    assert.equal(a.clickId, "G1");
    assert.equal(a.clickIdType, "gclid");
    const b = extractAttribution({ attribution: { fbclid: "F2" } });
    assert.equal(b.clickId, "F2");
    assert.equal(b.clickIdType, "fbclid");
  });

  it("falls back to a top-level source (insurance form shape)", () => {
    const a = extractAttribution({ source: "cost-insurance-page" });
    assert.equal(a.source, "cost-insurance-page");
  });

  it("never captures patient_id as attribution", () => {
    const a = extractAttribution({
      patient_id: "abc-123",
      patientId: "abc-123",
      attribution: { patient_id: "abc-123", source: "google" },
    });
    assert.equal(a.source, "google");
    // No field anywhere may carry the patient id.
    for (const v of Object.values(a)) {
      assert.notEqual(v, "abc-123");
    }
  });

  it("empty / bare payload → all NULLs (untagged)", () => {
    const a = extractAttribution({});
    for (const v of Object.values(a)) assert.equal(v, null);
  });

  it("caps overlong values", () => {
    const a = extractAttribution({ attribution: { source: "x".repeat(500) } });
    assert.equal((a.source ?? "").length, 200);
  });
});

describe("validateSource — no-source path (no DB)", () => {
  it("returns null when no source supplied", async () => {
    assert.equal(await validateSource(null), null);
  });
});

// ── conversion: server inertness ───────────────────────────────────────────
describe("conversion (server) — inert by default", () => {
  const OFF: ConversionConfig = {
    enabled: false,
    ga4MeasurementId: "G-XXX",
    ga4ApiSecret: "secret",
    eventName: "intake_conversion",
  };
  const INCOMPLETE: ConversionConfig = {
    enabled: true,
    ga4MeasurementId: "",
    ga4ApiSecret: "",
    eventName: "intake_conversion",
  };
  const ON: ConversionConfig = {
    enabled: true,
    ga4MeasurementId: "G-XXX",
    ga4ApiSecret: "secret",
    eventName: "intake_conversion",
  };

  it("conversionReady is false unless enabled AND fully configured", () => {
    assert.equal(conversionReady(OFF), false);
    assert.equal(conversionReady(INCOMPLETE), false);
    assert.equal(conversionReady(ON), true);
  });

  it("makes ZERO fetch calls when the flag is off", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const fired = await fireConversion(
      { formType: "registration", timestampMs: 1, clientId: "cid" },
      OFF,
      spyFetch,
    );
    assert.equal(fired, false);
    assert.equal(calls, 0);
  });

  it("makes ZERO fetch calls when GA4 config is incomplete", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await fireConversion(
      { formType: "consultation", timestampMs: 1, clientId: "cid" },
      INCOMPLETE,
      spyFetch,
    );
    assert.equal(calls, 0);
  });

  it("default env config is OFF (no flag set)", () => {
    const cfg = readConversionConfig({} as NodeJS.ProcessEnv);
    assert.equal(cfg.enabled, false);
    assert.equal(conversionReady(cfg), false);
  });

  it("GA4 payload carries NO PII — only event/form_type/timestamp/gclid", () => {
    const body = buildGa4Payload(ON, {
      formType: "registration",
      clickId: "GCL9",
      clickIdType: "gclid",
      timestampMs: 1000,
      clientId: "random-uuid",
    });
    const params = body.events[0].params;
    assert.deepEqual(Object.keys(params).sort(), [
      "form_type",
      "gclid",
      "submitted_at",
    ]);
    const blob = JSON.stringify(body).toLowerCase();
    for (const pii of ["email", "phone", "first", "last", "dob", "@", "patient"]) {
      assert.ok(!blob.includes(pii), `payload must not contain '${pii}'`);
    }
  });
});

// ── conversion: client pure logic ──────────────────────────────────────────
describe("conversion (client) — pure decision + shape", () => {
  it("does not post unless enabled AND embedded", () => {
    assert.equal(shouldPostConversion(false, false), false);
    assert.equal(shouldPostConversion(false, true), false);
    assert.equal(shouldPostConversion(true, false), false);
    assert.equal(shouldPostConversion(true, true), true);
  });

  it("message shape is exactly { event, form_type }", () => {
    const m = buildConversionMessage("insurance");
    assert.deepEqual(m, { event: CONVERSION_EVENT, form_type: "insurance" });
    assert.deepEqual(Object.keys(m).sort(), ["event", "form_type"]);
  });
});
