// Journey metric calculations — synthetic fixtures only.
//
// Every expected number below is worked out BY HAND in the test, from the
// fixture, and written as a literal. None of it is produced by re-running the
// implementation, because a test that asks the code what the answer is only
// proves the code is consistent with itself.
//
// SKIPPED unless METRICS_TEST_DATABASE_URL points at a DISPOSABLE database with
// the migrations applied. Never point it at production: it writes fixtures.
//
// All identifiers are obviously synthetic.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import {
  suppressCount,
  suppressPair,
  buildResult,
  SUPPRESS_BELOW,
  type MetricResult,
} from "../../lib/metrics/contract.js";
import { boundedNegativeClaim, canAnswerCreationWindowExactly } from "../../lib/metrics/coverage.js";
import {
  REGISTRATION_TO_CONSULTATION,
  INSURANCE_TO_REGISTRATION,
  APPOINTMENT_EVIDENCE_AFTER_ENTRY,
  DEFINITION_VERSION,
} from "../../lib/metrics/journey-sql.js";

const require_ = createRequire(import.meta.url);
const URL_ = process.env.METRICS_TEST_DATABASE_URL;
const live = Boolean(URL_);

function loadPg() {
  const dbEntry = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(dbEntry)] }));
}

// ---------------------------------------------------------------------------
// Contract behaviour — no database needed.
// ---------------------------------------------------------------------------
describe("metric contract distinguishes states a bare number would smear", () => {
  const base = {
    id: "t", definition_version: DEFINITION_VERSION, label: "t",
    unit: "distinct_patient_ids" as const, mode: "mature_window" as const,
    window_days: 14, window_basis: "elapsed_hours" as const,
    entry_period: null, eligibility: "", exclusions: [], provider_scope: "all",
    coverage: null, as_of: "2026-09-20T00:00:00Z", freshness: "", provisional_assumptions: [],
  };

  it("a zero denominator is not a zero rate", () => {
    const r = buildResult({ ...base, numerator: 0, denominator: 0 });
    assert.equal(r.status, "zero_denominator");
    assert.equal(r.rate, null, "0/0 must not render as 0%");
    assert.match(r.reason!, /undefined/);
  });

  it("a genuine zero is reported as zero, not as missing", () => {
    const r = buildResult({ ...base, numerator: 0, denominator: 40 });
    assert.equal(r.status, "zero");
    assert.equal(r.rate, 0);
    assert.equal(r.numerator, 0);
  });

  it("a real result carries a fraction, never a formatted string", () => {
    const r = buildResult({ ...base, numerator: 10, denominator: 40 });
    assert.equal(r.status, "ok");
    assert.equal(r.rate, 0.25);
    assert.equal(typeof r.rate, "number");
  });

  it("blocked beats any count", () => {
    const r = buildResult({
      ...base, numerator: 99, denominator: 100,
      hardStatus: { status: "blocked", reason: "staff mapping unconfirmed" },
    });
    assert.equal(r.status, "blocked");
    assert.equal(r.value, null);
    assert.equal(r.numerator, null, "a blocked metric must not leak its counts");
  });
});

describe("small-cell suppression, including complementary disclosure", () => {
  it("suppresses a small non-zero count but reports a true zero", () => {
    assert.equal(suppressCount(0), 0, "nobody did this is not disclosive");
    assert.equal(suppressCount(4), null);
    assert.equal(suppressCount(5), 5);
  });

  it("withholds BOTH sides when the numerator is small", () => {
    // 2/40: publishing denominator 40 with a hidden numerator still narrows it
    // to 1-4, and a published rate would give it away exactly.
    const s = suppressPair(2, 40);
    assert.equal(s.suppressed, true);
    assert.deepEqual([s.numerator, s.denominator, s.rate], [null, null, null]);
  });

  it("withholds when the COMPLEMENT is small — the subtraction attack", () => {
    // 38/40 hides only 2 people. Publishing it identifies them as easily as
    // publishing 2/40 would.
    const s = suppressPair(38, 40);
    assert.equal(s.suppressed, true, "n - k small is as disclosive as k small");
  });

  it("withholds a small denominator outright", () => {
    assert.equal(suppressPair(1, 3).suppressed, true);
  });

  it("publishes when every cell is large enough", () => {
    const s = suppressPair(10, 40);
    assert.equal(s.suppressed, false);
    assert.equal(s.rate, 0.25);
  });

  it("a zero numerator over a large denominator is publishable", () => {
    const s = suppressPair(0, 40);
    assert.equal(s.suppressed, false);
    assert.equal(s.rate, 0);
  });
});

