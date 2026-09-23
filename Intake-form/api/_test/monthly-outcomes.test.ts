// Monthly patient outcomes — definition, calculation, suppression, boundary.
//
// Every expected number is worked out BY HAND from the fixture and written as a
// literal. A second, independently written classifier (plain TypeScript over the
// raw fixture rows) is also compared against the database function: two
// implementations that agree are evidence; one implementation asked for its own
// answer is not.
//
// Database tests are SKIPPED unless OUTCOMES_TEST_DATABASE_URL (owner) and
// OUTCOMES_TEST_RO_URL (the restricted reporting role) point at a DISPOSABLE
// database carrying migrations through 0021. Never production: they write
// fixtures.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

import {
  OUTCOME_METRICS,
  isOutcomeMetric,
  BUCKETS,
  ANNOTATIONS,
  NO_COMBINED_MEASURE,
  MONTH_RE,
} from "../../lib/metrics/outcomes.js";

const require_ = createRequire(import.meta.url);
const OWNER = process.env.OUTCOMES_TEST_DATABASE_URL;
const RO = process.env.OUTCOMES_TEST_RO_URL;
const live = Boolean(OWNER && RO && !/fly\.dev|flycast|drsnip-intake-db/.test(OWNER + RO));
function loadPg() {
  const e = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(e)] }));
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MIGRATION = read("../../lib/db/migrations/0021_monthly_patient_outcomes.sql");

// The fifteen names exactly as read off DrChrono's settings page, 2026-09-23.
const VERIFIED_NAMES: Record<string, string> = {
  "585137": "Consultation with Vasectomy",
  "874151": "Auction Winner Consultation with Vasectomy",
  "503309": "Consultation Only",
  "585138": "Vasectomy Only",
  "594436": "Repeat DrSnip",
  "594437": "Repeat Outside Provider",
  "594438": "Prior Reversal Vasectomy",
  "886171": "Partial Vasectomy with Consultation",
  "503310": "Follow Up Visit",
  "665139": "Home Visit",
  "866117": "Light Duty Slip Only",
  "873325": "DrSnip Lab Only",
  "874156": "Outside Lab Only",
  "875741": "PVST Mail Order",
  "989114": "Special Accomodations",
};

// ===========================================================================
describe("the definition is data, kept in three separate places", () => {
  it("records all fifteen names exactly, with their UI source and date", () => {
    for (const [id, name] of Object.entries(VERIFIED_NAMES)) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(MIGRATION, new RegExp(`\\('${id}', '${esc}',\\s+'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23'`),
        `${id} ${name}`);
    }
    assert.match(MIGRATION, /'Special Accomodations'/, "the source's own spelling is preserved");
  });

  it("the classification contains no profile id and no status label", () => {
    const body = MIGRATION.split("-- >>> OUTCOME CLASSIFY BODY >>>")[1].split("-- <<< OUTCOME CLASSIFY BODY <<<")[0];
    assert.ok(body.length > 1000, "marker block found");
    assert.ok(!/\b\d{6}\b/.test(body), "a numeric profile id is hard-coded in the calculation");
    for (const label of ["'Complete'", "'Scheduled'", "'Cancelled'", "'Rescheduled'", "'Signed No Review'"]) {
      assert.ok(!body.includes(label), `status ${label} is hard-coded in the calculation`);
    }
  });

  it("seeds exactly one scope, provisional, and approves nothing", () => {
    assert.match(MIGRATION, /'selected_procedure_types', 1, 'provisional'/);
    assert.match(MIGRATION, /Selected procedure appointment types — provisional/);
    assert.ok(!/'approved',\s*jsonb_build_object/.test(MIGRATION));
    assert.ok(!/attendance_mappings/.test(MIGRATION.replace(/--.*$/gm, "")), "the attendance mapping is not touched");
  });

  it("corrects the earlier hypotheses by name, not by behaviour", () => {
    const roles = MIGRATION.split("jsonb_build_array(\n    jsonb_build_object('profile_source_id', '585137'")[1];
    assert.match(roles, /'585138', 'role', 'qualifying'/, "Vasectomy Only is a procedure type, not follow-up testing");
    assert.match(roles, /'875741', 'role', 'excluded_known'/, "PVST Mail Order is a known exclusion");
    assert.match(roles, /'503309', 'role', 'comparison'/, "Consultation Only is compared, not counted");
    for (const id of ["594436", "594437", "594438", "886171", "665139", "989114"]) {
      assert.match(roles, new RegExp(`'${id}', 'role', 'inclusion_undecided'`), id);
    }
    for (const id of ["503310", "873325", "874156", "866117"]) {
      assert.match(roles, new RegExp(`'${id}', 'role', 'excluded_known'`), id);
    }
  });

  it("leaves No Show unclassified — the clinic has not defined it", () => {
    const ended = MIGRATION.match(/'ended_not_active',\s+jsonb_build_array\(([^)]*)\)/)![1];
    assert.ok(!ended.includes("No Show"), "No Show must not be read as an ended appointment");
    for (const k of ["completion", "procedure_not_performed", "active_if_future", "replaced"]) {
      const list = MIGRATION.match(new RegExp(`'${k}',\\s+jsonb_build_array\\(([^)]*)\\)`))![1];
      assert.ok(!list.includes("No Show"), `No Show classified as ${k}`);
    }
    assert.match(MIGRATION, /No Show is DELIBERATELY UNCLASSIFIED/);
  });

  it("does not redefine any existing metric", () => {
    for (const fn of ["drsnip_booking_metric", "drsnip_journey_metric", "drsnip_attendance_metric",
                      "drsnip_attendance_evidence", "drsnip_status_inventory", "drsnip_journey_freshness"]) {
      assert.ok(!MIGRATION.includes(`FUNCTION public.${fn}(`), `${fn} is redefined`);
    }
  });
});

