// Train C — insurance → DrChrono bridge. DB-FREE: exercises the pure payload
// builder, the separate kill switch, the service-token guard, and the
// action_label CASE replica. The one network-shaped test stubs global fetch;
// nothing here talks to n8n, Postgres, or DrChrono.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildInsurancePayload,
  buildRegistrationPayload,
} from "../../lib/n8n/payload";
import {
  callN8nInsurance,
  callN8nRegistration,
  insuranceBridgeEnabled,
} from "../../lib/n8n/bridge";
import {
  requireServiceToken,
  serviceTokenConfigured,
  tokenMatches,
  SERVICE_TOKEN_HEADER,
} from "../_lib/service-auth";
import { DIMENSION_EXPR } from "../_lib/reporting";
import { makeReq, makeRes } from "./harness";

const SUB_ID = "b64e5cfb-58da-42b5-b14f-83c55637c0d3";
const AT = new Date("2026-08-19T21:14:00Z");

// A representative body from artifacts/intake-form/src/pages/Insurance.tsx.
// Fabricated identity — not a real patient.
function insuranceBody(overrides: Record<string, unknown> = {}) {
  return {
    formType: "insurance",
    firstName: "Testy",
    lastName: "Qaignore",
    email: "qa-insurance@xpandai.com",
    phone: "(555) 010-0819",
    dateOfBirth: "1990-01-01",
    sex: "Male",
    officeLocation: "Seattle, WA",
    stateResidence: "WA",
    streetAddress: "123 Test St",
    addressLine2: "Apt 4",
    city: "Seattle",
    state: "WA",
    postalCode: "98101",
    source: "cost-insurance-page",
    insurance: {
      primary: {
        carrier: "Test Carrier",
        subscriberName: { first: "Testy", last: "Qaignore" },
        policyNo: "POL123",
        groupNo: "GRP456",
        subscriberDob: "1990-01-01",
        relationship: "Self",
      },
      secondary: null,
    },
    insuranceCardFront: {
      filename: "front.jpg",
      size: 1024,
      contentType: "image/jpeg",
      base64Data: "QUJD",
    },
    insuranceCardBack: {
      filename: "back.jpg",
      size: 2048,
      contentType: "image/jpeg",
      base64Data: "REVG",
    },
    ...overrides,
  };
}

// ---- env isolation --------------------------------------------------------

const TOUCHED = [
  "N8N_INSURANCE_BRIDGE_ENABLED",
  "N8N_WEBHOOK_INSURANCE_URL",
  "N8N_BRIDGE_ENABLED",
  "N8N_WEBHOOK_REGISTRATION_URL",
  "N8N_WEBHOOK_SECRET",
  "N8N_SERVICE_TOKEN",
];
const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---- Payload builder: the no-bytes guarantee ------------------------------

/** Walk any structure and collect every string that looks like it could be
 *  card content. The point is to fail loudly if a future edit reintroduces
 *  base64 into the payload by any route, including a nested one. */
function findByteish(node: unknown, path = "$"): string[] {
  const hits: string[] = [];
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/base64|bytes|blob|dataUrl/i.test(k)) hits.push(`${path}.${k}`);
      hits.push(...findByteish(v, `${path}.${k}`));
    }
  }
  if (typeof node === "string" && node.startsWith("data:")) {
    hits.push(`${path} (data-url)`);
  }
  return hits;
}

test("buildInsurancePayload: NEVER carries card bytes, in any slot", () => {
  const p = buildInsurancePayload(
    SUB_ID,
    insuranceBody({
      partnerInsuranceCardFront: {
        filename: "sec-front.jpg",
        size: 999,
        contentType: "image/jpeg",
        base64Data: "R0lG",
      },
    }),
    AT,
  );
  assert.deepEqual(findByteish(p), []);
  // Belt and braces: the serialized payload must not contain the actual
  // base64 strings from the body.
  const wire = JSON.stringify(p);
  for (const b64 of ["QUJD", "REVG", "R0lG"]) {
    assert.equal(wire.includes(b64), false, `payload leaked ${b64}`);
  }
  // Nor the filenames, which can carry identifiers.
  assert.equal(wire.includes("front.jpg"), false);
});

