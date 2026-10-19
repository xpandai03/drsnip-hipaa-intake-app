// Train 4 — conversion by cohort (0024), against a hand-worked fixture.
//
// SKIPPED unless CONVERSION_TEST_DATABASE_URL points at a DISPOSABLE database
// carrying migrations through 0024. Never production: it writes (and rolls back).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MIGRATION = read("../../lib/db/migrations/0024_conversion_cohorts.sql");

describe("0024 — static contract", () => {
  it("builds on the same per-patient classifier as Monthly outcomes", () => {
    assert.match(MIGRATION, /FROM public\.drsnip_conversion_classify\(p_form\)/);
  });
  it("never grants the patient-level classifier", () => {
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\.drsnip_conversion_classify/.test(MIGRATION));
  });
  it("never JITs", () => {
    assert.match(MIGRATION, /SET jit = off/);
  });
  it("self-checks cohort == monthly before committing", () => {
    assert.match(MIGRATION, /cohort and monthly disagree/);
  });
});

const OWNER = process.env.CONVERSION_TEST_DATABASE_URL;
const live = Boolean(OWNER && !/fly\.dev|flycast|drsnip-intake-db/.test(OWNER));

function loadPg() {
  const require_ = createRequire(import.meta.url);
  const e = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(e)] }));
}

