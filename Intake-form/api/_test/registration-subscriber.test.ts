// Subscriber (policyholder) details on the registration document — regression
// guard for DRSNIP_SUBSCRIBER_DETAILS_INCIDENT_INVESTIGATION.md and
// DRSNIP_SUBSCRIBER_DETAILS_FORWARD_FIX_RELEASE.md.
//
// DB-FREE and synthetic only. The n8n half runs the REAL node code that is
// deployed to Registration v2 (lib/n8n/registration-v2/*.js), fed with the
// REAL app payload from buildRegistrationPayload, and inspects the PDF bytes it
// produces. Nothing here talks to n8n, Postgres or DrChrono.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { buildRegistrationPayload } from "../../lib/n8n/payload";
import { callN8nRegistration } from "../../lib/n8n/bridge";
import {
  coverageChangePatch,
  isValidDob,
  policyholderErrors,
  withApplicableInsurance,
} from "../../lib/registration/insurance";
import handler from "../submit";

const AT = new Date("2026-09-23T12:00:00Z");
const NODE_DIR = join(__dirname, "../../lib/n8n/registration-v2");
const NORMALIZE = readFileSync(join(NODE_DIR, "parse-normalize.js"), "utf8");
const RENDER = readFileSync(join(NODE_DIR, "generate-registration-pdf.js"), "utf8");

const PATIENT = {
  formType: "registration",
  firstName: "Zqpatient",
  lastName: "Synthetic",
  legalFirstName: "Zqpatient",
  legalLastName: "Synthetic",
  email: "synthetic@example.invalid",
  phone: "5550000000",
  dateOfBirth: "1990-01-01",
  stateResidence: "WA",
  state: "WA",
  city: "Seattle",
  postalCode: "98101",
  streetAddress: "1 Synthetic Way",
  officeLocation: "Seattle, WA",
};

const PRIMARY = {
  insuranceCompany: "Synthetic Health",
  insuranceIdNo: "SYN123",
  insuranceGroupNo: "G1",
};

const PARTNER_HOLDER = {
  insuredFirstName: "Zqsubfirst",
  insuredLastName: "Zqsublast",
  insuredDob: "1985-07-04",
  insuredEmployer: "Zqemployer",
};

const BOTH_PARTNER = {
  partnerInsuranceCompany: "Zqpartnerplan",
  partnerInsuranceIdNo: "SYNP456",
  partnerInsuranceGroupNo: "PG9",
  partnerInsuredFirstName: "Zqpartfirst",
  partnerInsuredLastName: "Zqpartlast",
  partnerInsuredDob: "1984-02-29",
  partnerInsuredEmployer: "Zqpartemployer",
};

// ---- helpers ---------------------------------------------------------------

type Json = Record<string, unknown>;

/** Execute an n8n Code-node body exactly as n8n does ($input / $ / Buffer). */
function runNode(code: string, input: Json, refs: Record<string, Json> = {}) {
  const $input = { first: () => ({ json: input }) };
  const $ = (name: string) => ({ first: () => ({ json: refs[name] }) });
  const fn = new Function("$input", "$", "Buffer", code);
  return fn($input, $, Buffer) as Array<{ json: Json; binary?: Json }>;
}

/** Full document path: app payload -> webhook shape -> normalise -> render. */
function renderDocument(payload: unknown) {
  const webhookItem = { headers: {}, body: payload } as Json;
  const [normalized] = runNode(NORMALIZE, webhookItem);
  const resolved = { patient_id: 999000111, drchrono_action: "create" };
  const [out] = runNode(RENDER, resolved, { "Parse & Normalize": normalized.json });
  const pdf = (out.binary as { pdf: { data: string } }).pdf.data;
  const bytes = Buffer.from(pdf, "base64");
  return { normalized: normalized.json, bytes, text: pdfText(bytes) };
}

/** The text-show operands of every content stream, in drawing order. */
function pdfText(bytes: Buffer): string {
  const src = bytes.toString("latin1");
  const parts: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\) Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    parts.push(
      m[1]
        .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\([\\()])/g, "$1"),
    );
  }
  return parts.join("\n");
}

function payloadFor(body: Json) {
  return buildRegistrationPayload("00000000-0000-4000-8000-000000000001", body as never, AT);
}