test("buildInsurancePayload: card presence is reported as a non-PHI count", () => {
  const two = buildInsurancePayload(SUB_ID, insuranceBody(), AT);
  assert.deepEqual(two.cards, { hasCards: true, count: 2 });

  const four = buildInsurancePayload(
    SUB_ID,
    insuranceBody({
      partnerInsuranceCardFront: { filename: "a", size: 1, base64Data: "AA" },
      partnerInsuranceCardBack: { filename: "b", size: 1, base64Data: "BB" },
    }),
    AT,
  );
  assert.deepEqual(four.cards, { hasCards: true, count: 4 });

  const none = buildInsurancePayload(
    SUB_ID,
    insuranceBody({ insuranceCardFront: null, insuranceCardBack: null }),
    AT,
  );
  assert.deepEqual(none.cards, { hasCards: false, count: 0 });
});

test("buildInsurancePayload: a metadata-only card ref counts as absent", () => {
  // Legacy / stub refs have no base64Data — there are no bytes to fetch, so
  // they must not make the workflow think a card is transferable.
  const p = buildInsurancePayload(
    SUB_ID,
    insuranceBody({
      insuranceCardFront: { filename: "front.jpg", size: 10 },
      insuranceCardBack: null,
    }),
    AT,
  );
  assert.deepEqual(p.cards, { hasCards: false, count: 0 });
});

test("buildInsurancePayload: DrChrono create fields are all populated", () => {
  const p = buildInsurancePayload(SUB_ID, insuranceBody(), AT);
  assert.equal(p.formType, "insurance");
  assert.equal(p.submissionId, SUB_ID);
  assert.equal(p.submittedAt, AT.toISOString());
  assert.deepEqual(p.patient, {
    officeLocation: "Seattle, WA",
    firstName: "Testy",
    lastName: "Qaignore",
    dateOfBirth: "1990-01-01",
    sex: "Male",
    streetAddress: "123 Test St",
    addressLine2: "Apt 4",
    city: "Seattle",
    state: "WA",
    postalCode: "98101",
    country: "",
    phone: "(555) 010-0819",
    email: "qa-insurance@xpandai.com",
  });
});

test("buildInsurancePayload: state falls back to stateResidence", () => {
  const p = buildInsurancePayload(
    SUB_ID,
    insuranceBody({ state: "", stateResidence: "OR" }),
    AT,
  );
  assert.equal(p.patient.state, "OR");
});

test("buildInsurancePayload: absent secondary serializes as null, not blanks", () => {
  const p = buildInsurancePayload(SUB_ID, insuranceBody(), AT);
  assert.equal(p.insurance.secondary, null);
  assert.deepEqual(p.insurance.primary, {
    carrier: "Test Carrier",
    subscriberFirstName: "Testy",
    subscriberLastName: "Qaignore",
    policyNo: "POL123",
    groupNo: "GRP456",
    subscriberDateOfBirth: "1990-01-01",
    relationship: "Self",
  });
});

test("buildInsurancePayload: an all-blank secondary block is also null", () => {
  const p = buildInsurancePayload(
    SUB_ID,
    insuranceBody({
      insurance: {
        primary: insuranceBody().insurance.primary,
        secondary: {
          carrier: "",
          subscriberName: { first: "", last: "" },
          policyNo: "",
          groupNo: "",
          subscriberDob: "",
          relationship: "",
        },
      },
    }),
    AT,
  );
  assert.equal(p.insurance.secondary, null);
});

test("buildInsurancePayload: a populated secondary is carried through", () => {
  const p = buildInsurancePayload(
    SUB_ID,
    insuranceBody({
      insurance: {
        primary: insuranceBody().insurance.primary,
        secondary: {
          carrier: "Second Carrier",
          subscriberName: { first: "Pat", last: "Qaignore" },
          policyNo: "POL999",
          groupNo: "GRP888",
          subscriberDob: "1988-02-02",
          relationship: "Spouse",
        },
      },
    }),
    AT,
  );
  assert.equal(p.insurance.secondary?.carrier, "Second Carrier");
  assert.equal(p.insurance.secondary?.subscriberFirstName, "Pat");
  assert.equal(p.insurance.secondary?.relationship, "Spouse");
});

test("buildInsurancePayload: a garbage body degrades to blanks, never throws", () => {
  const p = buildInsurancePayload(SUB_ID, { formType: "insurance" }, AT);
  assert.equal(p.patient.firstName, "");
  assert.equal(p.insurance.secondary, null);
  assert.deepEqual(p.cards, { hasCards: false, count: 0 });
});

// ---- Kill switch: independent from the registration/consultation bridge ----