describe(`cohort fill (${live ? "live" : "skipped without CONVERSION_TEST_DATABASE_URL"})`, { skip: !live }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c: any;
  before(async () => {
    const { Client } = loadPg();
    c = new Client({ connectionString: OWNER });
    await c.connect();
    await c.query("BEGIN");
    await c.query(`DELETE FROM appointment_status_transitions; DELETE FROM appointment_snapshots;
                   DELETE FROM appointment_sync_windows; DELETE FROM submissions;`);
    let n = 0;
    // created_at values are DrChrono's Eastern wall-clock stored as UTC (0023).
    const patient = async (pid: string, formAt: string, appts: Array<[string, string]>) => {
      await c.query(
        `INSERT INTO submissions (form_type, first_name, last_name, email, phone, raw_payload, n8n_status, n8n_patient_id, created_at)
         VALUES ('registration', 'T', 'T', 't@example.invalid', '0', '{}'::jsonb, 'success', $1::bigint, $2::timestamptz)`,
        [pid, formAt]);
      await c.query(
        `INSERT INTO appointment_sync_windows (window_key, strategy, state, patient_source_id, completed_at)
         VALUES ($1, 'patient_history', 'complete', $2, now())`, [`t-${pid}`, pid]);
      for (const [status, createdAt] of appts) {
        n += 1;
        await c.query(
          `INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at,
                                              scheduled_time, source_updated_at, current_status, deleted_flag)
           VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '10 days', $3::timestamptz, $4, false)`,
          [`t-c${n}`, pid, createdAt, status]);
      }
    };
    // JUNE cohort, 6 patients.
    //   A: form 10 Jun; Canceled in July, Scheduled created 5 Sep -> converted in September: P+3, not P+1.
    await patient("9200001", "2026-06-10T18:00:00Z", [["Cancelled", "2026-07-05T15:00:00Z"], ["Scheduled", "2026-09-05T15:00:00Z"]]);
    //   B..F: Complete created 20 Jun -> P+0.
    for (let i = 2; i <= 6; i++) await patient(`920000${i}`, "2026-06-12T18:00:00Z", [["Complete", "2026-06-20T15:00:00Z"]]);
    // JULY cohort, 11 patients.
    //   G: form 28 Jul; Rescheduled created 10 Aug -> converted, P+1 (the brief's own example).
    await patient("9200007", "2026-07-28T18:00:00Z", [["Rescheduled", "2026-08-10T15:00:00Z"]]);
    //   H..L: Complete created 30 Jul -> P+0.
    for (let i = 8; i <= 12; i++) await patient(`92000${String(i).padStart(2, "0")}`, "2026-07-15T18:00:00Z", [["Complete", "2026-07-30T15:00:00Z"]]);
    //   M..Q: no appointment -> not converted.
    for (let i = 13; i <= 17; i++) await patient(`92000${i}`, "2026-07-16T18:00:00Z", []);
    // Clock edge: stored 2026-08-01T05:00 is DrChrono's EASTERN wall-clock, i.e.
    // 1 Aug 02:00 Pacific -> August -> P+1. Read naively as UTC it would be
    // 31 Jul 22:00 Pacific (P+0). This row pins the Eastern reading.
    await patient("9200018", "2026-07-20T18:00:00Z", [["Complete", "2026-08-01T05:00:00Z"]]);
    await c.query(`INSERT INTO appointment_sync_state (scope_key, watermark, watermark_meaning)
                   VALUES ('practice_incremental', '2026-10-19T12:00:00Z', 'test')
                   ON CONFLICT (scope_key) DO UPDATE SET watermark = EXCLUDED.watermark`);
  });
  after(async () => { await c?.query("ROLLBACK"); await c?.end(); });

  const month = async (p: string) =>
    (await c.query(`SELECT *, period_start::text AS ps FROM public.drsnip_conversion_cohorts('registration', 'month')`))
      .rows.find((r: { ps: string }) => r.ps === p);

  it("June: one late converter lands in P+3, not P+1", async () => {
    const r = await month("2026-06-01");
    assert.equal(r.row_status, "ok");
    assert.equal(r.forms, 6);
    assert.equal(r.converted_now, 6);
    assert.deepEqual([r.fill_p0, r.fill_p1, r.fill_p2, r.fill_p3, r.fill_later], [5, 5, 5, 6, 6]);
    assert.deepEqual([r.ended_p0, r.ended_p1, r.ended_p2, r.ended_p3], [true, true, true, true]);
  });

  it("July: the Aug 10 reschedule is P+1; the Eastern-clock edge is P+1; unended periods are blank", async () => {
    const r = await month("2026-07-01");
    assert.equal(r.forms, 12);
    assert.equal(r.converted_now, 7);
    assert.deepEqual([r.fill_p0, r.fill_p1, r.fill_p2], [5, 7, 7]);
    // P+3 for July is October: it has not ended at a 19 Oct cutoff.
    assert.equal(r.ended_p3, false);
    assert.equal(r.fill_p3, null, "a period still running is blank, not zero");
    assert.equal(r.fill_later, null);
  });

  it("converted as of today equals Monthly outcomes for the same month and form", async () => {
    for (const [from, to] of [["2026-06-01", "2026-07-01"], ["2026-07-01", "2026-08-01"]]) {
      const m = (await c.query(`SELECT * FROM public.drsnip_conversion_monthly('registration', $1::date, $2::date)`, [from, to])).rows[0];
      const k = await month(from);
      assert.equal(k.converted_now, m.converted, from);
      assert.equal(k.forms, m.covered, from);
    }
  });

  it("weeks start on Monday and run back to the earliest submission, newest first", async () => {
    const rows = (await c.query(`SELECT period_start::text AS ps FROM public.drsnip_conversion_cohorts('registration', 'week')`)).rows;
    assert.ok(rows.length > 10);
    for (const r of rows) assert.equal(new Date(r.ps + "T12:00:00Z").getUTCDay(), 1, r.ps);
    assert.equal(rows[rows.length - 1].ps, "2026-06-08", "the week of the earliest submission (Wed 10 Jun)");
    assert.ok(rows[0].ps > rows[1].ps, "newest first");
  });

  it("a cohort of 1..4 is withheld whole", async () => {
    const rows = (await c.query(`SELECT *, period_start::text AS ps FROM public.drsnip_conversion_cohorts('registration', 'week')`)).rows;
    const small = rows.find((r: { ps: string }) => r.ps === "2026-07-20"); // one entrant that week
    assert.equal(small.row_status, "suppressed");
    assert.equal(small.forms, null);
    assert.equal(small.converted_now, null);
  });

  it("refuses an unsupported grain or form", async () => {
    await assert.rejects(c.query(`SAVEPOINT s1; SELECT * FROM public.drsnip_conversion_cohorts('registration', 'day')`));
    await c.query("ROLLBACK TO SAVEPOINT s1");
    await assert.rejects(c.query(`SAVEPOINT s2; SELECT * FROM public.drsnip_conversion_cohorts('consultation', 'month')`));
    await c.query("ROLLBACK TO SAVEPOINT s2");
  });
});