/** Text between a label and the next known label (a rendered row value). */
function after(text: string, label: string): string {
  const i = text.indexOf(label);
  assert.ok(i >= 0, `label not rendered: ${label}`);
  return text.slice(i + label.length, i + label.length + 400);
}

// ---- shared rules ------------------------------------------------------------

test("isValidDob: real calendar dates only, 1900..today, no reformatting", () => {
  const today = new Date("2026-09-23T12:00:00Z");
  for (const ok of ["1900-01-01", "2000-02-29", "1984-02-29", "2026-09-23", "1999-12-31"])
    assert.equal(isValidDob(ok, today), true, ok);
  for (const bad of [
    "1899-12-31", "1900-02-29", "2023-02-30", "2023-13-01", "2023-00-10",
    "2023-04-31", "2026-09-25", "02/03/1990", "1990-1-5", "", "1990-01-01T00:00:00Z",
  ])
    assert.equal(isValidDob(bad, today), false, bad);
  assert.equal(isValidDob(19900101 as unknown, today), false);
});

test("policyholderErrors: Partner's Insurance requires name + DOB", () => {
  const base = { ...PATIENT, ...PRIMARY, insuranceCoverage: "Partner's Insurance" };
  assert.deepEqual(Object.keys(policyholderErrors({ ...base, ...PARTNER_HOLDER })), []);
  assert.deepEqual(
    Object.keys(policyholderErrors(base)).sort(),
    ["insuredDob", "insuredFirstName", "insuredLastName"],
  );
  assert.deepEqual(
    Object.keys(policyholderErrors({ ...base, ...PARTNER_HOLDER, insuredLastName: "   " })),
    ["insuredLastName"],
  );
  assert.deepEqual(
    Object.keys(policyholderErrors({ ...base, ...PARTNER_HOLDER, insuredDob: "2023-02-30" })),
    ["insuredDob"],
  );
  // Employer stays optional.
  assert.deepEqual(
    Object.keys(policyholderErrors({ ...base, ...PARTNER_HOLDER, insuredEmployer: "" })),
    [],
  );
});

test("policyholderErrors: Both requires the PARTNER policyholder, not the patient's", () => {
  const base = { ...PATIENT, ...PRIMARY, insuranceCoverage: "Both" };
  assert.deepEqual(Object.keys(policyholderErrors({ ...base, ...BOTH_PARTNER })), []);
  assert.deepEqual(
    Object.keys(policyholderErrors({ ...base, ...BOTH_PARTNER, partnerInsuredDob: "" })),
    ["partnerInsuredDob"],
  );
  // Filling only the primary insured does not satisfy the partner requirement.
  assert.deepEqual(
    Object.keys(policyholderErrors({ ...base, ...PARTNER_HOLDER })).sort(),
    ["partnerInsuredDob", "partnerInsuredFirstName", "partnerInsuredLastName"],
  );
});

test("policyholderErrors: Own / No Insurance / blank are not made mandatory", () => {
  for (const c of ["Own Insurance", "No Insurance", "", "Something else"])
    assert.deepEqual(policyholderErrors({ ...PATIENT, insuranceCoverage: c }), {}, c);
});

test("withApplicableInsurance: stale hidden policy fields are blanked", () => {
  const stale = { ...PATIENT, ...PRIMARY, ...PARTNER_HOLDER, ...BOTH_PARTNER,
    partnerInsuranceCardFront: { filename: "p.jpg", size: 1 } };
  const own = withApplicableInsurance({ ...stale, insuranceCoverage: "Own Insurance" });
  assert.equal(own.partnerInsuredFirstName, "");
  assert.equal(own.partnerInsuranceCompany, "");
  assert.equal(own.partnerInsuranceCardFront, null);
  assert.equal(own.insuredFirstName, "Zqsubfirst"); // primary kept for Own
  const none = withApplicableInsurance({ ...stale, insuranceCoverage: "No Insurance" });
  assert.equal(none.insuranceCompany, "");
  assert.equal(none.insuredDob, "");
  assert.equal(none.partnerInsuredDob, "");
  const both = withApplicableInsurance({ ...stale, insuranceCoverage: "Both" });
  assert.equal(both.partnerInsuredFirstName, "Zqpartfirst");
});

