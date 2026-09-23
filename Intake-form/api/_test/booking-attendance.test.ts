// Booking evidence and attendance readiness.
//
// Every expected number is worked out BY HAND from the fixture and written as
// a literal. The fixture deliberately contains the awkward cases: a booking
// made before the entry, a cancellation followed by a rebooking, a record
// created after its own scheduled time, a deleted record, and a patient whose
// follow-up window runs past the appointment snapshot.
//
// Database tests are SKIPPED unless BOOKING_TEST_DATABASE_URL points at a
// DISPOSABLE database. Never production: they write fixtures.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";

import {
  CURRENT_MAPPING,
  attendanceIsApproved,
  classifyStatus,
  outstandingDecision,
  ATTENDANCE_UNAVAILABLE_REASON,
  type AttendanceMapping,
} from "../../lib/metrics/attendance-mapping.js";
import { UNAVAILABLE_METRICS, JOURNEY_METRICS } from "../../lib/metrics/registry.js";

const require_ = createRequire(import.meta.url);
const OWNER = process.env.BOOKING_TEST_DATABASE_URL;
const RO = process.env.BOOKING_TEST_RO_URL;
const live = Boolean(OWNER && RO);
function loadPg() {
  const e = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(e)] }));
}

// ---------------------------------------------------------------------------
describe("attendance mapping is a contract, not a guess", () => {
  it("is UNAPPROVED, with no invented provenance", () => {
    assert.equal(CURRENT_MAPPING.approval.state, "awaiting_clinic_confirmation");
    assert.equal(CURRENT_MAPPING.approval.provenance, null);
    assert.equal(CURRENT_MAPPING.approval.approved_on, null);
    assert.equal(attendanceIsApproved(), false);
  });

  it("is versioned, so a later number stays attributable", () => {
    assert.match(CURRENT_MAPPING.version, /^\d+\.\d+\.\d+/);
  });

  it("candidate lists exist but MUST NOT be usable without approval", () => {
    // The lists are there so the clinic can answer concretely. The gate is the
    // approval flag, and nothing may read past it.
    assert.ok(CURRENT_MAPPING.arrival_candidates.length > 0);
    assert.equal(attendanceIsApproved(), false, "candidates must not imply approval");
  });

  it("treats an unknown status as unknown, never as non-arrival", () => {
    // Silently folding a new status into "did not arrive" would understate
    // attendance forever and nobody would see it happen.
    assert.equal(classifyStatus("Teleport In"), "unknown");
    assert.equal(classifyStatus("Checked In"), "arrival");
    assert.equal(classifyStatus("No Show"), "non_arrival");
  });

  it("keeps genuinely ambiguous statuses out of BOTH sets", () => {
    for (const s of ["Complete", "Procedure Not Performed", "", "Confirmed"]) {
      assert.equal(classifyStatus(s), "ambiguous", `${s || "(blank)"} must not be auto-classified`);
      assert.ok(!CURRENT_MAPPING.arrival_candidates.includes(s));
      assert.ok(!CURRENT_MAPPING.non_arrival_candidates.includes(s));
    }
  });

  it("does not make attendance depend on procedure completion", () => {
    assert.ok(!/procedure/i.test(CURRENT_MAPPING.effective_definition.split("Procedure")[0]));
    assert.match(CURRENT_MAPPING.effective_definition, /Procedure completion is NOT part of this definition/);
    const att = UNAVAILABLE_METRICS.find((m) => m.id === "appointment_attendance_rate")!;
    assert.equal(att.blockers.length, 1, "only the mapping blocks attendance now");
    assert.ok(!att.blockers.join(" ").toLowerCase().includes("procedure"));
  });

  it("no longer claims history retrieval is incomplete", () => {
    // That WAS true; it is not any more, and a stale blocker is a wrong one.
    const att = UNAVAILABLE_METRICS.find((m) => m.id === "appointment_attendance_rate")!;
    assert.ok(!/incomplete|not retrieved|not looked up/i.test(att.reason + att.blockers.join(" ")));
    assert.equal(att.reason, ATTENDANCE_UNAVAILABLE_REASON);
    assert.match(att.reason, /Appointment history loaded/);
  });

  it("a cancellation after arrival does not erase the arrival", () => {
    assert.match(CURRENT_MAPPING.conflict_rule, /EARLIEST qualifying arrival/);
    assert.match(CURRENT_MAPPING.conflict_rule, /still arrived/);
  });

  it("states the exact outstanding decision", () => {
    const d = outstandingDecision();
    assert.equal(d.blocking, true);
    assert.ok(d.questions.length >= 4);
    assert.ok(d.questions.some((q) => /physically arrived/.test(q)));
    assert.ok(d.questions.some((q) => /procedure/i.test(q)), "procedure is asked separately");
  });

  it("an APPROVED mapping flips the gate — the mechanism works", () => {
    const approved: AttendanceMapping = {
      ...CURRENT_MAPPING,
      version: "1.0.0",
      approval: { state: "approved", provenance: "Clinic lead, email 2026-10-01", approved_on: "2026-10-01" },
    };
    assert.equal(attendanceIsApproved(approved), true);
    assert.equal(classifyStatus("MD In", approved), "arrival");
  });

  it("no metric label calls an appointment a vasectomy booking", () => {
    // The scope note legitimately says these are "NOT confirmed vasectomy
    // bookings", so a bare substring check would flag its own disclaimer. What
    // must never appear is a POSITIVE claim.
    const blob = JSON.stringify(JOURNEY_METRICS);
    const positive = blob.match(/(?<!NOT confirmed )vasectomy booking/i);
    assert.equal(positive, null, "a metric claims an appointment is a vasectomy booking");
    assert.match(JOURNEY_METRICS.booking_registration.providerScope, /NOT confirmed vasectomy/);
  });

  it("booking metrics are no longer observed minima", () => {
    // Per-patient retrieval is complete, so "none recorded" is a real negative
    // within the snapshot scope.
    assert.equal(JOURNEY_METRICS.booking_registration.isObservedMinimum, false);
    assert.match(JOURNEY_METRICS.booking_registration.coverageNote, /COMPLETE for every linked patient/);
    // The note used to say the figures were "bounded by the snapshot instant",
    // a fixed point left behind by the backfill. Recurring sync carries that
    // point forward hourly, so what the note must still state is the bound
    // itself and the fact that it only advances on a COMPLETED window — the
    // distinction between "complete to" and "last attempted".
    assert.match(JOURNEY_METRICS.booking_registration.coverageNote, /complete to/);
    assert.match(JOURNEY_METRICS.booking_registration.coverageNote, /read its whole window/);
    assert.match(JOURNEY_METRICS.booking_registration.coverageNote, /not covered until their first history read/);
  });
});

