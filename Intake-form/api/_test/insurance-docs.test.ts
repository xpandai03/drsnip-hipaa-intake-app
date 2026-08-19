// Train D — insurance documents (summary PDF + card images to the chart).
// DB-FREE: the PDF generator is a pure function over a submission row, so the
// whole document contract is testable without Postgres, n8n, or DrChrono.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Submission } from "@workspace/db";
import { INSURANCE_SECTIONS } from "../../lib/pdf/templates/insurance";
import { REGISTRATION_SECTIONS } from "../../lib/pdf/templates/registration";
import { generateSubmissionPdf, lookupPath } from "../../lib/pdf/generator";
import { buildInsurancePayload } from "../../lib/n8n/payload";
import { insuranceDocsEnabled, insuranceBridgeEnabled } from "../../lib/n8n/bridge";

const SUB_ID = "b64e5cfb-58da-42b5-b14f-83c55637c0d3";
const AT = new Date("2026-08-19T21:41:00Z"); // 2:41 PM PT

const TOUCHED = ["N8N_INSURANCE_DOCS_ENABLED", "N8N_INSURANCE_BRIDGE_ENABLED"];
afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
});

// A raw_payload exactly as Insurance.tsx posts it (card bytes already stripped
// by sanitizeForPersistence, which is what actually lands in the DB).
function insuranceRaw(overrides: Record<string, unknown> = {}) {
  return {
    formType: "insurance",
    firstName: "Testy",
    lastName: "Qaignore",
    email: "qa@xpandai.com",
    phone: "(555) 010-0404",
    dateOfBirth: "1991-04-04",
    sex: "Male",
    officeLocation: "Seattle, WA",
    streetAddress: "1200 QA Test Ave",
    addressLine2: "Suite 2",
    city: "Seattle",
    state: "WA",
    postalCode: "98101",
    insurance: {
      primary: {
        carrier: "QA Test Carrier",
        subscriberName: { first: "Testy", last: "Qaignore" },
        policyNo: "QA-POL-0404",
        groupNo: "QA-GRP-0404",
        subscriberDob: "1991-04-04",
        relationship: "Self",
      },
      secondary: null,
    },
    insuranceCardFront: { filename: "front.jpg", size: 1024, contentType: "image/jpeg" },
    insuranceCardBack: { filename: "back.jpg", size: 2048, contentType: "image/jpeg" },
    ...overrides,
  };
}

function insuranceRow(raw: Record<string, unknown> = insuranceRaw()): Submission {
  return {
    id: SUB_ID,
    createdAt: AT,
    updatedAt: AT,
    formType: "insurance",
    firstName: "Testy",
    lastName: "Qaignore",
    email: "qa@xpandai.com",
    phone: "(555) 010-0404",
    dateOfBirth: "1991-04-04",
    stateResidence: "WA",
    insuranceCardFrontFilename: "front.jpg",
    insuranceCardBackFilename: "back.jpg",
    hasInsuranceCards: true,
    mhMentalIllness: null,
    n8nStatus: "success",
    n8nPatientId: 135617264,
    n8nResponseAt: AT,
    n8nResponseBody: {},
    rawPayload: raw,
    source: null, utmSource: null, utmMedium: null, utmCampaign: null,
    utmTerm: null, utmContent: null, clickId: null, clickIdType: null,
    sourceValidated: null,
  } as unknown as Submission;
}

// ---- The template must not carry medical data ----------------------------

test("INSURANCE_SECTIONS: no medical-history field can reach the chart PDF", () => {
  const all = INSURANCE_SECTIONS.flatMap((s) => s.fields);
  assert.equal(
    all.filter((f) => f.kind === "medical").length,
    0,
    "insurance summary must contain no 'medical' fields",
  );
  for (const f of all) {
    assert.ok(
      !/^mh[A-Z]/.test(f.key.split(".")[0]),
      `medical key leaked into the insurance PDF: ${f.key}`,
    );
    assert.ok(!f.key.startsWith("medicalDetails"), `medicalDetails leaked: ${f.key}`);
  }
  // Sanity: the registration template DOES carry them, so the assertion above
  // is testing something real rather than passing vacuously.
  assert.ok(
    REGISTRATION_SECTIONS.flatMap((s) => s.fields).some((f) => f.kind === "medical"),
  );
});

test("INSURANCE_SECTIONS: carries the carrier data the verification team needs", () => {
  const keys = new Set(INSURANCE_SECTIONS.flatMap((s) => s.fields).map((f) => f.key));
  for (const k of [
    "insurance.primary.carrier",
    "insurance.primary.policyNo",
    "insurance.primary.groupNo",
    "insurance.primary.subscriberName.first",
    "insurance.primary.subscriberName.last",
    "insurance.primary.subscriberDob",
    "insurance.primary.relationship",
    "insurance.secondary.carrier",
    "insurance.secondary.policyNo",
    "officeLocation",
  ]) {
    assert.ok(keys.has(k), `insurance PDF missing required field: ${k}`);
  }
});

// ---- Nested path resolution ----------------------------------------------

test("lookupPath: resolves the nested carrier shape the insurance form posts", () => {
  const raw = insuranceRaw();
  assert.equal(lookupPath(raw, "insurance.primary.carrier"), "QA Test Carrier");
  assert.equal(lookupPath(raw, "insurance.primary.subscriberName.first"), "Testy");
  assert.equal(lookupPath(raw, "insurance.primary.relationship"), "Self");
});

