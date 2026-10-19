// GET /api/reports/journey?metric=<m>&from=YYYY-MM-DD&to=YYYY-MM-DD&window=7|14|30
//
// Aggregate-only patient-journey metrics. Auth-guarded, like every other
// reporting route.
//
// THIS ROUTE NEVER TOUCHES A PHI TABLE. It calls
// public.drsnip_journey_metric(), a SECURITY DEFINER function owned by a
// restricted, NOLOGIN role that holds SELECT on four tables and nothing else
// (migration 0014). Suppression happens inside that function, so a small cell
// is already NULL by the time it reaches this file — it cannot leak through a
// log line, an error message or a response body here.
//
// What comes back is counts, a status and non-identifying metadata. No patient
// id, no appointment id, no individual event timestamp, no raw status tied to a
// person, no source payload. Aggregate freshness timestamps ARE returned, so
// the UI can say how old the appointment snapshot is.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { firstOf, sqlState } from "../_lib/reporting";
import { CLINIC_TZ, CLINIC_TZ_LABEL, resolveClinicWindow } from "../_lib/clinic-time";
import {
  JOURNEY_METRICS,
  SUPPORTED_WINDOWS,
  isJourneyMetric,
  describeMetric,
  type JourneyMetricId,
} from "../../lib/metrics/registry";

/**
 * Widest period a single request may ask for.
 *
 * The database function enforces this too — this check exists so an absurd
 * request is refused before it costs a connection, not because the function
 * can be trusted less.
 */
const MAX_SPAN_DAYS = 400;

type FnRow = {
  metric: string;
  cohort: number | null;
  numerator: number | null;
  denominator: number | null;
  observed_numerator: number | null;
  observed_denominator: number | null;
  secondary_a: number | null;
  secondary_b: number | null;
  secondary_c: number | null;
  unresolved: number | null;
  coverage_denominator: number | null;
  matched: number | null;
  p50_days: string | number | null;
  p75_days: string | number | null;
  p90_days: string | number | null;
  status: string;
  notes: string | null;
};

const num = (v: string | number | null): number | null =>
  v === null || v === undefined ? null : Number(v);