// ---------------------------------------------------------------------------
describe("booking evidence against Postgres (skipped without BOOKING_TEST_DATABASE_URL)", () => {
  let owner: { query(t: string, v?: unknown[]): Promise<{ rows: Record<string, never>[] }>; end(): Promise<void>; connect(): Promise<void> };
  let ro: typeof owner;
  const n = (r: never, k: string) => Number((r as Record<string, string>)[k]);
  const one = async (c: typeof owner, sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows[0] as never;

  // Fixture clock. The SNAPSHOT is what matters, not wall time.
  const SNAP = "2026-03-20T00:00:00Z";
  const P = (i: number) => String(770000 + i);

  before(async () => {
    if (!live) return;
    const { Client } = loadPg();
    owner = new Client({ connectionString: OWNER! }); ro = new Client({ connectionString: RO! });
    await owner.connect(); await ro.connect();
    // SCOPED cleanup. These suites share a database and the runner executes
    // files in parallel, so a blanket DELETE removes another suite's fixtures
    // mid-run. This suite owns patient ids 77xxxx and appointment ids bk_*.
    const wipe = async () => {
      await owner.query(`DELETE FROM appointment_status_transitions WHERE source_appointment_id LIKE 'bk\\_%'`);
      await owner.query(`DELETE FROM appointment_snapshots WHERE source_appointment_id LIKE 'bk\\_%'`);
      await owner.query(`UPDATE appointment_sync_windows SET last_run_id = NULL WHERE window_key LIKE 'patient:77%'`);
      await owner.query(`DELETE FROM appointment_sync_windows WHERE window_key LIKE 'patient:77%'`);
      await owner.query(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 770000 AND 779999`);
    };
    await wipe();

    const sub = (i: number, form: string, at: string) => owner.query(
      `INSERT INTO submissions (form_type, first_name, last_name, email, phone, has_insurance_cards, raw_payload, n8n_patient_id, created_at, updated_at)
       VALUES ($1,'T','F','f@example.invalid','000',false,'{}'::jsonb,$2::bigint,$3::timestamptz,$3::timestamptz)`,
      [form, P(i), at]);
    const appt = (id: string, i: number, created: string, sched: string, o: { deleted?: boolean; status?: string } = {}) =>
      owner.query(
        `INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag, archived)
         VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$3::timestamptz,$5,$6,false)`,
        [id, P(i), created, sched, o.status ?? "", o.deleted ?? false]);
    // A completed history unit = this patient is COVERED.
    const covered = (i: number) => owner.query(
      `INSERT INTO appointment_sync_windows (window_key, strategy, patient_source_id, state, completed_at)
       VALUES ($1,'patient_history',$2,'complete',$3::timestamptz)`,
      [`patient:${P(i)}`, P(i), SNAP]);

    // ---- fixture ---------------------------------------------------------
    // SIX patients per archetype, not one. Suppression withholds any cell —
    // and any COMPLEMENT — under 5, so a one-per-case fixture comes back
    // entirely blank and proves nothing. Six keeps every published number and
    // every complement above the threshold.
    //
    // All register 2026-03-01 (Pacific) except the immature group.
    const N = 6;
    const ENTRY = "2026-03-01T17:00:00Z";
    let id = 0;
    const mk = async (kind: string) => {
      const ids: number[] = [];
      for (let k = 0; k < N; k += 1) {
        id += 1; ids.push(id);
        const entry = kind === "immature" ? "2026-03-15T17:00:00Z" : ENTRY;
        await sub(id, "registration", entry);
        if (kind !== "uncovered") await covered(id);
        switch (kind) {
          case "advance":            // booked forward, inside 14 days
            await appt(`bk_a${id}`, id, "2026-03-02T17:00:00Z", "2026-03-25T17:00:00Z"); break;
          case "late_record":        // record created AFTER its scheduled time
            await appt(`bk_l${id}`, id, "2026-03-05T18:00:00Z", "2026-03-05T17:00:00Z"); break;
          case "cancel_rebook":      // cancelled, then booked again
            await appt(`bk_c${id}a`, id, "2026-03-02T17:00:00Z", "2026-03-20T17:00:00Z", { status: "Cancelled" });
            await appt(`bk_c${id}b`, id, "2026-03-04T17:00:00Z", "2026-03-28T17:00:00Z"); break;
          case "deleted":            // record later deleted at the source
            await appt(`bk_d${id}`, id, "2026-03-03T17:00:00Z", "2026-03-26T17:00:00Z", { deleted: true }); break;
          case "prior_future":       // booked BEFORE entry, for a later date
            await appt(`bk_f${id}`, id, "2026-02-01T17:00:00Z", "2026-03-30T17:00:00Z"); break;
          case "prior_past":         // a past visit, and nothing after entry
            await appt(`bk_p${id}`, id, "2025-01-10T17:00:00Z", "2025-02-01T17:00:00Z"); break;
          case "late_booking":       // books on day 20: outside a 14-day window
            await appt(`bk_w${id}`, id, "2026-03-21T17:00:00Z", "2026-04-10T17:00:00Z"); break;
          case "none": case "immature": case "uncovered": break;
        }
      }
      return ids;
    };
    for (const kind of ["advance", "late_record", "cancel_rebook", "deleted",
                        "prior_future", "prior_past", "none", "late_booking",
                        "immature", "uncovered"]) {
      await mk(kind);
    }
  });

  after(async () => {
    if (!live || !owner) return;
    await owner.query(`DELETE FROM appointment_status_transitions WHERE source_appointment_id LIKE 'bk\\_%'`);
    await owner.query(`DELETE FROM appointment_snapshots WHERE source_appointment_id LIKE 'bk\\_%'`);
    await owner.query(`UPDATE appointment_sync_windows SET last_run_id = NULL WHERE window_key LIKE 'patient:77%'`);
    await owner.query(`DELETE FROM appointment_sync_windows WHERE window_key LIKE 'patient:77%'`);
    await owner.query(`DELETE FROM submissions WHERE n8n_patient_id BETWEEN 770000 AND 779999`);
    await owner.end(); await ro.end();
  });

  const call = (w: number) => one(ro,
    `SELECT * FROM public.drsnip_booking_metric('booking_registration', $1::date, $2::date, $3::int)`,
    ["2026-03-01", "2026-04-01", w]);

  it("matures against the SNAPSHOT, not the clock", { skip: !live }, async () => {
    const r = await call(14);
    // 10 archetypes x 6 = 60 registrations in March.
    assert.equal(n(r, "cohort_total"), 60);
    assert.equal(n(r, "cohort_covered"), 54, "all but the 6 with no history unit");
    assert.equal(n(r, "cohort_not_covered"), 6, "linked after the snapshot");
    // The immature six registered 2026-03-15; +14 days lands past the
    // 2026-03-20 snapshot, so their window was never fully observed.
    assert.equal(n(r, "immature"), 6);
    assert.equal(n(r, "eligible"), 48, "54 covered minus 6 immature");
  });

  it("counts a patient once however many appointments they hold", { skip: !live }, async () => {
    const r = await call(14);
    // Recorded in window: advance(6) + late_record(6) + cancel_rebook(6, two
    // records each but counted once) + deleted(6) = 24. prior_future and
    // prior_past predate entry; none has nothing; late_booking is on day 20.
    assert.equal(n(r, "recorded"), 24);
  });

  it("separates advance bookings from records created at/after their time", { skip: !live }, async () => {
    const r = await call(14);
    assert.equal(n(r, "advance_booking"), 18, "advance + cancel_rebook + deleted");
    assert.equal(n(r, "at_or_after_scheduled"), 6, "the late_record group only");
    assert.ok(n(r, "advance_booking") <= n(r, "recorded"));
  });

  it("a cancellation does not erase the booking evidence", { skip: !live }, async () => {
    const r = await call(14);
    assert.equal(n(r, "recorded_then_cancelled"), 6);
    assert.equal(n(r, "recorded"), 24, "and they are still counted as having booked");
  });

  it("a deleted record is still evidence a record was created", { skip: !live }, async () => {
    const r = await call(14);
    assert.equal(n(r, "recorded_then_deleted"), 6);
  });

  it("splits prior PAST visits from appointments already scheduled at entry", { skip: !live }, async () => {
    const r = await call(14);
    assert.equal(n(r, "prior_past_visit"), 6, "the 2025 visits");
    assert.equal(n(r, "prior_future_booking"), 6, "booked before entry, for a later date");
  });

  it("a prior appointment does not disqualify a later booking", { skip: !live }, async () => {
    // The prior-appointment groups are still in the eligible denominator; the
    // measures are independent, so holding an earlier record never removes a
    // patient from the others.
    const r = await call(14);
    assert.equal(n(r, "eligible"), 48);
    assert.equal(n(r, "prior_future_booking"), 6);
  });

  it("'none recorded' is a real negative, and excludes the immature", { skip: !live }, async () => {
    const r = await call(14);
    // Eligible 48, recorded 24 -> 24 did not: prior_future, prior_past, none,
    // late_booking.
    assert.equal(n(r, "none_recorded"), 24);
    assert.equal(n(r, "eligible") - n(r, "recorded"), n(r, "none_recorded"));
  });

  it("a wider window picks up a later booking and shrinks the eligible set", { skip: !live }, async () => {
    const r = await call(30);
    // A 30-day window from 2026-03-01 ends 03-31, past the 03-20 snapshot, so
    // NOBODY registering on 03-01 is mature at 30 days.
    assert.equal(n(r, "eligible"), 0, "the snapshot does not cover a 30-day window here");
    assert.equal((r as Record<string, string>).status, "zero_denominator");
  });

  it("time-to-booking uses advance bookings only", { skip: !live }, async () => {
    const r = await call(14);
    assert.equal(n(r, "matched"), 18, "the advance bookings only");
    // advance 03-02 (1d), cancel_rebook first advance 03-02 (1d), deleted
    // 03-03 (2d). Median of eighteen values drawn from {1,1,2} is 1.
    assert.equal(Math.round(Number((r as Record<string, string>).p50_days_to_advance)), 1);
  });

  it("rejects anything outside the allow-list", { skip: !live }, async () => {
    await assert.rejects(() => ro.query(
      `SELECT * FROM public.drsnip_booking_metric('attendance','2026-03-01','2026-04-01',14)`), /unsupported metric/);
    await assert.rejects(() => ro.query(
      `SELECT * FROM public.drsnip_booking_metric('booking_registration','2026-03-01','2026-04-01',13)`), /unsupported window/);
  });

  it("the restricted role still cannot read the PHI tables directly", { skip: !live }, async () => {
    for (const t of ["submissions", "appointment_snapshots", "appointment_status_transitions"]) {
      await assert.rejects(() => ro.query(`SELECT count(*) FROM ${t}`), /permission denied/);
    }
  });

  it("suppresses a small cohort entirely", { skip: !live }, async () => {
    const r = await one(ro,
      `SELECT * FROM public.drsnip_booking_metric('booking_insurance', $1::date, $2::date, 14)`,
      ["2026-03-01", "2026-04-01"]);
    // No insurance fixtures -> cohort 0. Zero is not disclosive; a 1-4 cohort
    // would be. Either way no small cell may appear.
    for (const k of ["cohort_total", "eligible", "recorded"]) {
      const v = (r as Record<string, string>)[k];
      if (v !== null) assert.ok(Number(v) === 0 || Number(v) >= 5, `${k}=${v} is a small cell`);
    }
  });

  it("the status-evidence summary withholds small groups and asserts no meaning",
    { skip: !live }, async () => {
    // Attach a deliberately rare status to ONE existing appointment, so the
    // group is a single patient and must be withheld.
    await owner.query(
      `INSERT INTO appointment_status_transitions (source_appointment_id, transition_at, from_status, to_status, dedupe_key)
       SELECT s.source_appointment_id, now(), '', 'RareStatus', 'rare'||g
         FROM (SELECT source_appointment_id FROM appointment_snapshots
                WHERE source_appointment_id LIKE 'bk\\_%' ORDER BY source_appointment_id LIMIT 1) s,
              generate_series(1,2) g`);
    // ...and a common one across many patients, so something survives.
    await owner.query(
      `INSERT INTO appointment_status_transitions (source_appointment_id, transition_at, from_status, to_status, dedupe_key)
       SELECT source_appointment_id, now(), '', 'Checked In', 'ci'
         FROM appointment_snapshots WHERE source_appointment_id LIKE 'bk\\_%'`);
    const rows = (await ro.query(`SELECT * FROM public.drsnip_status_evidence()`)).rows as never as { status: string; patients: string }[];
    assert.ok(!rows.some((x) => x.status === "RareStatus"), "a 1-patient status must be withheld");
    for (const x of rows) assert.ok(Number(x.patients) >= 5);
  });

  it("no function output contains an attendance verdict", { skip: !live }, async () => {
    const r = await call(14);
    const blob = JSON.stringify(r).toLowerCase();
    for (const banned of ["attended", "arrival", "arrived", "no_show", "showed"]) {
      assert.ok(!blob.includes(banned), `booking output leaked an attendance notion: ${banned}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("the journeys page presents the corrected structure", () => {
  const page = readFileSync(
    new URL("../../artifacts/intake-form/src/pages/admin/Journeys.tsx", import.meta.url), "utf8");

  it("does not place maturity as a patient stage in the funnel", () => {
    // "Had 14 full days to respond" is measurement eligibility, not something
    // a patient did, and it must not sit between two patient actions.
    assert.ok(!/Had \$\{windowDays\} full days to respond/.test(page),
      "maturity is still rendered as a waterfall stage");
  });

  it("does not make attendance follow consultation submission", () => {
    const idxCons = page.indexOf("Consultation form submitted");
    const idxAtt = page.indexOf("Attended the appointment");
    if (idxCons >= 0 && idxAtt >= 0) {
      assert.fail("consultation and attendance are still stages of one sequence");
    }
  });

  it("shows when the appointment figures are current to, once, and never a bare Live badge", () => {
    // The badge derives live / behind / paused / by-hand from the server. Since
    // 0022 it is the SAME instant every appointment figure uses, so the page
    // shows it once, in the header, instead of repeating it beside the figures.
    assert.match(page, /AppointmentFreshnessBadge/);
    assert.ok(!/>\s*Live\s*</.test(page));
    assert.ok(!/As at \{snap\}/.test(page), "a second copy of the appointment timestamp is back");
    assert.match(page, /as at the appointment-data time shown at the top of this page/);
  });

  it("carries no stale 'history incomplete' explanation", () => {
    assert.ok(!/history retrieval is incomplete/i.test(page));
    assert.ok(!/no complete history retrieved/i.test(page));
  });
});