describe("registry and wording", () => {
  it("is a closed allow-list", () => {
    assert.equal(isOutcomeMetric("outcome_registration"), true);
    assert.equal(isOutcomeMetric("outcome_insurance"), true);
    assert.equal(isOutcomeMetric("booking_registration"), false);
    assert.equal(isOutcomeMetric("toString"), false);
  });

  it("never calls anything a conversion, a loss or an outreach list", () => {
    const blob = JSON.stringify({ OUTCOME_METRICS, BUCKETS, ANNOTATIONS }).toLowerCase();
    assert.ok(!/conversion rate|converted/.test(blob));
    // The one permitted use is the disclaimer that says Neither does NOT mean lost.
    const rest = blob.replace("does not mean the patient was lost, did not attend, or should be contacted", "");
    assert.ok(!/\blost\b|\bfailed\b|eligible for outreach/.test(rest));
    assert.match(BUCKETS.neither.detail, /does not mean the patient was lost, did not attend, or should be contacted/);
    assert.match(NO_COMBINED_MEASURE, /No conversion rate/);
  });

  it("does not claim a completion is a procedure", () => {
    assert.match(BUCKETS.completed.means, /does not by itself establish that a procedure was performed/);
  });

  it("accepts whole months only", () => {
    assert.ok(MONTH_RE.test("2026-06"));
    for (const bad of ["2026-6", "2026-06-15", "2026-13", "June", ""]) assert.ok(!MONTH_RE.test(bad), bad);
  });
});

describe("endpoint source contract", () => {
  const src = read("../reports/outcomes.ts");
  const server = read("../../api-server/index.ts");

  it("is registered explicitly", () => {
    assert.match(server, /import reportsOutcomesHandler from "\.\.\/api\/reports\/outcomes";/);
    assert.match(server, /app\.all\("\/api\/reports\/outcomes", adapt\(reportsOutcomesHandler\)\);/);
  });

  it("is auth-guarded and GET-only", () => {
    assert.match(src, /requireAuth\(req, res\)/);
    assert.match(src, /if \(!auth\) return;/);
    assert.match(src, /Method not allowed/);
  });

  it("calls the functions and never reads a PHI table", () => {
    assert.match(src, /drsnip_outcome_metric/);
    assert.match(src, /drsnip_outcome_definition/);
    assert.ok(!src.includes("drsnip_outcome_classify"), "the patient-level classifier must not be reachable");
    for (const t of ["FROM submissions", "FROM appointment_snapshots", "FROM appointment_status_transitions", "public.submissions"]) {
      assert.ok(!src.includes(t), t);
    }
  });

  it("offers no filter beyond metric, scope name and whole months", () => {
    const params = [...src.matchAll(/req\.query\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(params)].sort(), ["from", "metric", "scope", "to"]);
  });

  it("returns no rate and no combined total", () => {
    const code = src.replace(/\/\/.*$/gm, "");
    assert.ok(!/\brate\b\s*:/.test(code), "a rate field is returned");
    assert.ok(!/completed\s*\+\s*scheduled|conversion\s*:/.test(code));
  });

  it("never echoes a driver error", () => {
    assert.ok(!/err.*\.message/.test(src.replace(/\/\/.*$/gm, "")));
  });

  it("maps a refused parameter to 400 through Drizzle's wrapped error", () => {
    // Found over HTTP: Drizzle puts the SQLSTATE on `cause`, so reading only
    // err.code turned an unregistered scope into a 500.
    assert.match(src, /const code = sqlState\(err\);/);
  });

  it("returns months and the cutoff in unambiguous forms", () => {
    // node-pg turns a SQL date into a LOCAL-midnight JS Date; the month is read
    // as text instead. The cutoff is re-serialised as ISO-8601 UTC.
    assert.match(src, /entry_month::text AS entry_month_text/);
    assert.match(src, /toISOString\(\)/);
  });
});

