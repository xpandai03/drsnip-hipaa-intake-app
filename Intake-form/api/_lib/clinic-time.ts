// Clinic-day time semantics for reporting.
//
// WHY THIS EXISTS: the console ran two calendars. Reporting bucketed and
// filtered on the UTC day (`DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')`
// in api/submissions/activity.ts, `date_trunc('day', created_at)` in
// api/_lib/reporting.ts, `Date.UTC(...)` range bounds, and `getUTCDate()` in
// the dashboard's own range picker), while every record display and every CSV
// export used Pacific (api/_lib/datetime.ts, asserted by
// api/_test/location.test.ts). A submission at 10 PM Pacific therefore landed
// in tomorrow's chart bucket and today's CSV row — most evenings, for a
// West-Coast clinic.
//
// This module is the single source of the clinic day. It is DST-aware by
// construction: it never uses a hardcoded offset, only the IANA zone via Intl,
// the same way api/_lib/datetime.ts does for exports. The two now agree.
//
// Pure + dependency-free so the whole calendar is unit-tested without a DB
// (see api/_test/clinic-time.test.ts).
//
// Plano, TX is Central. One clinic timezone (Pacific) is the deliberate choice
// for v1 and is named on screen; a per-location calendar is a business
// decision, not a silent default.

/** The clinic's reporting calendar. Matches PACIFIC in api/_lib/datetime.ts. */
export const CLINIC_TZ = "America/Los_Angeles";

/** Human label for the on-screen scope line. Never let a number ship without it. */
export const CLINIC_TZ_LABEL = "clinic days (Pacific)";

const DAY_MS = 86_400_000;

// en-CA yields ISO-style YYYY-MM-DD.
const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: CLINIC_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// hourCycle h23 so midnight is "00" and not "24" — formatToParts with
// hour12:false emits 24 for midnight in some ICU versions, which would push the
// offset calculation a full day out exactly at the boundary we care about.
const PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: CLINIC_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a well-formed YYYY-MM-DD clinic-day string. */
export function isClinicDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value);
}

/**
 * The zone's UTC offset, in ms, at a given instant. Derived by formatting the
 * instant as clinic wall-time and comparing it to the same wall-time read as
 * UTC — so it follows whatever the IANA database says, including DST.
 */
function offsetMsAt(instant: Date): number {
  const p: Record<string, string> = {};
  for (const part of PARTS_FMT.formatToParts(instant)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const wallAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return wallAsUtc - instant.getTime();
}

/**
 * The instant at which a clinic day begins (00:00:00 clinic-local).
 *
 * Two passes: guess the offset at the naive UTC reading of that wall time, then
 * re-read the offset at the corrected instant. The second pass is what makes a
 * DST-transition day correct — on spring-forward the first guess lands an hour
 * inside the gap, and the re-read pulls it back onto the real boundary.
 */
export function clinicDayStart(day: string): Date {
  const m = DAY_RE.exec(day);
  if (!m) throw new RangeError(`clinicDayStart: not a YYYY-MM-DD day: ${day}`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  let instant = new Date(wall - offsetMsAt(new Date(wall)));
  instant = new Date(wall - offsetMsAt(instant));
  return instant;
}

/**
 * The EXCLUSIVE end of an inclusive clinic-day range: the instant the day after
 * `day` begins. Computed from the next day's start rather than by adding 24h,
 * because a DST day is 23 or 25 hours long.
 */
export function clinicDayEndExclusive(day: string): Date {
  return clinicDayStart(addClinicDays(day, 1));
}

/** The clinic day an instant falls on, as YYYY-MM-DD. */
export function clinicDayOf(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError("clinicDayOf: invalid date");
  return DAY_FMT.format(d);
}

/** Today, on the clinic's calendar. */
export function todayClinicDay(now: Date = new Date()): string {
  return clinicDayOf(now);
}

/**
 * Shift a clinic-day string by whole days. Steps through midday to stay clear
 * of DST boundaries, then re-reads the clinic day — so "the day after" is
 * always the calendar day after, never a 23-hour arithmetic slip.
 */
export function addClinicDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new RangeError(`addClinicDays: not a YYYY-MM-DD day: ${day}`);
  const midday = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  return clinicDayOf(new Date(midday + n * DAY_MS));
}

/** Inclusive list of clinic days from `from` to `to`. Empty if from > to. */
export function clinicDayRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  // Bounded so a malformed pair can never spin: 3 years is far beyond any
  // window the console offers.
  for (let i = 0; i < 1100 && cur <= to; i += 1) {
    out.push(cur);
    cur = addClinicDays(cur, 1);
  }
  return out;
}

/**
 * Resolve a `from`/`to` query pair into clinic-day strings plus the absolute
 * instants to bind into SQL. `to` is inclusive as a DAY and becomes an
 * exclusive instant.
 *
 * Returns undefined bounds for absent params — an unbounded window, matching
 * the previous behaviour of parseDateUtc returning undefined.
 */
export function resolveClinicWindow(
  fromRaw: unknown,
  toRaw: unknown,
): {
  fromDay?: string;
  toDay?: string;
  from?: Date;
  toExclusive?: Date;
  invalid: boolean;
} {
  const fromDay = isClinicDay(fromRaw) ? fromRaw : undefined;
  const toDay = isClinicDay(toRaw) ? toRaw : undefined;
  if (fromDay && toDay && fromDay > toDay) {
    return { fromDay, toDay, invalid: true };
  }
  return {
    fromDay,
    toDay,
    from: fromDay ? clinicDayStart(fromDay) : undefined,
    toExclusive: toDay ? clinicDayEndExclusive(toDay) : undefined,
    invalid: false,
  };
}

/** The last `days` clinic days ending today, inclusive. `days` >= 1. */
export function lastClinicDays(
  days: number,
  now: Date = new Date(),
): { fromDay: string; toDay: string } {
  const toDay = todayClinicDay(now);
  return { fromDay: addClinicDays(toDay, -(Math.max(1, days) - 1)), toDay };
}
