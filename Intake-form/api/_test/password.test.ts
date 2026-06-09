// Phase 5 Block 1 — password policy + temp-credential + login-check unit tests.
// DB-FREE: api/_lib/password.ts is pure (node:crypto only), so these run with
// no live DB, exactly like permissions.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  TEMP_PASSWORD_LENGTH,
  generateTempPassword,
  requiresPasswordReset,
  validatePassword,
} from "../_lib/password";

// ---- validatePassword: length-over-composition policy ---------------------

test("validatePassword rejects non-strings", () => {
  assert.equal(validatePassword(undefined).ok, false);
  assert.equal(validatePassword(null).ok, false);
  assert.equal(validatePassword(12345678901234).ok, false);
});

test("validatePassword enforces the minimum length boundary", () => {
  const tooShort = "a".repeat(PASSWORD_MIN_LENGTH - 1);
  const justRight = "a".repeat(PASSWORD_MIN_LENGTH);
  assert.equal(validatePassword(tooShort).ok, false);
  assert.equal(validatePassword(justRight).ok, true);
});

test("validatePassword enforces the maximum length boundary", () => {
  const justRight = "a".repeat(PASSWORD_MAX_LENGTH);
  const tooLong = "a".repeat(PASSWORD_MAX_LENGTH + 1);
  assert.equal(validatePassword(justRight).ok, true);
  assert.equal(validatePassword(tooLong).ok, false);
});

// ---- generateTempPassword: strong + always policy-valid -------------------

test("generateTempPassword is the expected length and passes the policy", () => {
  for (let i = 0; i < 50; i++) {
    const pw = generateTempPassword();
    assert.equal(pw.length, TEMP_PASSWORD_LENGTH);
    assert.equal(validatePassword(pw).ok, true, `temp pw failed policy: ${pw}`);
  }
});

test("generateTempPassword avoids ambiguous characters (0/O/1/l/I)", () => {
  for (let i = 0; i < 50; i++) {
    assert.doesNotMatch(generateTempPassword(), /[0O1lI]/);
  }
});

test("generateTempPassword is non-deterministic across calls", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) seen.add(generateTempPassword());
  // 100 draws from ~117 bits of entropy must not collide.
  assert.equal(seen.size, 100);
});

// ---- requiresPasswordReset: the login-path check (no DB) ------------------

test("requiresPasswordReset reflects the user flag", () => {
  assert.equal(requiresPasswordReset({ mustResetPassword: true }), true);
  assert.equal(requiresPasswordReset({ mustResetPassword: false }), false);
});
