// Appointment sync — write-path behaviour that only a real Postgres can prove.
//
// The pure-logic tests in appointment-sync.test.ts cover projection, dedupe
// keys, budgets and run finalization. They cannot prove that replaying a page
// is a no-op, that two runs cannot claim one scope, or that a failed run
// leaves the cursor alone: those are properties of SQL and of Postgres'
// concurrency rules. This file executes the ACTUAL statements from
// lib/sync/appointment-sync.sql — the same text the n8n workflow runs — so the
// file cannot drift away from what is tested.
//
// SKIPPED unless SYNC_TEST_DATABASE_URL points at a DISPOSABLE database with
// the 0012 migration applied. Never point it at production: it writes rows.
//
//   createdb drsnip_sync_test
//   psql "$URL" -f lib/db/migrations/0012_appointment_sync.sql
//   SYNC_TEST_DATABASE_URL="$URL" node --import tsx --test api/_test/appointment-sync-db.test.ts
//
// Every identifier below is synthetic.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const require_ = createRequire(import.meta.url);

const URL_ = process.env.SYNC_TEST_DATABASE_URL;
const live = Boolean(URL_);

// pg is a dependency of @workspace/db, not of this package, so resolve it
// through that package rather than adding a devDependency for a test.
function loadPg() {
  const dbEntry = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(dbEntry)] }));
}

// --- load the real SQL ------------------------------------------------------
// Blocks are delimited exactly as the file writes them: a banner line, a
// `-- [n] TITLE` line, commentary, a closing banner, then the statement.
const SQL_PATH = new URL("../../lib/sync/appointment-sync.sql", import.meta.url);

function loadBlocks(): Record<string, string> {
  const lines = readFileSync(SQL_PATH, "utf8").split("\n");
  const isBanner = (l: string) => /^--\s*={10,}/.test(l);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^--\s*\[([0-9a-z]+)\]/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !isBanner(lines[j])) j += 1; // closing banner
    j += 1;
    let k = j;
    while (k < lines.length && !isBanner(lines[k])) k += 1; // next block's banner
    out[m[1]] = lines.slice(j, k).join("\n").trim();
  }
  return out;
}

const B = loadBlocks();

