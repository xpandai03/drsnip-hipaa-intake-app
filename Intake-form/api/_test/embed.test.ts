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
  ATTRIBUTION_MAX_LEN,
  ATTRIBUTION_PARAMS,
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

describe("iframeSnippet — attribution forwarding + no third-party scripts", () => {
  const insurance = EMBED_FORMS.find((f) => f.key === "insurance")!;
  const registration = EMBED_FORMS.find((f) => f.key === "registration")!;

  it("ships the iframe WITHOUT src so the script assigns it pre-load", () => {
    // A src on the element plus a script that rewrites it later = two loads,
    // and a late rewrite would reload a partially filled form.
    const s = iframeSnippet(insurance, "cost-insurance-page");
    assert.ok(s.includes("<iframe"));
    assert.equal(/<iframe[^>]*\ssrc=/.test(s), false, "iframe must ship with no src");
    assert.ok(s.includes("el.src = FORM_URL"), "script assigns the src");
    assert.ok(s.includes("min-width: 100%"));
  });

  it("forwards ONLY the eight campaign params the form reads", () => {
    const s = iframeSnippet(insurance, "cost-insurance-page");
    for (const k of ATTRIBUTION_PARAMS) {
      assert.ok(s.includes(`"${k}"`), `snippet should forward ${k}`);
    }
    assert.equal(ATTRIBUTION_PARAMS.length, 8);
  });

  it("never forwards the page URL, referrer, or an arbitrary passthrough", () => {
    for (const form of EMBED_FORMS) {
      const s = iframeSnippet(form, "x");
      assert.equal(s.includes("document.referrer"), false, "referrer must not travel");
      assert.equal(s.includes("window.location.href"), false, "page URL must not travel");
      assert.equal(s.includes("location.pathname"), false);
      // Only the search string is read, and only through the allowlist loop.
      assert.ok(s.includes("window.location.search"));
      assert.ok(s.includes("for (var i = 0; i < KEYS.length"));
    }
  });

  it("a campaign ?source= wins over the placement default", () => {
    const s = iframeSnippet(insurance, "cost-insurance-page");
    assert.ok(
      s.includes('if (!out.get("source") && DEFAULT_SOURCE) out.set("source", DEFAULT_SOURCE)'),
      "default fills in only when the visitor arrived untagged",
    );
    assert.ok(s.includes('"cost-insurance-page"'));
  });

  it("produces a clean URL when nothing is tagged — no trailing ? and no undefined", () => {
    const s = iframeSnippet(registration, "");
    assert.ok(s.includes('(qs ? "?" + qs : "")'), "no trailing ? when empty");
    assert.equal(s.includes("undefined"), false);
    // Empty values are skipped rather than forwarded as blanks.
    assert.ok(s.includes("if (v) out.set(KEYS[i], v)"));
  });

  it("values are length-capped, matching the form's own reader", () => {
    const s = iframeSnippet(insurance, "x");
    assert.ok(s.includes(`slice(0, ${ATTRIBUTION_MAX_LEN})`));
  });

  it("insurance keeps its origin-locked auto-height listener alongside forwarding", () => {
    const s = iframeSnippet(insurance);
    assert.ok(s.includes("drsnip:height"));
    assert.ok(s.includes("e.origin !== BASE_ORIGIN"), "listener stays origin-locked");
    assert.ok(s.includes("el.src = FORM_URL"), "and forwarding still happens");
  });

  it("registration/consultation forward attribution but carry no height listener", () => {
    for (const f of [registration, EMBED_FORMS.find((x) => x.key === "consultation")!]) {
      const s = iframeSnippet(f);
      assert.ok(s.includes("el.src = FORM_URL"), `${f.key} should forward`);
      assert.equal(s.includes("drsnip:height"), false, `${f.key} posts no height yet`);
    }
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
        "<script src",
      ]) {
        assert.ok(!s.includes(bad), `${form.key} snippet must not contain ${bad}`);
      }
    }
  });
});
