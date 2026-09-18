// Shared aggregate-only reporting helpers for the marketing dashboard endpoints
// (/api/reports/*). Ported from mcp/drsnip-reporting/src/drsnip-tools.js so the
// PHI posture is identical to the MCP connector:
//
//   • Grouping dimensions come from a fixed ALLOW-LIST → trusted SQL expressions
//     (never user SQL). The client only ever picks a dimension KEY; the SQL
//     expression is our own constant.
//   • Filter VALUES (form_type, dates) are bound as parameters via drizzle's
//     tagged `sql` template — never concatenated.
//   • Minimum-cell suppression: any group count < 5 renders as "<5", so a rare
//     combination can never be pinned to a small number of individuals.
//
// Unlike the MCP (which reads the PHI-free `drsnip_reporting_view` via a
// read-only role), these endpoints run under the app's operator connection
// against the base `submissions` table — so the dimension expressions below
// REPLICATE the view's projections exactly (office/insurance from raw_payload,
// the action_label CASE). They select ONLY non-identifying categoricals and
// counts; no name/email/phone/DOB/address/insurance-id/patient-id is ever
// referenced. Keep it that way: never add a dimension that reads an identifier.

import { sql } from "@workspace/db";
import { CLINIC_TZ } from "./clinic-time";
import { RESOLVED_LOCATION_SQL } from "./location";

export const SUPPRESS_BELOW = 5;

// Clinic-day truncation, as a raw SQL snippet builder. `created_at` is a
// timestamptz; `AT TIME ZONE` converts it to clinic wall-time, so date_trunc
// then buckets on the clinic's calendar instead of the server session's (UTC on
// this deployment). DST-correct because Postgres reads the IANA zone, not an
// offset. See api/_lib/clinic-time.ts for why this had to change.
function clinicTrunc(unit: "day" | "week" | "month"): string {
  return `date_trunc('${unit}', created_at AT TIME ZONE '${CLINIC_TZ}')::date`;
}

/**
 * Canonicalising wrapper for a clinic-location expression.
 *
 * The forms emit exactly "Seattle, WA" / "Portland, OR" / "Plano, TX" and a
 * drift test guards those literals (api/_test/location.test.ts). Historical
 * rows do not all match: a comma-less "Seattle WA" groups as its own bar, which
 * is what produced two Seattle rows on the dashboard.
 *
 * This folds together values that differ ONLY in punctuation, spacing or case.
 * It deliberately does NOT fold a bare city name ("Plano"), because that is a
 * different string with a different possible meaning — folding it would destroy
 * the evidence of what is actually stored. Unmapped values pass through
 * verbatim and appear as their own row, which is the honest rendering.
 */
export function canonicalLocationSql(inner: string): string {
  const key = `lower(regexp_replace(${inner}, '[^a-zA-Z]', '', 'g'))`;
  return (
    `(CASE ` +
    `WHEN ${key} = 'seattlewa' THEN 'Seattle, WA' ` +
    `WHEN ${key} = 'portlandor' THEN 'Portland, OR' ` +
    `WHEN ${key} = 'planotx' THEN 'Plano, TX' ` +
    `ELSE NULLIF(TRIM(${inner}), '') END)`
  );
}

