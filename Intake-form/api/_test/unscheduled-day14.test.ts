// Unscheduled at day 14 — classification edge cases, totals, and admin-only access.
// Synthetic fixtures only; no real patient data.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { DAY14_MONTHS_SQL, DAY14_RIGHT_NOW_SQL, pct, shapeDay14 } from "../_lib/unscheduled-day14";
import { makeReq, makeRes } from "./harness";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("shape: totals over complete months, average, headline", () => {
  const months = [
    { form_month: "2026-06", complete: true, cohort: 245, unscheduled_d14: 101, booked_later: 24, never: 77, never_no_appointment: 57, never_canceled_or_no_show: 20, never_no_status_only: 0 },
    { form_month: "2026-07", complete: true, cohort: 571, unscheduled_d14: 239, booked_later: 54, never: 185, never_no_appointment: 138, never_canceled_or_no_show: 47, never_no_status_only: 0 },
    { form_month: "2026-08", complete: true, cohort: 621, unscheduled_d14: 265, booked_later: 39, never: 226, never_no_appointment: 170, never_canceled_or_no_show: 56, never_no_status_only: 0 },
    { form_month: "2026-09", complete: true, cohort: 641, unscheduled_d14: 267, booked_later: 45, never: 222, never_no_appointment: 180, never_canceled_or_no_show: 41, never_no_status_only: 1 },
    { form_month: "2026-10", complete: false, cohort: 557, unscheduled_d14: 250, booked_later: 7, never: 243, never_no_appointment: 230, never_canceled_or_no_show: 13, never_no_status_only: 0 },
  ];
  const r = shapeDay14(months, { registrations_30d: 649, not_yet_synced: 0, nothing_booked_now: 278, past_day_14: 114 }, "2026-10-27T14:05:01Z");
  it("totals cover complete months only (June to September)", () => {
    assert.deepEqual(
      [r.totals!.from_month, r.totals!.to_month, r.totals!.cohort, r.totals!.unscheduled_d14, r.totals!.booked_later, r.totals!.never],
      ["2026-06", "2026-09", 2078, 872, 162, 710]);
    assert.equal(r.totals!.avg_unscheduled_per_month, 218);
    assert.equal(r.totals!.never_pct, 81.4);
  });
  it("June reads 245 / 101 (41.2%) / 24 / 77", () => {
    const jun = r.months[0];
    assert.deepEqual([jun.cohort, jun.unscheduled_d14, jun.unscheduled_pct, jun.booked_later, jun.never], [245, 101, 41.2, 24, 77]);
  });
  it("the headline is generated from the data", () => {
    assert.equal(r.headline, "Of people with nothing booked at day 14, 81% never booked.");
  });
  it("never divides by zero", () => {
    assert.equal(pct(3, 0), null);
    assert.equal(shapeDay14([], undefined, null).headline, null);
  });
  it("returns counts only — no identifier field anywhere in the queries", () => {
    for (const q of [DAY14_MONTHS_SQL, DAY14_RIGHT_NOW_SQL]) {
      assert.ok(!/\bpid\b\s+AS|patient_source_id|first_name|last_name|email|phone|date_of_birth/.test(q));
      assert.match(q, /count\(\*\)/);
    }
  });
});

describe("route contract", () => {
  const H = read("../admin/unscheduled-day14.ts");
  it("is admin only and time-boxed", () => {
    assert.match(H, /requireAdmin\(req, res\)/);
    assert.match(H, /reportQuery/);
    assert.ok(!/\bdb\.execute\b/.test(H));
  });
  it("signed out gets 401", async () => {
    const { default: handler } = await import("../admin/unscheduled-day14");
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    assert.equal(res.statusCode, 401);
  });
});

const OWNER = process.env.CONVERSION_TEST_DATABASE_URL;
const APPDB = process.env.DATABASE_URL;
const live = Boolean(OWNER && APPDB && !/fly\.dev|flycast|drsnip-intake-db/.test(OWNER + APPDB));
function loadPg() {
  const require_ = createRequire(import.meta.url);
  return require_(require_.resolve("pg", { paths: [dirname(require_.resolve("@workspace/db"))] }));
}

