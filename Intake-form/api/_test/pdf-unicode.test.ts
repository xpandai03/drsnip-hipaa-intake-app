// Name fidelity in every registration document path, plus the legacy Jotform
// subscriber mapping. DB-FREE, synthetic only. Runs the REAL node code
// deployed to n8n (lib/n8n/registration-v2, lib/n8n/legacy-jotform) and the
// console PDF generator, and reads the produced PDFs back as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { buildRegistrationPayload } from "../../lib/n8n/payload";
import { BEGIN, END, NODE_FILES, blockText, withBlock } from "../../lib/n8n/sync-pdf-unicode.mjs";
import {
  commonCoverage,
  loadFontAsset,
  planText,
  winAnsiByte,
  WINANSI_EXTRA,
} from "../../lib/pdf-unicode/support";
import { generateSubmissionPdf } from "../../lib/pdf/generator";
import { fontsFor, pdfText } from "./_pdf-text";

type Json = Record<string, unknown>;
const N8N = join(__dirname, "../../lib/n8n");
const V2_NORMALIZE = readFileSync(join(N8N, "registration-v2/parse-normalize.js"), "utf8");
const V2_RENDER = readFileSync(join(N8N, "registration-v2/generate-registration-pdf.js"), "utf8");
const LEGACY_NORMALIZE = readFileSync(join(N8N, "legacy-jotform/parse-normalize.live.js"), "utf8");
const LEGACY_RENDER = readFileSync(join(N8N, "legacy-jotform/generate-registration-pdf.js"), "utf8");
const ASSET = loadFontAsset(join(__dirname, "../.."));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const ctx = (fail = false) => ({
  helpers: {
    httpRequest: async () => {
      if (fail) throw new Error("network down");
      return ASSET;
    },
  },
});

// The existing 19-name fixture set (DRSNIP_SUBSCRIBER_DETAILS_POST_RELEASE_VERIFICATION.md §5).
const EXACT = ["José", "Zoë", "Müller", "Núñez", "François", "Øyvind", "Søren", "Ægir", "Straße",
  "Siobhán", "O’Brien", "Œuvre", "Šimon", "Łukasz", "Nguyễn", "Đặng", "Ольга"];
const NOT_DISPLAYABLE = ["王小明", "محمد"];

async function v2Render(body: Json, fail = false) {
  const payload = buildRegistrationPayload("00000000-0000-4000-8000-000000000001", body as never,
    new Date("2026-09-23T12:00:00Z"));
  const $in = (j: Json) => ({ first: () => ({ json: j }) });
  const [n] = await new AsyncFunction("$input", "$", "Buffer", V2_NORMALIZE).call(ctx(), $in({ headers: {}, body: payload }), () => null, Buffer);
  const [o] = await new AsyncFunction("$input", "$", "Buffer", V2_RENDER).call(ctx(fail), $in({ patient_id: 1 }),
    (name: string) => ({ first: () => ({ json: name === "Parse & Normalize" ? n.json : {} }) }), Buffer);
  const bytes = Buffer.from(o.binary.pdf.data, "base64");
  return { bytes, text: pdfText(bytes), review: o.json.pdf_review as { unicode_font: string; unrenderable_fields: string[]; leaked: number } };
}

const PATIENT = {
  formType: "registration", firstName: "Zqpatient", lastName: "Synthetic", legalFirstName: "Zqpatient",
  legalLastName: "Synthetic", email: "s@example.invalid", phone: "5550000000", dateOfBirth: "1990-01-01",
  state: "WA", city: "Seattle", postalCode: "98101", streetAddress: "1 Synthetic Way",
  insuranceCompany: "Zqplan", insuranceIdNo: "Z1", insuranceCoverage: "Partner's Insurance",
  insuredLastName: "Zqlast", insuredDob: "1985-07-04",
};

// ---- the shared rule ---------------------------------------------------------

test("every node file carries the shared block verbatim", () => {
  const block = blockText();
  for (const f of NODE_FILES) {
    const src = readFileSync(join(N8N, f), "utf8");
    assert.ok(src.includes(BEGIN) && src.includes(END), f);
    assert.equal(withBlock(src, block), src, `${f} is out of sync — run node lib/n8n/sync-pdf-unicode.mjs`);
  }
});

