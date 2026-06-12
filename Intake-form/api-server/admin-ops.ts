// One-shot, env-guarded console-user operations — bundled to dist/admin-ops.cjs
// (esbuild, self-contained) and run via the Fly release_command, AFTER
// dist/migrate.cjs (so the users.role column from migration 0007 exists). It
// reaches Postgres over Flycast via the DATABASE_URL the release machine
// already has — no WireGuard tunnel needed (the pattern that works under flaky
// WireGuard).
//
// Each block is independently GUARDED by its env vars and no-ops cleanly when
// they are unset, so this is safe in the release chain (a deploy never fails
// for lack of them). Idempotent.
//
//   ADMIN_RESET_EMAIL + ADMIN_RESET_PASSWORD [+ ADMIN_RESET_NAME]
//     → UPSERT that user as an admin and (re)set its password + is_active=true.
//       Recovers a locked-out admin after a DB cutover. ON CONFLICT updates the
//       hash + reactivates; it does NOT change an existing user's role.
//
//   PATIENTMAIL_VIEWER_EMAIL + PATIENTMAIL_VIEWER_PASSWORD [+ PATIENTMAIL_VIEWER_NAME]
//     → INSERT that user as role=viewer, ON CONFLICT (email) DO NOTHING — never
//       overwrites an existing row's password (idempotent).
//
// A password block is SKIPPED if its password is < 12 chars.
//
// HIPAA: never logs a password or any PHI. It logs console-staff account
// emails / roles / is_active only (admin & viewer identities, not patient data).

import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";

const BCRYPT_COST = 10;

function norm(email: string | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

async function printUsers(label: string): Promise<void> {
  const r = await pool.query(
    "SELECT email, role, is_active FROM users ORDER BY created_at",
  );
  console.log(`[admin-ops] ${label} — ${r.rows.length} console user(s):`);
  for (const u of r.rows) {
    console.log(
      `[admin-ops]   ${u.email} | role=${u.role} | is_active=${u.is_active}`,
    );
  }
}

async function resetAdmin(): Promise<void> {
  const email = norm(process.env.ADMIN_RESET_EMAIL);
  const password = process.env.ADMIN_RESET_PASSWORD ?? "";
  const name = (process.env.ADMIN_RESET_NAME ?? "DrSnip Admin").trim();
  if (!email) {
    console.log("[admin-ops] ADMIN_RESET_EMAIL unset — skipping admin reset.");
    return;
  }
  if (password.length < 12) {
    console.log(
      "[admin-ops] ADMIN_RESET_PASSWORD unset/<12 chars — skipping admin reset.",
    );
    return;
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const res = await pool.query(
    `INSERT INTO users (email, password_hash, name, role, is_active)
     VALUES ($1, $2, $3, 'admin', true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, is_active = true`,
    [email, passwordHash, name],
  );
  console.log(
    `[admin-ops] admin password reset applied for ${email} (rows=${res.rowCount}). Password NOT logged.`,
  );
}

async function seedPatientmailViewer(): Promise<void> {
  const email = norm(process.env.PATIENTMAIL_VIEWER_EMAIL);
  const password = process.env.PATIENTMAIL_VIEWER_PASSWORD ?? "";
  const name = (
    process.env.PATIENTMAIL_VIEWER_NAME ?? "DrSnip Patientmail (viewer)"
  ).trim();
  if (!email) {
    console.log(
      "[admin-ops] PATIENTMAIL_VIEWER_EMAIL unset — skipping viewer seed.",
    );
    return;
  }
  if (password.length < 12) {
    console.log(
      "[admin-ops] PATIENTMAIL_VIEWER_PASSWORD unset/<12 chars — skipping viewer seed.",
    );
    return;
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const res = await pool.query(
    `INSERT INTO users (email, password_hash, name, role, is_active)
     VALUES ($1, $2, $3, 'viewer', true)
     ON CONFLICT (email) DO NOTHING`,
    [email, passwordHash, name],
  );
  console.log(
    (res.rowCount ?? 0) > 0
      ? `[admin-ops] inserted ${email} as role=viewer.`
      : `[admin-ops] ${email} already present — no change (idempotent, password unchanged).`,
  );
  const a = await pool.query(
    "SELECT email, role, is_active FROM users WHERE email = $1",
    [email],
  );
  if (a.rows[0]) {
    console.log(
      `[admin-ops] viewer row: ${a.rows[0].email} | role=${a.rows[0].role} | is_active=${a.rows[0].is_active}`,
    );
  }
}

async function main(): Promise<void> {
  await printUsers("before");
  await resetAdmin();
  await seedPatientmailViewer();
  await printUsers("after");
  await pool.end();
}

main().catch((err) => {
  console.error(
    "[admin-ops] FAILED:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
