// Drill-down lists behind "Unscheduled at day 14": count parity, access
// control, parameter validation and the access log. Synthetic fixtures only.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { countQuery, listQuery, parseListParams, PAGE_SIZE, cohortKey } from "../_lib/unscheduled-list";
import { DAY14_MONTHS_SQL, DAY14_RIGHT_NOW_SQL, MONTH_BUCKETS, RIGHT_NOW_BUCKETS } from "../_lib/unscheduled-day14";
import { makeReq, makeRes } from "./harness";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
// drizzle-orm is a dependency of @workspace/db; resolve it from there.
const requireFromDb = createRequire(createRequire(import.meta.url).resolve("@workspace/db"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PgDialect } = requireFromDb("drizzle-orm/pg-core") as { PgDialect: new () => { sqlToQuery: (q: any) => { sql: string; params: unknown[] } } };

describe("parameters are allow-listed", () => {
  const ok = (q: Record<string, string>) => { const p = parseListParams(q, "2026-10"); assert.ok(!("error" in p), JSON.stringify(q)); return p; };
  const bad = (q: Record<string, unknown>) => assert.ok("error" in parseListParams(q, "2026-10"), JSON.stringify(q));
  it("accepts every month bucket with a month or the totals range, and the right-now buckets bare", () => {
    for (const b of MONTH_BUCKETS) { ok({ bucket: b, month: "2026-06" }); ok({ bucket: b, range: "2026-06..2026-09" }); }
    for (const b of RIGHT_NOW_BUCKETS) ok({ bucket: b });
    assert.equal((ok({ bucket: "never_no_appt", month: "2026-07", page: "3" }) as { page: number }).page, 3);
  });
  it("rejects anything else", () => {
    bad({});
    bad({ bucket: "never_no_appt" });                                   // month bucket without a cohort
    bad({ bucket: "never_no_appt", month: "2026-06", range: "2026-06..2026-09" });
    bad({ bucket: "drop table", month: "2026-06" });
    bad({ bucket: "never_no_appt", month: "2026-05" });                 // before the first month
    bad({ bucket: "never_no_appt", month: "2026-11" });                 // after the current month
    bad({ bucket: "never_no_appt", month: "2026-6" });
    bad({ bucket: "never_no_appt", month: "2026-06'; --" });
    bad({ bucket: "never_no_appt", range: "2026-09..2026-06" });
    bad({ bucket: "right_now_past_d14", month: "2026-06" });            // right-now takes no cohort
    bad({ bucket: "never_no_appt", month: "2026-06", page: "0" });
    bad({ bucket: "never_no_appt", month: "2026-06", page: "x" });
  });
  it("the bucket reaches SQL only as an allow-listed column; months only as bound parameters", () => {
    const d = new PgDialect();
    const q = d.sqlToQuery(listQuery(ok({ bucket: "never_no_appt", month: "2026-06" }) as never));
    assert.match(q.sql, /WHERE b\.never_no_appt AND b\.entry_month = \$1::date/);
    assert.deepEqual(q.params.slice(0, 1), ["2026-06-01"]);
  });
  it("selects no contact, birth, insurance or clinical field", () => {
    const src = read("../_lib/unscheduled-list.ts").split("export function listQuery")[1];
    for (const f of ["phone", "email", "date_of_birth", "address", "insurance", "raw_payload", "clinical", "reason"]) {
      assert.ok(!new RegExp(`\\b(s|a)\\.${f}`).test(src), f);
    }
  });
});

describe("route contract", () => {
  it("signed out gets 401", async () => {
    const { default: handler } = await import("../admin/unscheduled-list");
    const res = makeRes();
    await handler(makeReq({ method: "GET", query: { bucket: "never_no_appt", month: "2026-06" } } as never), res);
    assert.equal(res.statusCode, 401);
  });
  it("logs access with ids and counts only", () => {
    const h = read("../admin/unscheduled-list.ts");
    assert.match(h, /kind: "list_unscheduled"/);
    assert.match(h, /detail: `user=\$\{auth\.user\.id\} bucket=\$\{p\.bucket\} cohort=\$\{cohortKey\(p\.cohort\)\} rows=\$\{total\} page=\$\{p\.page\}`/);
  });
});

const OWNER = process.env.CONVERSION_TEST_DATABASE_URL;
const APPDB = process.env.DATABASE_URL;
const live = Boolean(OWNER && APPDB && !/fly\.dev|flycast|drsnip-intake-db/.test(OWNER + APPDB));
function loadPg() {
  const require_ = createRequire(import.meta.url);
  return require_(require_.resolve("pg", { paths: [dirname(require_.resolve("@workspace/db"))] }));
}

describe(`count parity against Postgres (${live ? "live" : "skipped without CONVERSION_TEST_DATABASE_URL and DATABASE_URL"})`, { skip: !live }, () => {
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
    await c.query(`DELETE FROM appointment_status_transitions; DELETE FROM appointment_snapshots;
                   DELETE FROM appointment_sync_windows; DELETE FROM submissions;`);
    // 260 synthetic patients across June–October with every outcome, some with a
    // second registration, a few uncovered. Statuses cycle through every class.
    await c.query(`
      INSERT INTO submissions (form_type, first_name, last_name, email, phone, raw_payload, n8n_status, n8n_patient_id, created_at)
      SELECT 'registration', 'Syn', 'P' || g, 's' || g || '@example.invalid', '0', '{}'::jsonb, 'success', 9500000 + g,
             least(timestamptz '2026-06-02 18:00+00' + g * interval '13 hours', now() - interval '1 hour')
        FROM generate_series(1, 260) g;
      INSERT INTO submissions (form_type, first_name, last_name, email, phone, raw_payload, n8n_status, n8n_patient_id, created_at)
      SELECT 'registration', 'Syn', 'P' || g, 's' || g || '@example.invalid', '0', '{}'::jsonb, 'success', 9500000 + g,
             least(timestamptz '2026-06-02 18:00+00' + g * interval '13 hours' + interval '20 days', now() - interval '1 hour')
        FROM generate_series(1, 260, 9) g;
      INSERT INTO appointment_sync_windows (window_key, strategy, state, patient_source_id, completed_at)
      SELECT 'p-' || g, 'patient_history', 'complete', (9500000 + g)::text, now() FROM generate_series(1, 260) g WHERE g % 23 <> 0;
      INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag)
      SELECT 'a-' || g || '-' || k, (9500000 + g)::text,
             timestamptz '2026-06-02 18:00+00' + g * interval '13 hours' + ((g * 7 + k * 11) % 40) * interval '1 day',
             timestamptz '2026-06-02 18:00+00' + g * interval '13 hours' + ((g * 7 + k * 11) % 40 + 5) * interval '1 day', now(),
             (ARRAY['Complete','Scheduled','Cancelled','No Show','','Rescheduled','MD In','Late Cancel within 48 hrs'])[1 + (g + k) % 8],
             (g + k) % 17 = 0
        FROM generate_series(1, 260) g, generate_series(1, 2) k
       WHERE g % 5 <> 0 AND (k = 1 OR g % 3 = 0);`);
  });
  after(async () => { await c?.query("ROLLBACK"); await c?.end(); });

  it("every bucket's list total equals the page's count, for every month, the totals row and right now", async () => {
    const months = (await c.query(DAY14_MONTHS_SQL)).rows as Record<string, number | string | boolean>[];
    const now = (await c.query(DAY14_RIGHT_NOW_SQL)).rows[0];
    assert.ok(months.length >= 4, "fixture spans several months");
    const col: Record<string, string> = {
      unscheduled_d14: "unscheduled_d14", booked_later: "booked_later", never_booked: "never", never_no_appt: "never_no_appointment",
      never_canceled_noshow: "never_canceled_or_no_show", never_no_status: "never_no_status_only",
    };
    const complete = months.filter((m) => m.complete).map((m) => String(m.form_month));
    const cases: { q: Record<string, string>; expect: number }[] = [];
    for (const b of MONTH_BUCKETS) {
      for (const m of months) cases.push({ q: { bucket: b, month: String(m.form_month) }, expect: Number(m[col[b]]) });
      if (complete.length) {
        const sum = months.filter((m) => m.complete).reduce((a, m) => a + Number(m[col[b]]), 0);
        cases.push({ q: { bucket: b, range: `${complete[0]}..${complete[complete.length - 1]}` }, expect: sum });
      }
    }
    cases.push({ q: { bucket: "right_now_unbooked" }, expect: Number(now.nothing_booked_now) });
    cases.push({ q: { bucket: "right_now_past_d14" }, expect: Number(now.past_day_14) });
    const current = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
    let nonZero = 0;
    for (const k of cases) {
      const p = parseListParams(k.q, current);
      assert.ok(!("error" in p), JSON.stringify(k.q));
      const total = Number((await run(countQuery(p as never))).rows[0].total);
      let rows = 0;
      const seen = new Set<string>();
      for (let page = 1; page <= Math.ceil(total / PAGE_SIZE) + 1; page++) {
        const r = (await run(listQuery({ ...(p as object), page } as never))).rows;
        for (const x of r) { assert.ok(!seen.has(x.chart_id), "a patient appears once"); seen.add(x.chart_id); }
        rows += r.length;
      }
      assert.equal(total, k.expect, `total ${cohortKey((p as { cohort: never }).cohort)} ${k.q.bucket}`);
      assert.equal(rows, k.expect, `rows ${JSON.stringify(k.q)}`);
      if (k.expect > 0) nonZero += 1;
    }
    assert.ok(nonZero >= 20, `the fixture exercises most cells (${nonZero} non-empty)`);
  });

  it("list rows carry only the agreed fields, oldest registration first", async () => {
    const p = parseListParams({ bucket: "unscheduled_d14", month: "2026-06" }, "2026-10") as never;
    const r = (await run(listQuery(p))).rows;
    assert.ok(r.length > 0);
    assert.deepEqual(Object.keys(r[0]).sort(),
      ["chart_id", "days_since", "has_appointment", "latest_date", "latest_status", "name", "registered_on", "submission_id"]);
    const dates = r.map((x: { registered_on: string }) => x.registered_on);
    assert.deepEqual(dates, [...dates].sort());
  });
});

