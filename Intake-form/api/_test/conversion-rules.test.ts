// Train 4 — the client's twelve statuses, and the rules that count them.
//
// Three layers:
//   1. Pure: every one of the client's twelve statuses classifies as listed
//      (TypeScript mirror; always runs).
//   2. Drift guard: the lists in lib/metrics/conversion-rules.ts are exactly
//      the lists migration 0023 seeds (always runs).
//   3. Database: the SQL classifier agrees with the mirror for every label, and
//      drsnip_conversion_monthly() counts a hand-built fixture correctly.
//      SKIPPED unless CONVERSION_TEST_DATABASE_URL points at a DISPOSABLE
//      database carrying migrations through 0023. Never production: it writes.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import {
  CLIENT_STATUS_LIST,
  CONVERSION_RULES,
  classifyStatus,
} from "../../lib/metrics/conversion-rules.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MIGRATION = read("../../lib/db/migrations/0023_jeff_conversion_rules.sql");

const UNCLASSIFIED_SEEN_IN_PRODUCTION = ["", "Arrived", "In Room", "MD In", "MD Out", "Checked In Online"];

describe("the client's twelve statuses", () => {
  it("lists exactly twelve, nine converted and three not", () => {
    assert.equal(CLIENT_STATUS_LIST.length, 12);
    assert.equal(CLIENT_STATUS_LIST.filter((s) => s.is === "converted").length, 9);
    assert.equal(CLIENT_STATUS_LIST.filter((s) => s.is === "not_converted").length, 3);
  });

  for (const s of CLIENT_STATUS_LIST) {
    it(`${s.status} -> ${s.is}`, () => {
      // The client's own words, and every DrChrono label that means the same.
      assert.equal(classifyStatus(s.status.replace(/ \(.*\)$/, "").replace("room N", "room 7")), s.is, s.status);
      for (const label of s.drchrono) assert.equal(classifyStatus(label), s.is, label);
    });
  }

  it("Ready in room N matches any room number, and nothing else", () => {
    for (const n of ["1", "2", "9", "10", "123"]) {
      assert.equal(classifyStatus(`Ready in ${n}`), "converted");
      assert.equal(classifyStatus(`Ready in room ${n}`), "converted");
    }
    assert.equal(classifyStatus("Ready in"), "unclassified");
    assert.equal(classifyStatus("Ready in room"), "unclassified");
    assert.equal(classifyStatus("Ready in lobby"), "unclassified");
  });

  it("is case- and whitespace-insensitive", () => {
    assert.equal(classifyStatus("  COMPLETE "), "converted");
    assert.equal(classifyStatus("signed   no review"), "converted");
    assert.equal(classifyStatus("no-SHOW"), "not_converted");
  });

  it("anything else is unclassified, including every other label seen in production", () => {
    for (const s of [...UNCLASSIFIED_SEEN_IN_PRODUCTION, null, undefined, "Something New"]) {
      assert.equal(classifyStatus(s), "unclassified", String(s));
    }
  });

  it("a cancel pattern does not swallow a converted label", () => {
    assert.equal(classifyStatus("Rescheduled"), "converted");
    assert.equal(classifyStatus("Cancellation pending"), "unclassified");
  });
});

describe("the TypeScript mirror and migration 0023 carry the same lists", () => {
  const block = MIGRATION.slice(MIGRATION.indexOf("INSERT INTO outcome_status_rules"), MIGRATION.indexOf("ON CONFLICT (version)"));
  const arrayAfter = (key: string): string[] => {
    const m = new RegExp(`'${key}', jsonb_build_array\\(\\s*((?:'(?:[^']|'')*'\\s*,?\\s*)*)\\)`, "s").exec(block);
    assert.ok(m, `no ${key} array in 0023`);
    return [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]);
  };
  for (const key of ["converted", "converted_patterns", "not_converted", "not_converted_patterns"] as const) {
    it(key, () => {
      assert.deepEqual(arrayAfter(key), [...CONVERSION_RULES[key]]);
    });
  }
  it("seeds version 2 as approved, with provenance", () => {
    assert.match(block, /VALUES \('2', 'approved'/);
    assert.match(MIGRATION, /'Jeffrey Cho', 'DrSnip client contact', 'video_call', DATE '2026-09-21'/);
  });
  it("the patient-level classifier is never granted to a caller", () => {
    assert.ok(!/GRANT EXECUTE ON FUNCTION public\.drsnip_conversion_classify/.test(MIGRATION));
  });
});

// ---------------------------------------------------------------------------
const OWNER = process.env.CONVERSION_TEST_DATABASE_URL;
const live = Boolean(OWNER && !/fly\.dev|flycast|drsnip-intake-db/.test(OWNER));

function loadPg() {
  const require_ = createRequire(import.meta.url);
  const e = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(e)] }));
}