test("coverageChangePatch: owner flip clears the primary set; detours restore", () => {
  // Partner's -> Own: the partner's details must not become the patient's policy.
  const flip = coverageChangePatch("partner", "Own Insurance");
  assert.equal(flip.insuredFirstName, "");
  assert.equal(flip.insuranceCompany, "");
  assert.equal(flip.insuranceCardFront, null);
  // Partner's -> Both: primary becomes the patient's own policy -> cleared.
  assert.equal(coverageChangePatch("partner", "Both").insuredDob, "");
  // Partner's -> No Insurance (-> back to Partner's): kept, so values restore.
  assert.deepEqual(coverageChangePatch("partner", "No Insurance"), {});
  assert.deepEqual(coverageChangePatch("partner", "Partner's Insurance"), {});
  // Owner remembered across the No-Insurance detour: Partner's -> None -> Own clears.
  assert.equal(coverageChangePatch("partner", "Own Insurance").insuredLastName, "");
  // Own <-> Both keeps the patient's own policy.
  assert.deepEqual(coverageChangePatch("patient", "Both"), {});
  assert.deepEqual(coverageChangePatch("", "Own Insurance"), {});
});

// ---- app -> n8n payload ------------------------------------------------------

test("payload: Partner's Insurance carries the partner policyholder", () => {
  const p = payloadFor({ ...PATIENT, ...PRIMARY, ...PARTNER_HOLDER, insuranceCoverage: "Partner's Insurance" });
  assert.equal(p.insurance.policyholderContract, 1);
  assert.equal(p.insurance.policyOwner, "partner");
  assert.deepEqual(p.insurance.insured, {
    firstName: "Zqsubfirst", lastName: "Zqsublast", dob: "1985-07-04", employer: "Zqemployer",
  });
  assert.equal(p.insurance.partnerPolicy, null);
  // Legacy scalars unchanged.
  assert.equal(p.insurance.provider, "Synthetic Health");
  assert.equal(p.insurance.memberId, "SYN123");
  assert.equal(p.insurance.groupId, "G1");
});

test("payload: Both keeps the two policies and their holders distinct", () => {
  const p = payloadFor({ ...PATIENT, ...PRIMARY, ...BOTH_PARTNER, insuranceCoverage: "Both",
    partnerInsuranceCardFront: { filename: "pf.jpg", size: 10 } });
  assert.equal(p.insurance.policyOwner, "patient");
  assert.deepEqual(p.insurance.insured, { firstName: "", lastName: "", dob: "", employer: "" });
  assert.deepEqual(p.insurance.partnerPolicy, {
    provider: "Zqpartnerplan", memberId: "SYNP456", groupId: "PG9",
    insured: { firstName: "Zqpartfirst", lastName: "Zqpartlast", dob: "1984-02-29", employer: "Zqpartemployer" },
    cardsUploaded: 1,
  });
  // The partner never leaks into the primary block, and vice versa.
  assert.doesNotMatch(JSON.stringify(p.insurance.insured), /Zqpart/);
  assert.equal(p.insurance.provider, "Synthetic Health");
});

test("payload: Own Insurance unchanged apart from the additive blocks", () => {
  const p = payloadFor({ ...PATIENT, ...PRIMARY, insuranceCoverage: "Own Insurance",
    ...BOTH_PARTNER /* stale from an earlier "Both" selection */ });
  assert.equal(p.insurance.status, "Own Insurance");
  assert.equal(p.insurance.provider, "Synthetic Health");
  assert.equal(p.insurance.policyOwner, "patient");
  assert.equal(p.insurance.partnerPolicy, null);
  assert.doesNotMatch(JSON.stringify(p), /Zqpart/);
});

test("payload: No Insurance forwards no stale policy or policyholder", () => {
  const p = payloadFor({ ...PATIENT, ...PRIMARY, ...PARTNER_HOLDER, insuranceCoverage: "No Insurance" });
  assert.equal(p.insurance.provider, "");
  assert.equal(p.insurance.policyOwner, "");
  assert.doesNotMatch(JSON.stringify(p), /Zqsub|Synthetic Health/);
});

test("payload: DOB passes through verbatim (no timezone shift)", () => {
  for (const dob of ["1984-02-29", "1900-01-01", "1999-12-31"]) {
    const p = payloadFor({ ...PATIENT, ...PRIMARY, ...PARTNER_HOLDER, insuredDob: dob,
      insuranceCoverage: "Partner's Insurance" });
    assert.equal(p.insurance.insured.dob, dob);
  }
});

// ---- the real n8n normalise + render ----------------------------------------

