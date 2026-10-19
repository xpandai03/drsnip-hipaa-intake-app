// One appointment-data cutoff (migration 0022) — regression tests.
//
// The defect: every appointment-based report took its "complete to" instant as
// greatest(max(per-patient catch-up), incremental watermark). One patient's read
// was applied to everyone, and a stalled hourly sync was hidden while the
// 10-minute catch-up kept moving the cutoff. These tests pin the rule that
// replaced it, and that every reporting path now uses the same instant.
//
// SKIPPED unless CUTOFF_TEST_DATABASE_URL (owner) and CUTOFF_TEST_RO_URL (the
// restricted reporting role) point at a DISPOSABLE database with migrations
// through 0022. The suite owns its database: it clears the sync state it needs.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { isStale } from "../../artifacts/intake-form/src/pages/admin/outcomes-view";

const require_ = createRequire(import.meta.url);
const OWNER = process.env.CUTOFF_TEST_DATABASE_URL;
const RO = process.env.CUTOFF_TEST_RO_URL;
const live = Boolean(OWNER && RO && !/fly\.dev|flycast|drsnip-intake-db/.test(OWNER + RO));
function loadPg() {
  const e = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(e)] }));
}
const MIGRATION = readFileSync(new URL("../../lib/db/migrations/0022_one_evidence_cutoff.sql", import.meta.url), "utf8");

describe("0022 source", () => {
  it("defines one cutoff, and no caller keeps the max(catch-up) rule", () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.drsnip_evidence_cutoff\(\)/);
    assert.ok(!/max\(w\.completed_at\)/.test(MIGRATION), "the old max(completed_at) rule survives");
    for (const f of ["drsnip_journey_freshness", "drsnip_booking_metric", "drsnip_attendance_evidence",
                     "drsnip_outcome_classify", "drsnip_outcome_metric"]) {
      assert.match(MIGRATION, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${f}\\(`), f);
    }
  });

  it("falls back only to the EARLIEST history read, never the latest", () => {
    assert.match(MIGRATION, /min\(x\.completed_at\)/);
  });

  it("changes no definition, scope, rule or approval", () => {
    const code = MIGRATION.replace(/--.*$/gm, "");
    for (const t of ["outcome_reporting_scopes", "outcome_status_rules", "appointment_profile_catalog",
                     "attendance_mappings"]) {
      assert.ok(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+(public\\.)?${t}`).test(code), `${t} is written`);
    }
  });
});

