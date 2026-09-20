// The aggregate reporting boundary: registry, endpoint contract, and — when a
// disposable database is available — the SECURITY DEFINER function called as
// the ACTUAL restricted role.
//
// SKIPPED against a database unless JOURNEY_TEST_DATABASE_URL (owner) and
// JOURNEY_TEST_RO_URL (the restricted reporting role) are set. Never point
// either at production: the fixtures write rows.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

import {
  JOURNEY_METRICS,
  SUPPORTED_WINDOWS,
  isJourneyMetric,
  describeMetric,
  UNAVAILABLE_METRICS,
} from "../../lib/metrics/registry.js";
import { suppressPartition, suppressDurations } from "../../lib/metrics/contract.js";

const require_ = createRequire(import.meta.url);
const OWNER = process.env.JOURNEY_TEST_DATABASE_URL;
const RO = process.env.JOURNEY_TEST_RO_URL;
const live = Boolean(OWNER && RO);

function loadPg() {
  const dbEntry = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(dbEntry)] }));
}

// ---------------------------------------------------------------------------
describe("metric registry is a closed allow-list", () => {
  it("rejects anything not in the list", () => {
    assert.equal(isJourneyMetric("registration_to_consultation"), true);
    assert.equal(isJourneyMetric("attendance"), false);
    assert.equal(isJourneyMetric("'; DROP TABLE submissions; --"), false);
    assert.equal(isJourneyMetric("toString"), false, "prototype keys must not pass");
    assert.equal(isJourneyMetric(undefined), false);
  });

  it("supports only fixed follow-up windows", () => {
    assert.deepEqual([...SUPPORTED_WINDOWS], [7, 14, 30]);
  });

  it("no label claims booking, arrival or attendance", () => {
    for (const [id, spec] of Object.entries(JOURNEY_METRICS)) {
      const text = `${spec.label} ${spec.countsWhat}`.toLowerCase();
      // "record found" and "form submitted" are what the data supports.
      assert.ok(!/\bbooked\b/.test(spec.label.toLowerCase()), `${id} label says "booked"`);
      assert.ok(!/\battended\b/.test(text), `${id} claims attendance`);
      assert.ok(!/\barrived\b/.test(text), `${id} claims arrival`);
    }
  });

  it("appointment metrics are flagged as observed minima and name their scope", () => {
    for (const id of ["appointment_evidence_registration", "appointment_evidence_insurance"] as const) {
      const s = describeMetric(id);
      assert.equal(s.isObservedMinimum, true);
      assert.match(s.providerScope, /All providers/);
      assert.match(s.providerScope, /NOT confirmed vasectomy/);
    }
  });

  it("form metrics are NOT observed minima — intake data has no coverage gap", () => {
    for (const id of ["registration_to_consultation", "insurance_to_registration"] as const) {
      assert.equal(describeMetric(id).isObservedMinimum, false);
    }
  });

  it("attendance is blocked on transition coverage and mapping — NOT on procedure completion", () => {
    // Procedure completion is a separate question with its own separate
    // answer. Listing it as an attendance prerequisite overstates what is
    // needed to unblock attendance, which an earlier draft did.
    const att = UNAVAILABLE_METRICS.find((m) => m.id === "appointment_attendance_rate")!;
    assert.equal(att.blockers.length, 2);
    assert.ok(!att.blockers.join(" ").toLowerCase().includes("procedure"));
    const proc = UNAVAILABLE_METRICS.find((m) => m.id === "procedure_completed")!;
    assert.ok(proc, "procedure completion is listed as its own unavailable metric");
  });

  it("historical absence is never phrased as 'never booked'", () => {
    const blob = JSON.stringify(JOURNEY_METRICS) + JSON.stringify(UNAVAILABLE_METRICS);
    assert.ok(!/never booked/i.test(blob));
    assert.ok(!/no appointment on record at all/i.test(blob));
    // and the bounded phrasing is present instead
    assert.match(JOURNEY_METRICS.appointment_evidence_registration.coverageNote,
      /bounded by what was retrieved/);
  });
});

