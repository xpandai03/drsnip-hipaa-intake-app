// Phase 5 Block 1 — password policy + temp-credential generation. PURE: no DB,
// no IO beyond node:crypto, so it is unit-testable in isolation (see
// api/_test/password.test.ts), exactly like api/_lib/permissions.ts.
//
// The HTTP handlers (api/admin/reset-password, api/auth/change-password) consume
// these; they own the DB writes. Keeping policy here makes the rules greppable
// and the tests read as a spec.

import { randomBytes } from "node:crypto";

// Policy (Q2, approved): length over composition. Min 12 for an admin/medical
// tool; max mirrors the login handler's bound (api/auth/login.ts) so a reset
// can never set a password that login would reject as too long.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

export type PasswordValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a candidate password against the policy. Pure. The error strings
 * are safe to return to an authenticated user setting their own password
 * (api/auth/change-password) — they describe the rule, never reveal anything
 * about other accounts.
 */
export function validatePassword(pw: unknown): PasswordValidation {
  if (typeof pw !== "string") {
    return { ok: false, error: "Password is required" };
  }
  if (pw.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    };
  }
  if (pw.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    };
  }
  return { ok: true };
}

// Unambiguous alphabet for the admin-issued temp password: no 0/O/1/l/I so the
// admin can read it aloud / paste it without transcription errors. 20 chars
// from a 58-symbol alphabet ≈ 117 bits of entropy — far above the 12-char
// minimum, and it is single-use (the must_reset_password flag forces a change).
const TEMP_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const TEMP_PASSWORD_LENGTH = 20;

/**
 * Generate a strong, single-use temporary password. Uses rejection sampling
 * over crypto.randomBytes so the alphabet distribution is unbiased (no modulo
 * skew). The result always satisfies validatePassword().
 */
export function generateTempPassword(): string {
  const out: string[] = [];
  const max = Math.floor(256 / TEMP_ALPHABET.length) * TEMP_ALPHABET.length;
  while (out.length < TEMP_PASSWORD_LENGTH) {
    for (const byte of randomBytes(TEMP_PASSWORD_LENGTH)) {
      if (byte < max) {
        out.push(TEMP_ALPHABET[byte % TEMP_ALPHABET.length]);
        if (out.length === TEMP_PASSWORD_LENGTH) break;
      }
    }
  }
  return out.join("");
}

/**
 * The "login-path check" (Q8): given a user row, does the app need to force a
 * password change before letting them proceed? Pure predicate so login/me can
 * surface it and tests can assert it with no DB.
 */
export function requiresPasswordReset(user: {
  mustResetPassword: boolean;
}): boolean {
  return user.mustResetPassword === true;
}
