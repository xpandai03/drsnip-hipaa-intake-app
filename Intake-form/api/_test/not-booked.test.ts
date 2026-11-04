// Not booked — classification edge cases, totals, and admin-only access.
// Synthetic fixtures only; no real patient data.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { NOT_BOOKED_MONTHS_SQL, NOT_BOOKED_RIGHT_NOW_SQL, pct, shapeNotBooked } from "../_lib/not-booked";
import { makeReq, makeRes } from "./harness";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("shape: totals over complete months, average, headline", () => {
  const months = [
    { form_month: "2026-06", complete: true, cohort: 245, not_booked: 77, canceled_or_no_show: 20, no_appointment: 57 },
    { form_month: "2026-07", complete: true, cohort: 571, not_booked: 185, canceled_or_no_show: 47, no_appointment: 138 },
    { form_month: "2026-08", complete: true, cohort: 621, not_booked: 226, canceled_or_no_show: 56, no_appointment: 170 },
    { form_month: "2026-09", complete: true, cohort: 641, not_booked: 222, canceled_or_no_show: 41, no_appointment: 181 },
    { form_month: "2026-10", complete: false, cohort: 557, not_booked: 243, canceled_or_no_show: 13, no_appointment: 230 },
  ];
  const r = shapeNotBooked(months, { registrations_30d: 649, not_yet_synced: 0, not_booked_now: 278 }, "2026-10-27T14:05:01Z");
  it("totals cover complete months only (June to September)", () => {
    assert.deepEqual(
      [r.totals!.from_month, r.totals!.to_month, r.totals!.cohort, r.totals!.not_booked, r.totals!.canceled_or_no_show, r.totals!.no_appointment],
      ["2026-06", "2026-09", 2078, 710, 164, 546]);
    assert.equal(r.totals!.avg_not_booked_per_month, 178);
    assert.equal(r.totals!.not_booked_pct, 34.2);
  });
  it("June reads 245 / 77 (31.4%) / 20 / 57", () => {
    const jun = r.months[0];
    assert.deepEqual([jun.cohort, jun.not_booked, jun.not_booked_pct, jun.canceled_or_no_show, jun.no_appointment], [245, 77, 31.4, 20, 57]);
  });
  it("the headline is generated from the data, with no day count in it", () => {
    assert.equal(r.headline, "Of 2,078 people who registered from June 2026 to September 2026, 34% have not booked.");
    assert.ok(!/\b14\b|day/i.test(r.headline!));
  });
  it("carries the right-now count", () => {
    assert.deepEqual(r.right_now, { registrations_30d: 649, not_yet_synced: 0, not_booked_now: 278 });
  });
  it("never divides by zero", () => {
    assert.equal(pct(3, 0), null);
    assert.equal(shapeNotBooked([], undefined, null).headline, null);
  });
  it("returns counts only — no identifier field anywhere in the queries", () => {
    for (const q of [NOT_BOOKED_MONTHS_SQL, NOT_BOOKED_RIGHT_NOW_SQL]) {
      assert.ok(!/\bpid\b\s+AS|patient_source_id|first_name|last_name|email|phone|date_of_birth/.test(q));
      assert.match(q, /count\(\*\)/);
    }
  });
});

describe("route contract", () => {
  const H = read("../admin/not-booked.ts");
  it("is admin only and time-boxed", () => {
    assert.match(H, /requireAdmin\(req, res\)/);
    assert.match(H, /reportQuery/);
    assert.ok(!/\bdb\.execute\b/.test(H));
  });
  it("signed out gets 401", async () => {
    const { default: handler } = await import("../admin/not-booked");
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

describe(`not-booked classification against Postgres (${live ? "live" : "skipped without CONVERSION_TEST_DATABASE_URL and DATABASE_URL"})`, { skip: !live }, () => {
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
       VALUES ($1,'patient_history','complete',$2,now())`, [`nb-${pid}`, pid]);
    let k = 0;
    // created_at is DrChrono's EASTERN wall-clock stored as UTC (0023): stored
    // 12:00Z is 12:00 ET = 16:00 UTC.
    const appt = (pid: string, status: string, createdEt: string) => c.query(
      `INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag)
       VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '3 days',$3::timestamptz,$4,false)`, [`nb-a${++k}`, pid, createdEt, status]);
    const P = { A: "9400001", B: "9400002", C: "9400003", D: "9400004", E: "9400005", F: "9400006", G: "9400007" };
    for (const p of Object.values(P)) await covered(p);
    // A: registered Jul 1; a converted appointment created on day 15 -> booked.
    await reg(P.A, "2026-07-01T18:00:00Z"); await appt(P.A, "Scheduled", "2026-07-16T12:00:00Z");
    // B: booked.
    await reg(P.B, "2026-07-02T18:00:00Z"); await appt(P.B, "Complete", "2026-07-16T10:00:00Z");
    // C: only blank-status appointments -> ignored, NOT COUNTED at all (rules v3).
    await reg(P.C, "2026-07-03T18:00:00Z"); await appt(P.C, "", "2026-07-05T12:00:00Z"); await appt(P.C, "", "2026-07-20T12:00:00Z");
    // D: no appointment at all -> not booked, no appointment.
    await reg(P.D, "2026-07-04T18:00:00Z");
    // E: canceled only -> not booked, canceled or no show.
    await reg(P.E, "2026-07-05T18:00:00Z"); await appt(P.E, "Cancelled", "2026-07-06T12:00:00Z");
    // F: two registrations; counted once, from the FIRST (Jul 6); booked.
    await reg(P.F, "2026-07-06T18:00:00Z"); await reg(P.F, "2026-07-20T18:00:00Z"); await appt(P.F, "Confirmed", "2026-07-25T12:00:00Z");
    // G: no-show beside an ignored MD In -> not booked, canceled or no show.
    await reg(P.G, "2026-07-07T18:00:00Z"); await appt(P.G, "No Show", "2026-07-10T12:00:00Z"); await appt(P.G, "MD In", "2026-07-11T12:00:00Z");
  });
  after(async () => { await c?.query("ROLLBACK"); await c?.end(); });

  it("July: 6 counted registrations (C ignored), 3 not booked: 2 canceled or no show, 1 no appointment", async () => {
    const rows = (await c.query(NOT_BOOKED_MONTHS_SQL)).rows;
    assert.equal(rows.length, 1, "F is counted once, in July (its first registration)");
    const jul = rows[0];
    assert.equal(jul.form_month, "2026-07");
    assert.equal(jul.complete, true);
    assert.deepEqual([jul.cohort, jul.not_booked, jul.canceled_or_no_show, jul.no_appointment], [6, 3, 2, 1]);
  });

  it("admins get the report; viewers get 403", async () => {
    const { default: handler } = await import("../admin/not-booked");
    const { createSession, SESSION_COOKIE_NAME } = await import("../_lib/auth");
    const { Client } = loadPg();
    const app = new Client({ connectionString: APPDB });
    await app.connect();
    const ids: string[] = [];
    try {
      for (const role of ["admin", "viewer"]) {
        const u = await app.query(
          `INSERT INTO users (email, password_hash, name, role, is_active) VALUES ($1, 'x', 'Test', $2, true) RETURNING id`,
          [`nb-${role}-${Date.now()}@example.invalid`, role]);
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
