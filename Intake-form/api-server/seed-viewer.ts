// Phase 4 Block E — viewer-account seed as a bundled release artifact.
//
// Bundled to dist/seed-viewer.cjs the SAME way as dist/migrate.cjs (esbuild,
// self-contained, no tsx / node_modules at runtime). It runs as part of the Fly
// release_command, AFTER `node dist/migrate.cjs`, so the users.role column
// (migration 0007) already exists. It reaches Postgres over Flycast via the
// DATABASE_URL the release machine already has — no WireGuard tunnel needed.
//
// Behavior (in order):
//   1. BREACH-CHECK: print every console user's email/role/is_active to stdout
//      BEFORE any write, so the rows are visible in `fly logs` / the deploy
//      output. This is the visible audit the operator reads.
//   2. GUARDED IDEMPOTENT SEED of viewer@drsnip.com:
//        - skips entirely if any EXISTING user is non-admin (defense-in-depth:
//          migration 0007 must have defaulted existing users to admin);
//        - ON CONFLICT (email) DO NOTHING — never double-inserts, never
//          overwrites an existing password.
//
// Non-destructive and idempotent → safe to leave in the release chain on every
// future deploy (it mirrors the existing seed-admin step that already runs on
// every deploy).
//
// Env:
//   DATABASE_URL    — provided to the release machine by Fly.
//   VIEWER_PASSWORD — Fly secret (>= 12 chars). If unset/short, the seed is
//                     SKIPPED cleanly (breach-check still prints, deploy still
//                     succeeds) so a deploy never fails for lack of it.
//
// HIPAA: never logs the password or any PHI. It logs console-staff account
// emails + roles only (admin/viewer identities, not patient data).

import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";

const BCRYPT_COST = 10;
const VIEWER_EMAIL = "viewer@drsnip.com";
const VIEWER_NAME = "DrSnip Viewer";

async function main(): Promise<void> {
  // ---- 1. Breach-check — print BEFORE any write ------------------------
  const before = await pool.query(
    "SELECT email, role, is_active FROM users ORDER BY created_at",
  );
  console.log(
    `[seed-viewer] breach-check — ${before.rows.length} console user(s):`,
  );
  for (const r of before.rows) {
    console.log(
      `[seed-viewer]   ${r.email} | role=${r.role} | is_active=${r.is_active}`,
    );
  }

  // Any existing user that is NOT admin (excluding the viewer we manage) means
  // migration 0007's default-to-admin did not hold — do NOT seed; surface it.
  const nonAdmin = before.rows.filter(
    (r: { email: string; role: string }) =>
      r.role !== "admin" && r.email !== VIEWER_EMAIL,
  );
  if (nonAdmin.length > 0) {
    console.error(
      `[seed-viewer] ABORT seed: ${nonAdmin.length} existing non-admin user(s) ` +
        `present (${nonAdmin
          .map((r: { email: string }) => r.email)
          .join(", ")}). Investigate migration 0007 before seeding.`,
    );
    // Non-destructive: exit 0 so the app deploy still succeeds; just don't seed.
    await pool.end();
    return;
  }

  // ---- 2. Guarded idempotent seed --------------------------------------
  const password = process.env.VIEWER_PASSWORD;
  if (!password || password.length < 12) {
    console.log(
      "[seed-viewer] VIEWER_PASSWORD unset or <12 chars — skipping seed " +
        "(breach-check above still ran). Set the secret and redeploy to seed.",
    );
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const res = await pool.query(
    `INSERT INTO users (email, password_hash, name, role, is_active)
     SELECT $1, $2, $3, 'viewer', true
     WHERE NOT EXISTS (
       SELECT 1 FROM users WHERE role <> 'admin' AND email <> $1
     )
     ON CONFLICT (email) DO NOTHING`,
    [VIEWER_EMAIL, passwordHash, VIEWER_NAME],
  );
  console.log(
    (res.rowCount ?? 0) > 0
      ? `[seed-viewer] inserted ${VIEWER_EMAIL} as role=viewer.`
      : `[seed-viewer] ${VIEWER_EMAIL} already present — no insert (idempotent).`,
  );

  const after = await pool.query(
    "SELECT email, role, is_active FROM users WHERE email = $1",
    [VIEWER_EMAIL],
  );
  const v = after.rows[0];
  if (v) {
    console.log(
      `[seed-viewer] viewer row: ${v.email} | role=${v.role} | is_active=${v.is_active}`,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error(
    "[seed-viewer] FAILED:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