/** A rate is only meaningful when BOTH sides survived suppression. */
function rateOf(n: number | null, d: number | null): number | null {
  if (n === null || d === null || d === 0) return null;
  return n / d;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const metric = firstOf(req.query.metric);
  if (!isJourneyMetric(metric)) {
    return res.status(400).json({ error: "invalid metric", allowed: Object.keys(JOURNEY_METRICS) });
  }

  const windowRaw = firstOf(req.query.window);
  const windowDays = windowRaw === undefined ? 14 : Number(windowRaw);
  if (!SUPPORTED_WINDOWS.includes(windowDays as (typeof SUPPORTED_WINDOWS)[number])) {
    return res.status(400).json({ error: "invalid window", allowed: SUPPORTED_WINDOWS });
  }

  // Pacific clinic days, the same convention the rest of reporting uses.
  const win = resolveClinicWindow(firstOf(req.query.from), firstOf(req.query.to));
  if (win.invalid) return res.status(400).json({ error: "from must be <= to" });

  const from = win.fromDay;
  const toExclusiveDay = win.toDay
    ? new Date(Date.UTC(
        Number(win.toDay.slice(0, 4)),
        Number(win.toDay.slice(5, 7)) - 1,
        Number(win.toDay.slice(8, 10)) + 1,
      )).toISOString().slice(0, 10)
    : undefined;

  if (!from || !toExclusiveDay) {
    return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
  }
  const spanDays =
    (Date.parse(toExclusiveDay) - Date.parse(from)) / 86_400_000;
  if (spanDays > MAX_SPAN_DAYS) {
    return res.status(400).json({ error: "period too wide", max_days: MAX_SPAN_DAYS });
  }

  const spec = describeMetric(metric as JourneyMetricId);

  try {
    const result = await db.execute<FnRow>(sql`
      SELECT * FROM public.drsnip_journey_metric(
        ${spec.fnName}::text, ${from}::date, ${toExclusiveDay}::date, ${windowDays}::int)
    `);
    const row = result.rows[0];
    if (!row) return res.status(500).json({ error: "metric unavailable" });

    const fresh = await db.execute<{
      intake_latest_at: string | null;
      appointments_synced_at: string | null;
      appointment_sync_active: boolean;
      history_complete_patients: number;
      linked_patients: number;
      sync_schedule_enabled: boolean;
    }>(sql`SELECT * FROM public.drsnip_journey_freshness()`);
    const f = fresh.rows[0];

    const matureNum = num(row.numerator);
    const matureDen = num(row.denominator);
    const obsNum = num(row.observed_numerator);
    const obsDen = num(row.observed_denominator);

    return res.status(200).json({
      metric,
      definition_version: spec.version,
      label: spec.label,
      unit: spec.unit,
      // What is counted, in the words shown to a person.
      counts_what: spec.countsWhat,
      // Present BOTH modes side by side so neither can be mistaken for the
      // other. An observed-to-date number and a mature-window number are
      // different quantities over different denominators.
      observed_to_date: {
        numerator: obsNum,
        denominator: obsDen,
        rate: rateOf(obsNum, obsDen),
        note: "Counts every outcome seen so far, including for entries only days old. A lower bound that rises as cohorts age; not comparable between periods.",
      },
      mature_window: {
        window_days: windowDays,
        window_basis: "elapsed_hours",
        numerator: matureNum,
        denominator: matureDen,
        rate: rateOf(matureNum, matureDen),
        note: `Only entries that have had the full ${windowDays} days available are in the denominator. Entries within the period that are still too recent are excluded, not counted as failures.`,
      },
      cohort: num(row.cohort),
      // Metric-specific extras; `secondary_labels` names them so the client
      // never has to guess what secondary_a means.
      secondary: {
        a: num(row.secondary_a),
        b: num(row.secondary_b),
        c: num(row.secondary_c),
        labels: spec.secondaryLabels,
      },
      coverage: {
        unresolved: num(row.unresolved),
        sufficient_coverage: num(row.coverage_denominator),
        note: spec.coverageNote,
      },
      durations: {
        matched: num(row.matched),
        p50_days: num(row.p50_days),
        p75_days: num(row.p75_days),
        p90_days: num(row.p90_days),
        note: "Elapsed days between entry and the first qualifying outcome, among matched entries only.",
      },
      provider_scope: spec.providerScope,
      is_observed_minimum: spec.isObservedMinimum,
      status: row.status,
      scope: {
        from,
        to: win.toDay,
        timezone: CLINIC_TZ,
        timezone_label: CLINIC_TZ_LABEL,
      },
      freshness: {
        intake_latest_at: f?.intake_latest_at ?? null,
        appointments_synced_at: f?.appointments_synced_at ?? null,
        // Earned, not declared: true only when a scheduled run of the
        // incremental scope actually succeeded inside its cadence (0017). The
        // UI must never imply automatic updates from configuration alone.
        appointment_sync_active: f?.appointment_sync_active ?? false,
        appointment_update_mode: f?.sync_schedule_enabled ? "scheduled" : "manual",
        history_complete_patients: f?.history_complete_patients ?? null,
        linked_patients: f?.linked_patients ?? null,
      },
      suppression: {
        threshold: 5,
        note: "Cells below the threshold are withheld inside the database boundary, together with any total that would let them be recovered by subtraction. A null is 'withheld', never zero.",
      },
    });
  } catch (err) {
    // The function raises 22023 for anything outside its allow-list. Surface
    // that as a 400 and never echo the driver's message, which can quote the
    // query text.
    const code = sqlState(err);
    if (code === "22023") return res.status(400).json({ error: "unsupported metric parameters" });
    console.error("[reports/journey] query failed", code ?? "unknown");
    return res.status(500).json({ error: "metric query failed" });
  }
}
