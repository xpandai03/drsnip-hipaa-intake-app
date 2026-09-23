// GET /api/reports/booking?metric=booking_registration|booking_insurance
//                          &from=YYYY-MM-DD&to=YYYY-MM-DD&window=7|14|30
//
// Appointment-record evidence for an entry cohort. Auth-guarded, aggregate
// only, and — like /api/reports/journey — it never touches a PHI table: it
// calls public.drsnip_booking_metric(), a SECURITY DEFINER function owned by a
// restricted NOLOGIN role, with suppression applied inside that boundary.
//
// THE KEY FIELD IS `snapshot_cutoff`. Appointment data is a stored snapshot;
// intake keeps arriving after it. Every figure here is "as at" that instant,
// and the cohort is matured against it rather than against the clock — so a
// patient whose follow-up window runs past the snapshot is reported as
// IMMATURE, not as someone who did not book.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { firstOf, sqlState } from "../_lib/reporting";
import { CLINIC_TZ, CLINIC_TZ_LABEL, resolveClinicWindow } from "../_lib/clinic-time";
import { BOOKING_METRICS, SUPPORTED_WINDOWS } from "../../lib/metrics/registry";
import {
  CURRENT_MAPPING,
  attendanceIsApproved,
  ATTENDANCE_UNAVAILABLE_REASON,
  outstandingDecision,
} from "../../lib/metrics/attendance-mapping";

const MAX_SPAN_DAYS = 400;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const rate = (n: number | null, d: number | null) =>
  n === null || d === null || d === 0 ? null : n / d;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const metric = firstOf(req.query.metric);
  if (!metric || !Object.prototype.hasOwnProperty.call(BOOKING_METRICS, metric)) {
    return res.status(400).json({ error: "invalid metric", allowed: Object.keys(BOOKING_METRICS) });
  }
  const spec = BOOKING_METRICS[metric as keyof typeof BOOKING_METRICS];

  const windowDays = req.query.window === undefined ? 14 : Number(firstOf(req.query.window));
  if (!SUPPORTED_WINDOWS.includes(windowDays as (typeof SUPPORTED_WINDOWS)[number])) {
    return res.status(400).json({ error: "invalid window", allowed: SUPPORTED_WINDOWS });
  }

  const win = resolveClinicWindow(firstOf(req.query.from), firstOf(req.query.to));
  if (win.invalid) return res.status(400).json({ error: "from must be <= to" });
  const from = win.fromDay;
  if (!from || !win.toDay) return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
  const toExclusive = new Date(Date.UTC(
    Number(win.toDay.slice(0, 4)), Number(win.toDay.slice(5, 7)) - 1, Number(win.toDay.slice(8, 10)) + 1,
  )).toISOString().slice(0, 10);
  if ((Date.parse(toExclusive) - Date.parse(from)) / 86_400_000 > MAX_SPAN_DAYS) {
    return res.status(400).json({ error: "period too wide", max_days: MAX_SPAN_DAYS });
  }

  try {
    const r = await db.execute<Record<string, unknown>>(sql`
      SELECT * FROM public.drsnip_booking_metric(
        ${spec.fnName}::text, ${from}::date, ${toExclusive}::date, ${windowDays}::int)
    `);
    const row = r.rows[0];
    if (!row) return res.status(500).json({ error: "metric unavailable" });

    const eligible = num(row.eligible);
    const recorded = num(row.recorded);
    const advance = num(row.advance_booking);

    return res.status(200).json({
      metric,
      definition_version: spec.version,
      label: spec.label,
      counts_what: spec.countsWhat,
      // Everything below is as at this instant, not "now".
      snapshot_cutoff: row.snapshot_cutoff ?? null,
      cohort: {
        total: num(row.cohort_total),
        covered: num(row.cohort_covered),
        not_covered: num(row.cohort_not_covered),
        eligible,
        immature: num(row.immature),
        note:
          "Eligible = patients whose appointment history was retrieved AND whose full follow-up " +
          "window had elapsed before the appointment snapshot. Patients still inside their " +
          "window at the snapshot are counted as immature and excluded from the denominator — " +
          "they are not people who failed to book.",
      },
      recorded: { count: recorded, rate: rate(recorded, eligible) },
      advance_booking: {
        count: advance,
        rate: rate(advance, eligible),
        note:
          "The conservative subset: the record was created BEFORE the time it was scheduled for. " +
          "It is the closest thing to evidence of a genuine forward booking.",
      },
      at_or_after_scheduled: {
        count: num(row.at_or_after_scheduled),
        note: "Its own category — not invalid data, and deliberately excluded from booking timing.",
      },
      prior: {
        past_visit: num(row.prior_past_visit),
        future_booking: num(row.prior_future_booking),
        note:
          "An appointment record that already existed at entry, split into a past visit and one " +
          "already scheduled for a later date. Holding either does not remove a patient from the " +
          "measures above.",
      },
      changed_after_recording: {
        later_cancelled: num(row.recorded_then_cancelled),
        later_deleted: num(row.recorded_then_deleted),
        note: "A cancellation does not erase the evidence that a record was created.",
      },
      none_recorded: num(row.none_recorded),
      timing: { matched: num(row.matched), p50_days: num(row.p50_days_to_advance) },
      provider_scope: spec.providerScope,
      coverage_note: spec.coverageNote,
      // Attendance never leaks a value from here.
      attendance: {
        available: attendanceIsApproved(),
        mapping_version: CURRENT_MAPPING.version,
        approval_state: CURRENT_MAPPING.approval.state,
        reason: attendanceIsApproved() ? null : ATTENDANCE_UNAVAILABLE_REASON,
        outstanding_decision: attendanceIsApproved() ? [] : outstandingDecision().questions,
      },
      status: row.status,
      scope: { from, to: win.toDay, timezone: CLINIC_TZ, timezone_label: CLINIC_TZ_LABEL },
      suppression: {
        threshold: 5,
        note: "Small cells and small complements are withheld inside the database boundary.",
      },
    });
  } catch (err) {
    const code = sqlState(err);
    if (code === "22023") return res.status(400).json({ error: "unsupported metric parameters" });
    console.error("[reports/booking] query failed", code ?? "unknown");
    return res.status(500).json({ error: "metric query failed" });
  }
}