describe("suppression across related cells", () => {
  it("withholds a small part AND blocks its recovery by subtraction", () => {
    // 69 total = 67 eligible + 2 excluded. Hiding only the 2 leaves it
    // recoverable as 69 - 67. This exact disclosure was published once.
    const r = suppressPartition([67, 2], 69);
    assert.equal(r.parts[1], null, "the small part is withheld");
    assert.equal(r.parts[0], null, "and so is the part that would reveal it");
    assert.ok(r.withheld >= 2);
  });

  it("leaves a safe partition alone", () => {
    const r = suppressPartition([40, 29], 69);
    assert.deepEqual(r.parts, [40, 29]);
    assert.equal(r.total, 69);
  });

  it("withholds everything when there are too few parts to hide among", () => {
    const r = suppressPartition([2], 2);
    assert.deepEqual(r.parts, [null]);
    assert.equal(r.total, null);
  });

  it("withholds percentiles computed over a handful of people", () => {
    const small = suppressDurations(3, 4.1, 9.0, 12.0);
    assert.equal(small.suppressed, true);
    assert.equal(small.p50_days, null);
    assert.equal(small.p90_days, null, "hiding only p50 still narrows the distribution");

    const ok = suppressDurations(40, 4.1, 9.0, 12.0);
    assert.equal(ok.suppressed, false);
    assert.equal(ok.p50_days, 4.1);
  });
});

describe("endpoint source contract", () => {
  const src = readFileSync(new URL("../reports/journey.ts", import.meta.url), "utf8");

  it("is auth-guarded like every other reporting route", () => {
    assert.match(src, /requireAuth\(req, res\)/);
    assert.match(src, /if \(!auth\) return;/);
  });

  it("rejects non-GET", () => {
    assert.match(src, /Method not allowed/);
  });

  it("calls the function and never queries a PHI table directly", () => {
    assert.match(src, /drsnip_journey_metric/);
    for (const t of ["FROM submissions", "FROM appointment_snapshots", "FROM appointment_status_transitions"]) {
      assert.ok(!src.includes(t), `endpoint must not read ${t} directly`);
    }
  });

  it("never echoes the driver error message to the client", () => {
    assert.ok(!/err.*\.message/.test(src.replace(/\/\/.*$/gm, "")),
      "a driver message can quote the query text");
  });

  it("bounds the requested period server-side", () => {
    assert.match(src, /MAX_SPAN_DAYS/);
    assert.match(src, /period too wide/);
  });
});

