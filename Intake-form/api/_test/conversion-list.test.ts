// Conversion-by-cohort drill-down: parity with drsnip_conversion_cohorts() for
// every published cell (both forms, both grains), validation, titles, access
// control and logging. Synthetic fixtures only.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  CONVERSION_BUCKETS, conversionCountQuery, conversionListQuery, conversionTitle, parseConversionListParams,
} from "../_lib/conversion-list";
import { buildPatientListCsv } from "../_lib/patient-csv";
import { makeReq, makeRes } from "./harness";

const requireFromDb = createRequire(createRequire(import.meta.url).resolve("@workspace/db"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PgDialect } = requireFromDb("drizzle-orm/pg-core") as { PgDialect: new () => { sqlToQuery: (q: any) => { sql: string; params: unknown[] } } };

describe("parameters and titles", () => {
  const ok = (q: Record<string, string>) => { const p = parseConversionListParams(q, "2026-10-27"); assert.ok(!("error" in p), JSON.stringify(q)); return p; };
  const bad = (q: Record<string, unknown>) => assert.ok("error" in parseConversionListParams(q, "2026-10-27"), JSON.stringify(q));
  it("accepts every bucket for a month or a Monday-start week", () => {
    for (const b of CONVERSION_BUCKETS) {
      ok({ form: "registration", grain: "month", period: "2026-06-01", bucket: b });
      ok({ form: "insurance", grain: "week", period: "2026-10-05", bucket: b });
    }
  });
  it("rejects anything else", () => {
    bad({ form: "consultation", grain: "month", period: "2026-06-01", bucket: "forms" });
    bad({ form: "registration", grain: "day", period: "2026-06-01", bucket: "forms" });
    bad({ form: "registration", grain: "month", period: "2026-06-02", bucket: "forms" });   // not a month start
    bad({ form: "registration", grain: "week", period: "2026-10-06", bucket: "forms" });    // not a Monday
    bad({ form: "registration", grain: "month", period: "2026-11-01", bucket: "forms" });   // future
    bad({ form: "registration", grain: "month", period: "2026-05-01", bucket: "forms" });   // before intake
    bad({ form: "registration", grain: "month", period: "2026-02-30", bucket: "forms" });
    bad({ form: "registration", grain: "month", period: "2026-06-01", bucket: "nope" });
    bad({ form: "registration", grain: "month", period: "2026-06-01'--", bucket: "forms" });
    bad({ form: "registration", grain: "month", period: "2026-06-01", bucket: "forms", page: "0" });
  });
  it("states the list in plain English", () => {
    assert.equal(conversionTitle({ form: "registration", grain: "month", period: "2026-06-01", bucket: "converted_by_plus1" }, 158),
      "Registration, June 2026: converted by end of July (158)");
    assert.equal(conversionTitle({ form: "registration", grain: "month", period: "2026-06-01", bucket: "converted_now" }, 168),
      "Registration, June 2026: converted as of today (168)");
    assert.equal(conversionTitle({ form: "insurance", grain: "week", period: "2026-10-05", bucket: "converted_by_end_of_period" }, 5),
      "Insurance inquiry, Week of Oct 5, 2026: converted by end of the week of Oct 5, 2026 (5)");
  });
});

describe("route", () => {
  it("signed out gets 401 (list and CSV)", async () => {
    for (const mod of ["../admin/conversion-list", "../admin/conversion-list-csv"]) {
      const { default: handler } = await import(mod);
      const res = makeRes();
      await handler(makeReq({ method: "GET", query: { form: "registration", grain: "month", period: "2026-06-01", bucket: "forms" } } as never), res);
      assert.equal(res.statusCode, 401, mod);
    }
  });
});

const OWNER = process.env.CONVERSION_TEST_DATABASE_URL;
const APPDB = process.env.DATABASE_URL;
const live = Boolean(OWNER && APPDB && !/fly\.dev|flycast|drsnip-intake-db/.test(OWNER + APPDB));
function loadPg() {
  const require_ = createRequire(import.meta.url);
  return require_(require_.resolve("pg", { paths: [dirname(require_.resolve("@workspace/db"))] }));
}

describe(`parity with drsnip_conversion_cohorts (${live ? "live" : "skipped"})`, { skip: !live }, () => {
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
      SELECT CASE WHEN g % 4 = 0 THEN 'insurance' ELSE 'registration' END, 'Syn', 'P' || g, 's' || g || '@example.invalid', '0', '{}'::jsonb, 'success', 9700000 + g,
             least(timestamptz '2026-06-15 18:00+00' + g * interval '7 hours', now() - interval '1 hour')
        FROM generate_series(1, 480) g;
      INSERT INTO appointment_sync_windows (window_key, strategy, state, patient_source_id, completed_at)
      SELECT 'v-' || g, 'patient_history', 'complete', (9700000 + g)::text, now() FROM generate_series(1, 480) g WHERE g % 29 <> 0;
      INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag)
      SELECT 'v-a' || g || '-' || k, (9700000 + g)::text,
             timestamptz '2026-06-15 18:00+00' + g * interval '7 hours' + ((g * 5 + k * 13) % 95 - 3) * interval '1 day',
             timestamptz '2026-06-15 18:00+00' + g * interval '7 hours' + ((g * 5 + k * 13) % 95) * interval '1 day', now(),
             (ARRAY['Complete','Scheduled','Cancelled','No Show','','Rescheduled','Confirmed'])[1 + (g + k) % 7], false
        FROM generate_series(1, 480) g, generate_series(1, 2) k
       WHERE g % 6 <> 0 AND (k = 1 OR g % 4 = 1)
         AND timestamptz '2026-06-15 18:00+00' + g * interval '7 hours' + ((g * 5 + k * 13) % 95 - 3) * interval '1 day' < now();
      INSERT INTO appointment_sync_state (scope_key, watermark, watermark_meaning) VALUES ('practice_incremental', now() - interval '10 minutes', 'test')
      ON CONFLICT (scope_key) DO UPDATE SET watermark = EXCLUDED.watermark;`);
  });
  after(async () => { await c?.query("ROLLBACK"); await c?.end(); });

  it("every published cell: list total == every-row list == the cohort table's cell", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    let checked = 0;
    for (const form of ["registration", "insurance"] as const) {
      for (const grain of ["month", "week"] as const) {
        const rows = (await c.query(`SELECT *, period_start::text AS ps FROM public.drsnip_conversion_cohorts($1, $2)`, [form, grain])).rows;
        for (const r of rows) {
          if (r.row_status !== "ok") continue;
          const cells: [string, number | null][] = [
            ["forms", r.forms], ["converted_now", r.converted_now],
            ["converted_by_end_of_period", r.fill_p0], ["converted_by_plus1", r.fill_p1],
            ["converted_by_plus2", r.fill_p2], ["converted_by_plus3", r.fill_p3],
          ];
          if (r.forms !== null && r.converted_now !== null) cells.push(["not_converted_now", r.forms - r.converted_now]);
          for (const [bucket, expect] of cells) {
            if (expect === null) continue; // withheld or period not ended: no link on the page
            const p = parseConversionListParams({ form, grain, period: r.ps, bucket }, today);
            assert.ok(!("error" in p), `${form} ${grain} ${r.ps} ${bucket}: ${"error" in p ? p.error : ""}`);
            const total = Number((await run(conversionCountQuery(p as never))).rows[0].total);
            const all = (await run(conversionListQuery(p as never, { all: true }))).rows;
            assert.equal(total, expect, `total ${form} ${grain} ${r.ps} ${bucket}`);
            assert.equal(all.length, expect, `rows ${form} ${grain} ${r.ps} ${bucket}`);
            const csvLines = buildPatientListCsv(all, "https://c", { convertedOn: true }).slice(1).trimEnd().split("\r\n").length - 1;
            assert.equal(csvLines, expect, `csv ${form} ${grain} ${r.ps} ${bucket}`);
            checked += 1;
          }
        }
      }
    }
    assert.ok(checked >= 60, `checked ${checked} cells`);
  });

  it("converted rows carry a 'Converted on' date; unconverted rows do not", async () => {
    const p1 = parseConversionListParams({ form: "registration", grain: "month", period: "2026-07-01", bucket: "converted_now" }, "2026-10-27") as never;
    const p2 = parseConversionListParams({ form: "registration", grain: "month", period: "2026-07-01", bucket: "not_converted_now" }, "2026-10-27") as never;
    const a = (await run(conversionListQuery(p1, { all: true }))).rows;
    const b = (await run(conversionListQuery(p2, { all: true }))).rows;
    assert.ok(a.length > 0 && a.every((x: { converted_on: string | null }) => /^\d{4}-\d{2}-\d{2}$/.test(String(x.converted_on))));
    assert.ok(b.every((x: { converted_on: string | null }) => x.converted_on === null));
  });
});

describe(`access control and logging (${live ? "live" : "skipped"})`, { skip: !live }, () => {
  it("viewer 403, bad params 400, admin 200 with one access row; CSV adds 'Converted on' and logs an export", async () => {
    const { default: list } = await import("../admin/conversion-list");
    const { default: csv } = await import("../admin/conversion-list-csv");
    const { createSession, SESSION_COOKIE_NAME } = await import("../_lib/auth");
    const { Client } = loadPg();
    const app = new Client({ connectionString: APPDB });
    await app.connect();
    const ids: string[] = [];
    try {
      for (const role of ["admin", "viewer"]) {
        const u = await app.query(`INSERT INTO users (email, password_hash, name, role, is_active) VALUES ($1,'x','Test',$2,true) RETURNING id`,
          [`conv-${role}-${Date.now()}@example.invalid`, role]);
        ids.push(u.rows[0].id);
      }
      const [adminSid, viewerSid] = [await createSession(ids[0]), await createSession(ids[1])];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const call = async (h: any, sid: string, query: Record<string, string>) => {
        const res = makeRes();
        Object.assign(res, { send(this: { body?: unknown }, b: unknown) { this.body = b; return this; } });
        await h(makeReq({ method: "GET", cookie: `${SESSION_COOKIE_NAME}=${sid}`, query } as never), res);
        return res as typeof res & { body?: string };
      };
      const q = { form: "registration", grain: "month", period: "2026-06-01", bucket: "converted_now" };
      assert.equal((await call(list, viewerSid, q)).statusCode, 403);
      assert.equal((await call(csv, viewerSid, q)).statusCode, 403);
      assert.equal((await call(list, adminSid, { ...q, bucket: "nope" })).statusCode, 400);
      assert.equal((await call(csv, adminSid, { ...q, period: "2026-06-02" })).statusCode, 400);
      assert.equal((await call(list, adminSid, q)).statusCode, 200);
      const a = (await app.query(`SELECT channel, detail FROM notification_events WHERE kind = 'list_conversion' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      assert.equal(a.channel, "access");
      assert.match(a.detail, new RegExp(`^user=${ids[0]} bucket=converted_now cohort=registration:month:2026-06-01 rows=\\d+ page=1$`));
      const out = await call(csv, adminSid, q);
      assert.equal(out.statusCode, 200);
      assert.ok(String(out.body).startsWith("﻿" + "Patient,First registered,Days since,Most recent appointment,Submission URL,DrChrono chart ID,DrChrono chart URL,Converted on"));
      const e = (await app.query(`SELECT detail FROM notification_events WHERE kind = 'export_patient_list' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      assert.match(e.detail, new RegExp(`^user=${ids[0]} bucket=converted_now cohort=registration:month:2026-06-01 rows=\\d+$`));
    } finally {
      await app.query(`DELETE FROM notification_events WHERE kind IN ('list_conversion','export_patient_list') AND detail LIKE ANY ($1::text[])`, [ids.map((i) => `user=${i}%`)]);
      await app.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [ids]);
      await app.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
      await app.end();
    }
  });
});
