// Patient-list CSV export: columns, escaping, every-row parity, access control
// and the access log. Synthetic fixtures only.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { PATIENT_CSV_COLUMNS, buildPatientListCsv, csvCell, csvFilename } from "../_lib/patient-csv";
import { countQuery, listQuery, parseListParams } from "../_lib/unscheduled-list";
import { MONTH_BUCKETS, RIGHT_NOW_BUCKETS } from "../_lib/unscheduled-day14";
import { makeReq, makeRes } from "./harness";

const requireFromDb = createRequire(createRequire(import.meta.url).resolve("@workspace/db"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PgDialect } = requireFromDb("drizzle-orm/pg-core") as { PgDialect: new () => { sqlToQuery: (q: any) => { sql: string; params: unknown[] } } };

const row = (o: Record<string, unknown> = {}) => ({
  chart_id: "123", submission_id: "abc", name: "Syn Patient", registered_on: "2026-06-03", days_since: 146,
  has_appointment: false, latest_status: null, latest_date: null, ...o,
});

describe("CSV shape and safety", () => {
  it("has exactly the seven columns, in order, after a UTF-8 BOM", () => {
    const csv = buildPatientListCsv([row()], "https://console.example");
    assert.ok(csv.startsWith("﻿"));
    const lines = csv.slice(1).trimEnd().split("\r\n");
    assert.equal(lines[0], PATIENT_CSV_COLUMNS.join(","));
    assert.deepEqual([...PATIENT_CSV_COLUMNS], ["Patient", "First registered", "Days since", "Most recent appointment",
      "Submission URL", "DrChrono chart ID", "DrChrono chart URL"]);
    assert.equal(lines[1], "Syn Patient,2026-06-03,146,No appointment,https://console.example/admin/submissions/abc,123,https://app.drchrono.com/chart/123/documents");
  });
  it("neutralises formulas and quotes per RFC 4180", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=x", "\r=x"]) assert.ok(csvCell(v).replace(/^"/, "").startsWith("'"), JSON.stringify(v));
    assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell("Last, First"), `"Last, First"`);
    assert.equal(csvCell('Say "hi"'), `"Say ""hi"""`);
    assert.equal(csvCell("line\nbreak"), `"line\nbreak"`);
    assert.equal(csvCell("2026-06-03"), "2026-06-03");
  });
  it("formats the appointment like the page and leaves a missing chart blank", () => {
    const csv = buildPatientListCsv([
      row({ has_appointment: true, latest_status: "Cancelled", latest_date: "2026-07-01" }),
      row({ has_appointment: true, latest_status: "", latest_date: "2026-07-02" }),
      row({ chart_id: null, submission_id: null }),
    ], "https://c");
    const lines = csv.slice(1).trimEnd().split("\r\n");
    assert.match(lines[1], /,Cancelled · 2026-07-01,/);
    assert.match(lines[2], /,No status · 2026-07-02,/);
    assert.ok(lines[3].endsWith(",,,"), "no submission URL, chart id or chart URL");
  });
  it("names the file without patient data", () => {
    const f = csvFilename("never_no_appt", "2026-06..2026-09", new Date("2026-10-27T18:05:00Z"));
    assert.equal(f, "drsnip-never_no_appt-2026-06-to-2026-09-20261027-1105.csv");
    assert.match(csvFilename("right_now_past_d14", "last-30-days"), /^drsnip-right_now_past_d14-last-30-days-\d{8}-\d{4}\.csv$/);
  });
});

