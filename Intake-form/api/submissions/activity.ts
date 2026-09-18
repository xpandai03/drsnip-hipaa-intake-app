// GET /api/submissions/activity — aggregated daily counts for the volume chart.
//
// Auth-guarded. Returns daily totals plus a per-form-type breakdown inside the
// requested window. Defaults to the last 90 clinic days.
//
// Query params (all optional):
//   start_date / from   YYYY-MM-DD inclusive (clinic day)
//   end_date   / to     YYYY-MM-DD inclusive (clinic day)
//   location            one of the canonical clinic locations
//
// TWO CORRECTIONS vs the previous version:
//
//   1. Buckets are CLINIC days (Pacific), not UTC days. This endpoint used
//      `DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')`, so a 10 PM Pacific
//      submission was charted on the following day while every CSV column and
//      the submissions list showed the Pacific day. See api/_lib/clinic-time.ts.
//
//   2. INSURANCE is in the breakdown. `by_form_type` carried only
//      `registration` and `consultation` while `total` summed every form type,
//      so insurance submissions were counted in the total and dropped from the
//      series — the stacked bars could not add up to their own total, and
//      insurance volume was invisible. `by_form_type` is now keyed by the
//      actual form_type values present, and `series` names them explicitly.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { isAllowedLocation } from "../_lib/location";
import { buildWhere, firstOf, ALLOWED_FORM_TYPES } from "../_lib/reporting";
import {
  CLINIC_TZ,
  CLINIC_TZ_LABEL,
  addClinicDays,
  clinicDayRange,
  clinicDayStart,
  clinicDayEndExclusive,
  isClinicDay,
  todayClinicDay,
} from "../_lib/clinic-time";

const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 400;

type FormCounts = Record<string, number>;
type DayBucket = {
  date: string;
  total: number;
  by_form_type: FormCounts;
};

function zeroCounts(): FormCounts {
  const out: FormCounts = {};
  for (const ft of ALLOWED_FORM_TYPES) out[ft] = 0;
  return out;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  // Accept both the original start_date/end_date and the from/to used by
  // /api/reports/*, so the dashboard can drive one window across every tile.
  const endRaw = firstOf(req.query.end_date) ?? firstOf(req.query.to);
  const startRaw = firstOf(req.query.start_date) ?? firstOf(req.query.from);

  const endDay = isClinicDay(endRaw) ? endRaw : todayClinicDay();
  const startDay = isClinicDay(startRaw)
    ? startRaw
    : addClinicDays(endDay, -(DEFAULT_WINDOW_DAYS - 1));

  if (startDay > endDay) {
    return res.status(400).json({ error: "start_date must be <= end_date" });
  }

  const days = clinicDayRange(startDay, endDay);
  if (days.length === 0 || days.length > MAX_WINDOW_DAYS) {
    return res
      .status(400)
      .json({ error: `window must be between 1 and ${MAX_WINDOW_DAYS} days` });
  }

  const locationParam = firstOf(req.query.location);
  const location = isAllowedLocation(locationParam) ? locationParam : undefined;

  const where = buildWhere({
    from: clinicDayStart(startDay),
    toExclusive: clinicDayEndExclusive(endDay),
    location,
  });

  // One row per (clinic day, form_type).
  const daily = await db.execute<{
    day: string;
    form_type: string;
    total: number;
  }>(sql`
    SELECT
      to_char(date_trunc('day', created_at AT TIME ZONE ${CLINIC_TZ}), 'YYYY-MM-DD') AS day,
      form_type,
      count(*)::int AS total
    FROM submissions
    ${where}
    GROUP BY 1, 2
    ORDER BY 1
  `);

  // Seed every day so empty days return explicit zeros (a measured zero, not a
  // gap) and the series is dense for the chart.
  const buckets = new Map<string, DayBucket>();
  for (const day of days) {
    buckets.set(day, { date: day, total: 0, by_form_type: zeroCounts() });
  }

  const summary: FormCounts = zeroCounts();
  let total = 0;
  // Any form_type the DB returns that is not in the allow-list still has to be
  // counted somewhere visible, or the totals stop reconciling again.
  const seen = new Set<string>(ALLOWED_FORM_TYPES);

  for (const row of daily.rows) {
    const bucket = buckets.get(row.day);
    const n = Number(row.total) || 0;
    const ft = row.form_type ?? "unknown";
    seen.add(ft);
    if (bucket) {
      bucket.total += n;
      bucket.by_form_type[ft] = (bucket.by_form_type[ft] ?? 0) + n;
    }
    summary[ft] = (summary[ft] ?? 0) + n;
    total += n;
  }

  const series = [...seen].sort();

  return res.status(200).json({
    start_date: startDay,
    end_date: endDay,
    timezone: CLINIC_TZ,
    timezone_label: CLINIC_TZ_LABEL,
    location: location ?? null,
    /** The form types present in this response, in a stable order. */
    series,
    daily_counts: [...buckets.values()],
    summary: { total, ...summary },
  });
}
