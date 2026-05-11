// Seed the `settings` table with v1 defaults. Idempotent — uses ON CONFLICT
// DO NOTHING so re-running won't overwrite values an admin has changed via
// the Settings tab.
//
// Run with:
//   DATABASE_URL=postgres://... pnpm --filter @workspace/scripts seed-settings

import { db, pool, settings } from "@workspace/db";
import { sql } from "drizzle-orm";

const SEED_ACTOR = "system:sprint-0-seed";

// Keys & defaults match PLAN_PHASE_2.md §6 Sprint 4. `days_out_gate` is
// intentionally absent (cut from v1; Phase 3 candidate — see Resolved Q4).
const DEFAULTS: Array<{ key: string; value: unknown }> = [
  { key: "a7_valve", value: true },                  // ON by default → A-7 leads route normally
  { key: "kill_switch", value: false },              // OFF → submissions accepted
  { key: "channel_federal_paused", value: false },
  { key: "channel_internal_paused", value: false },
  { key: "channel_fnn_paused", value: false },
];

async function main() {
  console.log(`Seeding ${DEFAULTS.length} settings rows…`);
  for (const row of DEFAULTS) {
    const result = await db
      .insert(settings)
      .values({ key: row.key, value: row.value, updatedBy: SEED_ACTOR })
      .onConflictDoNothing({ target: settings.key })
      .returning();
    if (result.length === 0) {
      console.log(`  ${row.key}: already present, skipped`);
    } else {
      console.log(`  ${row.key}: inserted with default ${JSON.stringify(row.value)}`);
    }
  }

  // Quick sanity read.
  const rows = await db.execute(sql`SELECT key, value FROM settings ORDER BY key`);
  console.log("\nCurrent settings:");
  for (const r of rows.rows) {
    console.log(`  ${r.key} = ${JSON.stringify(r.value)}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