test("document: Partner's Insurance renders the partner policyholder name + DOB", async () => {
  const { normalized, bytes, text } = renderDocument(
    payloadFor({ ...PATIENT, ...PRIMARY, ...PARTNER_HOLDER, insuranceCoverage: "Partner's Insurance" }),
  );
  assert.equal(normalized.insurance_insured_first_name, "Zqsubfirst");
  assert.equal(normalized.insurance_insured_dob, "1985-07-04");
  assert.match(text, /Partner's policy - the partner is the policyholder/);
  assert.match(after(text, "Policyholder (insured) name"), /^\nZqsubfirst Zqsublast/);
  assert.match(after(text, "Policyholder (insured) date of birth"), /^\n1985-07-04/);
  assert.match(after(text, "Policyholder (insured) employer"), /^\nZqemployer/);
  assert.doesNotMatch(text, /Partner's policy \(secondary\)/);
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
});

test("document: Both renders two distinct policies, each with its own holder", () => {
  const { text } = renderDocument(
    payloadFor({ ...PATIENT, ...PRIMARY, ...BOTH_PARTNER, insuranceCoverage: "Both" }),
  );
  const own = text.indexOf("Patient's own policy (primary)");
  const partner = text.indexOf("Partner's policy (secondary) - the partner is the policyholder");
  assert.ok(own >= 0 && partner > own, "both policy headings, primary first");
  const ownBlock = text.slice(own, partner);
  const partnerBlock = text.slice(partner);
  assert.match(ownBlock, /Synthetic Health/);
  assert.doesNotMatch(ownBlock, /Zqpart/);
  assert.match(after(ownBlock, "Policyholder (insured) name"), /^\nNot provided/);
  assert.match(partnerBlock, /Zqpartnerplan/);
  assert.match(after(partnerBlock, "Policyholder (insured) name"), /^\nZqpartfirst Zqpartlast/);
  assert.match(after(partnerBlock, "Policyholder (insured) date of birth"), /^\n1984-02-29/);
  assert.match(partnerBlock, /Partner insurance cards\nNone uploaded/);
});

test("document: Own Insurance keeps its rows; no partner section", () => {
  const { text } = renderDocument(
    payloadFor({ ...PATIENT, ...PRIMARY, insuranceCoverage: "Own Insurance" }),
  );
  assert.match(text, /Patient's own policy/);
  assert.match(after(text, "Insurance Company"), /^\nSynthetic Health/);
  assert.match(after(text, "ID No."), /^\nSYN123/);
  assert.match(after(text, "Group No."), /^\nG1/);
  assert.doesNotMatch(text, /Partner's policy/);
});

test("document: No Insurance renders no policyholder rows", () => {
  const { text } = renderDocument(payloadFor({ ...PATIENT, insuranceCoverage: "No Insurance" }));
  assert.match(text, /Current insurance coverage\nNo Insurance/);
  assert.doesNotMatch(text, /Policyholder/);
});

test("document: an older payload is marked 'not transmitted', never the patient", () => {
  // Shape the app sent before this release: no policyholder blocks at all.
  const legacy = payloadFor({ ...PATIENT, ...PRIMARY, ...PARTNER_HOLDER,
    insuranceCoverage: "Partner's Insurance" }) as unknown as { insurance: Json };
  for (const k of ["policyOwner", "insured", "partnerPolicy", "policyholderContract"])
    delete legacy.insurance[k];
  const { normalized, text } = renderDocument(legacy);
  assert.equal(normalized.insurance_policyholder_contract, false);
  assert.match(text, /Partner's policy - the partner is the policyholder/);
  assert.match(after(text, "Policyholder (insured) name"), /^\nNot transmitted by the intake app/);
  assert.doesNotMatch(after(text, "Policyholder (insured) name"), /Zqpatient/);

  const legacyBoth = payloadFor({ ...PATIENT, ...PRIMARY, ...BOTH_PARTNER,
    insuranceCoverage: "Both" }) as unknown as { insurance: Json };
  for (const k of ["policyOwner", "insured", "partnerPolicy", "policyholderContract"])
    delete legacyBoth.insurance[k];
  const both = renderDocument(legacyBoth);
  assert.match(both.text, /Partner's policy details\nNot transmitted by the intake app/);
});

test("document: long names, punctuation and accents stay readable and valid", async () => {
  const longLast = "Zqlong" + "-Hyphenated".repeat(12);
  const { bytes, text } = renderDocument(
    payloadFor({ ...PATIENT, ...PRIMARY, insuranceCoverage: "Partner's Insurance",
      insuredFirstName: "José (Jr.) O'Brien\\Zq", insuredLastName: longLast,
      insuredDob: "1985-07-04", insuredEmployer: "A & B (Holdings) \"Zq\"" }),
  );
  // Accents folded, PDF string delimiters escaped (round-trip through Tj).
  assert.match(text, /Jose \(Jr\.\) O'Brien\\Zq/);
  assert.match(text, /\(Holdings\)/);
  // The long name wraps across lines rather than overflowing: every piece is
  // present and no single rendered line holds all of it.
  const joined = text.replace(/\n/g, "");
  assert.ok(joined.includes(longLast), "long name fully rendered");
  assert.ok(!text.split("\n").includes(longLast), "long name wrapped");
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
});

test("document: page breaks — the insurance section survives a page overflow", async () => {
  const details = "Zqdetail ".repeat(120);
  const body: Json = { ...PATIENT, ...PRIMARY, ...BOTH_PARTNER, insuranceCoverage: "Both" };
  for (const k of ["mhSurgeries", "mhMedications", "mhAllergies", "mhChronic", "mhBleeding"])
    body[k] = "Yes";
  body.medicalDetails = { mhSurgeries: details, mhMedications: details, mhAllergies: details,
    mhChronic: details, mhBleeding: details };
  const { bytes, text } = renderDocument(payloadFor(body));
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2, "overflowed onto another page");
  assert.match(text, new RegExp(`Page ${doc.getPageCount()} of ${doc.getPageCount()}`));
  assert.match(after(text, "Partner's policy (secondary)"), /Zqpartfirst Zqpartlast/);
});

// ---- server gate + delivery --------------------------------------------------

function fakeRes() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    setHeader(k: string, v: string) { r.headers[k] = v; },
  };
  return r;
}

test("server: incomplete partner policyholder is rejected before storage", async () => {
  const cases: Array<[Json, string[]]> = [
    [{ ...PATIENT, ...PRIMARY, insuranceCoverage: "Partner's Insurance",
       insuredFirstName: "Zqsubfirst", insuredLastName: "Zqsublast" }, ["insuredDob"]],
    [{ ...PATIENT, ...PRIMARY, insuranceCoverage: "Partner's Insurance",
       insuredDob: "1985-07-04" }, ["insuredFirstName", "insuredLastName"]],
    [{ ...PATIENT, ...PRIMARY, insuranceCoverage: "Partner's Insurance",
       ...PARTNER_HOLDER, insuredDob: "1985-02-30" }, ["insuredDob"]],
    [{ ...PATIENT, ...PRIMARY, ...BOTH_PARTNER, insuranceCoverage: "Both",
       partnerInsuredFirstName: "" }, ["partnerInsuredFirstName"]],
  ];
  for (const [body, fields] of cases) {
    const res = fakeRes();
    await handler({ method: "POST", body } as never, res as never);
    assert.equal(res.statusCode, 400);
    const out = res.body as { success: boolean; error: string; fieldErrors: Json };
    assert.equal(out.success, false);
    assert.deepEqual(Object.keys(out.fieldErrors).sort(), [...fields].sort());
    // Never echoes submitted values.
    assert.doesNotMatch(JSON.stringify(out), /Zqsub|1985|Zqpart|Zqpatient/);
  }
});

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("delivery: one POST per submission, carrying the policyholder block", async () => {
  process.env.N8N_BRIDGE_ENABLED = "true";
  process.env.N8N_WEBHOOK_REGISTRATION_URL = "https://n8n.invalid/webhook/r";
  process.env.N8N_WEBHOOK_SECRET = "s";
  const calls: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response(JSON.stringify({ status: "success", patient_id: 1 }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await callN8nRegistration("00000000-0000-4000-8000-000000000002",
    { ...PATIENT, ...PRIMARY, ...PARTNER_HOLDER, insuranceCoverage: "Partner's Insurance" } as never, AT);
  assert.equal(calls.length, 1, "no retry / duplicate delivery added");
  const sent = JSON.parse(calls[0]);
  assert.equal(sent.insurance.insured.firstName, "Zqsubfirst");
  assert.equal(sent.insurance.policyholderContract, 1);
});