describe("route", () => {
  it("signed out gets 401", async () => {
    const { default: handler } = await import("../admin/unscheduled-list-csv");
    const res = makeRes();
    await handler(makeReq({ method: "GET", query: { bucket: "never_no_appt", month: "2026-06" } } as never), res);
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

describe(`every-row parity against Postgres (${live ? "live" : "skipped"})`, { skip: !live }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c: any;
  const dialect = new PgDialect();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (q: any) => { const r = dialect.sqlToQuery(q); return c.query(r.sql, r.params); };
  before(async () => {
    const { Client } = loadPg();
    c = new Client({ connectionString: OWNER });
    await c.connect();
    await c.query("BEGIN");
    await c.query(`DELETE FROM appointment_status_transitions; DELETE FROM appointment_snapshots; DELETE FROM appointment_sync_windows; DELETE FROM submissions;`);
    await c.query(`
      INSERT INTO submissions (form_type, first_name, last_name, email, phone, raw_payload, n8n_status, n8n_patient_id, created_at)
      SELECT 'registration', CASE WHEN g % 50 = 0 THEN '=cmd' ELSE 'Syn' END, 'P' || g, 's' || g || '@example.invalid', '0', '{}'::jsonb, 'success', 9600000 + g,
             least(timestamptz '2026-06-02 18:00+00' + g * interval '9 hours', now() - interval '1 hour')
        FROM generate_series(1, 400) g;
      INSERT INTO appointment_sync_windows (window_key, strategy, state, patient_source_id, completed_at)
      SELECT 'c-' || g, 'patient_history', 'complete', (9600000 + g)::text, now() FROM generate_series(1, 400) g;
      INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag)
      SELECT 'c-a' || g, (9600000 + g)::text, timestamptz '2026-06-02 18:00+00' + g * interval '9 hours' + (g % 30) * interval '1 day',
             timestamptz '2026-06-02 18:00+00' + g * interval '9 hours' + (g % 30 + 4) * interval '1 day', now(),
             (ARRAY['Complete','','Cancelled','No Show','Scheduled'])[1 + g % 5], false
        FROM generate_series(1, 400) g WHERE g % 4 <> 0;`);
  });
  after(async () => { await c?.query("ROLLBACK"); await c?.end(); });

  it("for every bucket and cohort, CSV rows == list total (the export is every row, not a page)", async () => {
    const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    const current = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
    const qs: Record<string, string>[] = [];
    for (const b of MONTH_BUCKETS) { for (const m of months) if (m <= current) qs.push({ bucket: b, month: m }); qs.push({ bucket: b, range: "2026-06..2026-09" }); }
    for (const b of RIGHT_NOW_BUCKETS) qs.push({ bucket: b });
    let over100 = 0;
    for (const q of qs) {
      const p = parseListParams(q, current);
      assert.ok(!("error" in p));
      const total = Number((await run(countQuery(p as never))).rows[0].total);
      const rows = (await run(listQuery(p as never, { all: true }))).rows;
      const csv = buildPatientListCsv(rows, "https://c");
      const lines = csv.slice(1).trimEnd().split("\r\n").length - 1;
      assert.equal(rows.length, total, JSON.stringify(q));
      assert.equal(lines, total, `csv ${JSON.stringify(q)}`);
      if (total > 100) over100 += 1;
    }
    assert.ok(over100 >= 1, "at least one list is longer than a page");
  });

  it("an '=' name is exported neutralised", async () => {
    const p = parseListParams({ bucket: "unscheduled_d14", range: "2026-06..2026-09" }, "2026-10") as never;
    const csv = buildPatientListCsv((await run(listQuery(p, { all: true }))).rows, "https://c");
    assert.ok(!/(^|,)=cmd/m.test(csv), "no raw formula cell");
    assert.match(csv, /(^|,)'=cmd/m);
  });
});

describe(`access control and the export log (${live ? "live" : "skipped"})`, { skip: !live }, () => {
  it("viewer 403, bad params 400, admin 200 CSV with one export row and no patient identifier", async () => {
    const { default: handler } = await import("../admin/unscheduled-list-csv");
    const { createSession, SESSION_COOKIE_NAME } = await import("../_lib/auth");
    const { Client } = loadPg();
    const app = new Client({ connectionString: APPDB });
    await app.connect();
    const ids: string[] = [];
    try {
      for (const role of ["admin", "viewer"]) {
        const u = await app.query(`INSERT INTO users (email, password_hash, name, role, is_active) VALUES ($1,'x','Test',$2,true) RETURNING id`,
          [`csv-${role}-${Date.now()}@example.invalid`, role]);
        ids.push(u.rows[0].id);
      }
      const [adminSid, viewerSid] = [await createSession(ids[0]), await createSession(ids[1])];
      const call = async (sid: string, query: Record<string, string>) => {
        const res = makeRes();
        // The production adapter has send(); the shared mock only has json().
        Object.assign(res, { send(this: { body?: unknown }, b: unknown) { this.body = b; return this; } });
        await handler(makeReq({ method: "GET", cookie: `${SESSION_COOKIE_NAME}=${sid}`, query } as never), res);
        return res as typeof res & { body?: string };
      };
      assert.equal((await call(viewerSid, { bucket: "never_no_appt", month: "2026-06" })).statusCode, 403);
      assert.equal((await call(adminSid, { bucket: "nope", month: "2026-06" })).statusCode, 400);
      assert.equal((await call(adminSid, { bucket: "never_no_appt", month: "2026-13" })).statusCode, 400);
      const ok = await call(adminSid, { bucket: "never_no_appt", month: "2026-06" });
      assert.equal(ok.statusCode, 200);
      assert.ok(String(ok.body).startsWith("\uFEFF" + "Patient,First registered"));
      assert.match(String(ok.headers["content-type"] ?? ok.headers["Content-Type"]), /text\/csv/);
      assert.match(String(ok.headers["content-disposition"] ?? ok.headers["Content-Disposition"]), /filename="drsnip-never_no_appt-2026-06-\d{8}-\d{4}\.csv"/);
      const log = (await app.query(`SELECT channel, detail, submission_id FROM notification_events WHERE kind = 'export_patient_list' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      assert.equal(log.channel, "export");
      assert.equal(log.submission_id, null);
      assert.match(log.detail, new RegExp(`^user=${ids[0]} bucket=never_no_appt cohort=2026-06 rows=\\d+$`));
    } finally {
      await app.query(`DELETE FROM notification_events WHERE kind = 'export_patient_list' AND detail LIKE ANY ($1::text[])`, [ids.map((i) => `user=${i}%`)]);
      await app.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [ids]);
      await app.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
      await app.end();
    }
  });
});