// ---------------------------------------------------------------------------
describe("the database boundary, called as the restricted role (skipped without URLs)", () => {
  let owner: { query(t: string, v?: unknown[]): Promise<{ rows: Record<string, never>[] }>; end(): Promise<void>; connect(): Promise<void> };
  let ro: typeof owner;

  before(async () => {
    if (!live) return;
    const { Client } = loadPg();
    owner = new Client({ connectionString: OWNER! });
    ro = new Client({ connectionString: RO! });
    await owner.connect();
    await ro.connect();
    // SCOPED cleanup, not `DELETE FROM submissions`. These suites can share a
    // database and the runner executes files in parallel, so wiping the table
    // deletes another suite's fixtures mid-run. Each suite owns an id range —
    // AND its own entry month, because the metrics count by entry period, so a
    // shared month would inflate both cohorts even with separate ids.
    await owner.query(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 800000 AND 899999`);
    // 40 registrations, 18 of which consult: comfortably above suppression.
    await owner.query(`
      INSERT INTO submissions (form_type, first_name, last_name, email, phone, has_insurance_cards, raw_payload, n8n_patient_id, created_at, updated_at)
      SELECT 'registration','T','F','f@example.invalid','000',false,'{}'::jsonb, 800000+i,
             TIMESTAMPTZ '2026-02-01T17:00:00Z' + (i || ' hours')::interval,
             TIMESTAMPTZ '2026-02-01T17:00:00Z' + (i || ' hours')::interval
        FROM generate_series(1,40) i`);
    await owner.query(`
      INSERT INTO submissions (form_type, first_name, last_name, email, phone, has_insurance_cards, raw_payload, n8n_patient_id, created_at, updated_at)
      SELECT 'consultation','T','F','f@example.invalid','000',false,'{}'::jsonb, 800000+i,
             TIMESTAMPTZ '2026-02-04T17:00:00Z' + (i || ' hours')::interval,
             TIMESTAMPTZ '2026-02-04T17:00:00Z' + (i || ' hours')::interval
        FROM generate_series(1,18) i`);
    // A deliberately tiny insurance cohort, to prove it is withheld.
    await owner.query(`
      INSERT INTO submissions (form_type, first_name, last_name, email, phone, has_insurance_cards, raw_payload, n8n_patient_id, created_at, updated_at)
      SELECT 'insurance','T','F','f@example.invalid','000',false,'{}'::jsonb, 810000+i,
             TIMESTAMPTZ '2026-02-02T17:00:00Z', TIMESTAMPTZ '2026-02-02T17:00:00Z'
        FROM generate_series(1,3) i`);
  });

  after(async () => {
    if (!live || !owner) return;
    await owner.query(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 800000 AND 899999`);
    await owner.end();
    await ro.end();
  });

  const call = (m: string, from: string, to: string, w: number) =>
    ro.query(`SELECT * FROM public.drsnip_journey_metric($1,$2::date,$3::date,$4::int)`, [m, from, to, w]);

  it("the reporting role has NO direct access to the PHI tables", { skip: !live }, async () => {
    for (const t of ["submissions", "appointment_snapshots", "appointment_status_transitions"]) {
      await assert.rejects(() => ro.query(`SELECT count(*) FROM ${t}`), /permission denied/,
        `reporting role can read ${t}`);
    }
  });

  it("but CAN obtain aggregates through the function", { skip: !live }, async () => {
    const r = await call("registration_to_consultation", "2026-02-01", "2026-03-01", 14);
    const row = r.rows[0] as never as Record<string, string | null>;
    assert.equal(Number(row.cohort), 40);
    assert.equal(Number(row.observed_numerator), 18);
    assert.equal(Number(row.denominator), 40, "all 40 entries are mature by now");
    assert.equal(Number(row.numerator), 18);
    assert.equal(row.status, "ok");
  });

  it("a small cohort is withheld ENTIRELY, including its size", { skip: !live }, async () => {
    const r = await call("insurance_to_registration", "2026-02-01", "2026-03-01", 14);
    const row = r.rows[0] as never as Record<string, string | null>;
    // A first version returned cohort = 3 while withholding the rate — the
    // very disclosure the rate suppression existed to prevent.
    for (const k of ["cohort", "numerator", "denominator", "observed_numerator",
                     "observed_denominator", "secondary_a", "matched", "p50_days"]) {
      assert.equal(row[k], null, `${k} leaked for a 3-person cohort`);
    }
    assert.equal(row.status, "suppressed_or_undefined");
  });

  it("rejects every input outside the allow-list", { skip: !live }, async () => {
    await assert.rejects(() => call("attendance", "2026-02-01", "2026-03-01", 14), /unsupported metric/);
    await assert.rejects(() => call("registration_to_consultation", "2026-02-01", "2026-03-01", 13), /unsupported window/);
    await assert.rejects(() => call("registration_to_consultation", "2026-03-01", "2026-02-01", 14), /invalid entry period/);
    await assert.rejects(() => call("registration_to_consultation", "2020-01-01", "2026-03-01", 14), /out of bounds/);
  });

  it("the function owner is not a superuser and cannot reach what it does not need",
    { skip: !live }, async () => {
    const r = await owner.query(`
      SELECT (SELECT rolsuper FROM pg_roles WHERE rolname='drsnip_metrics_fn') AS is_super,
             has_table_privilege('drsnip_metrics_fn','public.users','SELECT') AS users,
             has_table_privilege('drsnip_metrics_fn','public.appointment_status_transitions','SELECT') AS trans,
             has_schema_privilege('drsnip_metrics_fn','public','CREATE') AS can_create,
             has_table_privilege('drsnip_metrics_fn','public.submissions','SELECT') AS subs`);
    const row = r.rows[0] as never as Record<string, boolean>;
    assert.equal(row.is_super, false, "SECURITY DEFINER owned by a superuser would hand callers superuser reach");
    assert.equal(row.users, false);
    assert.equal(row.trans, false);
    assert.equal(row.can_create, false);
    assert.equal(row.subs, true, "it does need submissions");
  });

  it("the function pins a search_path that excludes public and puts pg_temp last",
    { skip: !live }, async () => {
    const r = await owner.query(
      `SELECT unnest(proconfig) AS cfg FROM pg_proc WHERE proname='drsnip_journey_metric'`);
    const cfgs = (r.rows as never as { cfg: string }[]).map((x) => x.cfg);
    const sp = cfgs.find((c) => c.startsWith("search_path="))!;
    assert.ok(sp, "no search_path pinned — that is a privilege-escalation path");
    assert.match(sp, /pg_catalog/);
    assert.ok(sp.trim().endsWith("pg_temp"), "pg_temp must be LAST or it is searched first");
    assert.ok(!/[=,]\s*public\s*(,|$)/.test(sp), "public must not be on the path; objects are schema-qualified");
    assert.ok(cfgs.some((c) => c.startsWith("statement_timeout=")), "no statement timeout");
  });

  it("EXECUTE is revoked from PUBLIC", { skip: !live }, async () => {
    const r = await owner.query(
      `SELECT has_function_privilege('public','public.drsnip_journey_metric(text,date,date,integer)','EXECUTE') AS pub`);
    assert.equal((r.rows[0] as never as { pub: boolean }).pub, false);
  });

  it("freshness reports the appointment snapshot as NOT live", { skip: !live }, async () => {
    const r = await ro.query(`SELECT * FROM public.drsnip_journey_freshness()`);
    const row = r.rows[0] as never as Record<string, unknown>;
    assert.equal(row.appointment_sync_active, false,
      "recurring sync is disabled; the UI must not imply automatic updates");
  });

  it("a September cohort has mature entries — maturity is per entry, not per month",
    { skip: !live }, async () => {
    // Entries dated across September; as-of is now. Some have had 14 days,
    // some have not. The mature denominator must be between the two, never 0
    // just because the month as a whole is young.
    await owner.query(`
      INSERT INTO submissions (form_type, first_name, last_name, email, phone, has_insurance_cards, raw_payload, n8n_patient_id, created_at, updated_at)
      SELECT 'registration','T','F','f@example.invalid','000',false,'{}'::jsonb, 820000+i,
             now() - ((40 - i) || ' days')::interval, now() - ((40 - i) || ' days')::interval
        FROM generate_series(1,30) i`);
    const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const r = await call("registration_to_consultation", from, to, 14);
    const row = r.rows[0] as never as Record<string, string>;
    const cohort = Number(row.cohort);
    const mature = Number(row.denominator);
    assert.ok(mature > 0, "some recent entries HAVE had 14 days — this must not be zero");
    assert.ok(mature < cohort, "and the most recent ones have not, so it is not the whole cohort");
    await owner.query(`DELETE FROM submissions WHERE n8n_patient_id >= 820000 AND n8n_patient_id < 830000`);
  });
});

