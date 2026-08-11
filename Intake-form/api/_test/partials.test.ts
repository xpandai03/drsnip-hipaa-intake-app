// Train 2 tests: registration drop-off capture.
//
//   • The privacy core: the beacon whitelist STRIPS any non-whitelisted field
//     (a partial carrying a medical answer is impossible by construction).
//   • Capture only after the contact step (nothing stored before).
//   • Origin guard + handler guards (405/403/400) without a DB.
//   • CSV export shape (Pacific split columns, no medical column).
//   • The beacon is silent when the endpoint is down (wizard unaffected).
//
// The DB-backed behaviors (upsert, conversion-delete, grace exclusion, 30-day
// purge) are verified live in the post-deploy smoke — they need Postgres.
// No PHI (synthetic values only).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import partialHandler, { partialSchema } from "../registration-partial";
import { originAllowed, PARTIAL_RETENTION_DAYS, PARTIAL_GRACE_HOURS } from "../_lib/partials";
import { buildPartialsCsv } from "../registration-partials/export";
import { makeReq, makeRes } from "./harness";
import {
  shouldCaptureAtStep,
  sendPartialBeacon,
} from "../../artifacts/intake-form/src/lib/dropoff";

// ── PRIVACY: whitelist strips everything non-whitelisted ────────────────────
describe("partial whitelist — medical answers impossible by construction", () => {
  it("strips any non-whitelisted field (medical/insurance/DOB/raw)", () => {
    const parsed = partialSchema.safeParse({
      partialId: "abcdef12345678",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "(555) 010-0001",
      officeLocation: "Plano, TX",
      furthestStep: 5,
      furthestStepLabel: "Insurance",
      // Hostile extras that MUST NOT survive:
      mhBleeding: "Yes",
      mhKidneyDisease: "Yes",
      familyPlanning: "details",
      insuranceIdNo: "ZZ999",
      dateOfBirth: "1990-01-01",
      rawPayload: { secret: 1 },
      streetAddress: "123 Main",
    });
    assert.ok(parsed.success);
    const keys = Object.keys(parsed.data);
    for (const forbidden of [
      "mhBleeding",
      "mhKidneyDisease",
      "familyPlanning",
      "insuranceIdNo",
      "dateOfBirth",
      "rawPayload",
      "streetAddress",
    ]) {
      assert.ok(!keys.includes(forbidden), `${forbidden} must be stripped`);
    }
    // Whitelisted fields survive.
    assert.equal(parsed.data.firstName, "Jane");
    assert.equal(parsed.data.officeLocation, "Plano, TX");
    assert.equal(parsed.data.furthestStep, 5);
  });

  it("requires a partial id of sane length", () => {
    assert.equal(partialSchema.safeParse({ email: "a@b.com" }).success, false);
    assert.equal(partialSchema.safeParse({ partialId: "short" }).success, false);
  });
});

// ── capture only after the contact step ─────────────────────────────────────
describe("shouldCaptureAtStep — nothing before the contact step", () => {
  const CONTACT = 1; // patient-info=0, contact=1
  it("does NOT capture at or before the contact step", () => {
    assert.equal(shouldCaptureAtStep(0, CONTACT), false); // patient-info
    assert.equal(shouldCaptureAtStep(1, CONTACT), false); // arriving at contact
  });
  it("captures once advanced PAST the contact step", () => {
    assert.equal(shouldCaptureAtStep(2, CONTACT), true);
    assert.equal(shouldCaptureAtStep(5, CONTACT), true);
  });
});

// ── origin guard ────────────────────────────────────────────────────────────
describe("originAllowed", () => {
  it("permits our domains and absent origin; rejects cross-origin", () => {
    assert.equal(originAllowed("https://intake.drsnip.com"), true);
    assert.equal(originAllowed("https://intake.doctorsnip.com"), true);
    assert.equal(originAllowed(undefined), true); // same-origin / curl
    assert.equal(originAllowed("https://evil.example.com"), false);
    assert.equal(originAllowed("http://intake.drsnip.com"), false); // scheme matters
  });
});

// ── beacon handler guards (no DB reached) ───────────────────────────────────
describe("beacon handler — guards", () => {
  it("405s a non-POST", async () => {
    const res = makeRes();
    await partialHandler(makeReq({ method: "GET" }), res);
    assert.equal(res.statusCode, 405);
  });
  it("403s a cross-origin POST", async () => {
    const res = makeRes();
    await partialHandler(
      makeReq({
        method: "POST",
        headers: { origin: "https://evil.example.com" },
        body: { partialId: "abcdef12345678" },
      }),
      res,
    );
    assert.equal(res.statusCode, 403);
  });
  it("400s an invalid body (no partial id) before any DB write", async () => {
    const res = makeRes();
    await partialHandler(
      makeReq({ method: "POST", body: { email: "a@b.com" } }),
      res,
    );
    assert.equal(res.statusCode, 400);
  });
});

// ── retention/grace constants (locked design) ───────────────────────────────
describe("retention + grace constants", () => {
  it("30-day retention, 24-hour grace", () => {
    assert.equal(PARTIAL_RETENTION_DAYS, 30);
    assert.equal(PARTIAL_GRACE_HOURS, 24);
  });
});

// ── CSV export shape ────────────────────────────────────────────────────────
describe("buildPartialsCsv — Pacific split columns, no medical column", () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    partialId: "abcdef12345678",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "(555) 010-0001",
    officeLocation: "Seattle, WA",
    furthestStep: 5,
    furthestStepLabel: "Insurance",
    source: "google",
    utmSource: "google",
    utmMedium: "cpc",
    utmCampaign: "seattle",
    utmTerm: null,
    utmContent: null,
    clickId: "G1",
    clickIdType: "gclid",
    createdAt: new Date("2026-08-07T21:14:00Z"),
    updatedAt: new Date("2026-08-07T22:00:00Z"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const csv = buildPartialsCsv([row]);
  const header = csv.split("\r\n")[0];

  it("has Pacific date/time split columns", () => {
    assert.ok(header.includes("Started Date (PT)"));
    assert.ok(header.includes("Started Time (PT)"));
    assert.ok(header.includes("Last Active Date (PT)"));
  });
  it("renders the Pacific values (2:14 PM PDT on 08-07)", () => {
    assert.ok(csv.includes("2026-08-07"));
    assert.ok(csv.includes("2:14 PM"));
  });
  it("has NO medical/insurance columns", () => {
    for (const forbidden of ["Bleeding", "Kidney", "Insurance ID", "Medical", "DOB", "Date of Birth"]) {
      assert.ok(!header.includes(forbidden), `header must not contain ${forbidden}`);
    }
  });
});

// ── beacon is silent when the endpoint is down ──────────────────────────────
describe("sendPartialBeacon — never throws (wizard unaffected)", () => {
  it("swallows a rejecting fetch and a missing window", () => {
    // No window (server-like): returns without throwing.
    assert.doesNotThrow(() => sendPartialBeacon({ partialId: "abcdef12345678" }));

    // Simulate a browser with a failing endpoint.
    const g = globalThis as unknown as {
      window?: unknown;
      fetch?: unknown;
    };
    const savedWindow = g.window;
    const savedFetch = g.fetch;
    g.window = {};
    g.fetch = () => Promise.reject(new Error("endpoint down"));
    try {
      assert.doesNotThrow(() =>
        sendPartialBeacon({ partialId: "abcdef12345678", email: "a@b.com" }),
      );
    } finally {
      g.window = savedWindow;
      g.fetch = savedFetch;
    }
  });
});
