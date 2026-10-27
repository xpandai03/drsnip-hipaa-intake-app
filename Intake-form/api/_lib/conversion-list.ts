// Drill-down behind every count on "Conversion by cohort" (admin only).
//
// "Converted" is never redefined: membership comes from the same per-patient
// classifier as the cohort table, public.drsnip_conversion_classify(form),
// which applies the clinic's status rules (v2). The period index n (P+0..P+3)
// is the SAME expression public.drsnip_conversion_cohorts() uses
// (0024_conversion_cohorts.sql:84-101), copied verbatim, and a parity test
// plus a production parity run hold every list total equal to its cell.
//
// Columns: the patient-list columns plus "Converted on" (the created date of
// the first converted-set appointment, clinic day). No phone, email, DOB,
// address, insurance or clinical field.

import { sql } from "@workspace/db";
import { PAGE_SIZE } from "./unscheduled-list";

export const CONVERSION_BUCKETS = [
  "forms",
  "converted_now",
  "not_converted_now",
  "converted_by_end_of_period",
  "converted_by_plus1",
  "converted_by_plus2",
  "converted_by_plus3",
] as const;
export type ConversionBucket = (typeof CONVERSION_BUCKETS)[number];
export type ConversionForm = "registration" | "insurance";
export type Grain = "month" | "week";

export type ConversionListParams = {
  form: ConversionForm;
  grain: Grain;
  period: string; // YYYY-MM-DD, the cohort's first day (month start or Monday)
  bucket: ConversionBucket;
  page: number;
};