describe(`access control, validation and the access log (${live ? "live" : "skipped"})`, { skip: !live }, () => {
  it("viewer 403, bad params 400, admin 200 with one access row and no patient identifier in it", async () => {
    const { default: handler } = await import("../admin/unscheduled-list");
    const { createSession, SESSION_COOKIE_NAME } = await import("../_lib/auth");
    const { Client } = loadPg();
    const app = new Client({ connectionString: APPDB });
    await app.connect();
    const ids: string[] = [];
    try {
      for (const role of ["admin", "viewer"]) {
        const u = await app.query(`INSERT INTO users (email, password_hash, name, role, is_active) VALUES ($1,'x','Test',$2,true) RETURNING id`,
          [`list-${role}-${Date.now()}@example.invalid`, role]);
        ids.push(u.rows[0].id);
      }
      const [adminSid, viewerSid] = [await createSession(ids[0]), await createSession(ids[1])];
      const call = async (sid: string, query: Record<string, string>) => {
        const res = makeRes();
        await handler(makeReq({ method: "GET", cookie: `${SESSION_COOKIE_NAME}=${sid}`, query } as never), res);
        return res;
      };
      assert.equal((await call(viewerSid, { bucket: "never_no_appt", month: "2026-06" })).statusCode, 403);
      assert.equal((await call(adminSid, { bucket: "nope", month: "2026-06" })).statusCode, 400);
      assert.equal((await call(adminSid, { bucket: "never_no_appt" })).statusCode, 400);
      const before = Number((await app.query(`SELECT count(*) FROM notification_events WHERE kind = 'list_unscheduled'`)).rows[0].count);
      const ok = await call(adminSid, { bucket: "never_no_appt", month: "2026-06" });
      assert.equal(ok.statusCode, 200);
      const log = (await app.query(`SELECT channel, outcome, detail, submission_id FROM notification_events WHERE kind = 'list_unscheduled' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      const after = Number((await app.query(`SELECT count(*) FROM notification_events WHERE kind = 'list_unscheduled'`)).rows[0].count);
      assert.equal(after, before + 1, "exactly one access row per call");
      assert.equal(log.channel, "access");
      assert.equal(log.submission_id, null);
      assert.match(log.detail, new RegExp(`^user=${ids[0]} bucket=never_no_appt cohort=2026-06 rows=\\d+ page=1$`));
    } finally {
      await app.query(`DELETE FROM notification_events WHERE kind = 'list_unscheduled' AND detail LIKE ANY ($1::text[])`, [ids.map((i) => `user=${i}%`)]);
      await app.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [ids]);
      await app.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
      await app.end();
    }
  });
});
