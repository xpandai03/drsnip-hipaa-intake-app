// Conversion signal — the PII-free { event, form_type } postMessage the
// marketing agency's GTM container listens for.
//
// The payload whitelist is the whole safety property: this message crosses an
// origin boundary onto a WordPress page the practice does not control, so
// anything that leaked into it would leave the PHI boundary entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONVERSION_EVENT,
  buildConversionMessage,
  shouldPostConversion,
} from "../../artifacts/intake-form/src/lib/conversion";

test("payload is EXACTLY { event, form_type } — no other key can appear", () => {
  for (const form of ["registration", "consultation", "insurance"]) {
    const msg = buildConversionMessage(form);
    assert.deepEqual(Object.keys(msg).sort(), ["event", "form_type"]);
    assert.equal(msg.event, CONVERSION_EVENT);
    assert.equal(msg.form_type, form);
  }
});

test("the builder is structurally incapable of leaking PHI", () => {
  // It takes one string and returns two. There is no object spread, no body,
  // no URL — so a future edit that tried to add a field would have to change
  // this signature, and this assertion.
  assert.equal(buildConversionMessage.length, 1, "takes exactly one argument");
  const msg = JSON.stringify(buildConversionMessage("registration"));
  for (const forbidden of [
    "name", "email", "phone", "dob", "birth", "address", "carrier",
    "policy", "group", "subscriber", "submission", "patient", "cookie", "url",
  ]) {
    assert.equal(
      msg.toLowerCase().includes(forbidden),
      false,
      `payload leaked "${forbidden}"`,
    );
  }
});

test("nothing fires unless BOTH enabled and embedded", () => {
  assert.equal(shouldPostConversion(false, false), false);
  assert.equal(shouldPostConversion(true, false), false, "not embedded => silent");
  assert.equal(shouldPostConversion(false, true), false, "flag off => silent");
  assert.equal(shouldPostConversion(true, true), true);
});

// ---- Call sites: fire once, on confirmed success only ---------------------

const PAGES: Array<[string, string]> = [
  ["artifacts/intake-form/src/pages/Home.tsx", "registration"],
  ["artifacts/intake-form/src/pages/Consultation.tsx", "consultation"],
  ["artifacts/intake-form/src/pages/Insurance.tsx", "insurance"],
];

test("all three forms call postConversion, exactly once, with their own form_type", () => {
  for (const [rel, form] of PAGES) {
    const src = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
    const calls = src.match(/postConversion\(/g) ?? [];
    assert.equal(calls.length, 1, `${rel} should call postConversion exactly once`);
    assert.ok(
      src.includes(`postConversion("${form}")`),
      `${rel} should report form_type "${form}"`,
    );
  }
});

test("the call is gated on success — never on a failed or errored submit", () => {
  for (const [rel] of PAGES.slice(0, 2)) {
    const src = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
    // The wizard forms compute `ok` from the response and only then report.
    assert.ok(
      /if \(ok\) postConversion\(/.test(src),
      `${rel} must guard the call on the success flag`,
    );
    // The catch branch returns false without reporting anything.
    assert.ok(
      /catch \{[\s\S]*?return false;/.test(src),
      `${rel} error path must return false without reporting`,
    );
  }
});

test("conversion ships OFF: the flag is build-time and defaults absent", () => {
  const df = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.ok(
    df.includes("ARG VITE_CONVERSION_TRACKING_ENABLED"),
    "Dockerfile must accept the build ARG",
  );
  // No default value => absent => Vite folds the branch away.
  assert.equal(
    /ARG VITE_CONVERSION_TRACKING_ENABLED=/.test(df),
    false,
    "the ARG must not carry a default that silently enables tracking",
  );
});