const FIRST_DAY = "2026-06-01";
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today on the clinic calendar, YYYY-MM-DD. */
export function clinicToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function parseConversionListParams(
  q: Record<string, unknown>,
  today: string = clinicToday(),
): ConversionListParams | { error: string } {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const form = one(q.form), grain = one(q.grain), period = one(q.period), bucket = one(q.bucket), pageRaw = one(q.page);
  if (form !== "registration" && form !== "insurance") return { error: "invalid form" };
  if (grain !== "month" && grain !== "week") return { error: "invalid grain" };
  if (!(CONVERSION_BUCKETS as readonly string[]).includes(String(bucket))) return { error: "invalid bucket" };
  if (typeof period !== "string" || !DATE_RE.test(period)) return { error: "invalid period" };
  const d = new Date(`${period}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== period) return { error: "invalid period" };
  if (grain === "month" && period.slice(8) !== "01") return { error: "a month period starts on the 1st" };
  if (grain === "week" && d.getUTCDay() !== 1) return { error: "a week period starts on a Monday" };
  // The first cohort week can start before June 1 (week of Monday 2026-06-08 is
  // the earliest in practice); allow from the Monday on or before FIRST_DAY.
  if (period < "2026-05-25" || period > today) return { error: "period out of range" };
  if (grain === "month" && period < FIRST_DAY) return { error: "period out of range" };
  let page = 1;
  if (pageRaw !== undefined && pageRaw !== "") {
    if (typeof pageRaw !== "string" || !/^[1-9][0-9]{0,4}$/.test(pageRaw)) return { error: "invalid page" };
    page = Number(pageRaw);
  }
  return { form, grain, period, bucket: bucket as ConversionBucket, page };
}

/** Per-patient members of every bucket, for one form and grain. */
function membersCte(p: Pick<ConversionListParams, "form" | "grain">) {
  // grain and form are allow-listed above; they still go in as parameters.
  return sql`
WITH cl AS (
  SELECT x.*,
         CASE WHEN ${p.grain}::text = 'month' THEN x.entry_month ELSE x.entry_week END AS p0,
         CASE WHEN x.conversion_day IS NULL THEN NULL
              WHEN ${p.grain}::text = 'month' THEN date_trunc('month', x.conversion_day)::date
              ELSE date_trunc('week', x.conversion_day)::date END AS pc
    FROM public.drsnip_conversion_classify(${p.form}::text) x
),
cx AS (
  SELECT cl.*,
         CASE WHEN NOT cl.converted OR cl.pc IS NULL THEN NULL
              WHEN ${p.grain}::text = 'month'
                THEN greatest(0, (extract(year FROM cl.pc) * 12 + extract(month FROM cl.pc))
                               - (extract(year FROM cl.p0) * 12 + extract(month FROM cl.p0)))::int
              ELSE greatest(0, (cl.pc - cl.p0) / 7) END AS n
    FROM cl
),
m AS (
  SELECT cx.pid, cx.entry_at, cx.p0, cx.conversion_day,
         cx.is_covered                                     AS forms,
         (cx.is_covered AND cx.converted)                  AS converted_now,
         (cx.is_covered AND NOT cx.converted)              AS not_converted_now,
         (cx.is_covered AND cx.converted AND cx.n <= 0)    AS converted_by_end_of_period,
         (cx.is_covered AND cx.converted AND cx.n <= 1)    AS converted_by_plus1,
         (cx.is_covered AND cx.converted AND cx.n <= 2)    AS converted_by_plus2,
         (cx.is_covered AND cx.converted AND cx.n <= 3)    AS converted_by_plus3
    FROM cx
)`;
}

function bucketColumn(b: ConversionBucket): string {
  if (!(CONVERSION_BUCKETS as readonly string[]).includes(b)) throw new Error("bucket not allow-listed");
  return `m.${b}`;
}

export function conversionCountQuery(p: ConversionListParams) {
  return sql`${membersCte(p)}
SELECT count(*)::int AS total FROM m WHERE ${sql.raw(bucketColumn(p.bucket))} AND m.p0 = ${p.period}::date`;
}

export function conversionListQuery(p: ConversionListParams, opts: { all?: boolean } = {}) {
  const offset = (p.page - 1) * PAGE_SIZE;
  const window = opts.all ? sql`` : sql`LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
  return sql`${membersCte(p)},
sel AS (
  SELECT m.pid, m.entry_at, m.conversion_day FROM m WHERE ${sql.raw(bucketColumn(p.bucket))} AND m.p0 = ${p.period}::date
),
fs AS (
  SELECT DISTINCT ON (s.n8n_patient_id) s.n8n_patient_id::text AS pid, s.id::text AS submission_id,
         s.first_name, s.last_name
    FROM public.submissions s JOIN sel ON sel.pid = s.n8n_patient_id::text
   WHERE s.form_type = ${p.form}::text
   ORDER BY s.n8n_patient_id, s.created_at, s.id
),
la AS (
  SELECT DISTINCT ON (a.patient_source_id) a.patient_source_id AS pid, a.current_status, a.scheduled_time
    FROM public.appointment_snapshots a JOIN sel ON sel.pid = a.patient_source_id
   WHERE a.deleted_flag IS NOT TRUE
   ORDER BY a.patient_source_id, a.scheduled_time DESC NULLS LAST, a.source_appointment_id DESC
)
SELECT sel.pid AS chart_id,
       fs.submission_id,
       btrim(coalesce(fs.first_name, '') || ' ' || coalesce(fs.last_name, '')) AS name,
       to_char(sel.entry_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS registered_on,
       floor(extract(epoch FROM now() - sel.entry_at) / 86400)::int AS days_since,
       (la.pid IS NOT NULL) AS has_appointment,
       la.current_status AS latest_status,
       to_char(la.scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS latest_date,
       to_char(sel.conversion_day, 'YYYY-MM-DD') AS converted_on
  FROM sel
  LEFT JOIN fs ON fs.pid = sel.pid
  LEFT JOIN la ON la.pid = sel.pid
 ORDER BY sel.entry_at, sel.pid
 ${window}`;
}

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function addMonths(period: string, n: number): string {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7)) - 1 + n;
  return `${LONG[((m % 12) + 12) % 12]} ${y + Math.floor(m / 12)}`;
}
function weekOf(period: string, plusWeeks = 0): string {
  const d = new Date(`${period}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * plusWeeks);
  return `week of ${SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Registration, June 2026: converted by end of July (158)" */
export function conversionTitle(p: Pick<ConversionListParams, "form" | "grain" | "period" | "bucket">, total: number): string {
  const form = p.form === "registration" ? "Registration" : "Insurance inquiry";
  const cohort = p.grain === "month" ? addMonths(p.period, 0) : weekOf(p.period).replace(/^w/, "W");
  const by = (n: number) => p.grain === "month"
    ? `converted by end of ${addMonths(p.period, n).replace(/ \d{4}$/, "")}`
    : `converted by end of the ${weekOf(p.period, n)}`;
  const label: Record<ConversionBucket, string> = {
    forms: "all patients",
    converted_now: "converted as of today",
    not_converted_now: "not converted as of today",
    converted_by_end_of_period: by(0),
    converted_by_plus1: by(1),
    converted_by_plus2: by(2),
    converted_by_plus3: by(3),
  };
  return `${form}, ${cohort}: ${label[p.bucket]} (${total.toLocaleString("en-US")})`;
}

export const conversionCohortKey = (p: Pick<ConversionListParams, "form" | "grain" | "period">) => `${p.form}:${p.grain}:${p.period}`;