describe("negative claims are bounded by what was actually searched", () => {
  const horizon = { from: "2000-01-01", to: "2028-03-31", contiguous: true, windows_complete: 26 };

  it("a history-complete patient licenses the strong claim", () => {
    const s = boundedNegativeClaim("history_complete", horizon, "2026-09-20T00:00Z");
    assert.match(s, /no date bound/);
    assert.ok(!/does NOT establish/.test(s));
  });

  it("a sweep-only patient licenses only the horizon-bounded claim", () => {
    const s = boundedNegativeClaim("history_not_retrieved", horizon, "2026-09-20T00:00Z");
    assert.match(s, /2000-01-01 and 2028-03-31/);
    assert.match(s, /does NOT establish that the patient has never booked/);
  });

  it("only complete history can answer a creation-time window exactly", () => {
    assert.equal(canAnswerCreationWindowExactly("history_complete"), true);
    assert.equal(canAnswerCreationWindowExactly("history_not_retrieved"), false);
    assert.equal(canAnswerCreationWindowExactly("history_partial_or_failed"), false);
  });
});

// ---------------------------------------------------------------------------
// Calculations against Postgres, on a hand-built fixture.
// ---------------------------------------------------------------------------
describe("journey calculations on synthetic fixtures (skipped without METRICS_TEST_DATABASE_URL)", () => {
  let db: {
    connect(): Promise<void>;
    query(t: string, v?: unknown[]): Promise<{ rows: Record<string, never>[]; rowCount: number | null }>;
    end(): Promise<void>;
  };
  const q = (sql: string, v: unknown[] = []) => db.query(sql, v);
  const one = async (sql: string, v: unknown[] = []) => (await q(sql, v)).rows[0] as never;
  const n = (row: never, k: string) => Number((row as Record<string, string>)[k]);

  // Fixture clock. AS_OF is fixed so maturity is deterministic.
  const AS_OF = "2026-09-20T00:00:00Z";
  const HISTORY_START = "2026-06-15T00:00:00Z";
  const P = (i: number) => String(900000 + i); // synthetic patient ids

  async function sub(patient: number | null, form: string, atIso: string) {
    await q(
      `INSERT INTO submissions (form_type, first_name, last_name, email, phone,
                                has_insurance_cards, raw_payload, n8n_patient_id, created_at, updated_at)
       VALUES ($1,'Test','Fixture','fixture@example.invalid','000-000-0000', false, '{}'::jsonb,
               $2::bigint, $3::timestamptz, $3::timestamptz)`,
      [form, patient === null ? null : P(patient), atIso],
    );
  }
  async function appt(id: string, patient: number, createdIso: string, scheduledIso: string, opts: {
    deleted?: boolean; status?: string | null;
  } = {}) {
    await q(
      `INSERT INTO appointment_snapshots
         (source_appointment_id, patient_source_id, source_created_at, scheduled_time,
          source_updated_at, current_status, deleted_flag, archived)
       VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$3::timestamptz,$5,$6,false)
       ON CONFLICT (source_appointment_id) DO NOTHING`,
      [id, P(patient), createdIso, scheduledIso, opts.status ?? "", opts.deleted ?? false],
    );
  }
  async function historyComplete(patient: number) {
    await q(
      `INSERT INTO appointment_sync_windows (window_key, strategy, patient_source_id, state, completed_at)
       VALUES ($1,'patient_history',$2,'complete', now()) ON CONFLICT (window_key) DO NOTHING`,
      [`patient:${P(patient)}`, P(patient)],
    );
  }

  before(async () => {
    if (!live) return;
    const { Client } = loadPg();
    db = new Client({ connectionString: URL_! });
    await db.connect();
    // Clean slate for repeat runs.
    await q(`DELETE FROM appointment_status_transitions`);
    await q(`UPDATE appointment_sync_windows SET last_run_id = NULL`);
    await q(`DELETE FROM appointment_sync_windows`);
    await q(`DELETE FROM appointment_snapshots`);
    // SCOPED: this suite owns patient ids 9xxxxx and the one unlinked row it
    // inserts. Wiping the whole table would delete a sibling suite's fixtures
    // when both run against the same database in parallel.
    await q(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 900000 AND 999999 OR n8n_patient_id IS NULL`);

    // ---- FIXTURE -------------------------------------------------------
    // P1  straightforward: registers 07-01, consults 07-05 (4 days).
    await sub(1, "registration", "2026-07-01T17:00:00Z");
    await sub(1, "consultation", "2026-07-05T17:00:00Z");

    // P2  registers 07-01, consults 07-20 (19 days: inside 30, outside 14).
    await sub(2, "registration", "2026-07-01T17:00:00Z");
    await sub(2, "consultation", "2026-07-20T17:00:00Z");

    // P3  registers 07-02, never consults.
    await sub(3, "registration", "2026-07-02T17:00:00Z");

    // P4  REPEAT: first registration in JUNE, a second one in July. July must
    //     not treat them as a new entry. Their consultation is 07-10.
    await sub(4, "registration", "2026-06-20T17:00:00Z");
    await sub(4, "registration", "2026-07-03T17:00:00Z");
    await sub(4, "consultation", "2026-07-10T17:00:00Z");

    // P5  consultation BEFORE registration, then another AFTER. The earlier one
    //     must not count, and must not disqualify the later one.
    await sub(5, "consultation", "2026-06-25T17:00:00Z");
    await sub(5, "registration", "2026-07-04T17:00:00Z");
    await sub(5, "consultation", "2026-07-06T17:00:00Z");

    // P6  IMMATURE: registers 2026-09-19, one day before as-of.
    await sub(6, "registration", "2026-09-19T17:00:00Z");

    // P7  SAME-TIMESTAMP TIE: registration and consultation at the same instant.
    //     The outcome requires strictly-after, so this must NOT count.
    await sub(7, "registration", "2026-07-07T17:00:00Z");
    await sub(7, "consultation", "2026-07-07T17:00:00Z");

    // Unlinked submission: no patient id, must be invisible to every metric.
    await sub(null, "registration", "2026-07-08T17:00:00Z");

    // ---- insurance cohort ----------------------------------------------
    // P10 inquiry 08-01 then registers 08-05 -> converted (4 days).
    await sub(10, "insurance", "2026-08-01T17:00:00Z");
    await sub(10, "registration", "2026-08-05T17:00:00Z");
    // P11 inquiry 08-02, no registration.
    await sub(11, "insurance", "2026-08-02T17:00:00Z");
    // P12 ALREADY registered 07-01, inquires 08-03 -> not eligible.
    await sub(12, "registration", "2026-07-01T17:00:00Z");
    await sub(12, "insurance", "2026-08-03T17:00:00Z");
    // P13 inquiry 08-04, registers 08-25 (21 days: outside 14, inside 30).
    await sub(13, "insurance", "2026-08-04T17:00:00Z");
    await sub(13, "registration", "2026-08-25T17:00:00Z");
    // P14 REPEAT inquiries; only the first is the entry. Registers 08-09.
    await sub(14, "insurance", "2026-08-05T17:00:00Z");
    await sub(14, "insurance", "2026-08-07T17:00:00Z");
    await sub(14, "registration", "2026-08-09T17:00:00Z");
    // P15 inquires on the very first day of intake history -> eligibility
    //     unknown, because an earlier registration cannot be ruled out.
    await sub(15, "insurance", "2026-06-15T18:00:00Z");

    // ---- appointment evidence, keyed to the REGISTRATION cohort ---------
    // P1 books forward, inside window: created 07-02, scheduled 07-20.
    await appt("f_p1_a", 1, "2026-07-02T17:00:00Z", "2026-07-20T17:00:00Z");
    // P2 record created AT/AFTER its scheduled time (the 24.7% pattern).
    await appt("f_p2_a", 2, "2026-07-10T18:00:00Z", "2026-07-10T17:00:00Z");
    // P3 books, cancels, rebooks: three records, one patient. Must count once.
    await appt("f_p3_a", 3, "2026-07-03T17:00:00Z", "2026-07-25T17:00:00Z", { status: "Cancelled" });
    await appt("f_p3_b", 3, "2026-07-04T17:00:00Z", "2026-07-26T17:00:00Z", { deleted: true });
    await appt("f_p3_c", 3, "2026-07-05T17:00:00Z", "2026-08-01T17:00:00Z");
    // P4 has a PAST visit predating intake, and also books after entry.
    await appt("f_p4_old", 4, "2024-01-10T17:00:00Z", "2024-02-01T17:00:00Z");
    await appt("f_p4_new", 4, "2026-07-05T17:00:00Z", "2026-07-30T17:00:00Z");
    // P5 had an appointment ALREADY SCHEDULED for the future at entry time.
    await appt("f_p5_pre", 5, "2026-06-01T17:00:00Z", "2026-08-15T17:00:00Z");
    // P7 books far outside the 14-day window (created 60 days after entry).
    await appt("f_p7_late", 7, "2026-09-05T17:00:00Z", "2026-09-30T17:00:00Z");

    // P1 and P3 have complete patient history; the rest do not.
    await historyComplete(1);
    await historyComplete(3);
  });

  after(async () => {
    if (!live || !db) return;
    await q(`DELETE FROM appointment_status_transitions`);
    await q(`DELETE FROM appointment_sync_windows`);
    await q(`DELETE FROM appointment_snapshots`);
    await q(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 900000 AND 999999 OR n8n_patient_id IS NULL`);
    await db.end();
  });

  // --- registration -> consultation ---------------------------------------
  describe("registration → consultation form submitted", () => {
    // July entry period. First-registration entries landing in July:
    //   P1 (07-01), P2 (07-01), P3 (07-02), P5 (07-04), P7 (07-07), P12 (07-01).
    // P12 belongs to the insurance fixture too — the cohorts genuinely overlap,
    // which is exactly why their totals must never be added together.
    // P4's FIRST registration is 2026-06-20, so P4 is a June entry and must be
    // absent from July even though they submitted again on 07-03.
    const JULY: [string, string] = ["2026-07-01", "2026-08-01"];

    it("first entry is computed before the period filter, so a repeat is not a new patient",
      { skip: !live }, async () => {
      const r = await one(REGISTRATION_TO_CONSULTATION, [...JULY, AS_OF, 14]);
      assert.equal(n(r, "cohort"), 6, "P1,P2,P3,P5,P7,P12 — NOT P4 (first registration was in June)");
    });

    it("observed-to-date counts P1, P2 and P5 only", { skip: !live }, async () => {
      // P1 consults 07-05 yes. P2 consults 07-20 yes. P3 never. P5 consults
      // 07-06 (the 06-25 one predates entry and does not count, but also does
      // not disqualify). P7's consultation is at the SAME instant as entry and
      // the definition requires strictly after, so no.
      const r = await one(REGISTRATION_TO_CONSULTATION, [...JULY, AS_OF, 14]);
      assert.equal(n(r, "observed_converted"), 3);
    });

    it("a same-instant consultation does not count as progression", { skip: !live }, async () => {
      const r = await one(
        `SELECT count(*)::int AS c FROM submissions a
          WHERE a.form_type='consultation' AND a.n8n_patient_id::text = $1
            AND a.created_at > (SELECT min(created_at) FROM submissions b
                                 WHERE b.form_type='registration' AND b.n8n_patient_id = a.n8n_patient_id)`,
        [P(7)]);
      assert.equal(n(r, "c"), 0, "strictly-after is what stops a tie being progression");
    });

    it("the 14-day mature window excludes P2, whose consultation took 19 days",
      { skip: !live }, async () => {
      const r = await one(REGISTRATION_TO_CONSULTATION, [...JULY, AS_OF, 14]);
      // All five July entries are older than 14 days at as-of, so all are mature.
      assert.equal(n(r, "mature_cohort"), 6);
      // Within 14 days: P1 (4d) and P5 (2d). P2 took 19d.
      assert.equal(n(r, "mature_converted"), 2);
    });

    it("the 30-day window picks P2 up", { skip: !live }, async () => {
      const r = await one(REGISTRATION_TO_CONSULTATION, [...JULY, AS_OF, 30]);
      assert.equal(n(r, "mature_cohort"), 6);
      assert.equal(n(r, "mature_converted"), 3, "P1 4d, P5 2d, P2 19d");
    });

    it("an immature cohort shrinks the denominator rather than counting as failure",
      { skip: !live }, async () => {
      // September period: only P6, who registered 1 day before as-of.
      const r = await one(REGISTRATION_TO_CONSULTATION, ["2026-09-01", "2026-10-01", AS_OF, 14]);
      assert.equal(n(r, "cohort"), 1);
      assert.equal(n(r, "mature_cohort"), 0,
        "P6 has not had 14 days, so they must not sit in a 14-day denominator");
      assert.equal(n(r, "observed_converted"), 0);
    });

    it("median time-to-consultation matches the hand calculation", { skip: !live }, async () => {
      const r = await one(REGISTRATION_TO_CONSULTATION, [...JULY, AS_OF, 14]);
      // Matched durations: P1 4d, P2 19d, P5 2d -> median 4.
      assert.equal(Number((r as Record<string, string>).p50_days), 4);
    });

    it("an unlinked submission is invisible", { skip: !live }, async () => {
      const r = await one(
        `SELECT count(*)::int AS c FROM submissions WHERE n8n_patient_id IS NULL`);
      assert.equal(n(r, "c"), 1, "the fixture has one, and no metric may count it");
      const m = await one(REGISTRATION_TO_CONSULTATION, [...JULY, AS_OF, 14]);
      assert.equal(n(m, "cohort"), 6, "still 6 — the unlinked row is not in the cohort");
    });

    it("an empty period yields a zero denominator, not a zero rate", { skip: !live }, async () => {
      const r = await one(REGISTRATION_TO_CONSULTATION, ["2025-01-01", "2025-02-01", AS_OF, 14]);
      assert.equal(n(r, "cohort"), 0);
      const built = buildResult({
        id: "x", definition_version: DEFINITION_VERSION, label: "x",
        unit: "distinct_patient_ids", mode: "mature_window", window_days: 14,
        window_basis: "elapsed_hours", entry_period: null, eligibility: "", exclusions: [],
        provider_scope: "all", coverage: null, as_of: AS_OF, freshness: "",
        provisional_assumptions: [], numerator: 0, denominator: n(r, "mature_cohort"),
      });
      assert.equal(built.status, "zero_denominator");
      assert.equal(built.rate, null);
    });
  });

  // --- insurance -> registration -------------------------------------------
  describe("insurance inquiry → registration", () => {
    const AUG: [string, string] = ["2026-08-01", "2026-09-01"];

    it("separates the already-registered from the eligible", { skip: !live }, async () => {
      const r = await one(INSURANCE_TO_REGISTRATION, [...AUG, AS_OF, 14, HISTORY_START]);
      // August inquiry entries: P10, P11, P12, P13, P14. (P15 is June.)
      assert.equal(n(r, "entries_total"), 5);
      assert.equal(n(r, "already_registered"), 1, "P12 registered 07-01, before inquiring");
      assert.equal(n(r, "eligible"), 4, "P10, P11, P13, P14");
    });

    it("repeat inquiries do not create a second cohort entry", { skip: !live }, async () => {
      const r = await one(INSURANCE_TO_REGISTRATION, [...AUG, AS_OF, 14, HISTORY_START]);
      assert.equal(n(r, "entries_total"), 5, "P14 inquired twice and appears once");
    });

    it("observed-to-date counts P10, P13 and P14", { skip: !live }, async () => {
      const r = await one(INSURANCE_TO_REGISTRATION, [...AUG, AS_OF, 14, HISTORY_START]);
      assert.equal(n(r, "observed_converted"), 3, "P11 never registered");
    });

    it("a 14-day window drops P13, whose registration took 21 days", { skip: !live }, async () => {
      const r = await one(INSURANCE_TO_REGISTRATION, [...AUG, AS_OF, 14, HISTORY_START]);
      assert.equal(n(r, "mature_cohort"), 4);
      assert.equal(n(r, "mature_converted"), 2, "P10 4d, P14 4d; P13 took 21d");
      // The distinction the old 37.3% figure lost: observed 3/4 vs 14-day 2/4.
      assert.notEqual(n(r, "observed_converted"), n(r, "mature_converted"));
    });

    it("eligibility is unknown, not assumed, at the edge of intake history",
      { skip: !live }, async () => {
      const r = await one(INSURANCE_TO_REGISTRATION,
        ["2026-06-01", "2026-07-01", AS_OF, 14, HISTORY_START]);
      assert.equal(n(r, "entries_total"), 1, "P15 only");
      assert.equal(n(r, "eligibility_unknown"), 1,
        "an inquiry on day one of intake history cannot be shown to be a first-time patient");
      assert.equal(n(r, "eligible"), 0, "and must not be counted as eligible");
    });
  });

  // --- appointment evidence -------------------------------------------------
  describe("appointment-record evidence after entry", () => {
    const JULY: [string, string] = ["2026-07-01", "2026-08-01"];
    const args = (days: number) => [...JULY, AS_OF, days, "registration"];

    it("counts each patient once however many appointments they hold",
      { skip: !live }, async () => {
      const r = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY, args(30));
      assert.equal(n(r, "cohort"), 6, "P1,P2,P3,P5,P7,P12");
      // Records created after entry within 30 days:
      //   P1 f_p1_a (07-02) yes. P2 f_p2_a (07-10) yes. P3 three records, all
      //   within 30 days -> counted ONCE. P5 only has a record created 06-01,
      //   which predates entry -> no. P7 books on 09-05, 60 days later -> no.
      assert.equal(n(r, "record_created_after_entry"), 3, "P1, P2, P3 — P3 counted once");
    });

    it("forward-scheduled is a strict subset and excludes the at-or-after case",
      { skip: !live }, async () => {
      const r = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY, args(30));
      // P1 created 07-02 for 07-20 -> forward. P3's records are all forward.
      // P2 was created an hour AFTER its scheduled time -> not forward.
      assert.equal(n(r, "forward_scheduled"), 2, "P1 and P3");
      assert.equal(n(r, "created_at_or_after_scheduled"), 1, "P2 only");
      assert.ok(n(r, "forward_scheduled") <= n(r, "record_created_after_entry"));
    });

    it("records created at/after their scheduled time are kept as their own category",
      { skip: !live }, async () => {
      const r = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY, args(30));
      assert.equal(n(r, "created_at_or_after_scheduled"), 1,
        "neither discarded as bad data nor counted as an advance booking");
    });

    it("separates a prior PAST visit from an already-scheduled FUTURE visit",
      { skip: !live }, async () => {
      const r = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY, args(30));
      // Nobody in the JULY cohort has a prior PAST visit: P4's 2024 visit
      // belongs to the June cohort, and P5's pre-existing record was created
      // 06-01 for 08-15 — scheduled AFTER entry, so it is an already-scheduled
      // FUTURE visit, a different thing entirely.
      assert.equal(n(r, "prior_past_visit"), 0);
      assert.equal(n(r, "prior_future_booking"), 1, "P5");
    });

    it("a patient with an old appointment is NOT excluded from new-booking evidence",
      { skip: !live }, async () => {
      // P4 (June cohort) has a 2024 visit and a July booking. In the June
      // period they must still register as having booked after entry.
      const r = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY,
        ["2026-06-01", "2026-07-01", AS_OF, 30, "registration"]);
      assert.equal(n(r, "cohort"), 1, "P4 only");
      assert.equal(n(r, "prior_past_visit"), 1, "the 2024 visit is recorded");
      assert.equal(n(r, "record_created_after_entry"), 1,
        "and it does not disqualify the July booking");
    });

    it("a shorter window excludes a later booking", { skip: !live }, async () => {
      const r7 = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY, args(7));
      // Within 7 days of entry: P1 (1d), P3 (1-3d). P2's record is 9 days after
      // its 07-01 entry, so it drops out.
      assert.equal(n(r7, "record_created_after_entry"), 2, "P1 and P3; P2 is 9 days out");
    });

    it("deleted and cancelled records still count as evidence a record was created",
      { skip: !live }, async () => {
      const r = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY, args(30));
      assert.equal(n(r, "in_window_record_deleted"), 1,
        "P3 has a deleted record and it is reported, not erased");
      assert.equal(n(r, "record_created_after_entry"), 3,
        "P3 still counts: the record was created, whatever happened to it later");
    });

    it("the exact-answer subset is only the history-complete patients",
      { skip: !live }, async () => {
      const r = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY, args(30));
      assert.equal(n(r, "cohort_history_complete"), 2, "P1 and P3");
      assert.equal(n(r, "exact_denominator"), 2);
      assert.equal(n(r, "exact_positive"), 2);
      // P5 and P7 have no in-window record AND no complete history -> unresolved.
      assert.equal(n(r, "unresolved"), 3,
        "P5, P7, P12: not-found without complete history is unresolved, never a confirmed negative");
    });

    it("positives plus unresolved never exceed the cohort", { skip: !live }, async () => {
      const r = await one(APPOINTMENT_EVIDENCE_AFTER_ENTRY, args(30));
      assert.ok(n(r, "record_created_after_entry") + n(r, "unresolved") <= n(r, "cohort"));
    });
  });

  it("the registration and insurance cohorts overlap and must never be summed",
    { skip: !live }, async () => {
    const reg = await one(REGISTRATION_TO_CONSULTATION, ["2026-07-01", "2026-08-01", AS_OF, 14]);
    const ins = await one(INSURANCE_TO_REGISTRATION, ["2026-08-01", "2026-09-01", AS_OF, 14, HISTORY_START]);
    const both = await one(
      `SELECT count(*)::int AS c FROM (
         SELECT n8n_patient_id FROM submissions WHERE form_type='registration' AND n8n_patient_id IS NOT NULL
         INTERSECT
         SELECT n8n_patient_id FROM submissions WHERE form_type='insurance' AND n8n_patient_id IS NOT NULL) x`);
    assert.ok(n(both, "c") >= 1, "P12 and P14 are in both");
    assert.ok(n(reg, "cohort") > 0 && n(ins, "entries_total") > 0);
  });

  // --- transitions ---------------------------------------------------------
  describe("missing transitions are not empty transitions", () => {
    it("distinguishes retrieved-and-empty from never-retrieved", { skip: !live }, async () => {
      // f_p1_a belongs to P1, whose history is complete and who has no
      // transition rows -> genuinely empty. f_p2_a belongs to P2, never probed
      // -> unknown. The difference decides whether "no progression" is a fact.
      const r = await one(
        `SELECT
           (SELECT ${`CASE
              WHEN EXISTS (SELECT 1 FROM appointment_status_transitions t
                            WHERE t.source_appointment_id = s.source_appointment_id)
                THEN 'transitions_retrieved_present'
              WHEN s.patient_source_id IN (
                     SELECT patient_source_id FROM appointment_sync_windows
                      WHERE strategy = 'patient_history' AND state = 'complete')
                THEN 'transitions_retrieved_empty'
              ELSE 'transitions_not_retrieved' END`}
              FROM appointment_snapshots s WHERE s.source_appointment_id='f_p1_a') AS p1,
           (SELECT ${`CASE
              WHEN EXISTS (SELECT 1 FROM appointment_status_transitions t
                            WHERE t.source_appointment_id = s.source_appointment_id)
                THEN 'transitions_retrieved_present'
              WHEN s.patient_source_id IN (
                     SELECT patient_source_id FROM appointment_sync_windows
                      WHERE strategy = 'patient_history' AND state = 'complete')
                THEN 'transitions_retrieved_empty'
              ELSE 'transitions_not_retrieved' END`}
              FROM appointment_snapshots s WHERE s.source_appointment_id='f_p2_a') AS p2`);
      assert.equal((r as Record<string, string>).p1, "transitions_retrieved_empty");
      assert.equal((r as Record<string, string>).p2, "transitions_not_retrieved");
    });
  });

  // --- time handling --------------------------------------------------------
  describe("time handling", () => {
    it("entry-period filters use the Pacific calendar day, not UTC", { skip: !live }, async () => {
      // 2026-07-01T05:00Z is 2026-06-30 22:00 Pacific — a JUNE entry.
      await sub(90, "registration", "2026-07-01T05:00:00Z");
      const july = await one(REGISTRATION_TO_CONSULTATION, ["2026-07-01", "2026-08-01", AS_OF, 14]);
      const june = await one(REGISTRATION_TO_CONSULTATION, ["2026-06-01", "2026-07-01", AS_OF, 14]);
      assert.equal(n(july, "cohort"), 6, "unchanged: the new entry is not a July one");
      assert.equal(n(june, "cohort"), 2, "P4 plus the boundary patient");
      await q(`DELETE FROM submissions WHERE n8n_patient_id = $1`, [P(90)]);
    });

    it("follow-up windows are elapsed durations, so DST cannot change them",
      { skip: !live }, async () => {
      // 2026-11-01 is the Pacific DST fall-back: that local day is 25 hours.
      // An elapsed 7-day window must stay exactly 168 hours either side of it.
      // First: show the trap. `interval '7 days'` is CALENDAR arithmetic in the
      // session time zone, so a window spanning the Pacific fall-back is 169
      // hours — a cohort would get an extra hour purely because of when it fell.
      await q(`SET TIME ZONE 'America/Los_Angeles'`);
      const bad = await one(
        `SELECT EXTRACT(EPOCH FROM (($1::timestamptz + interval '7 days') - $1::timestamptz))/3600 AS h`,
        ["2026-10-29T12:00:00Z"]);
      assert.equal(Number((bad as Record<string, string>).h), 169,
        "calendar-day arithmetic is NOT 168 hours across DST — this is why the SQL uses hours");

      // What the metric SQL actually does: hours, identical either side of DST
      // and independent of the session time zone.
      const good = await one(
        `SELECT EXTRACT(EPOCH FROM (($1::timestamptz + ((7*24) || ' hours')::interval) - $1::timestamptz))/3600 AS h_dst,
                EXTRACT(EPOCH FROM (($2::timestamptz + ((7*24) || ' hours')::interval) - $2::timestamptz))/3600 AS h_plain`,
        ["2026-10-29T12:00:00Z", "2026-07-01T12:00:00Z"]);
      assert.equal(Number((good as Record<string, string>).h_dst), 168);
      assert.equal(Number((good as Record<string, string>).h_plain), 168,
        "both cohorts get identical time, which is what makes them comparable");
      await q(`SET TIME ZONE 'UTC'`);
    });
  });
});

