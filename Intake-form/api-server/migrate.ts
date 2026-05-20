// Migration + admin-seed runner — executed as the Fly `release_command` on
// every deploy (see fly.toml [deploy]). It runs inside Fly's network, so it
// reaches Postgres over the private `.flycast` address with no WireGuard
// tunnel needed.
//
// The four migration SQL files + the admin seed are inlined at bundle time
// (esbuild `.sql` text loader), so dist/migrate.cjs is fully self-contained.
//
// Every migration is idempotent (CREATE ... IF NOT EXISTS / ALTER ... IF
// EXISTS / DROP ... IF EXISTS) and the admin seed is ON CONFLICT DO NOTHING,
// so re-running on every deploy is safe.
//
// HIPAA: logs migration step names + error messages only — never PHI.
//
// (`.sql` imports are typed by api-server/sql-modules.d.ts.)

import { pool } from "@workspace/db";
import coreTables from "../lib/db/migrations/0000_core_tables.sql";
import appointmentSyncEvents from "../lib/db/migrations/0001_appointment_sync_events.sql";
import marketingSources from "../lib/db/migrations/0002_marketing_sources.sql";
import drsnipSchema from "../lib/db/migrations/0003_drsnip_schema.sql";
import seedAdmin from "../scripts/seed-admin.sql";

const STEPS: Array<{ name: string; sql: string }> = [
  { name: "0000_core_tables", sql: coreTables },
  { name: "0001_appointment_sync_events", sql: appointmentSyncEvents },
  { name: "0002_marketing_sources", sql: marketingSources },
  { name: "0003_drsnip_schema", sql: drsnipSchema },
  { name: "seed-admin", sql: seedAdmin },
];

async function main(): Promise<void> {
  for (const step of STEPS) {
    console.log(`[migrate] applying ${step.name}`);
    await pool.query(step.sql);
  }
  console.log("[migrate] all migrations + admin seed applied successfully");
  await pool.end();
}

main().catch((err) => {
  console.error(
    "[migrate] FAILED:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
