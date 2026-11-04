// "Not booked" (2026-10-27 call): registrations whose patient has nothing
// booked as of today, by registration month, split by what is on the chart.
//
// COUNTS ONLY. The patient-level classifier runs inside the database and only
// aggregates leave it; no chart id, name or date of any patient is returned.
//
// "Booked" is NOT redefined here. It is the clinic's rule set (status rules
// v3, migration 0025, mirrored in lib/metrics/conversion-rules.ts), applied by
// public.drsnip_conversion_classify('registration'): one row per linked chart
// at its FIRST registration. A patient whose appointments all carry an
// ignored status (blank, MD In, …) is not in that set at all.
//
//   not booked             no converted-set appointment as of today, split:
//     canceled or no show  at least one canceled, late-canceled or no-show
//     no appointment       no live appointment on the chart at all
//
// Only patients whose appointment history has been read (covered) are counted.
// A month is "complete" once it has ended on the clinic calendar.

// ONE per-patient definition. The page's counts and the drill-down lists are
// both read from this CTE, so a list can never disagree with the cell it came
// from. Each bucket is a boolean column; every bucket implies is_covered.
export const NOT_BOOKED_CTE = `
WITH b AS (
  SELECT x.pid, x.entry_at, x.entry_month, x.is_covered,
         (x.is_covered AND NOT x.converted)                                         AS not_booked,
         (x.is_covered AND NOT x.converted AND x.has_not_converted)                 AS canceled_noshow,
         (x.is_covered AND NOT x.converted AND NOT x.has_appointment)               AS no_appointment,
         (x.is_covered AND NOT x.converted AND x.entry_at > now() - interval '30 days') AS right_now_not_booked
    FROM public.drsnip_conversion_classify('registration') x
)
`;

/** Month buckets (one per table column) and the "right now" bucket. */
export const MONTH_BUCKETS = ["not_booked", "canceled_noshow", "no_appointment"] as const;
export const RIGHT_NOW_BUCKETS = ["right_now_not_booked"] as const;
export type MonthBucket = (typeof MONTH_BUCKETS)[number];
export type RightNowBucket = (typeof RIGHT_NOW_BUCKETS)[number];
export type Bucket = MonthBucket | RightNowBucket;
export const isBucket = (v: unknown): v is Bucket =>
  (MONTH_BUCKETS as readonly string[]).includes(String(v)) || (RIGHT_NOW_BUCKETS as readonly string[]).includes(String(v));
export const isMonthBucket = (v: Bucket): v is MonthBucket => (MONTH_BUCKETS as readonly string[]).includes(v);

export const NOT_BOOKED_MONTHS_SQL = NOT_BOOKED_CTE + `
SELECT to_char(b.entry_month, 'YYYY-MM') AS form_month,
       ((b.entry_month + interval '1 month')::timestamp
          AT TIME ZONE 'America/Los_Angeles') <= now() AS complete,
       count(*)::int                                     AS cohort,
       count(*) FILTER (WHERE b.not_booked)::int         AS not_booked,
       count(*) FILTER (WHERE b.canceled_noshow)::int    AS canceled_or_no_show,
       count(*) FILTER (WHERE b.no_appointment)::int     AS no_appointment
  FROM b
 WHERE b.is_covered AND b.entry_month >= DATE '2026-06-01'
 GROUP BY b.entry_month
 ORDER BY b.entry_month
`;

export const NOT_BOOKED_RIGHT_NOW_SQL = NOT_BOOKED_CTE + `
SELECT count(*) FILTER (WHERE b.entry_at > now() - interval '30 days')::int                    AS registrations_30d,
       count(*) FILTER (WHERE b.entry_at > now() - interval '30 days' AND NOT b.is_covered)::int AS not_yet_synced,
       count(*) FILTER (WHERE b.right_now_not_booked)::int                                       AS not_booked_now
  FROM b
`;

// The hourly practice-wide sync, not the 10-minute catch-up: the catch-up
// "succeeds" every 10 minutes even when it has nothing to read, so it says
// nothing about how fresh the appointment data is.
export const NOT_BOOKED_AS_OF_SQL = `
SELECT max(r.finished_at) AS as_of
  FROM public.appointment_sync_runs r
 WHERE r.scope_key = 'practice_incremental' AND r.outcome = 'success'
`;

export type MonthRow = {
  form_month: string;
  complete: boolean;
  cohort: number;
  not_booked: number;
  canceled_or_no_show: number;
  no_appointment: number;
};

export type RightNow = {
  registrations_30d: number;
  not_yet_synced: number;
  not_booked_now: number;
};

/** One decimal; null when there is nothing to divide by. */
export function pct(n: number, of: number): number | null {
  return of > 0 ? Math.round((n / of) * 1000) / 10 : null;
}

const n = (v: unknown) => Number(v ?? 0);

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => `${LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** Pure: shape the three query results into the response. */
export function shapeNotBooked(rawMonths: Record<string, unknown>[], rawNow: Record<string, unknown> | undefined, asOf: unknown) {
  const months: (MonthRow & { not_booked_pct: number | null })[] = rawMonths.map((r) => {
    const m: MonthRow = {
      form_month: String(r.form_month),
      complete: Boolean(r.complete),
      cohort: n(r.cohort),
      not_booked: n(r.not_booked),
      canceled_or_no_show: n(r.canceled_or_no_show),
      no_appointment: n(r.no_appointment),
    };
    return { ...m, not_booked_pct: pct(m.not_booked, m.cohort) };
  });

  // Totals cover the months that have ended, so a month still filling in never
  // drags the headline share.
  const done = months.filter((m) => m.complete);
  const sum = (k: keyof MonthRow) => done.reduce((a, m) => a + (m[k] as number), 0);
  const totals = done.length === 0 ? null : {
    from_month: done[0].form_month,
    to_month: done[done.length - 1].form_month,
    months: done.length,
    cohort: sum("cohort"),
    not_booked: sum("not_booked"),
    not_booked_pct: pct(sum("not_booked"), sum("cohort")),
    avg_not_booked_per_month: Math.round(sum("not_booked") / done.length),
    canceled_or_no_show: sum("canceled_or_no_show"),
    no_appointment: sum("no_appointment"),
  };

  const rn = rawNow ?? {};
  const right_now: RightNow = {
    registrations_30d: n(rn.registrations_30d),
    not_yet_synced: n(rn.not_yet_synced),
    not_booked_now: n(rn.not_booked_now),
  };

  const asOfDate = asOf ? new Date(asOf as string) : null;
  return {
    months,
    totals,
    right_now,
    data_as_of: asOfDate && !Number.isNaN(asOfDate.getTime()) ? asOfDate.toISOString() : null,
    headline: totals && totals.not_booked_pct !== null
      ? `Of ${totals.cohort.toLocaleString("en-US")} people who registered from ${monthName(totals.from_month)} to ` +
        `${monthName(totals.to_month)}, ${Math.round(totals.not_booked_pct)}% have not booked.`
      : null,
  };
}