describe("the SQL modules are well-formed", () => {
  it("no exported SQL contains a backtick, which would terminate its template literal", () => {
    // This has bitten twice: a backtick inside a SQL comment ends the template
    // and the failure surfaces as an unrelated syntax error hundreds of lines
    // away. Cheap to assert, expensive to debug.
    const src = require_("node:fs").readFileSync(
      new URL("../../lib/metrics/journey-sql.ts", import.meta.url), "utf8") as string;
    for (const m of src.matchAll(/export const [A-Z_]+ = `([\s\S]*?)`;/g)) {
      assert.ok(!m[1].includes("`"), "a SQL template literal contains a backtick");
    }
  });

  it("every SQL statement is parameterized, never interpolated with a value", () => {
    const src = require_("node:fs").readFileSync(
      new URL("../../lib/metrics/journey-sql.ts", import.meta.url), "utf8") as string;
    for (const m of src.matchAll(/export const [A-Z_]+ = `([\s\S]*?)`;/g)) {
      const interpolations = [...m[1].matchAll(/\$\{(\w+)\}/g)].map((x) => x[1]);
      for (const name of interpolations) {
        assert.equal(name, "ENTRY_PERIOD_FILTER",
          "only a fixed, value-free SQL fragment may be interpolated");
      }
    }
  });
});
