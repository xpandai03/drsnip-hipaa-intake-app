// Tests for the Plano clinic literal + the embed snippet builders.
//
//   • Plano drift guard: the insurance form's clinic value MUST equal the
//     registration form's Plano literal character-for-character, or the
//     dashboard office-split tile forks the data. This reads both source files
//     and fails if they drift — without importing the React components or
//     modifying the registration form.
//   • embed builders: URL source tagging (with/without), snippet shape, and the
//     no-third-party-script guarantee (iframe only).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formUrl,
  iframeSnippet,
  EMBED_FORMS,
  INTAKE_BASE,
} from "../../artifacts/intake-form/src/lib/embed";

function officeLocations(relPath: string): string[] {
  const src = readFileSync(new URL(relPath, import.meta.url), "utf8");
  const m = src.match(/const OFFICE_LOCATIONS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, `OFFICE_LOCATIONS not found in ${relPath}`);
  return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("Plano clinic literal — no drift between forms", () => {
  const reg = officeLocations("../../artifacts/intake-form/src/pages/Home.tsx");
  const ins = officeLocations(
    "../../artifacts/intake-form/src/pages/Insurance.tsx",
  );

  it("registration defines Plano as 'Plano, TX'", () => {
    assert.ok(reg.includes("Plano, TX"), `registration clinics: ${reg}`);
  });

  it("insurance now offers Plano with the identical literal", () => {
    assert.ok(ins.includes("Plano, TX"), `insurance clinics: ${ins}`);
    const regPlano = reg.find((c) => c.startsWith("Plano"));
    const insPlano = ins.find((c) => c.startsWith("Plano"));
    assert.equal(insPlano, regPlano); // fails on any spelling drift
  });

  it("insurance clinic values are all a subset of registration's", () => {
    for (const c of ins) {
      assert.ok(reg.includes(c), `insurance value '${c}' not in registration set`);
    }
  });
});

describe("formUrl — source tagging", () => {
  it("bare URL when no source", () => {
    assert.equal(formUrl("/insurance"), `${INTAKE_BASE}/insurance`);
    assert.equal(formUrl("/insurance", ""), `${INTAKE_BASE}/insurance`);
    assert.equal(formUrl("/insurance", "  "), `${INTAKE_BASE}/insurance`);
  });
  it("appends ?source=<key> when tagged", () => {
    assert.equal(
      formUrl("/insurance", "cost-insurance-page"),
      `${INTAKE_BASE}/insurance?source=cost-insurance-page`,
    );
    assert.equal(formUrl("/", "google"), `${INTAKE_BASE}/?source=google`);
  });
  it("uses & when the path already has a query", () => {
    assert.equal(
      formUrl("/x?a=1", "google"),
      `${INTAKE_BASE}/x?a=1&source=google`,
    );
  });
  it("encodes the source key", () => {
    assert.ok(formUrl("/", "a b&c").endsWith("source=a%20b%26c"));
  });
});

describe("iframeSnippet — shape + no third-party scripts", () => {
  const insurance = EMBED_FORMS.find((f) => f.key === "insurance")!;
  const registration = EMBED_FORMS.find((f) => f.key === "registration")!;

  it("embeds the correct (optionally tagged) src", () => {
    const s = iframeSnippet(insurance, "cost-insurance-page");
    assert.ok(s.includes(`src="${INTAKE_BASE}/insurance?source=cost-insurance-page"`));
    assert.ok(s.includes("<iframe"));
    assert.ok(s.includes("min-width: 100%"));
  });

  it("insurance includes the origin-locked auto-height listener", () => {
    const s = iframeSnippet(insurance);
    assert.ok(s.includes("drsnip:height"));
    assert.ok(s.includes(`e.origin !== "${INTAKE_BASE}"`) || s.includes("ALLOWED_ORIGIN"));
  });

  it("registration/consultation are plain iframes (no script)", () => {
    const s = iframeSnippet(registration);
    assert.ok(!s.includes("<script"));
  });

  it("NEVER injects a third-party tag manager / analytics script", () => {
    for (const form of EMBED_FORMS) {
      const s = iframeSnippet(form, "google").toLowerCase();
      for (const bad of [
        "googletagmanager",
        "gtm.js",
        "gtag",
        "tracking.intrepy",
        "connect.facebook",
        "google-analytics.com",
      ]) {
        assert.ok(!s.includes(bad), `${form.key} snippet must not contain ${bad}`);
      }
    }
  });
});
