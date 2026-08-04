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

export const SUPPRESS_BELOW = 5;

// Allow-listed grouping dimensions → trusted SQL expressions over `submissions`.
// These mirror drsnip_reporting_view (see
// mcp/drsnip-reporting/sql/001_reporting_view_and_role.sql lines 78–106).
export const DIMENSION_EXPR: Record<string, string> = {
  form_type: "form_type",
  n8n_status: "coalesce(n8n_status, 'pending')",
  // Non-identifying categoricals extracted from raw_payload (whitelist only).
  office_location: "raw_payload->>'officeLocation'",
  insurance_coverage: "raw_payload->>'insuranceCoverage'",
  // Derived new-vs-returning label (never the patient id) — replicates the view.
  action_label:
    "(CASE " +
    "WHEN n8n_status = 'manual_review' THEN 'manual_review' " +
    "WHEN n8n_status = 'failed' THEN 'failed' " +
    "WHEN n8n_status IS NULL THEN 'pending' " +
    "WHEN form_type = 'consultation' THEN 'matched' " +
    "WHEN lower(n8n_response_body->'response'->>'drchrono_action') IN ('created','create') THEN 'create' " +
    "WHEN lower(n8n_response_body->'response'->>'drchrono_action') IN ('updated','update') THEN 'update' " +
    "ELSE 'unknown' END)",
  day: "date_trunc('day', created_at)::date",
  week: "date_trunc('week', created_at)::date",
  month: "date_trunc('month', created_at)::date",
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
}): ReturnType<typeof sql> {
  const clauses: ReturnType<typeof sql>[] = [];
  if (opts.formType) clauses.push(sql`form_type = ${opts.formType}`);
  if (opts.from) clauses.push(sql`created_at >= ${opts.from}`);
  if (opts.toExclusive) clauses.push(sql`created_at < ${opts.toExclusive}`);
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
