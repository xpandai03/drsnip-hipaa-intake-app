// Seed a single READ-ONLY viewer account (Phase 4 Block D, D.5) so staff can
// be given limited, read-only access to the admin console — e.g. for Jeff to
// demo the viewer flow.
//
// Mirrors seed-admin-users.ts: idempotent (skip if the email already exists,
// NEVER overwrite an existing password), password supplied via env (not a CLI
// arg — args leak to shell history), and the script never logs the password.
//
// The created account has role = 'viewer', so it is blocked SERVER-SIDE from
// delete / CSV export / link generation (see api/_lib/permissions.ts).
//
// Usage (run manually — NOT part of the deploy migrate step):
//   DATABASE_URL=postgres://... \
//   VIEWER_EMAIL=viewer@drsnip.com \         # optional, defaults to viewer@drsnip.com
//   VIEWER_NAME='DrSnip Viewer' \            # optional
//   VIEWER_PASSWORD='<temp 12+ char password>' \
//   pnpm --filter @workspace/scripts seed-viewer-user
//
// To rotate the password, delete the row in SQL first, then re-run.

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, pool, users } from "@workspace/db";

const BCRYPT_COST = 10;

async function main() {
  const email = (process.env.VIEWER_EMAIL ?? "viewer@drsnip.com")
    .trim()
    .toLowerCase();
  const name = (process.env.VIEWER_NAME ?? "DrSnip Viewer").trim();
  const password = process.env.VIEWER_PASSWORD;

  if (!password) {
    console.error(
      "VIEWER_PASSWORD env var is required (12+ chars). Refusing to seed a " +
        "viewer with no/blank password. Do NOT pass it as a CLI arg.",
    );
    process.exit(1);
  }
  if (password.length < 12) {
    console.error(
      `VIEWER_PASSWORD too short (${password.length} chars). Use 12+ chars; ` +
        "do NOT log this value.",
    );
    process.exit(1);
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    console.log(`${email}: already exists, skipped (password unchanged).`);
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await db
    .insert(users)
    .values({ email, name, passwordHash, role: "viewer" });
  console.log(`${email}: inserted as role=viewer (name=${JSON.stringify(name)}).`);

  await pool.end();
}

main().catch((err) => {
  // Never echo the password if it spilled into an error message.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