// Allow-listed grouping dimensions → trusted SQL expressions over `submissions`.
// These mirror drsnip_reporting_view (see
// mcp/drsnip-reporting/sql/001_reporting_view_and_role.sql, kept in step with
// mcp/drsnip-reporting/sql/002_action_label_insurance.sql).
export const DIMENSION_EXPR: Record<string, string> = {
  form_type: "form_type",
  n8n_status: "coalesce(n8n_status, 'pending')",
  // Marketing attribution channel (migration 0008). NULL = untagged/direct.
  source: "source",
  // Non-identifying categoricals extracted from raw_payload (whitelist only).
  //
  // office_location reads the submission's OWN officeLocation, trimmed and
  // variant-canonicalised (so "Seattle WA" no longer forms a second Seattle
  // bar). A consultation has none — the form deliberately does not ask — so it
  // groups as NULL, which the tile labels "Not asked (consultation)" rather
  // than the old bare "Unspecified". The subtitle now names that population.
  //
  // It deliberately does NOT use RESOLVED_LOCATION_SQL, even though that would
  // attribute a consultation to its patient's clinic. That expression joins on
  // `email` and `n8n_patient_id`, and a GROUPING dimension must not reference an
  // identifier column at all — api/_test/reports.test.ts enforces exactly that
  // and caught the attempt. The resolved definition stays where it is needed and
  // safe: the submissions list, detail, export and the location FILTER below.
  office_location: canonicalLocationSql("raw_payload->>'officeLocation'"),
  insurance_coverage: "NULLIF(TRIM(raw_payload->>'insuranceCoverage'), '')",
  // Derived new-vs-returning label (never the patient id) — replicates the view.
  // Train C added the 'not_applicable' and form_type='insurance' branches; the
  // insurance branch MUST stay above the generic drchrono_action branches, which
  // would otherwise claim insurance rows and inflate the PATIENT create/update
  // counts with inquirers. Mirror of 002_action_label_insurance.sql — change
  // both together.
  action_label:
    "(CASE " +
    "WHEN n8n_status = 'manual_review' THEN 'manual_review' " +
    "WHEN n8n_status = 'failed' THEN 'failed' " +
    "WHEN n8n_status = 'not_applicable' THEN 'not_applicable' " +
    "WHEN n8n_status IS NULL THEN 'pending' " +
    "WHEN form_type = 'insurance' THEN (CASE " +
    "WHEN lower(n8n_response_body->'response'->>'drchrono_action') IN ('created','create') THEN 'inquiry_create' " +
    "WHEN lower(n8n_response_body->'response'->>'drchrono_action') IN ('updated','update') THEN 'inquiry_update' " +
    "ELSE 'inquiry_unknown' END) " +
    "WHEN form_type = 'consultation' THEN 'matched' " +
    "WHEN lower(n8n_response_body->'response'->>'drchrono_action') IN ('created','create') THEN 'create' " +
    "WHEN lower(n8n_response_body->'response'->>'drchrono_action') IN ('updated','update') THEN 'update' " +
    "ELSE 'unknown' END)",
  // Clinic-day buckets, not UTC. See clinicTrunc + api/_lib/clinic-time.ts.
  day: clinicTrunc("day"),
  week: clinicTrunc("week"),
  month: clinicTrunc("month"),
};

// how_heard is handled separately (jsonb array unnest, consultation-only).
export const COUNT_DIMENSIONS = Object.keys(DIMENSION_EXPR);
export const ALLOWED_DIMENSIONS = [...COUNT_DIMENSIONS, "how_heard"];

export const ALLOWED_FORM_TYPES = ["registration", "consultation", "insurance"];

export function isAllowedDimension(d: unknown): d is string {
  return typeof d === "string" && ALLOWED_DIMENSIONS.includes(d);
}

// Minimum-cell suppression. A count of 0 stays 0 (an explicit "none", not a
// hidden small cell); 1..4 becomes "<5"; 5+ passes through.
export function suppress(n: number): number | string {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v > 0 && v < SUPPRESS_BELOW ? `<${SUPPRESS_BELOW}` : v;
}

export type CountRow = { value: string | null; count: number | string };

/** Apply suppression to a set of grouped rows; report how many cells were hidden. */
export function suppressRows(
  rows: { value: string | null; count: number }[],
): { rows: CountRow[]; suppressed_cells: number } {
  let suppressed = 0;
  const out: CountRow[] = rows.map((r) => {
    const s = suppress(r.count);
    if (typeof s === "string") suppressed += 1;
    return { value: r.value, count: s };
  });
  return { rows: out, suppressed_cells: suppressed };
}

/**
 * Parameterized WHERE fragment (drizzle SQL). Values bound via `${}`, never
 * concatenated. `to` is treated as an EXCLUSIVE upper bound (pass end-of-window
 * next-day midnight); filters on created_at.
 */
export function buildWhere(opts: {
  formType?: string;
  from?: Date;
  toExclusive?: Date;
  /** Canonical clinic location (must have passed isAllowedLocation). */
  location?: string;
}): ReturnType<typeof sql> {
  const clauses: ReturnType<typeof sql>[] = [];
  if (opts.formType) clauses.push(sql`form_type = ${opts.formType}`);
  if (opts.from) clauses.push(sql`created_at >= ${opts.from}`);
  if (opts.toExclusive) clauses.push(sql`created_at < ${opts.toExclusive}`);
  // Filters on the SAME canonicalised, consultation-resolving definition the
  // office_location dimension groups by, so a filtered total always equals that
  // location's bar. The value is bound; only our own expression is raw.
  if (opts.location)
    clauses.push(
      sql`${sql.raw(canonicalLocationSql(RESOLVED_LOCATION_SQL))} = ${opts.location}`,
    );
  if (clauses.length === 0) return sql``;
  return sql`WHERE ${sql.join(clauses, sql` AND `)}`;
}