test("insurance route is OFF by default", async () => {
  assert.equal(insuranceBridgeEnabled(), false);
  const out = await callN8nInsurance(SUB_ID, insuranceBody(), AT);
  assert.equal(out.status, "failed");
  assert.equal(out.errorMessage, "bridge disabled");
  assert.equal(out.diagnostic?.kind, "config");
});

test("N8N_BRIDGE_ENABLED alone does NOT enable insurance", async () => {
  process.env.N8N_BRIDGE_ENABLED = "true";
  process.env.N8N_WEBHOOK_INSURANCE_URL = "https://n8n.invalid/webhook/x";
  process.env.N8N_WEBHOOK_SECRET = "s";
  assert.equal(insuranceBridgeEnabled(), false);
  const out = await callN8nInsurance(SUB_ID, insuranceBody(), AT);
  assert.equal(out.errorMessage, "bridge disabled");
});

test("N8N_INSURANCE_BRIDGE_ENABLED alone does NOT enable registration", async () => {
  process.env.N8N_INSURANCE_BRIDGE_ENABLED = "true";
  process.env.N8N_WEBHOOK_REGISTRATION_URL = "https://n8n.invalid/webhook/r";
  process.env.N8N_WEBHOOK_SECRET = "s";
  const out = await callN8nRegistration(SUB_ID, { formType: "registration" }, AT);
  assert.equal(out.status, "failed");
  assert.equal(out.errorMessage, "bridge disabled");
});

test("insurance route reports its own missing config by name", async () => {
  process.env.N8N_INSURANCE_BRIDGE_ENABLED = "true";
  process.env.N8N_WEBHOOK_SECRET = "s";
  const noUrl = await callN8nInsurance(SUB_ID, insuranceBody(), AT);
  assert.equal(noUrl.errorMessage, "missing config: N8N_WEBHOOK_INSURANCE_URL");

  process.env.N8N_WEBHOOK_INSURANCE_URL = "https://n8n.invalid/webhook/x";
  delete process.env.N8N_WEBHOOK_SECRET;
  const noSecret = await callN8nInsurance(SUB_ID, insuranceBody(), AT);
  assert.equal(noSecret.errorMessage, "missing config: N8N_WEBHOOK_SECRET");
});

// ---- Transport: conforms to the frozen response contract ------------------