describe("a refused parameter is a 400, not a 500, on every metric route", () => {
  // Regression for a confirmed defect: /booking and /journey answered an entry
  // period the database refuses (SQLSTATE 22023) with 500, because Drizzle
  // wraps the driver error and the routes read only err.code.
  it("sqlState reads the code whether or not the driver error is wrapped", async () => {
    const { sqlState } = await import("../_lib/reporting.js");
    assert.equal(sqlState({ code: "22023" }), "22023", "unwrapped");
    assert.equal(sqlState(Object.assign(new Error("Failed query"), { cause: { code: "22023" } })), "22023", "Drizzle-wrapped");
    assert.equal(sqlState(new Error("no code")), undefined);
    assert.equal(sqlState(null), undefined);
    assert.equal(sqlState({ code: 22023 }), undefined, "only a string SQLSTATE counts");
  });

  for (const route of ["../reports/booking.ts", "../reports/journey.ts", "../reports/attendance.ts",
                       "../attendance-mapping/preview.ts", "../reports/outcomes.ts"]) {
    it(`${route.replace("../", "")} maps 22023 through sqlState`, () => {
      const src = read(route);
      assert.match(src, /const code = sqlState\(err\);\s+if \(code === "22023"\) return res\.status\(400\)/);
      assert.ok(!/\(err as \{ code\?: string \}\)\?\.code/.test(src), "the unwrapped-only read is back");
    });
  }
});

// ===========================================================================
type Row = Record<string, string | null | string[]>;
type Client = { query(t: string, v?: unknown[]): Promise<{ rows: Row[] }>; end(): Promise<void>; connect(): Promise<void> };

