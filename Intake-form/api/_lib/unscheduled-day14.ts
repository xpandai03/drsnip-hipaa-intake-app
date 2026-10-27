// "Unscheduled at day 14" (2026-10-27): registrations with nothing booked two
// weeks after the patient first registered, and what happened to them after.
//
// COUNTS ONLY. The patient-level classifier runs inside the database and only
// aggregates leave it; no chart id, name or date of any patient is returned.
//
// "Converted" is NOT redefined here. It is the clinic's rule set (status rules
// v2, migration 0023, mirrored in lib/metrics/conversion-rules.ts), applied by
// public.drsnip_conversion_classify('registration'): one row per linked chart at
// its FIRST registration, with the created date of its earliest converted-set
// appointment (`conversion_at`). Day 14 is measured from that first
// registration:
//
//   booked by day 14   converted, and the first converted appointment was
//                      created within 14 days of the first registration (an
//                      appointment made before the form counts as booked)
//   booked later       converted, but only after day 14 (day 15 is "later")
//   never booked       not converted as of today, split three ways:
//     no appointment     no live appointment on the chart at all
//     canceled/no-show   at least one canceled, late-canceled or no-show
//     no status only     appointments exist but every one has a blank or
//                        other unclassified status
//
// Only patients whose appointment history has been read (covered) are counted.
// A month is "complete" once day 14 has passed for its last registrant.

export const DAY14_MONTHS_SQL = `
WITH c AS (
  SELECT x.* FROM public.drsnip_conversion_classify('registration') x WHERE x.is_covered
),
d AS (
  SELECT c.entry_month,
         (c.converted AND coalesce(c.conversion_at <= c.entry_at + interval '14 days', false)) AS by_d14,
         c.converted, c.has_appointment, c.has_not_converted
    FROM c
)
SELECT to_char(d.entry_month, 'YYYY-MM') AS form_month,
       ((d.entry_month + interval '1 month' + interval '14 days')::timestamp
          AT TIME ZONE 'America/Los_Angeles') <= now() AS complete,
       count(*)::int                                                                  AS cohort,
       count(*) FILTER (WHERE NOT d.by_d14)::int                                      AS unscheduled_d14,
       count(*) FILTER (WHERE d.converted AND NOT d.by_d14)::int                      AS booked_later,
       count(*) FILTER (WHERE NOT d.converted)::int                                   AS never,
       count(*) FILTER (WHERE NOT d.converted AND NOT d.has_appointment)::int         AS never_no_appointment,
       count(*) FILTER (WHERE NOT d.converted AND d.has_not_converted)::int           AS never_canceled_or_no_show,
       count(*) FILTER (WHERE NOT d.converted AND NOT d.has_not_converted
                          AND d.has_appointment)::int                                 AS never_no_status_only
  FROM d
 WHERE d.entry_month >= DATE '2026-06-01'
 GROUP BY d.entry_month
 ORDER BY d.entry_month
`;

export const DAY14_RIGHT_NOW_SQL = `
SELECT count(*)::int                                                                   AS registrations_30d,
       count(*) FILTER (WHERE NOT x.is_covered)::int                                   AS not_yet_synced,
       count(*) FILTER (WHERE x.is_covered AND NOT x.converted)::int                   AS nothing_booked_now,
       count(*) FILTER (WHERE x.is_covered AND NOT x.converted
                          AND x.entry_at < now() - interval '14 days')::int            AS past_day_14
  FROM public.drsnip_conversion_classify('registration') x
 WHERE x.entry_at > now() - interval '30 days'
`;

// The hourly practice-wide sync, not the 10-minute catch-up: the catch-up
// "succeeds" every 10 minutes even when it has nothing to read, so it says
// nothing about how fresh the appointment data is.
export const DAY14_AS_OF_SQL = `
SELECT max(r.finished_at) AS as_of
  FROM public.appointment_sync_runs r
 WHERE r.scope_key = 'practice_incremental' AND r.outcome = 'success'
`;

export type MonthRow = {
  form_month: string;
  complete: boolean;
  cohort: number;
  unscheduled_d14: number;
  booked_later: number;
  never: number;
  never_no_appointment: number;
  never_canceled_or_no_show: number;
  never_no_status_only: number;
};

export type RightNow = {
  registrations_30d: number;
  not_yet_synced: number;
  nothing_booked_now: number;
  past_day_14: number;
};

/** One decimal; null when there is nothing to divide by. */
export function pct(n: number, of: number): number | null {
  return of > 0 ? Math.round((n / of) * 1000) / 10 : null;
}

const n = (v: unknown) => Number(v ?? 0);

/** Pure: shape the three query results into the response. */
export function shapeDay14(rawMonths: Record<string, unknown>[], rawNow: Record<string, unknown> | undefined, asOf: unknown) {
  const months: (MonthRow & { unscheduled_pct: number | null; booked_later_pct: number | null; never_pct: number | null })[] =
    rawMonths.map((r) => {
      const m: MonthRow = {
        form_month: String(r.form_month),
        complete: Boolean(r.complete),
        cohort: n(r.cohort),
        unscheduled_d14: n(r.unscheduled_d14),
        booked_later: n(r.booked_later),
        never: n(r.never),
        never_no_appointment: n(r.never_no_appointment),
        never_canceled_or_no_show: n(r.never_canceled_or_no_show),
        never_no_status_only: n(r.never_no_status_only),
      };
      return {
        ...m,
        unscheduled_pct: pct(m.unscheduled_d14, m.cohort),
        booked_later_pct: pct(m.booked_later, m.unscheduled_d14),
        never_pct: pct(m.never, m.unscheduled_d14),
      };
    });

  const done = months.filter((m) => m.complete);
  const sum = (k: keyof MonthRow) => done.reduce((a, m) => a + (m[k] as number), 0);
  const totals = done.length === 0 ? null : {
    from_month: done[0].form_month,
    to_month: done[done.length - 1].form_month,
    months: done.length,
    cohort: sum("cohort"),
    unscheduled_d14: sum("unscheduled_d14"),
    unscheduled_pct: pct(sum("unscheduled_d14"), sum("cohort")),
    avg_unscheduled_per_month: Math.round(sum("unscheduled_d14") / done.length),
    booked_later: sum("booked_later"),
    booked_later_pct: pct(sum("booked_later"), sum("unscheduled_d14")),
    never: sum("never"),
    never_pct: pct(sum("never"), sum("unscheduled_d14")),
    never_no_appointment: sum("never_no_appointment"),
    never_canceled_or_no_show: sum("never_canceled_or_no_show"),
    never_no_status_only: sum("never_no_status_only"),
  };

  const rn = rawNow ?? {};
  const right_now: RightNow = {
    registrations_30d: n(rn.registrations_30d),
    not_yet_synced: n(rn.not_yet_synced),
    nothing_booked_now: n(rn.nothing_booked_now),
    past_day_14: n(rn.past_day_14),
  };

  const asOfDate = asOf ? new Date(asOf as string) : null;
  return {
    months,
    totals,
    right_now,
    data_as_of: asOfDate && !Number.isNaN(asOfDate.getTime()) ? asOfDate.toISOString() : null,
    headline: totals && totals.never_pct !== null
      ? `Of people with nothing booked at day 14, ${Math.round(totals.never_pct)}% never booked.`
      : null,
  };
}