test("block (n8n) and support.ts (app) classify text identically", async () => {
  const probe = [...EXACT, ...NOT_DISPLAYABLE, "Anne-Marie", "éclair", "ạ̈", "😀 Zq", "ʻOkina", "Ω", "€5", "tab\there"];
  // Run the block's pdfuPlan inside a minimal node program.
  const code = blockText() + "\nawait pdfuLoad(this, !this.fail);\nreturn $input.map((s) => pdfuPlan(s));";
  for (const fail of [false, true]) {
    const fromBlock = await new AsyncFunction("$input", code).call({ ...ctx(fail), fail: false }, probe);
    const hasGlyph = fail ? null : commonCoverage(ASSET);
    const fromApp = probe.map((s) => {
      const p = planText(s, hasGlyph);
      return p.kind === "unsupported" ? { kind: p.kind, text: p.text, unsupported: p.unsupported } : { kind: p.kind, text: p.text };
    });
    assert.deepEqual(fromBlock, fromApp, fail ? "font unavailable" : "font loaded");
  }
});

test("every WinAnsi character is covered by the embedded font too", () => {
  const has = commonCoverage(ASSET);
  const cps = [...Array.from({ length: 0x5f }, (_, i) => 0x20 + i), ...Array.from({ length: 0x60 }, (_, i) => 0xa0 + i), ...Object.keys(WINANSI_EXTRA).map(Number)];
  for (const cp of cps) {
    assert.ok(winAnsiByte(String.fromCodePoint(cp)) !== undefined);
    assert.ok(has(cp), `U+${cp.toString(16)} missing from the Noto subset`);
  }
});

// ---- Registration v2 document -----------------------------------------------

test("v2: the 19-name fixture — 17 exact, 2 explicitly marked, none altered", async () => {
  for (const name of [...EXACT, ...NOT_DISPLAYABLE]) {
    const { bytes, text, review } = await v2Render({ ...PATIENT, insuredFirstName: name });
    const holder = text.split("Policyholder (insured) name\n")[1] ?? "";
    if (EXACT.includes(name)) {
      assert.ok(holder.startsWith(`${name} Zqlast`), `${name} -> ${holder.slice(0, 40)}`);
      assert.deepEqual(review.unrenderable_fields, []);
      // Standard font for WinAnsi, embedded font only when needed.
      const fonts = fontsFor(bytes, name);
      assert.ok(fonts.length > 0);
      if ([...name].every((c) => winAnsiByte(c) !== undefined)) assert.ok(fonts.every((f) => f.startsWith("F")), `${name}: ${fonts}`);
      else assert.ok(fonts.every((f) => f.startsWith("U")), `${name}: ${fonts}`);
    } else {
      assert.ok(holder.startsWith("[Cannot be shown exactly in this document ("), holder.slice(0, 80));
      assert.match(holder, /see the DrSnip intake console/);
      assert.deepEqual(review.unrenderable_fields, ["Policyholder (insured) name"]);
      assert.match(text, /Review needed\nCharacters not shown\nSome entries contain characters/);
      // The rest of the registration is intact.
      assert.match(text, /Policyholder \(insured\) date of birth\n1985-07-04/);
    }
    assert.doesNotMatch(holder.split("\n")[0], /\?/, `${name}: no substituted '?'`);
    assert.doesNotMatch(text, /�/);
    assert.equal(review.leaked, 0);
    await PDFDocument.load(bytes);
  }
});

test("v2: patient name in header, Patient Information and every footer is exact", async () => {
  const { text } = await v2Render({ ...PATIENT, legalFirstName: "Łukasz", firstName: "Łukasz", legalLastName: "Nguyễn-Øyvind", lastName: "Nguyễn-Øyvind", insuredFirstName: "Zoë" });
  const pages = (text.match(/Page \d+ of \d+/g) ?? []).length;
  assert.ok(pages >= 2);
  assert.equal(text.split("\n").filter((l) => l === "Łukasz Nguyễn-Øyvind").length, 1, "centered header");
  assert.equal(text.split("\n").filter((l) => l === "Łukasz Nguyễn-Øyvind · CONFIDENTIAL / PHI").length, pages, "every footer");
  assert.match(text, /Legal First Name\nŁukasz/);
  assert.match(text, /Legal Last Name\nNguyễn-Øyvind/);
});