describe(`database classifier and monthly counts (${live ? "live" : "skipped without CONVERSION_TEST_DATABASE_URL"})`, { skip: !live }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c: any;
  before(async () => {
    const { Client } = loadPg();
    c = new Client({ connectionString: OWNER });
    await c.connect();
  });
  after(async () => { await c?.end(); });

  it("SQL and TypeScript agree on every label", async () => {
    const labels = [
      ...CLIENT_STATUS_LIST.flatMap((s) => s.drchrono),
      ...UNCLASSIFIED_SEEN_IN_PRODUCTION,
      "Canceled", "Late canceled", "No-show", "Ready in room 7", "COMPLETE", "Cancellation pending",
    ];
    const r = await c.query(
      `SELECT l, public.drsnip_conversion_status_class(l, (SELECT rules FROM public.drsnip_conversion_rules())) AS cls
         FROM unnest($1::text[]) l`, [labels]);
    for (const row of r.rows) assert.equal(row.cls, classifyStatus(row.l), `label "${row.l}"`);
  });

  it("counts one fixture month exactly (hand-worked)", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`DELETE FROM appointment_status_transitions; DELETE FROM appointment_snapshots;
                     DELETE FROM appointment_sync_windows; DELETE FROM submissions;`);
      // Twenty-four linked patients, each with a first registration in July 2026
      // (Pacific), every one's history read. Each list is one patient's
      // appointments, as [status, deleted?]. Expected bucket in the comment.
      type A = [string, boolean?];
      const P: Array<{ appts: A[]; bucket: string }> = [
        // 8 converted
        { appts: [["Complete"]], bucket: "converted" },
        { appts: [["Complete"], ["No Show"]], bucket: "converted" },          // any converted wins
        { appts: [["Cancelled"], ["Rescheduled"]], bucket: "converted" },
        { appts: [["Procedure Not Performed"]], bucket: "converted" },        // moved into the set
        { appts: [["Checked In"]], bucket: "converted" },
        { appts: [["Ready in 2"]], bucket: "converted" },
        { appts: [["In Session"]], bucket: "converted" },
        { appts: [["Signed No Review"], [""]], bucket: "converted" },
        // 5 not converted
        { appts: [["No Show"]], bucket: "not_converted" },
        { appts: [["Cancelled"]], bucket: "not_converted" },
        { appts: [["Late Cancel within 48 hrs"]], bucket: "not_converted" },
        { appts: [["Cancelled"], [""]], bucket: "not_converted" },
        { appts: [["No Show"], ["Arrived"]], bucket: "not_converted" },
        // 5 unclassified only
        { appts: [[""]], bucket: "unclassified_only" },
        { appts: [["Arrived"]], bucket: "unclassified_only" },
        { appts: [["MD Out"]], bucket: "unclassified_only" },
        { appts: [["In Room"]], bucket: "unclassified_only" },
        { appts: [[""], ["Checked In Online"]], bucket: "unclassified_only" },
        // 6 no appointment
        { appts: [], bucket: "no_appointment" },
        { appts: [], bucket: "no_appointment" },
        { appts: [], bucket: "no_appointment" },
        { appts: [], bucket: "no_appointment" },
        { appts: [], bucket: "no_appointment" },
        { appts: [["Complete", true]], bucket: "no_appointment" },             // deleted is not on the chart
      ];
      let n = 0;
      for (const [i, pt] of P.entries()) {
        const pid = String(9100000 + i);
        await c.query(
          `INSERT INTO submissions (form_type, first_name, last_name, email, phone, raw_payload, n8n_status, n8n_patient_id, created_at)
           VALUES ('registration', 'T', 'T', 't@example.invalid', '0', '{}'::jsonb, 'success', $1::bigint, $2::timestamptz)`,
          [pid, `2026-07-${String(1 + (i % 28)).padStart(2, "0")}T18:00:00Z`]);
        await c.query(
          `INSERT INTO appointment_sync_windows (window_key, strategy, state, patient_source_id, completed_at)
           VALUES ($1, 'patient_history', 'complete', $2, now())`, [`t-${pid}`, pid]);
        for (const [status, deleted] of pt.appts) {
          n += 1;
          await c.query(
            `INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at,
                                                scheduled_time, source_updated_at, current_status, deleted_flag)
             VALUES ($1, $2, '2026-07-29T15:00:00Z', '2026-08-03T09:00:00Z', '2026-07-29T15:00:00Z', $3, $4)`,
            [`t-a${n}`, pid, status, deleted ?? false]);
        }
      }
      // A July registration no chart was ever linked to: counted as a submission, not a patient.
      await c.query(
        `INSERT INTO submissions (form_type, first_name, last_name, email, phone, raw_payload, n8n_status, created_at)
         VALUES ('registration', 'T', 'T', 't@example.invalid', '0', '{}'::jsonb, 'manual_review', '2026-07-20T18:00:00Z')`);
      await c.query(`INSERT INTO appointment_sync_state (scope_key, watermark, watermark_meaning)
                     VALUES ('practice_incremental', '2026-10-19T12:00:00Z', 'test')
                     ON CONFLICT (scope_key) DO UPDATE SET watermark = EXCLUDED.watermark`);

      const r = await c.query(`SELECT * FROM public.drsnip_conversion_monthly('registration', '2026-07-01', '2026-08-01')`);
      assert.equal(r.rows.length, 1);
      const m = r.rows[0];
      assert.equal(m.row_status, "ok");
      assert.equal(m.status_rules_version, "2");
      assert.equal(m.cohort_total, 24);
      assert.equal(m.covered, 24);
      assert.equal(m.not_covered, 0);
      assert.deepEqual(
        [m.converted, m.not_converted, m.unclassified_only, m.no_appointment], [8, 5, 5, 6]);
      assert.deepEqual(m.withheld, ["unlinked_submissions_small"]);
      assert.equal(m.unlinked_submissions, null, "1 unlinked submission is a small group");
      assert.equal(m.entry_period_complete, true);
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