describe(`day-14 classification against Postgres (${live ? "live" : "skipped without CONVERSION_TEST_DATABASE_URL and DATABASE_URL"})`, { skip: !live }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c: any;
  before(async () => {
    const { Client } = loadPg();
    c = new Client({ connectionString: OWNER });
    await c.connect();
    await c.query("BEGIN");
    await c.query(`DELETE FROM appointment_status_transitions; DELETE FROM appointment_snapshots;
                   DELETE FROM appointment_sync_windows; DELETE FROM submissions;`);
    const reg = (pid: string, at: string) => c.query(
      `INSERT INTO submissions (form_type, first_name, last_name, email, phone, raw_payload, n8n_status, n8n_patient_id, created_at)
       VALUES ('registration','T','T','t@example.invalid','0','{}'::jsonb,'success',$1::bigint,$2::timestamptz)`, [pid, at]);
    const covered = (pid: string) => c.query(
      `INSERT INTO appointment_sync_windows (window_key, strategy, state, patient_source_id, completed_at)
       VALUES ($1,'patient_history','complete',$2,now())`, [`d14-${pid}`, pid]);
    let k = 0;
    // created_at is DrChrono's EASTERN wall-clock stored as UTC (0023): stored
    // 12:00Z is 12:00 ET = 16:00 UTC.
    const appt = (pid: string, status: string, createdEt: string) => c.query(
      `INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag)
       VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '3 days',$3::timestamptz,$4,false)`, [`d14-a${++k}`, pid, createdEt, status]);
    const P = { A: "9400001", B: "9400002", C: "9400003", D: "9400004", E: "9400005", F: "9400006", G: "9400007" };
    for (const p of Object.values(P)) await covered(p);
    // A: registered Jul 1 18:00Z; first converted appointment created on day 15 -> booked later.
    await reg(P.A, "2026-07-01T18:00:00Z"); await appt(P.A, "Scheduled", "2026-07-16T12:00:00Z");
    // B: registered Jul 2 18:00Z; created Jul 16 10:00 ET = 14:00Z, inside day 14 -> booked by day 14.
    await reg(P.B, "2026-07-02T18:00:00Z"); await appt(P.B, "Complete", "2026-07-16T10:00:00Z");
    // C: only blank-status appointments -> never booked, "no status only" (not "no appointment").
    await reg(P.C, "2026-07-03T18:00:00Z"); await appt(P.C, "", "2026-07-05T12:00:00Z"); await appt(P.C, "", "2026-07-20T12:00:00Z");
    // D: no appointment at all.
    await reg(P.D, "2026-07-04T18:00:00Z");
    // E: canceled only.
    await reg(P.E, "2026-07-05T18:00:00Z"); await appt(P.E, "Cancelled", "2026-07-06T12:00:00Z");
    // F: two registrations; counted once, from the FIRST (Jul 6). Booked Jul 25 = day 19 -> later,
    //    although it would be day 5 from the second registration.
    await reg(P.F, "2026-07-06T18:00:00Z"); await reg(P.F, "2026-07-20T18:00:00Z"); await appt(P.F, "Confirmed", "2026-07-25T12:00:00Z");
    // G: appointment made BEFORE the registration -> booked by day 14.
    await reg(P.G, "2026-07-07T18:00:00Z"); await appt(P.G, "Complete", "2026-06-30T12:00:00Z");
  });
  after(async () => { await c?.query("ROLLBACK"); await c?.end(); });

  it("July: 7 registrations, 5 with nothing booked by day 14, 2 booked later, 3 never (1 / 1 / 1)", async () => {
    const rows = (await c.query(DAY14_MONTHS_SQL)).rows;
    assert.equal(rows.length, 1, "F is counted once, in July (its first registration)");
    const jul = rows[0];
    assert.equal(jul.form_month, "2026-07");
    assert.equal(jul.complete, true);
    assert.deepEqual(
      [jul.cohort, jul.unscheduled_d14, jul.booked_later, jul.never, jul.never_no_appointment, jul.never_canceled_or_no_show, jul.never_no_status_only],
      [7, 5, 2, 3, 1, 1, 1]);
  });

  it("admins get the report; viewers get 403", async () => {
    const { default: handler } = await import("../admin/unscheduled-day14");
    const { createSession, SESSION_COOKIE_NAME } = await import("../_lib/auth");
    const { Client } = loadPg();
    const app = new Client({ connectionString: APPDB });
    await app.connect();
    const ids: string[] = [];
    try {
      for (const role of ["admin", "viewer"]) {
        const u = await app.query(
          `INSERT INTO users (email, password_hash, name, role, is_active) VALUES ($1, 'x', 'Test', $2, true) RETURNING id`,
          [`d14-${role}-${Date.now()}@example.invalid`, role]);
        ids.push(u.rows[0].id);
      }
      const [adminSid, viewerSid] = [await createSession(ids[0]), await createSession(ids[1])];
      const resV = makeRes();
      await handler(makeReq({ method: "GET", cookie: `${SESSION_COOKIE_NAME}=${viewerSid}` }), resV);
      assert.equal(resV.statusCode, 403);
      const resA = makeRes();
      await handler(makeReq({ method: "GET", cookie: `${SESSION_COOKIE_NAME}=${adminSid}` }), resA);
      assert.equal(resA.statusCode, 200);
      assert.ok(Array.isArray((resA.jsonBody as { months: unknown[] }).months));
    } finally {
      await app.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [ids]);
      await app.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
      await app.end();
    }
  });
});