test("insurance route posts to its own URL with the shared token header, and no bytes on the wire", async () => {
  process.env.N8N_INSURANCE_BRIDGE_ENABLED = "true";
  process.env.N8N_WEBHOOK_INSURANCE_URL = "https://n8n.invalid/webhook/ins";
  process.env.N8N_WEBHOOK_SECRET = "shared-secret";

  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  let seenBody = "";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init.headers as Record<string, string>;
    seenBody = String(init.body);
    return new Response(
      JSON.stringify({
        success: true,
        submission_id: SUB_ID,
        patient_id: 135211892,
        drchrono_action: "created",
        manual_review_required: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const out = await callN8nInsurance(SUB_ID, insuranceBody(), AT);

  assert.equal(seenUrl, "https://n8n.invalid/webhook/ins");
  assert.equal(seenHeaders["X-DrSnip-Token"], "shared-secret");
  assert.equal(seenBody.includes("QUJD"), false, "card bytes hit the wire");
  // classify() is reused unchanged — the workflow conforms to it.
  assert.equal(out.status, "success");
  assert.equal(out.patientId, 135211892);
});

test("insurance route classifies manual_review with the registration contract", async () => {
  process.env.N8N_INSURANCE_BRIDGE_ENABLED = "true";
  process.env.N8N_WEBHOOK_INSURANCE_URL = "https://n8n.invalid/webhook/ins";
  process.env.N8N_WEBHOOK_SECRET = "s";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: false,
        reason: "manual_review_required",
        submission_id: SUB_ID,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const out = await callN8nInsurance(SUB_ID, insuranceBody(), AT);
  assert.equal(out.status, "manual_review");
  assert.equal(out.patientId, undefined);
});

test("registration payload is unaffected by the insurance builder", () => {
  // Regression guard for guardrail B8: the shared module gained a function, so
  // assert the existing contract still emits its own shape.
  const p = buildRegistrationPayload(
    SUB_ID,
    { formType: "registration", firstName: "A", lastName: "B" },
    AT,
  );
  assert.equal(p.formType, "registration");
  assert.equal(p.patient.legalFirstName, "A");
  assert.ok("medicalHistory" in p);
  assert.ok("consent" in p);
});

// ---- Service token guard --------------------------------------------------

test("tokenMatches: only an exact, non-empty match passes", () => {
  assert.equal(tokenMatches("abc123", "abc123"), true);
  assert.equal(tokenMatches("abc124", "abc123"), false);
  assert.equal(tokenMatches("abc12", "abc123"), false);
  assert.equal(tokenMatches("abc1234", "abc123"), false);
  assert.equal(tokenMatches("", ""), false, "empty must never authenticate");
  assert.equal(tokenMatches("anything", ""), false);
  assert.equal(tokenMatches(undefined, "abc123"), false);
  assert.equal(tokenMatches(null, "abc123"), false);
  assert.equal(tokenMatches(42, "abc123"), false);
});

test("requireServiceToken: FAILS CLOSED when no token is configured", () => {
  assert.equal(serviceTokenConfigured(), false);
  const res = makeRes();
  const ok = requireServiceToken(
    makeReq({ method: "GET", headers: { [SERVICE_TOKEN_HEADER]: "guess" } }),
    res,
    "test",
  );
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
});

test("requireServiceToken: 401 on a missing or wrong token", () => {
  process.env.N8N_SERVICE_TOKEN = "correct-horse";
  for (const headers of [{}, { [SERVICE_TOKEN_HEADER]: "wrong" }]) {
    const res = makeRes();
    const ok = requireServiceToken(makeReq({ method: "GET", headers }), res, "t");
    assert.equal(ok, false);
    assert.equal(res.statusCode, 401);
  }
});

test("requireServiceToken: passes on the correct token", () => {
  process.env.N8N_SERVICE_TOKEN = "correct-horse";
  const res = makeRes();
  const ok = requireServiceToken(
    makeReq({
      method: "GET",
      headers: { [SERVICE_TOKEN_HEADER]: "correct-horse" },
    }),
    res,
    "t",
  );
  assert.equal(ok, true);
  assert.equal(res.statusCode, 0, "no response written on success");
});

test("service token is a DIFFERENT secret from the webhook secret", () => {
  // Guardrail B6: a card-path rotation must not be able to 401 the bridge.
  process.env.N8N_SERVICE_TOKEN = "service-token";
  process.env.N8N_WEBHOOK_SECRET = "webhook-secret";
  const res = makeRes();
  const ok = requireServiceToken(
    makeReq({
      method: "GET",
      headers: { [SERVICE_TOKEN_HEADER]: "webhook-secret" },
    }),
    res,
    "t",
  );
  assert.equal(ok, false, "the webhook secret must not open the file endpoints");
  assert.equal(res.statusCode, 401);
});

// ---- action_label replica -------------------------------------------------

test("action_label: insurance is labelled separately and never as a patient create/update", () => {
  const expr = DIMENSION_EXPR.action_label;
  assert.ok(expr.includes("'inquiry_create'"));
  assert.ok(expr.includes("'inquiry_update'"));
  assert.ok(expr.includes("'inquiry_unknown'"));
  assert.ok(expr.includes("'not_applicable'"));

  // Ordering is the whole point: the insurance branch must be evaluated before
  // the generic drchrono_action branches, or insurance rows land in the PATIENT
  // create/update buckets.
  const insuranceAt = expr.indexOf("form_type = 'insurance'");
  const genericCreateAt = expr.indexOf("THEN 'create'");
  const genericUpdateAt = expr.indexOf("THEN 'update'");
  assert.ok(insuranceAt > -1 && genericCreateAt > -1 && genericUpdateAt > -1);
  assert.ok(insuranceAt < genericCreateAt);
  assert.ok(insuranceAt < genericUpdateAt);

  // not_applicable must be caught before the NULL/pending check can't see it
  // and before form_type branching.
  assert.ok(
    expr.indexOf("'not_applicable'") < insuranceAt,
    "not_applicable must be resolved by status, ahead of form_type",
  );
});

test("action_label: the SQL migration and the app replica stay in step", async () => {
  const { readFileSync } = await import("node:fs");
  const sqlText = readFileSync(
    new URL(
      "../../mcp/drsnip-reporting/sql/002_action_label_insurance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const label of [
    "inquiry_create",
    "inquiry_update",
    "inquiry_unknown",
    "not_applicable",
  ]) {
    assert.ok(sqlText.includes(`'${label}'`), `002 SQL missing ${label}`);
    assert.ok(
      DIMENSION_EXPR.action_label.includes(`'${label}'`),
      `app replica missing ${label}`,
    );
  }
});