// ---- date parsing (UTC-day, matching api/submissions/activity.ts) ----------
export function parseDateUtc(value: unknown): Date | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function addDaysUtc(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] as string | undefined;
  if (typeof value === "string") return value;
  return undefined;
}

// ---------------------------------------------------------------------------
// EHR write-back outcome (replaces the old "Success rate" tile)
// ---------------------------------------------------------------------------
//
// WHAT WAS WRONG. Dashboard.tsx computed `success / Σ(status counts)` in the
// browser, from /api/reports/counts rows that had ALREADY been <5-suppressed.
// Three separate defects:
//
//   1. It was a DrChrono write-back rate sitting in a row of patient-count
//      tiles labelled only "Success rate", so it read as patient conversion.
//   2. The denominator silently dropped every suppressed cell. Because the
//      small cells are the FAILURE modes, hiding a 1–4 `failed` bucket RAISED
//      the displayed rate. A rate must never be computed from suppressed cells.
//   3. `not_applicable` sat in the denominator. Those are insurance rows from
//      before the insurance bridge existed — a DELIBERATE skip (see
//      api/submit.ts markBridgeSkipped). Counting a deliberate skip as a
//      non-success depresses the same number defect 2 inflates, and the two do
//      not cancel in any knowable way.
//
// THE DEFINITION NOW. Computed server-side from true counts, with an explicit
// eligible denominator:
//
//   skipped   n8n_status = 'not_applicable'   deliberate bypass — NOT eligible
//   pending   n8n_status IS NULL              in flight, outcome not yet known
//                                             — NOT eligible (it is not a
//                                             failure, it is an absence)
//   resolved  success + manual_review + failed          <- THE DENOMINATOR
//
//   rate = succeeded / resolved, or NULL when resolved = 0.
//
// A zero denominator yields NULL, never 0% — "0% of nothing" is not a rate.
// A measured zero numerator over a nonzero denominator IS 0%, and is reported
// as such.
//
// PRIVACY. `resolved`, `succeeded` and the rate are window-level aggregates
// over a processing status — the same class of figure as total_submissions,
// which api/reports/summary.ts already exempts because it is the denominator
// and identifies nobody. The small COMPONENT counts (manual_review, failed,
// pending, skipped) are the ones that could be small, so those are suppressed
// for display while the rate keeps its true arithmetic.

export type WritebackStatusCounts = {
  success: number;
  manual_review: number;
  failed: number;
  pending: number;
  not_applicable: number;
};

export type WritebackOutcome = {
  /** success + manual_review + failed. The denominator. */
  resolved: number;
  /** Automatic chart write-backs that succeeded. */
  succeeded: number;
  /** Routed to a human. A real outcome, not a failure. Suppressed if small. */
  manual_review: number | string;
  /** Errored. Suppressed if small. */
  failed: number | string;
  /** Still in flight — not in the denominator. Suppressed if small. */
  pending: number | string;
  /** Deliberate bypass — not in the denominator. Suppressed if small. */
  skipped: number | string;
  /** succeeded / resolved as a percentage, one decimal. NULL when resolved=0. */
  rate_pct: number | null;
  /** The denominator in words, for the on-screen basis line. */
  basis: string;
};

export const WRITEBACK_BASIS =
  "automatic chart write-backs ÷ submissions with a resolved outcome " +
  "(excludes deliberate skips and submissions still in flight)";

/** Sum a status name out of a raw (unsuppressed) count map. */
function n(counts: Partial<WritebackStatusCounts>, key: keyof WritebackStatusCounts): number {
  const v = counts[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Build the write-back outcome from TRUE (unsuppressed) status counts.
 *
 * Callers must pass raw counts straight from SQL. Passing suppressed values
 * here would reintroduce defect 2.
 */
export function writebackOutcome(
  counts: Partial<WritebackStatusCounts>,
): WritebackOutcome {
  const succeeded = n(counts, "success");
  const manualReview = n(counts, "manual_review");
  const failed = n(counts, "failed");
  const pending = n(counts, "pending");
  const skipped = n(counts, "not_applicable");

  const resolved = succeeded + manualReview + failed;

  return {
    resolved,
    succeeded,
    manual_review: suppress(manualReview),
    failed: suppress(failed),
    pending: suppress(pending),
    skipped: suppress(skipped),
    rate_pct: resolved === 0 ? null : Math.round((succeeded / resolved) * 1000) / 10,
    basis: WRITEBACK_BASIS,
  };
}
