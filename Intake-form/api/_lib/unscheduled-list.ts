// Drill-down behind every count on "Unscheduled at day 14" (admin only).
//
// The rows come from the SAME per-patient bucket CTE the page counts
// (DAY14_BUCKET_CTE in ./unscheduled-day14), so a list total always equals the
// cell it was opened from. Nothing here redefines "booked".
//
// Minimum necessary: per patient, the name as stored on their first
// registration, that registration's date (Pacific) and age in days, their most
// recent appointment's status and date, the submission id (for the console
// link) and the DrChrono chart id. No phone, email, DOB, address, insurance or
// clinical field is selected.

import { sql } from "@workspace/db";
import {
  DAY14_BUCKET_CTE,
  MONTH_BUCKETS,
  RIGHT_NOW_BUCKETS,
  isBucket,
  isMonthBucket,
  type Bucket,
} from "./unscheduled-day14";

export const PAGE_SIZE = 100;
export const FIRST_MONTH = "2026-06";
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const idx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

export type Cohort =
  | { kind: "month"; month: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "none" };

export type ListParams = { bucket: Bucket; cohort: Cohort; page: number };

/** The current month on the clinic calendar. */
export function clinicMonth(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" })
    .format(now).slice(0, 7);
}

const okMonth = (m: string, current: string) =>
  MONTH_RE.test(m) && idx(m) >= idx(FIRST_MONTH) && idx(m) <= idx(current);

/** Allow-list validation. Returns the parsed params or a 400 message. */
export function parseListParams(
  q: Record<string, unknown>,
  current: string = clinicMonth(),
): ListParams | { error: string } {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const bucket = one(q.bucket);
  const month = one(q.month);
  const range = one(q.range);
  const pageRaw = one(q.page);
  if (!isBucket(bucket)) return { error: "invalid bucket" };
  let page = 1;
  if (pageRaw !== undefined && pageRaw !== "") {
    if (typeof pageRaw !== "string" || !/^[1-9][0-9]{0,4}$/.test(pageRaw)) return { error: "invalid page" };
    page = Number(pageRaw);
  }
  if (!isMonthBucket(bucket)) {
    if (month !== undefined || range !== undefined) return { error: "this bucket takes no month or range" };
    return { bucket, cohort: { kind: "none" }, page };
  }
  if ((month === undefined) === (range === undefined)) return { error: "give exactly one of month or range" };
  if (month !== undefined) {
    if (typeof month !== "string" || !okMonth(month, current)) return { error: "invalid month" };
    return { bucket, cohort: { kind: "month", month }, page };
  }
  if (typeof range !== "string") return { error: "invalid range" };
  const m = /^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/.exec(range);
  if (!m || !okMonth(m[1], current) || !okMonth(m[2], current) || idx(m[1]) > idx(m[2])) return { error: "invalid range" };
  return { bucket, cohort: { kind: "range", from: m[1], to: m[2] }, page };
}

/** The bucket's column, from the allow-list only — never from user text. */
function bucketColumn(b: Bucket): string {
  const all = [...MONTH_BUCKETS, ...RIGHT_NOW_BUCKETS] as readonly string[];
  if (!all.includes(b)) throw new Error("bucket not allow-listed");
  return `b.${b}`;
}

function cohortFilter(c: Cohort) {
  if (c.kind === "month") return sql`AND b.entry_month = ${`${c.month}-01`}::date`;
  if (c.kind === "range") return sql`AND b.entry_month BETWEEN ${`${c.from}-01`}::date AND ${`${c.to}-01`}::date`;
  return sql``;
}

export function countQuery(p: ListParams) {
  return sql`${sql.raw(DAY14_BUCKET_CTE)}
SELECT count(*)::int AS total FROM b WHERE ${sql.raw(bucketColumn(p.bucket))} ${cohortFilter(p.cohort)}`;
}

/** The list rows. `all` drops the page window (CSV export): same query, every row. */
export function listQuery(p: ListParams, opts: { all?: boolean } = {}) {
  const offset = (p.page - 1) * PAGE_SIZE;
  const window = opts.all ? sql`` : sql`LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
  return sql`${sql.raw(DAY14_BUCKET_CTE)},
sel AS (
  SELECT b.pid, b.entry_at FROM b WHERE ${sql.raw(bucketColumn(p.bucket))} ${cohortFilter(p.cohort)}
),
fs AS (
  SELECT DISTINCT ON (s.n8n_patient_id) s.n8n_patient_id::text AS pid, s.id::text AS submission_id,
         s.first_name, s.last_name
    FROM public.submissions s JOIN sel ON sel.pid = s.n8n_patient_id::text
   WHERE s.form_type = 'registration'
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
       -- scheduled_time is DrChrono's Pacific wall-clock stored as UTC (0023 header).
       to_char(la.scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS latest_date
  FROM sel
  LEFT JOIN fs ON fs.pid = sel.pid
  LEFT JOIN la ON la.pid = sel.pid
 ORDER BY sel.entry_at, sel.pid
 ${window}`;
}

export const BUCKET_LABELS: Record<Bucket, string> = {
  unscheduled_d14: "nothing booked by day 14",
  booked_later: "nothing booked by day 14, booked later",
  never_booked: "nothing booked by day 14, never booked",
  never_no_appt: "never booked, no appointment",
  never_canceled_noshow: "never booked, canceled or no-show",
  never_no_status: "never booked, appointment with no status",
  right_now_unbooked: "registered in the last 30 days, nothing booked yet",
  right_now_past_d14: "registered in the last 30 days, nothing booked, more than 14 days ago",
};

export function cohortKey(c: Cohort): string {
  return c.kind === "month" ? c.month : c.kind === "range" ? `${c.from}..${c.to}` : "last-30-days";
}