describe("the calculation against Postgres (skipped without OUTCOMES_TEST_* URLs)", () => {
  let owner: Client;
  let ro: Client;
  const SNAP = "2026-04-15T00:00:00Z";           // the evidence cutoff; wall clock is irrelevant
  const ENTRY = "2026-03-02T17:00:00Z";          // 09:00 Pacific, 2 March
  const P = (i: number) => String(660000 + i);
  let seq = 0;

  const q = (t: string, v: unknown[] = []) => owner.query(t, v);
  const sub = (pid: string | null, form: string, at: string) => q(
    `INSERT INTO submissions (form_type, first_name, last_name, email, phone, has_insurance_cards, raw_payload, n8n_patient_id, created_at, updated_at)
     VALUES ($1,'T','F','f@example.invalid','000',false,'{}'::jsonb,$2::bigint,$3::timestamptz,$3::timestamptz)`,
    [form, pid, at]);
  const covered = (pid: string) => q(
    `INSERT INTO appointment_sync_windows (window_key, strategy, patient_source_id, state, completed_at)
     VALUES ($1,'patient_history',$2,'complete',$3::timestamptz)`, [`patient:${pid}`, pid, SNAP]);
  const appt = async (pid: string, profile: string | null, status: string | null, sched: string,
                      o: { created?: string; deleted?: boolean; archived?: boolean; history?: string[] } = {}) => {
    seq += 1;
    const id = `oc_${seq}`;
    await q(`INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, profile_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag, archived)
             VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$4::timestamptz,$6,$7,$8)`,
      [id, pid, profile, o.created ?? "2026-03-03T17:00:00Z", sched, status, o.deleted ?? false, o.archived ?? false]);
    for (const [k, to] of (o.history ?? []).entries()) {
      await q(`INSERT INTO appointment_status_transitions (source_appointment_id, transition_at, from_status, to_status, dedupe_key)
               VALUES ($1, '2026-03-10T17:00:00Z'::timestamptz + ($2 || ' hours')::interval, '', $3, $4)`,
        [id, String(k), to, `oc${seq}_${k}`]);
    }
  };

  const Q = "585137", AUCTION = "874151", VAS_ONLY = "585138", CONSULT = "503309",
        PVST = "875741", LAB = "873325", REPEAT = "594436";
  const FUT = "2026-05-01T17:00:00Z";

  // Archetype -> what each of its six patients holds, and the expected answer.
  // Kept as data so the independent classifier and the hand-counts read the
  // same fixture without sharing any classification logic.
  const N = 6;
  let id = 0;
  const wipe = async () => {
    await q(`DELETE FROM appointment_status_transitions WHERE source_appointment_id LIKE 'oc\\_%'`);
    await q(`DELETE FROM appointment_snapshots WHERE source_appointment_id LIKE 'oc\\_%'`);
    await q(`DELETE FROM appointment_sync_windows WHERE window_key LIKE 'patient:66%'`);
    await q(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 660000 AND 669999 OR (n8n_patient_id IS NULL AND email = 'unlinked@example.invalid')`);
  };

  const build = async (kind: string, entry = ENTRY, form = "registration", count = N) => {
    for (let k = 0; k < count; k += 1) {
      id += 1; const p = P(id);
      await sub(p, form, entry);
      if (kind !== "not_covered") await covered(p);
      switch (kind) {
        case "completed":             await appt(p, Q, "Complete", "2026-03-20T17:00:00Z"); break;
        case "completed_future":      await appt(p, Q, "Complete", "2026-03-20T17:00:00Z"); await appt(p, Q, "Scheduled", FUT); break;
        case "cancel_then_active":    await appt(p, Q, "Cancelled", "2026-03-20T17:00:00Z");
                                      await appt(p, Q, "Scheduled", FUT, { created: "2026-03-10T17:00:00Z" }); break;
        case "resched_chain_cancel":  await appt(p, Q, "Rescheduled", "2026-03-20T17:00:00Z");
                                      await appt(p, Q, "Rescheduled", "2026-03-27T17:00:00Z", { created: "2026-03-15T17:00:00Z" });
                                      await appt(p, Q, "Cancelled", "2026-04-05T17:00:00Z", { created: "2026-03-20T17:00:00Z" }); break;
        case "resched_no_replacement":await appt(p, Q, "Rescheduled", "2026-03-20T17:00:00Z"); break;
        case "past_open":             await appt(p, Q, "Confirmed", "2026-04-01T17:00:00Z"); break;
        case "blank_selected":        await appt(p, Q, "", "2026-03-25T17:00:00Z"); break;
        case "blank_pvst_only":       await appt(p, PVST, "", "2026-03-25T17:00:00Z", { created: "2026-03-25T18:00:00Z" }); break;
        case "deleted_completion":    await appt(p, Q, "Complete", "2026-03-20T17:00:00Z", { deleted: true }); break;
        case "deleted_future":        await appt(p, Q, "Scheduled", FUT, { deleted: true }); break;
        case "conflicting_history":   await appt(p, Q, "Cancelled", "2026-03-20T17:00:00Z", { history: ["Checked In", "Complete", "Cancelled"] }); break;
        case "vasectomy_only":        await appt(p, VAS_ONLY, "Complete", "2026-03-25T17:00:00Z"); break;
        case "consult_only":          await appt(p, CONSULT, "Complete", "2026-03-20T17:00:00Z"); break;
        case "pnp":                   await appt(p, Q, "Procedure Not Performed", "2026-03-20T17:00:00Z"); break;
        case "snr":                   await appt(p, Q, "Signed No Review", "2026-03-20T17:00:00Z"); break;
        case "pre_entry_completion":  await appt(p, Q, "Complete", "2026-01-10T18:00:00Z", { created: "2025-12-20T18:00:00Z" }); break;
        case "booked_before_entry":   await appt(p, Q, "Scheduled", FUT, { created: "2026-02-20T18:00:00Z" }); break;
        case "undecided_profile":     await appt(p, REPEAT, "Complete", "2026-03-20T17:00:00Z"); break;
        case "unknown_profile":       await appt(p, "999999", "Scheduled", FUT); break;
        case "unrelated_ambiguity":   await appt(p, Q, "Complete", "2026-03-20T17:00:00Z");
                                      await appt(p, PVST, "", "2026-03-22T17:00:00Z");
                                      await appt(p, REPEAT, "Scheduled", FUT); break;
        case "no_records": break;
        case "not_covered":           await appt(p, Q, "Complete", "2026-03-20T17:00:00Z"); break;
        case "duplicate_submissions": await sub(p, form, "2026-03-20T17:00:00Z"); await appt(p, Q, "Scheduled", FUT); break;
        case "late_cancel":           await appt(p, Q, "Late Cancel within 48 hrs", "2026-03-20T17:00:00Z"); break;
        case "no_show":               await appt(p, Q, "No Show", "2026-03-20T17:00:00Z"); break;
        case "no_show_then_completed":await appt(p, Q, "No Show", "2026-01-15T18:00:00Z", { created: "2026-01-11T18:00:00Z" });
                                      await appt(p, Q, "Complete", "2026-01-25T18:00:00Z", { created: "2026-01-16T18:00:00Z" }); break;
        case "no_show_then_scheduled":await appt(p, Q, "No Show", "2026-01-15T18:00:00Z", { created: "2026-01-11T18:00:00Z" });
                                      await appt(p, Q, "Scheduled", FUT, { created: "2026-01-16T18:00:00Z" }); break;
        case "in_clinic":             await appt(p, Q, "Checked In", "2026-03-20T17:00:00Z"); break;
        case "excluded_lab_future":   await appt(p, LAB, "Scheduled", FUT); break;
        case "same_day_before_entry": await appt(p, Q, "Complete", "2026-03-02T16:00:00Z", { created: "2026-03-02T18:00:00Z" }); break;
        case "previous_day":          await appt(p, Q, "Complete", "2026-03-01T20:00:00Z", { created: "2026-02-20T18:00:00Z" }); break;
        case "null_profile":          await appt(p, null, "Scheduled", FUT); break;
        case "archived":              await appt(p, Q, "Complete", "2026-03-20T17:00:00Z", { archived: true }); break;
        case "comparison_scheduled":  await appt(p, CONSULT, "Scheduled", FUT); break;
        case "auction_winner":        await appt(p, AUCTION, "Scheduled", FUT); break;
        case "resched_then_active":   await appt(p, Q, "Rescheduled", "2026-03-20T17:00:00Z");
                                      await appt(p, Q, "Scheduled", FUT, { created: "2026-03-10T17:00:00Z" }); break;
        case "resched_then_cancelled":await appt(p, Q, "Rescheduled", "2026-03-20T17:00:00Z");
                                      await appt(p, Q, "Cancelled", "2026-04-01T17:00:00Z", { created: "2026-03-10T17:00:00Z" }); break;
        case "late_march_boundary":   await appt(p, Q, "Complete", "2026-04-05T17:00:00Z", { created: "2026-04-02T17:00:00Z" }); break;
        case "feb_boundary":          await appt(p, Q, "Complete", "2026-03-05T17:00:00Z"); break;
        case "april_completed":       await appt(p, Q, "Complete", "2026-04-10T17:00:00Z", { created: "2026-04-03T17:00:00Z" }); break;
        case "april_scheduled":       await appt(p, Q, "Scheduled", FUT, { created: "2026-04-03T17:00:00Z" }); break;
        case "insurance_registered_first": await sub(p, "registration", "2026-01-15T18:00:00Z");
                                      await appt(p, Q, "Complete", "2026-03-20T17:00:00Z"); break;
        default: throw new Error(`unknown archetype ${kind}`);
      }
    }
  };

  before(async () => {
    if (!live) return;
    const { Client: C } = loadPg();
    owner = new C({ connectionString: OWNER! }); ro = new C({ connectionString: RO! });
    await owner.connect(); await ro.connect();
    await wipe();
    for (const k of [
      "completed", "completed_future", "cancel_then_active", "resched_chain_cancel", "resched_no_replacement",
      "past_open", "blank_selected", "blank_pvst_only", "deleted_completion", "deleted_future",
      "conflicting_history", "vasectomy_only", "consult_only", "pnp", "snr", "pre_entry_completion",
      "booked_before_entry", "undecided_profile", "unknown_profile", "unrelated_ambiguity", "no_records",
      "not_covered", "duplicate_submissions", "late_cancel", "no_show", "in_clinic", "excluded_lab_future",
      "same_day_before_entry", "previous_day", "null_profile", "archived", "comparison_scheduled",
      "auction_winner", "resched_then_active", "resched_then_cancelled",
    ]) await build(k);
    await build("late_march_boundary", "2026-04-01T06:30:00Z");   // 23:30 PDT, 31 March
    await build("feb_boundary", "2026-03-01T07:30:00Z");          // 23:30 PST, 28 February
    for (let k = 0; k < 6; k += 1) {                              // unlinked March registrations
      await q(`INSERT INTO submissions (form_type, first_name, last_name, email, phone, has_insurance_cards, raw_payload, created_at, updated_at)
               VALUES ('registration','T','F','unlinked@example.invalid','000',false,'{}'::jsonb,'2026-03-12T17:00:00Z','2026-03-12T17:00:00Z')`);
    }
    // April: an open month with a deliberately small cell.
    await build("april_completed", "2026-04-02T17:00:00Z", "registration", 10);
    await build("april_scheduled", "2026-04-02T17:00:00Z", "registration", 3);
    await build("no_records", "2026-04-02T17:00:00Z", "registration", 8);
    // January: No Show beside a completion, and beside a future booking.
    await build("no_show_then_completed", "2026-01-10T18:00:00Z");
    await build("no_show_then_scheduled", "2026-01-10T18:00:00Z");
    // Insurance, February: half already registered before inquiring.
    await build("insurance_registered_first", "2026-02-10T18:00:00Z", "insurance");
    await build("no_records", "2026-02-10T18:00:00Z", "insurance");
    // Insurance, March: a cohort of three, which must publish nothing.
    await build("completed", "2026-03-10T18:00:00Z", "insurance", 3);
  });

  after(async () => {
    if (!live || !owner) return;
    await wipe();
    await owner.end(); await ro.end();
  });

  const metric = async (m: string, from = "2026-02-01", to = "2026-05-01", c: Client = ro) =>
    (await c.query(`SELECT * FROM public.drsnip_outcome_metric($1, 'selected_procedure_types', $2::date, $3::date)`, [m, from, to])).rows;
  const month = (rows: Row[], m: string) => rows.find((r) => String(r.entry_month).startsWith(m) ||
    new Date(r.entry_month as string).toISOString().startsWith(m))!;
  const n = (r: Row, k: string) => (r[k] === null ? null : Number(r[k]));

  it("places each covered patient in exactly one bucket, and the buckets add up", { skip: !live }, async () => {
    const mar = month(await metric("outcome_registration"), "2026-03");
    // 35 covered archetypes x 6, plus 6 never retrieved.
    assert.equal(n(mar, "cohort_total"), 216);
    assert.equal(n(mar, "covered"), 210);
    assert.equal(n(mar, "not_covered"), 6, "history never retrieved: outside the buckets, not a negative");
    assert.equal(n(mar, "completed")! + n(mar, "scheduled")! + n(mar, "unknown")! + n(mar, "neither")!, 210);
  });

  it("matches the hand count", { skip: !live }, async () => {
    const mar = month(await metric("outcome_registration"), "2026-03");
    // completed: completed, completed_future, vasectomy_only, snr, unrelated_ambiguity,
    //   same_day_before_entry, archived, late_march_boundary                    = 8 x 6
    // scheduled: cancel_then_active, booked_before_entry, duplicate_submissions,
    //   auction_winner, resched_then_active                                     = 5 x 6
    // unknown: resched_no_replacement, past_open, blank_selected, deleted_completion,
    //   conflicting_history, undecided_profile, unknown_profile, in_clinic, null_profile,
    //   no_show (undefined by the clinic, so it establishes nothing)         = 10 x 6
    // neither: the other twelve                                                 = 12 x 6
    assert.equal(n(mar, "completed"), 48);
    assert.equal(n(mar, "scheduled"), 30);
    assert.equal(n(mar, "unknown"), 60);
    assert.equal(n(mar, "neither"), 72);
    assert.equal(mar.row_status, "ok");
    assert.deepEqual(mar.withheld, []);
  });

  it("explains every Unknown, and never turns missing evidence into a negative", { skip: !live }, async () => {
    const mar = month(await metric("outcome_registration"), "2026-03");
    assert.equal(n(mar, "unknown_past_dated_open"), 6);
    assert.equal(n(mar, "unknown_status_unresolved"), 18, "blank on a selected visit, still Checked In, and No Show");
    assert.equal(n(mar, "unknown_rescheduled_no_replacement"), 6);
    assert.equal(n(mar, "unknown_conflicting_history"), 6);
    assert.equal(n(mar, "unknown_deleted_completion"), 6);
    assert.equal(n(mar, "unknown_undecided_profile"), 6);
    assert.equal(n(mar, "unknown_unknown_profile"), 12, "a new id and a NULL profile are both unknown, not excluded");
  });

  it("splits Neither without calling it anything worse", { skip: !live }, async () => {
    const mar = month(await metric("outcome_registration"), "2026-03");
    // no qualifying record: blank_pvst_only, deleted_future, consult_only, pre_entry_completion,
    //   no_records, excluded_lab_future, previous_day, comparison_scheduled  = 8 x 6
    // had one: resched_chain_cancel, pnp, late_cancel, resched_then_cancelled = 4 x 6
    assert.equal(n(mar, "neither_no_qualifying_record"), 48);
    assert.equal(n(mar, "neither_had_qualifying_record"), 24);
  });

  it("reports annotations beside the buckets, never inside them", { skip: !live }, async () => {
    const mar = month(await metric("outcome_registration"), "2026-03");
    assert.equal(n(mar, "completed_with_future_booking"), 6);
    assert.equal(n(mar, "completed_review_withheld_only"), 6, "Signed No Review counts, and is visible");
    assert.equal(n(mar, "procedure_not_performed"), 6, "and is NOT counted as completed");
    assert.equal(n(mar, "comparison_completed"), 6, "Consultation Only completion, for comparison");
    assert.equal(n(mar, "comparison_scheduled"), 6);
    assert.equal(n(mar, "positive_booked_before_entry"), 6);
    assert.equal(n(mar, "prior_completion_before_entry"), 12, "the January visit and the previous-day visit");
    assert.equal(n(mar, "repeat_submitters"), 6, "counted once, at the first submission");
    assert.equal(n(mar, "unlinked_submissions"), 6, "submissions, not people, and outside the cohort");
    assert.equal(n(mar, "registered_before_inquiry"), 0);
  });

  it("a No Show never erases a completion or a current booking elsewhere", { skip: !live }, async () => {
    const jan = month(await metric("outcome_registration", "2026-01-01", "2026-02-01"), "2026-01");
    // 6 No Show + later Complete, 6 No Show + future Scheduled, plus the 6
    // insurance patients who registered on 15 January and completed in March.
    assert.equal(n(jan, "covered"), 18);
    assert.equal(n(jan, "completed"), 12, "No Show then Complete stays Completed");
    assert.equal(n(jan, "scheduled"), 6, "No Show then a future booking stays Scheduled");
    assert.equal(n(jan, "unknown"), 0);
    assert.equal(n(jan, "neither"), 0);
  });

  it("uses the clinic calendar for months and for 'on or after entry'", { skip: !live }, async () => {
    const rows = await metric("outcome_registration");
    const feb = month(rows, "2026-02");
    assert.equal(n(feb, "covered"), 6, "23:30 Pacific on 28 Feb is February, although it is March in UTC");
    assert.equal(n(feb, "completed"), 6);
    // late_march_boundary (23:30 PDT on 31 March) is in March's 48 completed.
    // same_day_before_entry (08:00 on the entry day) counts; previous_day does not.
  });

  it("states how long each month has been observed", { skip: !live }, async () => {
    const rows = await metric("outcome_registration");
    const mar = month(rows, "2026-03"), apr = month(rows, "2026-04");
    assert.equal(mar.entry_period_complete as unknown as boolean, true);
    assert.equal(Number(mar.days_observed_min), 13.7, "1 Apr 00:00 PDT to the cutoff");
    assert.equal(Number(mar.days_observed_max), 44.7, "1 Mar 00:00 PST to the cutoff");
    assert.equal(apr.entry_period_complete as unknown as boolean, false, "April is still open at the cutoff");
    assert.equal(Number(apr.days_observed_min), 0);
  });

  it("withholds a small cell with a partner, and every outcome annotation with it", { skip: !live }, async () => {
    const apr = month(await metric("outcome_registration"), "2026-04");
    // 10 completed, 3 scheduled, 0 unknown, 8 neither: the 3 is withheld, and so
    // is the next-smallest (the 0), so neither can be recovered from covered.
    assert.equal(n(apr, "covered"), 21);
    assert.equal(n(apr, "completed"), 10);
    assert.equal(n(apr, "neither"), 8);
    assert.equal(apr.scheduled, null);
    assert.equal(apr.unknown, null);
    assert.ok((apr.withheld as string[]).includes("partition_small_cell"));
    for (const k of ["neither_no_qualifying_record", "completed_with_future_booking", "comparison_completed",
                     "unknown_past_dated_open", "positive_booked_before_entry"]) {
      assert.equal(apr[k], null, `${k} would bound a withheld bucket`);
    }
  });

  it("publishes nothing about a cohort of three", { skip: !live }, async () => {
    const mar = month(await metric("outcome_insurance"), "2026-03");
    assert.equal(mar.row_status, "suppressed");
    for (const k of ["cohort_total", "covered", "completed", "scheduled", "unknown", "neither"]) {
      assert.equal(mar[k], null, k);
    }
  });

  it("keeps insurance patients who registered first, and says how many", { skip: !live }, async () => {
    const feb = month(await metric("outcome_insurance"), "2026-02");
    assert.equal(n(feb, "covered"), 12);
    assert.equal(n(feb, "completed"), 6);
    assert.equal(n(feb, "neither"), 6);
    assert.equal(n(feb, "registered_before_inquiry"), 6, "not silently removed from the denominator");
  });

  it("judges 'future' against the evidence cutoff, not the clock", { skip: !live }, async () => {
    // The wall clock is months past every fixture date, yet 1 May bookings are
    // active because the evidence is only complete to 15 April. Advance the
    // PRACTICE-WIDE watermark past 1 May and the same records become past-dated
    // and Unknown. (A single patient's catch-up would not move it — 0022; see
    // evidence-cutoff.test.ts.)
    await q(`UPDATE appointment_sync_state SET watermark = '2026-05-02T00:00:00Z' WHERE scope_key = 'practice_incremental'`);
    try {
      const mar = month(await metric("outcome_registration"), "2026-03");
      assert.equal(n(mar, "scheduled"), 0);
      assert.equal(n(mar, "unknown"), 90, "60 + the 30 whose booking date has now passed");
      assert.equal(n(mar, "completed"), 48, "a completion does not move");
    } finally {
      await q(`UPDATE appointment_sync_state SET watermark = NULL WHERE scope_key = 'practice_incremental'`);
    }
  });

  it("agrees with an independently written classifier", { skip: !live }, async () => {
    const got = month(await metric("outcome_registration", "2026-02-01", "2026-05-01", owner), "2026-03");
    const exp = await independentBuckets(owner, "registration", "2026-03-01", "2026-04-01", SNAP);
    assert.deepEqual(
      { completed: n(got, "completed"), scheduled: n(got, "scheduled"), unknown: n(got, "unknown"), neither: n(got, "neither"), not_covered: n(got, "not_covered") },
      exp);
  });

  it("the restricted role reaches aggregates only", { skip: !live }, async () => {
    await assert.rejects(() => ro.query(
      `SELECT * FROM public.drsnip_outcome_classify('[]'::jsonb,'{}'::jsonb,'registration','2026-03-01','2026-04-01')`),
      /permission denied/);
    for (const t of ["submissions", "appointment_snapshots", "appointment_status_transitions"]) {
      await assert.rejects(() => ro.query(`SELECT count(*) FROM ${t}`), /permission denied/);
    }
    const blob = JSON.stringify(await metric("outcome_registration"));
    assert.ok(!/66\d{4}|oc_\d+/.test(blob), "a patient or appointment id left the boundary");
  });

  it("refuses anything off the allow-list", { skip: !live }, async () => {
    const bad = async (m: string, s: string, f: string, t: string, re: RegExp) => assert.rejects(() => ro.query(
      `SELECT * FROM public.drsnip_outcome_metric($1,$2,$3::date,$4::date)`, [m, s, f, t]), re);
    await bad("booking_registration", "selected_procedure_types", "2026-03-01", "2026-04-01", /unsupported metric/);
    await bad("outcome_registration", "anything_else", "2026-03-01", "2026-04-01", /unsupported scope/);
    await bad("outcome_registration", "selected_procedure_types", "2026-03-02", "2026-04-01", /invalid entry period/);
    await bad("outcome_registration", "selected_procedure_types", "2026-03-01", "2026-03-15", /invalid entry period/);
    await bad("outcome_registration", "selected_procedure_types", "2025-12-01", "2026-01-01", /invalid entry period/);
    await bad("outcome_registration", "selected_procedure_types", "2026-01-01", "2027-03-01", /invalid entry period/);
  });

  it("reads out the definition and every stored profile", { skip: !live }, async () => {
    const rows = (await ro.query(`SELECT * FROM public.drsnip_outcome_definition('selected_procedure_types')`)).rows;
    assert.equal(rows[0].scope_state, "provisional");
    for (const [pid, name] of Object.entries(VERIFIED_NAMES)) {
      const r = rows.find((x) => x.profile_source_id === pid)!;
      assert.equal(r.exact_name, name);
      assert.equal(r.name_source, "drchrono_settings_ui");
    }
    const unknown = rows.find((x) => x.profile_source_id === "999999")!;
    assert.equal(unknown.role, "unknown_profile");
    assert.equal(unknown.exact_name, null, "no name is invented for an id nobody has seen named");
    assert.ok(rows.some((x) => x.profile_source_id === null && x.role === "unknown_profile"), "NULL profile is listed");
  });

  it("an approval without provenance is refused, and a scope has one live version", { skip: !live }, async () => {
    await assert.rejects(() => q(
      `INSERT INTO outcome_reporting_scopes (scope_key, version, state, label, description, status_rules_version, profile_roles)
       VALUES ('t_scope', 1, 'approved', 't', 't', '1', '[]')`), /provenance_check/);
    await assert.rejects(() => q(
      `INSERT INTO outcome_reporting_scopes (scope_key, version, state, label, description, status_rules_version, profile_roles)
       VALUES ('selected_procedure_types', 2, 'provisional', 't', 't', '1', '[]')`), /one_live_idx/);
    await assert.rejects(() => q(`UPDATE outcome_status_rules SET state = 'approved' WHERE version = '1'`), /provenance_check/);
  });
});

// ---------------------------------------------------------------------------
// INDEPENDENT CLASSIFIER. Written from the brief's rules, in TypeScript, over
// raw rows — it shares no SQL with the function. Roles and status lists are
// read from the definition tables because they are the DEFINITION, not the
// calculation.
async function independentBuckets(c: Client, form: string, from: string, to: string, cutoff: string) {
  const def = (await c.query(`SELECT s.profile_roles, r.rules FROM outcome_reporting_scopes s
                                JOIN outcome_status_rules r ON r.version = s.status_rules_version
                               WHERE s.scope_key = 'selected_procedure_types' AND s.state <> 'superseded'`)).rows[0] as unknown as
    { profile_roles: { profile_source_id: string; role: string }[]; rules: Record<string, string[]> };
  const role = new Map(def.profile_roles.map((r) => [r.profile_source_id, r.role]));
  const R = def.rules;
  const subs = (await c.query(`SELECT n8n_patient_id::text AS pid, created_at FROM submissions
                                WHERE form_type = $1 AND n8n_patient_id IS NOT NULL`, [form])).rows as unknown as { pid: string; created_at: Date }[];
  const cov = new Set((await c.query(`SELECT patient_source_id FROM appointment_sync_windows
                                       WHERE strategy='patient_history' AND state='complete'`)).rows.map((r) => r.patient_source_id as string));
  const appts = (await c.query(`SELECT source_appointment_id AS id, patient_source_id AS pid, profile_source_id AS prof,
                                       current_status AS st, scheduled_time AS at, source_created_at AS made, deleted_flag AS del
                                  FROM appointment_snapshots`)).rows as unknown as
    { id: string; pid: string; prof: string | null; st: string | null; at: Date; made: Date; del: boolean }[];
  const hist = new Set((await c.query(`SELECT source_appointment_id AS id FROM appointment_status_transitions
                                        WHERE missing_since IS NULL AND to_status = ANY($1)`, [R.completion])).rows.map((r) => r.id as string));

  const pacificDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
  const first = new Map<string, Date>();
  for (const s of subs) {
    const t = new Date(s.created_at);
    if (!first.has(s.pid) || t < first.get(s.pid)!) first.set(s.pid, t);
  }
  const cut = new Date(cutoff).getTime();
  const out = { completed: 0, scheduled: 0, unknown: 0, neither: 0, not_covered: 0 };

  for (const [pid, entry] of first) {
    const day = pacificDay(entry);
    if (day < from || day >= to) continue;
    if (!cov.has(pid)) { out.not_covered += 1; continue; }
    const mine = appts.filter((a) => a.pid === pid);
    const kind = (a: (typeof mine)[number]) => role.get(a.prof ?? "") ?? "unknown_profile";
    const afterEntry = (a: (typeof mine)[number]) => pacificDay(new Date(a.at)) >= day;
    const current = mine.filter((a) => !a.del && afterEntry(a));
    const counted = current.filter((a) => kind(a) === "qualifying");
    const has = (list: string[], s: string | null) => s !== null && list.includes(s);
    const future = (a: (typeof mine)[number]) => new Date(a.at).getTime() > cut;

    if (counted.some((a) => has(R.completion, a.st))) { out.completed += 1; continue; }
    if (counted.some((a) => has(R.active_if_future, a.st) && future(a))) { out.scheduled += 1; continue; }

    const known = [...R.completion, ...R.procedure_not_performed, ...R.active_if_future, ...R.ended_not_active, ...R.replaced];
    const couldBeReplacement = (a: (typeof mine)[number]) => !a.del && kind(a) !== "comparison" && kind(a) !== "excluded_known";
    const ambiguous =
      counted.some((a) => has(R.active_if_future, a.st) && !future(a)) ||
      counted.some((a) => !has(known, a.st)) ||
      counted.some((a) => has(R.replaced, a.st) &&
        !mine.some((b) => b.id !== a.id && couldBeReplacement(b) && new Date(b.made) > new Date(a.made))) ||
      counted.some((a) => !has(R.completion, a.st) && hist.has(a.id)) ||
      mine.some((a) => a.del && afterEntry(a) && kind(a) === "qualifying" && has(R.completion, a.st)) ||
      current.some((a) => ["inclusion_undecided", "unknown_profile"].includes(kind(a)) &&
        (has(R.completion, a.st) || has(R.active_if_future, a.st) || !has(known, a.st)));
    if (ambiguous) out.unknown += 1; else out.neither += 1;
  }
  return out;
}