test("lookupPath: plain keys behave exactly as a property read (no regression)", () => {
  const raw = insuranceRaw();
  assert.equal(lookupPath(raw, "firstName"), "Testy");
  assert.equal(lookupPath(raw, "officeLocation"), "Seattle, WA");
  assert.equal(lookupPath(raw, "nope"), undefined);
});

test("lookupPath: a null/absent branch yields undefined, never throws", () => {
  const raw = insuranceRaw();
  // secondary is null when the patient gave no secondary carrier
  assert.equal(lookupPath(raw, "insurance.secondary.carrier"), undefined);
  assert.equal(lookupPath(raw, "insurance.nope.deep.deeper"), undefined);
  assert.equal(lookupPath({}, "a.b.c"), undefined);
  // walking THROUGH a scalar must not throw
  assert.equal(lookupPath({ a: "str" }, "a.b"), undefined);
});

// ---- The PDF itself -------------------------------------------------------

test("generateSubmissionPdf: produces a valid PDF for an insurance submission", async () => {
  const bytes = await generateSubmissionPdf(insuranceRow());
  assert.ok(bytes.length > 500, "PDF suspiciously small");
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
});

test("generateSubmissionPdf: an all-empty insurance payload still renders", async () => {
  const bytes = await generateSubmissionPdf(insuranceRow({ formType: "insurance" }));
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
});

test("generateSubmissionPdf: a secondary carrier renders without error", async () => {
  const raw = insuranceRaw({
    insurance: {
      primary: insuranceRaw().insurance.primary,
      secondary: {
        carrier: "Second Carrier",
        subscriberName: { first: "Pat", last: "Qaignore" },
        policyNo: "POL999",
        groupNo: "GRP888",
        subscriberDob: "1988-02-02",
        relationship: "Spouse",
      },
    },
  });
  assert.equal(lookupPath(raw, "insurance.secondary.carrier"), "Second Carrier");
  const bytes = await generateSubmissionPdf(insuranceRow(raw));
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
});

test("registration PDF still generates (generator change is additive)", async () => {
  const row = insuranceRow();
  const reg = { ...row, formType: "registration" } as unknown as Submission;
  const bytes = await generateSubmissionPdf(reg);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
});

// ---- Document flag --------------------------------------------------------

test("documents flag is OFF by default and independent of the chart bridge", () => {
  assert.equal(insuranceDocsEnabled(), false);

  process.env.N8N_INSURANCE_BRIDGE_ENABLED = "true";
  assert.equal(insuranceDocsEnabled(), false, "chart flag must not enable docs");

  delete process.env.N8N_INSURANCE_BRIDGE_ENABLED;
  process.env.N8N_INSURANCE_DOCS_ENABLED = "true";
  assert.equal(insuranceDocsEnabled(), true);
  assert.equal(insuranceBridgeEnabled(), false, "docs flag must not enable charts");
});

test("payload carries documents.enabled, defaulting to false", () => {
  const off = buildInsurancePayload(SUB_ID, insuranceRaw(), AT);
  assert.deepEqual(off.documents, { enabled: false });

  const on = buildInsurancePayload(SUB_ID, insuranceRaw(), AT, {
    documentsEnabled: true,
  });
  assert.deepEqual(on.documents, { enabled: true });
});

// ---- The no-bytes guarantee, extended to the Train D payload -------------

function findByteish(node: unknown, path = "$"): string[] {
  const hits: string[] = [];
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/base64|bytes|blob|dataUrl/i.test(k)) hits.push(`${path}.${k}`);
      hits.push(...findByteish(v, `${path}.${k}`));
    }
  }
  if (typeof node === "string" && node.startsWith("data:")) hits.push(`${path} (data-url)`);
  return hits;
}

test("Train D payload still carries NO card bytes, docs on or off", () => {
  const withBytes = insuranceRaw({
    insuranceCardFront: { filename: "f.jpg", size: 10, contentType: "image/jpeg", base64Data: "QUJD" },
    insuranceCardBack: { filename: "b.jpg", size: 10, contentType: "image/jpeg", base64Data: "REVG" },
    partnerInsuranceCardFront: { filename: "pf.jpg", size: 10, base64Data: "R0lG" },
    partnerInsuranceCardBack: { filename: "pb.jpg", size: 10, base64Data: "SElK" },
  });
  for (const documentsEnabled of [false, true]) {
    const p = buildInsurancePayload(SUB_ID, withBytes, AT, { documentsEnabled });
    assert.deepEqual(findByteish(p), [], `bytes leaked with docs=${documentsEnabled}`);
    const wire = JSON.stringify(p);
    for (const b64 of ["QUJD", "REVG", "R0lG", "SElK"]) {
      assert.equal(wire.includes(b64), false, `payload leaked ${b64}`);
    }
    assert.equal(wire.includes("front.jpg"), false, "filename leaked");
    // Four cards present -> the count signal is what n8n uses to decide to fetch.
    assert.deepEqual(p.cards, { hasCards: true, count: 4 });
  }
});

test("zero-card submission reports nothing to fetch", () => {
  const p = buildInsurancePayload(
    SUB_ID,
    insuranceRaw({ insuranceCardFront: null, insuranceCardBack: null }),
    AT,
    { documentsEnabled: true },
  );
  assert.deepEqual(p.cards, { hasCards: false, count: 0 });
  assert.deepEqual(p.documents, { enabled: true });
});
