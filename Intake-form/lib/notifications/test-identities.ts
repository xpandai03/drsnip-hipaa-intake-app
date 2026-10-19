// Test identities — the rows engineers create on purpose.
//
// The documented recipe (FINDINGS-submission-health.md Appendix A; the smoke
// recipes in the agent notes): an @xpandai.com email, or a name containing
// "Qaignore", "Tester" or "Smoke". These rows are real in the database and the
// EHR, but they are not patients, and the operator digest must not count them.
//
// One SQL predicate, written against a `submissions` row aliased `s`, plus a
// TypeScript mirror so the recipe is unit-tested. They must stay identical.

export const TEST_EMAIL_DOMAIN = "@xpandai.com";
export const TEST_NAME_PATTERN = "(qaignore|tester|smoke)";

/** SQL: true when the `submissions` row aliased `s` is a test identity. */
export const TEST_IDENTITY_SQL =
  `(s.email ILIKE '%${TEST_EMAIL_DOMAIN}' OR (s.first_name || ' ' || s.last_name) ~* '${TEST_NAME_PATTERN}')`;

export function isTestIdentity(row: { email?: string | null; firstName?: string | null; lastName?: string | null }): boolean {
  const email = String(row.email ?? "").toLowerCase();
  const name = `${row.firstName ?? ""} ${row.lastName ?? ""}`;
  return email.endsWith(TEST_EMAIL_DOMAIN) || new RegExp(TEST_NAME_PATTERN, "i").test(name);
}