type Client = { query(t: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void>; connect(): Promise<void> };

describe("the cutoff against Postgres (skipped without CUTOFF_TEST_* URLs)", () => {
  let owner: Client;
  let ro: Client;
  const W = "2026-09-10T12:00:00Z";          // the practice-wide incremental watermark
  const LATE_CATCHUP = "2026-09-10T20:00:00Z"; // one new patient read after W
  const BACKFILL = "2026-08-20T00:00:00Z";
  const ENTRY = "2026-08-03T17:00:00Z";
  const P = (i: number) => String(670000 + i);
  const q = (t: string, v: unknown[] = []) => owner.query(t, v);

  const cutoff = async (c: Client = ro) => (await c.query(`SELECT cutoff, basis FROM public.drsnip_evidence_cutoff()`)).rows[0];
  const iso = (v: unknown) => (v === null ? null : new Date(v as string).toISOString());
  const outcomesAug = async () => (await ro.query(
    `SELECT * FROM public.drsnip_outcome_metric('outcome_registration','selected_procedure_types','2026-08-01','2026-09-01')`)).rows[0];
  const booking = async () => (await ro.query(
    `SELECT * FROM public.drsnip_booking_metric('booking_registration','2026-08-01','2026-09-01',14)`)).rows[0];
  const freshness = async () => (await ro.query(`SELECT * FROM public.drsnip_journey_freshness()`)).rows[0];
  const attendance = async () => (await owner.query(
    `SELECT * FROM public.drsnip_attendance_evidence('[]'::jsonb,'attendance_registration','2026-08-01','2026-09-01',14)`)).rows[0];
  const setWatermark = (w: string | null) => q(`UPDATE appointment_sync_state SET watermark = $1::timestamptz WHERE scope_key = 'practice_incremental'`, [w]);

  before(async () => {
    if (!live) return;
    const { Client: C } = loadPg();
    owner = new C({ connectionString: OWNER! }); ro = new C({ connectionString: RO! });
    await owner.connect(); await ro.connect();
    await q(`DELETE FROM appointment_snapshots WHERE source_appointment_id LIKE 'ec\\_%'`);
    await q(`DELETE FROM appointment_sync_runs`);
    await q(`DELETE FROM appointment_sync_windows`);
    await q(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 670000 AND 679999`);
    await setWatermark(null);
    // Three groups of six registrations (six clears suppression):
    //   1-6   a booking scheduled BETWEEN the watermark and the late catch-up
    //   7-12  a booking scheduled BEFORE the watermark (its date has passed)
    //   13-18 a completed appointment
    for (let i = 1; i <= 18; i += 1) {
      await q(`INSERT INTO submissions (form_type, first_name, last_name, email, phone, has_insurance_cards, raw_payload, n8n_patient_id, created_at, updated_at)
               VALUES ('registration','T','F','f@example.invalid','000',false,'{}'::jsonb,$1::bigint,$2::timestamptz,$2::timestamptz)`, [P(i), ENTRY]);
      const [status, sched] = i <= 6 ? ["Scheduled", "2026-09-10T18:00:00Z"]
        : i <= 12 ? ["Scheduled", "2026-09-10T08:00:00Z"] : ["Complete", "2026-08-20T17:00:00Z"];
      await q(`INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, profile_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag, archived)
               VALUES ($1,$2,'585137','2026-08-05T17:00:00Z',$3::timestamptz,'2026-08-05T17:00:00Z',$4,false,false)`, [`ec_${i}`, P(i), sched, status]);
    }
  });

  after(async () => {
    if (!live || !owner) return;
    await q(`DELETE FROM appointment_snapshots WHERE source_appointment_id LIKE 'ec\\_%'`);
    await q(`DELETE FROM appointment_sync_runs`);
    await q(`DELETE FROM appointment_sync_windows`);
    await q(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 670000 AND 679999`);
    await setWatermark(null);
    await owner.end(); await ro.end();
  });

  it("with no watermark and no history read, every path says unavailable — nothing is invented", { skip: !live }, async () => {
    const c = await cutoff();
    assert.equal(c.cutoff, null);
    assert.equal(c.basis, "unavailable");
    const o = await outcomesAug();
    assert.equal(o.row_status, "unavailable");
    assert.equal(o.completed, null, "no counts against a missing cutoff");
    assert.ok((o.withheld as string[]).includes("evidence_cutoff_unavailable"));
    assert.equal((await booking()).status, "unavailable");
    assert.equal((await freshness()).appointments_synced_at, null);
    assert.equal((await attendance()).evidence_as_of, null);
  });

  it("with no watermark, falls back to the EARLIEST history read, not the latest", { skip: !live }, async () => {
    for (let i = 1; i <= 18; i += 1) {
      await q(`INSERT INTO appointment_sync_windows (window_key, strategy, patient_source_id, state, completed_at)
               VALUES ($1,'patient_history',$2,'complete',$3::timestamptz)`, [`patient:${P(i)}`, P(i), BACKFILL]);
    }
    // A patient read much later: under the old rule this became everyone's cutoff.
    await q(`INSERT INTO appointment_sync_windows (window_key, strategy, patient_source_id, state, completed_at)
             VALUES ('patient:679001','patient_history','679001','complete',$1::timestamptz)`, [LATE_CATCHUP]);
    const c = await cutoff();
    assert.equal(iso(c.cutoff), new Date(BACKFILL).toISOString());
    assert.equal(c.basis, "history_baseline");
  });

  it("a new patient's catch-up after the watermark does not move the cutoff", { skip: !live }, async () => {
    await setWatermark(W);
    const c = await cutoff();
    assert.equal(iso(c.cutoff), new Date(W).toISOString(), "the late catch-up at 20:00 must not become the cutoff");
    assert.equal(c.basis, "incremental_watermark");
  });

  it("failed or partial incremental runs do not move it", { skip: !live }, async () => {
    for (const outcome of ["failed", "partial", "budget_exhausted", "lock_contended"]) {
      await q(`INSERT INTO appointment_sync_runs (mode, scope_key, run_cutoff, outcome, complete, watermark_after, finished_at)
               VALUES ('scheduled','practice_incremental','2026-09-11T00:00:00Z',$1,false,'2026-09-11T00:00:00Z','2026-09-11T00:05:00Z')`, [outcome]);
    }
    assert.equal(iso((await cutoff()).cutoff), new Date(W).toISOString());
    // The watermark itself only moves on a complete, successful run — pinned in
    // appointment-sync-db.test.ts ("a failed middle page does NOT advance the watermark").
  });

  it("catch-ups continuing while the hourly sync is stalled cannot hide it", { skip: !live }, async () => {
    // Freeze the watermark five hours ago; keep reading new patients up to now.
    const stalled = new Date(Date.now() - 5 * 3600_000).toISOString();
    await setWatermark(stalled);
    for (let k = 0; k < 3; k += 1) {
      await q(`INSERT INTO appointment_sync_windows (window_key, strategy, patient_source_id, state, completed_at)
               VALUES ($1,'patient_history',$2,'complete', now() - ($3 || ' minutes')::interval)`, [`patient:67900${k + 2}`, `67900${k + 2}`, String(10 * k)]);
    }
    const c = await cutoff();
    assert.equal(iso(c.cutoff), new Date(stalled).toISOString(), "catch-ups must not refresh the claimed cutoff");
    const ageMin = (Date.now() - new Date(c.cutoff as string).getTime()) / 60000;
    assert.equal(isStale(ageMin), true, "the page's stale warning fires");
    const f = await freshness();
    assert.equal(iso(f.appointments_synced_at), new Date(stalled).toISOString(), "the badge shows the stalled instant too");
    await q(`DELETE FROM appointment_sync_windows WHERE window_key LIKE 'patient:67900_' AND patient_source_id <> '679001'`);
    await setWatermark(W);
  });

  it("outcomes, booking, attendance and the freshness badge report the same instant", { skip: !live }, async () => {
    const want = new Date(W).toISOString();
    assert.equal(iso((await outcomesAug()).evidence_cutoff), want, "monthly outcomes");
    assert.equal(iso((await booking()).snapshot_cutoff), want, "booking");
    assert.equal(iso((await attendance()).evidence_as_of), want, "attendance");
    assert.equal(iso((await freshness()).appointments_synced_at), want, "freshness badge");
  });

  it("'currently scheduled' is judged at the watermark, not at a later catch-up", { skip: !live }, async () => {
    const o = await outcomesAug();
    assert.equal(Number(o.covered), 18);
    assert.equal(Number(o.completed), 6);
    // Booked for 18:00, after the 12:00 watermark: still ahead as far as the
    // evidence can say. Under the old rule (cutoff 20:00) these six were
    // wrongly past-dated and Unknown.
    assert.equal(Number(o.scheduled), 6);
    assert.equal(Number(o.unknown), 6, "the 08:00 bookings' date has passed: past-dated, Unknown");
    assert.equal(Number(o.unknown_past_dated_open), 6);
    assert.equal(Number(o.neither), 0);
  });
});