describe("waterfall states are not conflated", () => {
  const src = readFileSync(
    new URL("../../artifacts/intake-form/src/components/ui/waterfall-chart.tsx", import.meta.url), "utf8");

  it("an unavailable stage does not also claim to be 'not measured'", () => {
    // The caption under a stage label used to be hard-coded to "not measured"
    // for every non-suppressed state, so an `unavailable` stage read "not
    // available" above and "NOT MEASURED" below. They mean different things:
    // nothing tracks it, versus the source cannot answer yet.
    assert.ok(!/: "not measured"\}/.test(src),
      "the caption is hard-coded again; use markerText(stage.state)");
  });
});

describe("the journeys page keeps real and synthetic apart", () => {
  const page = readFileSync(
    new URL("../../artifacts/intake-form/src/pages/admin/Journeys.tsx", import.meta.url), "utf8");

  it("never renders a 'Live' badge for appointments", () => {
    // Recurring sync is disabled; "Live" would promise automatic updates.
    assert.ok(!/>\s*Live\s*</.test(page));
    assert.match(page, /Appointment snapshot — last refreshed/);
  });

  it("states plainly that appointment records do not auto-update", () => {
    assert.match(page, /recurring sync is switched off/);
  });

  it("labels itself as actual data and pulls nothing from the demo", () => {
    assert.match(page, /Actual intake data/);
    assert.ok(!/demo-fixtures/.test(page), "no synthetic fixture may be imported here");
    assert.ok(!/insurance-demo/.test(page.replace(/\/\/.*$/gm, "")),
      "the demo is a separate route, not a data source");
  });

  it("wraps in AdminLayout, so the page is not a navigation dead end", () => {
    // Routes in this app do NOT wrap pages; each page self-wraps. Without it
    // /admin/journeys renders with no nav and no sign-out.
    assert.match(page, /<AdminLayout>/);
    assert.match(page, /from "\.\/AdminLayout"/);
  });

  it("says appointment categories overlap rather than forming a funnel", () => {
    assert.match(page, /overlapping categories, not a funnel/);
  });

  it("a failed request is never rendered as a zero", () => {
    assert.match(page, /a failed request is not a result/i);
    assert.match(page, /placeholderData/, "a refetch failure must keep the last good value");
  });
});
