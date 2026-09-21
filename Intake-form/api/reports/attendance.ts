// GET /api/reports/attendance?metric=…&from=…&to=…&window=…
//
// PUBLISHED attendance. The approved mapping is resolved INSIDE the database
// (`drsnip_attendance_metric`, migration 0020) — this handler cannot supply
// classifications, and neither can its caller. If it could, "approved" would be
// advisory rather than a gate.
//
// WHAT IT DOES NOT RETURN
//   * No rate. Evidenced arrivals and unknowns are counts; a denominator that
//     could carry a rate needs a reliable absence marker, which the clinic has
//     not confirmed.
//   * No patient-level "did not attend". `explicit_absence` is stored as a
//     reviewer's answer and drives nothing.
//   * Nothing that turns "tells us nothing" into non-attendance.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { firstOf } from "../_lib/reporting";
import { CLINIC_TZ, CLINIC_TZ_LABEL, resolveClinicWindow } from "../_lib/clinic-time";
import { ATTENDANCE_REVIEW_PROMPT } from "../../lib/metrics/attendance-contract";

const METRICS = ["attendance_registration", "attendance_insurance"] as const;
const WINDOWS = [7, 14, 30];

type Row = {
  status: string;
  definition_version: number | null;
  confirmed_on: string | null;
  confirmed_by_name: string | null;
  confirmed_by_role: string | null;
  confirmed_via: string | null;
  confirmed_scope: string | null;
  cohort_total: number | null;
  eligible: number | null;
  immature: number | null;
  arrived_in_window: number | null;
  arrived_untimed: number | null;
  arrived_outside: number | null;
  not_established: number | null;
  remote_only: number | null;
  in_window_deleted_only: number | null;
  undecided_labels: number | null;
  new_labels_since_approval: number | null;
  evidence_as_of: string | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const metric = firstOf(req.query.metric);
  if (!metric || !(METRICS as readonly string[]).includes(metric)) {
    return res.status(400).json({ error: "invalid metric", allowed: METRICS });
  }
  const windowDays = Number(firstOf(req.query.window) ?? 14);
  if (!WINDOWS.includes(windowDays)) {
    return res.status(400).json({ error: "invalid window", allowed: WINDOWS });
  }
  const win = resolveClinicWindow(firstOf(req.query.from), firstOf(req.query.to));
  if (win.invalid || !win.fromDay || !win.toDay) {
    return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
  }
  const toExclusive = new Date(Date.UTC(
    Number(win.toDay.slice(0, 4)), Number(win.toDay.slice(5, 7)) - 1, Number(win.toDay.slice(8, 10)) + 1,
  )).toISOString().slice(0, 10);

  try {
    const r = await db.execute<Row>(sql`
      SELECT * FROM public.drsnip_attendance_metric(
        ${metric}::text, ${win.fromDay}::date, ${toExclusive}::date, ${windowDays}::int)`);
    const row = r.rows[0];
    if (!row) return res.status(500).json({ error: "attendance unavailable" });

    const scope = {
      from: win.fromDay, to: win.toDay,
      timezone: CLINIC_TZ, timezone_label: CLINIC_TZ_LABEL,
      window_days: windowDays, window_basis: "elapsed_hours",
    };

    if (row.status === "unapproved" || row.status === "withdrawn") {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        metric, unit: "distinct_patient_ids", status: row.status,
        reason: ATTENDANCE_REVIEW_PROMPT,
        // A withdrawal says WHY and WHEN. "Unavailable" with no reason is the
        // state this whole feature exists to replace.
        withdrawn: row.status === "withdrawn"
          ? {
              // confirmed_scope carries the withdrawal reason for this row; the
              // function reuses the column rather than widening the signature.
              reason: row.confirmed_scope,
              previous_version: row.definition_version,
              previously_confirmed_by: row.confirmed_by_name,
              at: row.evidence_as_of,
            }
          : null,
        scope,
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      metric,
      unit: "distinct_patient_ids",
      status: "ok",
      scope,
      definition: {
        version: row.definition_version,
        confirmed_by_name: row.confirmed_by_name,
        confirmed_by_role: row.confirmed_by_role,
        confirmed_via: row.confirmed_via,
        confirmed_on: row.confirmed_on,
        confirmed_scope: row.confirmed_scope,
        undecided_labels: row.undecided_labels,
        new_labels_since_approval: row.new_labels_since_approval,
      },
      cohort: {
        total: row.cohort_total,
        eligible: row.eligible,
        immature: row.immature,
        note:
          "Eligible means the patient's appointment history was retrieved and their full " +
          "follow-up window had elapsed before the appointment data cutoff.",
      },
      // Four outcomes, and they are deliberately not three. Untimed evidence is
      // real evidence that cannot be placed in a window; folding it either way
      // would be a guess.
      arrival: {
        evidenced_in_window: row.arrived_in_window,
        evidenced_untimed: row.arrived_untimed,
        evidenced_outside_window: row.arrived_outside,
        not_established: row.not_established,
        remote_only: row.remote_only,
        in_window_resting_on_deleted_record: row.in_window_deleted_only,
      },
      notes: {
        untimed:
          "Evidence that the patient was here, with no usable arrival time — a status with " +
          "no timestamp, or a current status that carries none. We do not place it in the " +
          "window, because a scheduled time is not proof of when someone arrived.",
        not_established:
          "No record either way. This is not a count of people who did not come.",
        no_rate:
          "No attendance rate is published. A rate needs a dependable record of non-attendance, " +
          "which has not been confirmed.",
        movement:
          "Confirming more statuses can move patients out of “not established”. Revisions to " +
          "the definition, and corrections at the source, can move figures in either direction.",
        disposition:
          "Arrival evidence is separate from what the appointment says now. A patient who came " +
          "in and whose appointment was later cancelled still came in.",
      },
      suppression: {
        threshold: 5,
        note:
          "Small groups are withheld inside the database, together with any figure that would " +
          "let one be recovered by subtraction. A withheld value is never zero.",
      },
      evidence_as_of: row.evidence_as_of,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "22023") return res.status(400).json({ error: "unsupported parameters" });
    console.error("[reports/attendance] failed", code ?? "unknown");
    return res.status(500).json({ error: "attendance query failed" });
  }
}