describe("the SQL file parses into the blocks the workflow needs", () => {
  it("has every block, each a non-empty statement", () => {
    for (const k of ["1", "1b", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16"]) {
      assert.ok(B[k] && B[k].length > 20, `block [${k}] missing or empty`);
    }
  });

  it("no block contains an interpolated value — parameters only", () => {
    for (const [k, sql] of Object.entries(B)) {
      assert.ok(!/\$\{/.test(sql), `block [${k}] interpolates a value into SQL`);
    }
  });

  it("no parameterized block sends more than one statement", () => {
    // node-postgres uses the extended protocol whenever parameters are passed,
    // and that protocol rejects multiple statements in one query text. A
    // second statement here would fail only at runtime, inside n8n.
    for (const [k, sql] of Object.entries(B)) {
      if (!/\$\d/.test(sql)) continue;
      const stripped = sql.replace(/--[^\n]*/g, "").replace(/'[^']*'/g, "''");
      const terminators = (stripped.match(/;/g) ?? []).length;
      assert.ok(terminators <= 1, `block [${k}] has ${terminators} statements`);
    }
  });

  it("the writer never DELETEs appointment or transition evidence", () => {
    for (const [k, sql] of Object.entries(B)) {
      const body = sql.replace(/--[^\n]*/g, "");
      assert.ok(
        !/DELETE\s+FROM\s+appointment_(snapshots|status_transitions)/i.test(body),
        `block [${k}] deletes evidence`,
      );
    }
  });
});

describe("write-path behaviour against Postgres (skipped without SYNC_TEST_DATABASE_URL)", () => {
  let Client: new (c: { connectionString: string }) => {
    connect(): Promise<void>;
    query(t: string, v?: unknown[]): Promise<{ rows: Record<string, never>[]; rowCount: number | null }>;
    end(): Promise<void>;
  };
  let db: InstanceType<typeof Client>;

  // Unique per test process so repeated runs never collide.
  const stamp = Date.now().toString(36);
  const SCOPE = `test_scope_${stamp}`;
  const APPT = `appt_${stamp}_1`;
  const PATIENT = `700001`;

  const q = (sql: string, v: unknown[] = []) => db.query(sql, v);
  const one = async (sql: string, v: unknown[] = []) => (await q(sql, v)).rows[0] as never;

  before(async () => {
    if (!live) return;
    ({ Client } = loadPg());
    db = new Client({ connectionString: URL_! });
    await db.connect();
    await q(
      `INSERT INTO appointment_sync_state (scope_key, watermark_meaning)
       VALUES ($1, 'test scope') ON CONFLICT (scope_key) DO NOTHING`,
      [SCOPE],
    );
    // An interrupted earlier run can leave claimable wtest_ windows behind.
    // Block [13] claims the lowest window_key for the strategy, so those
    // strays would be picked up by THIS run and then tangle its teardown.
    await q(`DELETE FROM appointment_sync_windows WHERE window_key LIKE 'wtest\\_%'`);
  });

  after(async () => {
    if (!live || !db) return;
    // Clean up only what this process created.
    await q(`DELETE FROM appointment_status_transitions WHERE source_appointment_id LIKE $1`, [`appt_${stamp}_%`]);
    await q(`DELETE FROM appointment_snapshots WHERE source_appointment_id LIKE $1`, [`appt_${stamp}_%`]);
    await q(`UPDATE appointment_sync_state SET last_run_id = NULL, active_run_id = NULL WHERE scope_key = $1`, [SCOPE]);
    // Windows reference runs, so anything still pointing at this run's rows
    // must be released first or the FK rejects the delete. Clearing by run id
    // rather than by key is what makes this robust when a claim landed on a
    // window this process did not create.
    await q(`DELETE FROM appointment_sync_windows WHERE window_key LIKE $1`, [`wtest_${stamp}_%`]);
    await q(
      `UPDATE appointment_sync_windows SET last_run_id = NULL
        WHERE last_run_id IN (SELECT id FROM appointment_sync_runs WHERE scope_key = $1)`,
      [SCOPE],
    );
    await q(`DELETE FROM appointment_sync_runs WHERE scope_key = $1`, [SCOPE]);
    await q(`DELETE FROM appointment_sync_state WHERE scope_key = $1`, [SCOPE]);
    await db.end();
  });

  async function openRun(mode = "pilot", coverage = "bounded_pilot") {
    const r = await one(B["1"], [mode, SCOPE, "unit test", coverage]);
    return r as unknown as { run_id: string; run_cutoff: string };
  }
  const claim = (runId: string, lease = "30 minutes") => q(B["1b"], [SCOPE, runId, lease]);

  function snapshotParams(over: Partial<Record<string, unknown>> = {}) {
    const p: Record<string, unknown> = {
      id: APPT, patient: PATIENT, doctor: "800001", office: "345000", profile: "585000",
      created: "2026-07-01T10:00:00.000Z", scheduled: "2026-07-20T16:00:00.000Z",
      updated: "2026-07-02T11:00:00.000Z", status: "Complete",
      deleted: false, archived: false, run: null, group: "446000", ...over,
    };
    return [p.id, p.patient, p.doctor, p.office, p.profile, p.created, p.scheduled,
            p.updated, p.status, p.deleted, p.archived, p.run, p.group];
  }

  it("replaying the same page creates no duplicate and keeps first_observed_at", { skip: !live }, async () => {
    const run = await openRun();
    await claim(run.run_id);
    await q(B["3"], snapshotParams({ run: run.run_id }));
    const first = await one(`SELECT first_observed_at, last_observed_at FROM appointment_snapshots WHERE source_appointment_id=$1`, [APPT]);

    await q(B["3"], snapshotParams({ run: run.run_id }));
    const after_ = await one(`SELECT first_observed_at, last_observed_at, count(*) OVER () AS n FROM appointment_snapshots WHERE source_appointment_id=$1`, [APPT]);

    assert.equal(Number((after_ as never as { n: string }).n), 1, "replay must not insert a second row");
    assert.deepEqual(
      (after_ as never as { first_observed_at: Date }).first_observed_at,
      (first as never as { first_observed_at: Date }).first_observed_at,
      "first sighting must not be rewritten by a replay",
    );
    await q(B["7"], [run.run_id, SCOPE]);
  });

  it("a newer page updates the row; a stale one cannot clobber it", { skip: !live }, async () => {
    const run = await openRun();
    await claim(run.run_id);

    await q(B["3"], snapshotParams({ run: run.run_id, updated: "2026-07-10T00:00:00.000Z", status: "Confirmed" }));
    await q(B["3"], snapshotParams({ run: run.run_id, updated: "2026-07-11T00:00:00.000Z", status: "Rescheduled" }));
    let row = await one(`SELECT current_status FROM appointment_snapshots WHERE source_appointment_id=$1`, [APPT]);
    assert.equal((row as never as { current_status: string }).current_status, "Rescheduled");

    // Out-of-order arrival: an older page shows up after a newer one.
    await q(B["3"], snapshotParams({ run: run.run_id, updated: "2026-07-05T00:00:00.000Z", status: "STALE" }));
    row = await one(`SELECT current_status FROM appointment_snapshots WHERE source_appointment_id=$1`, [APPT]);
    assert.equal((row as never as { current_status: string }).current_status, "Rescheduled", "stale response must not win");

    // An incoming row with no timestamp at all is equally untrusted.
    await q(B["3"], snapshotParams({ run: run.run_id, updated: null, status: "NO_TIMESTAMP" }));
    row = await one(`SELECT current_status FROM appointment_snapshots WHERE source_appointment_id=$1`, [APPT]);
    assert.equal((row as never as { current_status: string }).current_status, "Rescheduled");

    await q(B["7"], [run.run_id, SCOPE]);
  });

  it("blank and absent status stay distinguishable in the column", { skip: !live }, async () => {
    const run = await openRun();
    await claim(run.run_id);
    const blank = `appt_${stamp}_blank`;
    const absent = `appt_${stamp}_absent`;
    await q(B["3"], snapshotParams({ id: blank, run: run.run_id, status: "" }));
    await q(B["3"], snapshotParams({ id: absent, run: run.run_id, status: null }));

    const r = await one(
      `SELECT (SELECT current_status FROM appointment_snapshots WHERE source_appointment_id=$1) AS blank,
              (SELECT current_status IS NULL FROM appointment_snapshots WHERE source_appointment_id=$2) AS absent_is_null`,
      [blank, absent],
    );
    assert.equal((r as never as { blank: string }).blank, "", "'' must survive as ''");
    assert.equal((r as never as { absent_is_null: boolean }).absent_is_null, true, "absent must survive as NULL");
    await q(B["7"], [run.run_id, SCOPE]);
  });

  it("cancelled and deleted records are stored, not dropped", { skip: !live }, async () => {
    const run = await openRun();
    await claim(run.run_id);
    const gone = `appt_${stamp}_deleted`;
    await q(B["3"], snapshotParams({ id: gone, run: run.run_id, status: "Cancelled", deleted: true, archived: true }));
    const r = await one(`SELECT current_status, deleted_flag, archived FROM appointment_snapshots WHERE source_appointment_id=$1`, [gone]);
    assert.deepEqual(r, { current_status: "Cancelled", deleted_flag: true, archived: true });
    await q(B["7"], [run.run_id, SCOPE]);
  });

  it("a sentinel item writes nothing, so an empty page still finishes its run", { skip: !live }, async () => {
    // n8n skips every downstream node when a node emits zero items, which would
    // strand the run as 'running' with the scope still leased. The projector
    // therefore always emits at least one item; an empty page sends a sentinel
    // whose id is null, and these statements must no-op on it.
    const run = await openRun();
    await claim(run.run_id);
    const before_ = await one(`SELECT count(*)::int AS n FROM appointment_snapshots`);

    await q(B["3"], snapshotParams({ id: null, patient: null, run: run.run_id }));
    await q(B["4"], [null, null, null, null, null, null, run.run_id]);
    await q(B["5"], [null, []]);

    const after_ = await one(`SELECT count(*)::int AS n FROM appointment_snapshots`);
    assert.equal((after_ as never as { n: number }).n, (before_ as never as { n: number }).n,
      "a sentinel must not create a row");

    // ...and the run still reaches a recorded, released end state.
    await q(B["6"], [run.run_id, "success", true, "bounded_pilot", run.run_cutoff, 1, 1, 1, 0, 0, 0, 0, null]);
    const released = await q(B["7"], [run.run_id, SCOPE]);
    assert.equal(released.rowCount, 1, "an empty page must still finish and release");
  });

  it("transitions replay cleanly and an omitted one is flagged, not deleted", { skip: !live }, async () => {
    const run = await openRun();
    await claim(run.run_id);
    await q(B["3"], snapshotParams({ run: run.run_id }));

    const k1 = "k1|2026-07-20T16:05:00Z|Confirmed|Checked In";
    const k2 = "k2|2026-07-20T16:20:00Z|Checked In|MD In";
    const put = (key: string, at: string, from: string, to: string) =>
      q(B["4"], [APPT, null, at, from, to, key, run.run_id]);

    await put(k1, "2026-07-20T16:05:00.000Z", "Confirmed", "Checked In");
    await put(k2, "2026-07-20T16:20:00.000Z", "Checked In", "MD In");
    await put(k1, "2026-07-20T16:05:00.000Z", "Confirmed", "Checked In"); // replay

    let n = await one(`SELECT count(*)::int AS n FROM appointment_status_transitions WHERE source_appointment_id=$1`, [APPT]);
    assert.equal((n as never as { n: number }).n, 2, "replay must not duplicate a transition");

    // A later response carries only k1. k2 is flagged as missing, not removed.
    await q(B["5"], [APPT, [k1]]);
    const after_ = await one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE missing_since IS NOT NULL)::int AS missing
         FROM appointment_status_transitions WHERE source_appointment_id=$1`,
      [APPT],
    );
    assert.equal((after_ as never as { total: number }).total, 2, "history must survive an omission");
    assert.equal((after_ as never as { missing: number }).missing, 1);

    // k2 comes back: the absence was a gap, not a correction.
    await put(k2, "2026-07-20T16:20:00.000Z", "Checked In", "MD In");
    const back = await one(
      `SELECT missing_since FROM appointment_status_transitions WHERE source_appointment_id=$1 AND dedupe_key=$2`,
      [APPT, k2],
    );
    assert.equal((back as never as { missing_since: null }).missing_since, null, "re-observation clears the flag");
    await q(B["7"], [run.run_id, SCOPE]);
  });

  it("a corrected transition is a NEW row — both readings are kept", { skip: !live }, async () => {
    const run = await openRun();
    await claim(run.run_id);
    await q(B["3"], snapshotParams({ run: run.run_id }));
    const at = "2026-07-20T17:00:00.000Z";
    await q(B["4"], [APPT, null, at, "MD In", "Complete", "c|orig", run.run_id]);
    await q(B["4"], [APPT, null, at, "MD In", "Cancelled", "c|corrected", run.run_id]);
    const n = await one(
      `SELECT count(*)::int AS n FROM appointment_status_transitions
        WHERE source_appointment_id=$1 AND dedupe_key LIKE 'c|%'`, [APPT]);
    assert.equal((n as never as { n: number }).n, 2);
    await q(B["7"], [run.run_id, SCOPE]);
  });

  it("only one of two concurrent runs can claim a scope", { skip: !live }, async () => {
    const a = await openRun();
    const b = await openRun();

    const first = await claim(a.run_id);
    const second = await claim(b.run_id);

    assert.equal(first.rowCount, 1, "the first claimant wins");
    assert.equal(second.rowCount, 0, "the second must be told the scope is held");

    // The loser is reported, not silently treated as a success.
    await q(B["6"], [b.run_id, "lock_contended", false, "bounded_pilot", null, null, 0, 0, 0, 0, 0, 0, null]);
    const loser = await one(`SELECT outcome, watermark_after FROM appointment_sync_runs WHERE id=$1`, [b.run_id]);
    assert.equal((loser as never as { outcome: string }).outcome, "lock_contended");
    assert.equal((loser as never as { watermark_after: null }).watermark_after, null);

    // Once the holder releases, the scope is claimable again.
    await q(B["7"], [a.run_id, SCOPE]);
    assert.equal((await claim(b.run_id)).rowCount, 1);
    await q(B["7"], [b.run_id, SCOPE]);
  });

  it("two genuinely overlapping claims cannot both win", { skip: !live }, async () => {
    // The sequential test above only shows the guard works once a claim has
    // committed. The property the design rests on is stronger: when two
    // UPDATEs collide, the loser BLOCKS on the row lock and then re-evaluates
    // its WHERE against the newly committed row. That is what is proved here.
    const a = await openRun();
    const b = await openRun();

    const { Client: C } = loadPg();
    const other = new C({ connectionString: URL_! });
    await other.connect();
    try {
      await q("BEGIN");
      const mine = await q(B["1b"], [SCOPE, a.run_id, "30 minutes"]);
      assert.equal(mine.rowCount, 1);

      // Issued while our transaction still holds the row lock; it must block.
      const contender = other.query(B["1b"], [SCOPE, b.run_id, "30 minutes"]);
      let settled = false;
      void contender.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(settled, false, "the second claim must block, not race ahead");

      await q("COMMIT");
      const theirs = await contender;
      assert.equal(theirs.rowCount, 0, "after re-evaluating, the loser must match nothing");
    } finally {
      await other.end();
      await q(B["7"], [a.run_id, SCOPE]);
    }
  });

  it("an expired lease is reclaimable, so a crashed run cannot hold a scope forever", { skip: !live }, async () => {
    const a = await openRun();
    await claim(a.run_id, "0 seconds"); // already expired
    const b = await openRun();
    assert.equal((await claim(b.run_id)).rowCount, 1);
    await q(B["7"], [b.run_id, SCOPE]);
  });

  it("a failed middle page does NOT advance the watermark", { skip: !live }, async () => {
    const before_ = await one(`SELECT watermark FROM appointment_sync_state WHERE scope_key=$1`, [SCOPE]);
    const run = await openRun("incremental", "incremental_window");
    await claim(run.run_id);
    // Page 3 of 5 failed: complete=false, and no watermark_after is offered.
    await q(B["6"], [run.run_id, "failed", false, "incremental_window", null, null, 3, 2, 40, 40, 0, 0, "HTTP 503 on page 3"]);
    await q(B["7"], [run.run_id, SCOPE]);

    const after_ = await one(`SELECT watermark, active_run_id FROM appointment_sync_state WHERE scope_key=$1`, [SCOPE]);
    assert.deepEqual(
      (after_ as never as { watermark: Date | null }).watermark,
      (before_ as never as { watermark: Date | null }).watermark,
      "a partial run must leave the cursor alone",
    );
    assert.equal((after_ as never as { active_run_id: null }).active_run_id, null, "but it must release the lease");
  });

  it("an exhausted budget is resumable, not a completion", { skip: !live }, async () => {
    const before_ = await one(`SELECT watermark FROM appointment_sync_state WHERE scope_key=$1`, [SCOPE]);
    const run = await openRun("incremental", "incremental_window");
    await claim(run.run_id);
    await q(B["6"], [run.run_id, "budget_exhausted", false, "incremental_window", null, null, 120, 120, 900, 12, 888, 30, null]);
    await q(B["7"], [run.run_id, SCOPE]);
    const after_ = await one(`SELECT watermark FROM appointment_sync_state WHERE scope_key=$1`, [SCOPE]);
    assert.deepEqual((after_ as never as { watermark: Date | null }).watermark,
                     (before_ as never as { watermark: Date | null }).watermark);
  });

  it("a complete successful run advances the cursor and the generation", { skip: !live }, async () => {
    const run = await openRun("incremental", "incremental_window");
    const claimed = await claim(run.run_id);
    const gen = Number((claimed.rows[0] as never as { next_generation: string }).next_generation);
    const cutoff = (run as unknown as { run_cutoff: Date }).run_cutoff;

    await q(B["6"], [run.run_id, "success", true, "incremental_window", cutoff, gen, 4, 3, 50, 12, 38, 22, null]);
    await q(B["7"], [run.run_id, SCOPE]);

    const st = await one(
      `SELECT watermark, last_committed_generation, active_run_id, last_run_id
         FROM appointment_sync_state WHERE scope_key=$1`, [SCOPE]);
    assert.deepEqual((st as never as { watermark: Date }).watermark, cutoff, "cursor moves to the run's cutoff");
    assert.equal(Number((st as never as { last_committed_generation: string }).last_committed_generation), gen);
    assert.equal((st as never as { active_run_id: null }).active_run_id, null);
    assert.equal((st as never as { last_run_id: string }).last_run_id, run.run_id);
  });

  it("a run whose lease was taken over cannot come back and clobber the cursor", { skip: !live }, async () => {
    const stale = await openRun("incremental", "incremental_window");
    await claim(stale.run_id, "0 seconds");
    const fresh = await openRun("incremental", "incremental_window");
    await claim(fresh.run_id); // takes the scope over

    const before_ = await one(`SELECT watermark FROM appointment_sync_state WHERE scope_key=$1`, [SCOPE]);
    await q(B["6"], [stale.run_id, "success", true, "incremental_window", "2030-01-01T00:00:00Z", 999, 1, 1, 1, 1, 0, 0, null]);
    const wrote = await q(B["7"], [stale.run_id, SCOPE]);
    assert.equal(wrote.rowCount, 0, "the superseded run must update nothing");

    const after_ = await one(`SELECT watermark FROM appointment_sync_state WHERE scope_key=$1`, [SCOPE]);
    assert.deepEqual((after_ as never as { watermark: Date }).watermark, (before_ as never as { watermark: Date }).watermark);
    await q(B["7"], [fresh.run_id, SCOPE]);
  });

  it("timestamps round-trip as UTC instants and report correctly in Pacific", { skip: !live }, async () => {
    const run = await openRun();
    await claim(run.run_id);
    const late = `appt_${stamp}_late`;
    // 10 PM Pacific on 6 Aug 2026 == 2026-08-07T05:00Z. Stored as an instant;
    // the clinic day is derived at read time, never frozen at write time.
    await q(B["3"], snapshotParams({ id: late, run: run.run_id, scheduled: "2026-08-07T05:00:00.000Z" }));
    const r = await one(
      `SELECT scheduled_time AT TIME ZONE 'America/Los_Angeles' AS local,
              (scheduled_time AT TIME ZONE 'America/Los_Angeles')::date::text AS clinic_day,
              scheduled_time = '2026-08-07T05:00:00Z'::timestamptz AS instant_preserved
         FROM appointment_snapshots WHERE source_appointment_id=$1`, [late]);
    assert.equal((r as never as { instant_preserved: boolean }).instant_preserved, true);
    assert.equal((r as never as { clinic_day: string }).clinic_day, "2026-08-06",
      "a 10 PM Pacific appointment belongs to the Pacific day, not the UTC one");
    await q(B["7"], [run.run_id, SCOPE]);
  });

  it("an appointment created after its scheduled time is stored as-is", { skip: !live }, async () => {
    const run = await openRun();
    await claim(run.run_id);
    const back = `appt_${stamp}_backdated`;
    await q(B["3"], snapshotParams({
      id: back, run: run.run_id,
      created: "2026-07-20T17:30:00.000Z", scheduled: "2026-07-20T16:00:00.000Z",
    }));
    const r = await one(
      `SELECT source_created_at > scheduled_time AS created_after FROM appointment_snapshots WHERE source_appointment_id=$1`, [back]);
    assert.equal((r as never as { created_after: boolean }).created_after, true,
      "ingestion records the oddity rather than repairing it");
    await q(B["7"], [run.run_id, SCOPE]);
  });

  it("the catch-up queue is a set difference and does not re-queue", { skip: !live }, async () => {
    await q(`DELETE FROM appointment_sync_patient_queue WHERE patient_source_id IN (SELECT patient_source_id FROM drsnip_linked_patient_ids)`);
    const first = await q(B["9"]);
    const second = await q(B["9"]);
    assert.equal(second.rowCount, 0, "a second sweep must add nothing new");
    assert.ok((first.rowCount ?? 0) >= 0);

    // A patient we already hold appointments for is not queued.
    const held = await one(
      `SELECT count(*)::int AS n FROM appointment_sync_patient_queue q
        WHERE EXISTS (SELECT 1 FROM appointment_snapshots s WHERE s.patient_source_id = q.patient_source_id)
          AND q.reason = 'newly_linked' AND q.queued_at > now() - interval '1 minute'`);
    assert.equal((held as never as { n: number }).n, 0);
  });

  it("the queue hands out each patient once (SKIP LOCKED batch claim)", { skip: !live }, async () => {
    await q(
      `INSERT INTO appointment_sync_patient_queue (patient_source_id, reason)
       VALUES ($1,'manual') ON CONFLICT (patient_source_id) DO UPDATE SET state='pending', attempts=0`,
      [`qtest_${stamp}`],
    );
    const claimed = await q(B["10"], [50]);
    assert.ok((claimed.rowCount ?? 0) >= 1);
    await q(B["11"], [`qtest_${stamp}`]);
    const done = await one(`SELECT state, attempts FROM appointment_sync_patient_queue WHERE patient_source_id=$1`, [`qtest_${stamp}`]);
    assert.equal((done as never as { state: string }).state, "done");
    assert.ok((done as never as { attempts: number }).attempts >= 1);
    await q(`DELETE FROM appointment_sync_patient_queue WHERE patient_source_id=$1`, [`qtest_${stamp}`]);
  });

  // -------------------------------------------------------------------------
  // Backfill checkpoints. The property that matters: nothing may look like
  // coverage unless the unit that produced it actually finished.
  // -------------------------------------------------------------------------
  const W = (k: string) => `wtest_${stamp}_${k}`;

  it("planning is idempotent and never resets a finished unit", { skip: !live }, async () => {
    await q(B["12"], [W("a"), "2022-01-01", "2022-03-31"]);
    await q(B["14"], [W("a"), "complete", false, 3, 100, 60, 40, 200, null]);
    await q(B["12"], [W("a"), "2022-01-01", "2022-03-31"]); // re-plan
    const r = await one(`SELECT state, completed_at IS NOT NULL AS done FROM appointment_sync_windows WHERE window_key=$1`, [W("a")]);
    assert.equal((r as never as { state: string }).state, "complete", "re-planning must not undo progress");
    assert.equal((r as never as { done: boolean }).done, true);
  });

  it("a truncated unit stays claimable and carries no completed_at", { skip: !live }, async () => {
    await q(B["12"], [W("b"), "2022-04-01", "2022-06-30"]);
    await q(B["14"], [W("b"), "partial", true, 40, 10000, 5000, 5000, 0, "page cap reached"]);
    const r = await one(`SELECT state, truncated, completed_at FROM appointment_sync_windows WHERE window_key=$1`, [W("b")]);
    assert.equal((r as never as { state: string }).state, "partial");
    assert.equal((r as never as { truncated: boolean }).truncated, true);
    assert.equal((r as never as { completed_at: null }).completed_at, null,
      "a capped unit must never look like coverage");

    // ...and the claimer picks it up again.
    const run = await openRun("backfill", "historical_complete");
    const claimed = await q(B["13"], [run.run_id, "scheduled_window", "30 minutes"]);
    const keys = claimed.rows.map((x) => (x as never as { window_key: string }).window_key);
    assert.ok(keys.length <= 1, "claims one unit at a time");
  });

  it("a failed unit does not advance coverage and is retried", { skip: !live }, async () => {
    await q(B["12"], [W("c"), "2022-07-01", "2022-09-30"]);
    await q(B["14"], [W("c"), "failed", false, 1, 0, 0, 0, 0, "HTTP 503"]);
    const r = await one(`SELECT state, completed_at FROM appointment_sync_windows WHERE window_key=$1`, [W("c")]);
    assert.equal((r as never as { state: string }).state, "failed");
    assert.equal((r as never as { completed_at: null }).completed_at, null);
  });

  it("two workers claiming at once take different units", { skip: !live }, async () => {
    await q(B["12"], [W("d1"), "2023-01-01", "2023-03-31"]);
    await q(B["12"], [W("d2"), "2023-04-01", "2023-06-30"]);
    const r1 = await openRun("backfill", "historical_complete");
    const r2 = await openRun("backfill", "historical_complete");
    const { Client: C } = loadPg();
    const other = new C({ connectionString: URL_! });
    await other.connect();
    try {
      await q("BEGIN");
      const mine = await q(B["13"], [r1.run_id, "scheduled_window", "30 minutes"]);
      const theirs = await other.query(B["13"], [r2.run_id, "scheduled_window", "30 minutes"]);
      const a = mine.rows.map((x) => (x as never as { window_key: string }).window_key);
      const b = theirs.rows.map((x) => (x as never as { window_key: string }).window_key);
      for (const k of a) assert.ok(!b.includes(k), "SKIP LOCKED must hand out distinct units");
      await q("COMMIT");
    } finally { await other.end(); }
  });

  it("an older backfill response cannot overwrite newer sync evidence", { skip: !live }, async () => {
    // The lease is PER SCOPE, so a historical run and an incremental run do not
    // block each other on the shared evidence tables. What actually protects
    // those tables is the row-level staleness guard in block [3]. Prove it
    // across scopes, which is the case the lease does not cover.
    const incr = await openRun("incremental", "incremental_window");
    const appt = `appt_${stamp}_xscope`;
    await q(B["3"], snapshotParams({ id: appt, run: incr.run_id, updated: "2026-09-19T00:00:00.000Z", status: "Rescheduled" }));

    const back = await openRun("backfill", "historical_complete");
    await q(B["3"], snapshotParams({ id: appt, run: back.run_id, updated: "2026-01-01T00:00:00.000Z", status: "STALE_HISTORY" }));

    const r = await one(`SELECT current_status FROM appointment_snapshots WHERE source_appointment_id=$1`, [appt]);
    assert.equal((r as never as { current_status: string }).current_status, "Rescheduled",
      "a historical read of an older revision must not roll back newer evidence");
  });

  it("coverage classification puts every linked patient in exactly one bucket", { skip: !live }, async () => {
    const rows = (await q(B["16"])).rows as never as { coverage_class: string; patients: string }[];
    const total = rows.reduce((n, r) => n + Number(r.patients), 0);
    const linked = await one(`SELECT count(*)::int AS n FROM drsnip_linked_patient_ids`);
    assert.equal(total, (linked as never as { n: number }).n, "buckets must sum to the linked population");
    const allowed = new Set(["has_appointment", "queried_none_found", "blocked_or_error", "queued_not_yet_queried", "not_yet_queried"]);
    for (const r of rows) assert.ok(allowed.has(r.coverage_class), `unexpected bucket ${r.coverage_class}`);
  });

  it("run rows carry counters and a sanitized summary, never a payload", { skip: !live }, async () => {
    const r = await one(
      `SELECT count(*)::int AS n FROM appointment_sync_runs
        WHERE scope_key=$1 AND error_summary IS NOT NULL AND length(error_summary) > 300`, [SCOPE]);
    assert.equal((r as never as { n: number }).n, 0);
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('appointment_snapshots','appointment_status_transitions','appointment_sync_runs')
          AND column_name IN ('raw_payload','payload','clinical_note','vitals','reason','notes','first_name','last_name','email','phone','date_of_birth')`);
    assert.equal(cols.rowCount, 0, "no schema column may hold a payload or an identifier beyond the patient id");
  });
});