test("v2: unsupported patient name -> explicit header notice, generic footer", async () => {
  const { text, review } = await v2Render({ ...PATIENT, legalFirstName: "王", firstName: "王", insuredFirstName: "Zoë" });
  assert.match(text, /\[Cannot be shown exactly in this document \(Chinese\/Japanese characters\)/);
  assert.ok(review.unrenderable_fields.includes("Patient name"));
  assert.ok(review.unrenderable_fields.includes("Legal First Name"));
  assert.match(text, /DrSnip Patient Intake — CONFIDENTIAL \/ PHI/);
  assert.match(text, /Zoë Zqlast/);
});

test("v2: font asset unreachable -> WinAnsi still exact, others marked, intake continues", async () => {
  const { bytes, text, review } = await v2Render({ ...PATIENT, insuredFirstName: "Łukasz", insuredLastName: "Müller" }, true);
  assert.equal(review.unicode_font, "unavailable");
  assert.match(text.replace(/\n/g, " "), /\[Cannot be shown exactly in this document \(accented Latin characters\)/);
  assert.doesNotMatch(text, /\?ukasz|Lukasz/);
  assert.match(text, /Policyholder \(insured\) date of birth\n1985-07-04/);
  await PDFDocument.load(bytes);
});

test("v2: WinAnsi-only documents embed no font (unchanged size class)", async () => {
  const { bytes, review } = await v2Render({ ...PATIENT, insuredFirstName: "José" });
  assert.equal(review.unicode_font, "not-needed");
  assert.doesNotMatch(bytes.toString("latin1"), /FontFile2/);
});

test("v2: long international names wrap across lines and pages", async () => {
  const long = "Łukasz-" + "Đặng-Nguyễn-".repeat(10) + "Zq";
  const { bytes, text } = await v2Render({ ...PATIENT, insuredFirstName: long });
  const joined = text.replace(/\n/g, "");
  assert.ok(joined.includes(long));
  assert.ok(!text.split("\n").includes(`${long} Zqlast`), "wrapped");
  await PDFDocument.load(bytes);
});

// ---- Legacy Jotform document ----------------------------------------------------

function jotform(extra: Json): Json {
  const raw = {
    q3_q3_dropdown1: "Seattle, WA", q4_q4_textbox2: "Zqpatient", q7_q7_textbox5: "Synthetic",
    q8_q8_datetime6: { month: "01", day: "15", year: "1990" }, q13_q13_email11: "s@example.invalid",
    q10_q10_phone8: { full: "(555) 000-0000" }, q31_q31_radio29: "Partner's Insurance",
    q32_q32_textbox30: "Zqplan", q33_q33_textbox31: "Z1", q34_q34_textbox32: "G1", ...extra,
  };
  return { body: { rawRequest: JSON.stringify(raw), submissionID: "zq-synthetic-1" } };
}

async function legacyRender(webhook: Json, fail = false) {
  const items = [{ json: webhook }];
  const [n] = new Function("items", LEGACY_NORMALIZE)(items);
  const refs: Record<string, Json> = { "Parse & Normalize": n.json, Webhook: webhook };
  const [o] = await new AsyncFunction("$input", "$", "Buffer", "$json", LEGACY_RENDER).call(ctx(fail),
    { first: () => ({ json: { patient_id: 1 } }) }, (name: string) => ({ first: () => ({ json: refs[name] }) }), Buffer, { patient_id: 1 });
  const bytes = Buffer.from(o.binary.pdf.data, "base64");
  return { bytes, text: pdfText(bytes), json: o.json, normalized: n.json };
}

test("legacy: Partner's -> policyholder name, DOB, employer rendered from q35-q38", async () => {
  const { text, normalized } = await legacyRender(jotform({
    q35_q35_fullname33: { first: "Zqsubfirst", last: "Zqsublast" }, q36_q36_textbox34: "",
    q37_q37_datetime35: { month: "07", day: "04", year: "1985" }, q38_q38_textbox36: "Zqemployer",
  }));
  assert.match(text, /Policy ownership: Partner's policy - the partner is the policyholder/);
  assert.match(text, /Policyholder \(insured\) name: Zqsubfirst Zqsublast/);
  assert.match(text, /Policyholder \(insured\) date of birth: 1985-07-04/);
  assert.match(text, /Policyholder \(insured\) employer: Zqemployer/);
  // Parse & Normalize output (and so the auto-mapped Sheets audit) is unchanged.
  assert.ok(!Object.keys(normalized).some((k) => /insured/.test(k)));
});

test("legacy: separate last-name answer wins; a conflict is flagged, not hidden", async () => {
  const { text } = await legacyRender(jotform({
    q35_q35_fullname33: { first: "Zqsubfirst", last: "Zqone" }, q36_q36_textbox34: "Zqtwo",
    q37_q37_datetime35: { month: "07", day: "04", year: "1985" },
  }));
  assert.match(text, /Policyholder \(insured\) name: Zqsubfirst Zqtwo/);
  assert.match(text, /Policyholder last name - check:/);
});

test("legacy: missing / invalid details are stated, never invented", async () => {
  const empty = await legacyRender(jotform({}));
  assert.match(empty.text, /Policyholder \(insured\) name: Not provided on the form/);
  assert.match(empty.text, /Policyholder \(insured\) date of birth: Not provided on the form/);
  const bad = await legacyRender(jotform({ q35_q35_fullname33: { first: "Zq", last: "Zq" }, q37_q37_datetime35: { month: "02", day: "30", year: "1985" } }));
  assert.match(bad.text, /date of birth: Not a valid date on the form - confirm with the patient/);
});

test("legacy: Both -> ownership explicitly NOT SPECIFIED, holder 'as entered'", async () => {
  const { text } = await legacyRender(jotform({
    q31_q31_radio29: "Both", q35_q35_fullname33: { first: "Zqsubfirst", last: "Zqsublast" },
    q37_q37_datetime35: { month: "07", day: "04", year: "1985" },
  }));
  assert.match(text, /Policy ownership: NOT SPECIFIED - this form collects one policy for "Both"/);
  assert.match(text, /Policyholder \(insured\) name - as entered: Zqsubfirst Zqsublast/);
});

test("legacy: Own / No Insurance -> no policyholder rows (fields are hidden there)", async () => {
  for (const cov of ["Own Insurance", "No Insurance"]) {
    const { text } = await legacyRender(jotform({ q31_q31_radio29: cov, q35_q35_fullname33: { first: "Zqstale", last: "Zqstale" } }));
    assert.doesNotMatch(text, /Policyholder|Zqstale|Policy ownership/, cov);
  }
});

test("legacy: international names exact; Ł no longer corrupted to another letter", async () => {
  for (const name of [...EXACT, ...NOT_DISPLAYABLE]) {
    const { bytes, text, json } = await legacyRender(jotform({
      q4_q4_textbox2: name, q35_q35_fullname33: { first: name, last: "Zqlast" },
      q37_q37_datetime35: { month: "07", day: "04", year: "1985" },
    }));
    const review = json.pdf_review as { unrenderable_fields: string[]; leaked: number };
    if (EXACT.includes(name)) {
      assert.match(text, new RegExp(`Full Name: ${name} Synthetic`));
      assert.match(text, new RegExp(`Policyholder \\(insured\\) name: ${name} Zqlast`));
    } else {
      assert.match(text, /Review needed/);
      assert.ok(review.unrenderable_fields.includes("Full Name"));
      assert.match(text, /\[Cannot be shown exactly in this document/);
    }
    assert.doesNotMatch(text, /�/);
    assert.equal(review.leaked, 0);
    await PDFDocument.load(bytes);
  }
});

// ---- console PDF (app) -------------------------------------------------------------

function submissionRow(first: string, last: string, insured: string) {
  return {
    id: "00000000-0000-4000-8000-00000000abcd", formType: "registration", firstName: first, lastName: last,
    email: "s@example.invalid", phone: "5550000000", dateOfBirth: "1990-01-01", createdAt: new Date("2026-09-23T12:00:00Z"),
    rawPayload: { insuranceCoverage: "Partner's Insurance", insuranceCompany: "Zqplan", insuredFirstName: insured, insuredLastName: "Zqlast", insuredDob: "1985-07-04" },
  } as never;
}

function pdftotext(bytes: Uint8Array): string | null {
  const dir = mkdtempSync(join(tmpdir(), "zq-pdf-"));
  const file = join(dir, "doc.pdf");
  try {
    writeFileSync(file, bytes);
    return execFileSync("pdftotext", ["-enc", "UTF-8", file, "-"], { timeout: 20000 }).toString();
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("console PDF: international names no longer crash generation; exact where supported", async (t) => {
  let checked = 0;
  for (const name of [...EXACT, ...NOT_DISPLAYABLE]) {
    const bytes = await generateSubmissionPdf(submissionRow(name, "Synthetic", name));
    await PDFDocument.load(bytes);
    const text = pdftotext(bytes);
    if (text === null) continue;
    checked++;
    if (EXACT.includes(name)) assert.ok(text.includes(`${name} Synthetic`), `${name} header`);
    else {
      assert.ok(text.includes("Cannot be shown exactly in this document"), name);
      assert.ok(text.includes("Review needed"), name);
    }
  }
  if (checked === 0) t.diagnostic("pdftotext not installed: generation + validity checked, text not extracted");
});
