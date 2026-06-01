// GET /api/submissions/export — flat CSV of submissions (Phase 4 Block D, D.2).
//
// ADMIN ONLY (requireAdmin → 403 for viewers). Honors the same optional
// filters as the list view (form_type / start_date / end_date / search) so it
// exports "this view". The CSV is flat: dedicated patient/insurance/n8n
// columns + every raw_payload answer (prefixed `rp_`), including each medical
// mhX Yes/No AND its `rp_mhX_explanation` from raw_payload.medicalDetails.
//
// HIPAA: every export is audit-logged with { ts, actor_email, row_count,
// filters } — NEVER any PHI field value. The `search` term itself can be PHI
// (a patient name/email), so the audit records only WHETHER a search was
// applied, not its text. The CSV file content is PHI, but it is only ever
// returned to the authenticated admin who requested it; it is never logged.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  and,
  db,
  desc,
  eq,
  gte,
  ilike,
  lte,
  or,
  submissions,
} from "@workspace/db";
import { requireAdmin } from "../_lib/auth";

const ALLOWED_FORM_TYPES = new Set(["registration", "consultation"]);

function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] as string | undefined;
  if (typeof value === "string") return value;
  return undefined;
}

function parseDateStart(value: unknown): Date | undefined {
  const v = firstOf(value);
  const m = v && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0));
}

function parseDateEndExclusive(value: unknown): Date | undefined {
  const v = firstOf(value);
  const m = v && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 0, 0, 0, 0));
}

// Dedicated (non-raw_payload) columns, in a fixed, doctor-friendly order.
const FIXED_COLUMNS: Array<{ header: string; get: (r: SubmissionRow) => unknown }> = [
  { header: "id", get: (r) => r.id },
  { header: "created_at", get: (r) => toIso(r.createdAt) },
  { header: "form_type", get: (r) => r.formType },
  { header: "first_name", get: (r) => r.firstName },
  { header: "last_name", get: (r) => r.lastName },
  { header: "email", get: (r) => r.email },
  { header: "phone", get: (r) => r.phone },
  { header: "date_of_birth", get: (r) => r.dateOfBirth },
  { header: "state_residence", get: (r) => r.stateResidence },
  { header: "insurance_card_front_filename", get: (r) => r.insuranceCardFrontFilename },
  { header: "insurance_card_back_filename", get: (r) => r.insuranceCardBackFilename },
  // Partner (B.4 "Both") card filenames. There is no dedicated DB column for
  // these, so the filename is read from the sanitized raw_payload metadata —
  // records that a partner card was uploaded, without the bytes. Mirrors the
  // original card filename columns above.
  { header: "partner_insurance_card_front_filename", get: (r) => rawCardFilename(r.rawPayload, "partnerInsuranceCardFront") },
  { header: "partner_insurance_card_back_filename", get: (r) => rawCardFilename(r.rawPayload, "partnerInsuranceCardBack") },
  { header: "has_insurance_cards", get: (r) => r.hasInsuranceCards },
  { header: "mh_mental_illness", get: (r) => r.mhMentalIllness },
  { header: "n8n_status", get: (r) => r.n8nStatus },
  { header: "n8n_patient_id", get: (r) => r.n8nPatientId },
  { header: "n8n_response_at", get: (r) => toIso(r.n8nResponseAt) },
];

// raw_payload keys handled specially / excluded from the generic `rp_` sweep:
// medicalDetails is exploded into rp_<key>_explanation columns; card objects
// are skipped (filenames are already dedicated columns, and base64 must never
// be exported — it is stripped at submit anyway).
const RAW_SPECIAL_KEYS = new Set([
  "medicalDetails",
  "insuranceCardFront",
  "insuranceCardBack",
  // B.4 partner ("Both") cards — excluded from the generic rp_ sweep exactly
  // like the originals; their filenames surface as dedicated columns above so
  // no base64/object JSON is ever dumped into the CSV.
  "partnerInsuranceCardFront",
  "partnerInsuranceCardBack",
]);

type SubmissionRow = typeof submissions.$inferSelect;

// Pull a card filename out of a raw_payload card-object metadata value.
// Returns "" when absent. Used for the partner card columns (which have no
// dedicated DB column). Never reads base64Data.
function rawCardFilename(rawPayload: unknown, key: string): string {
  const card = asRecord(asRecord(rawPayload)[key]);
  return typeof card.filename === "string" ? card.filename : "";
}

function toIso(v: Date | string | null): string {
  if (v == null) return "";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// Flatten one raw_payload value into a single CSV cell. Scalars stringify;
// arrays join (objects within arrays → JSON); nested objects → JSON.
function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return String(v);
  if (Array.isArray(v))
    return v
      .map((x) =>
        x && typeof x === "object" ? JSON.stringify(x) : String(x ?? ""),
      )
      .join(" | ");
  return JSON.stringify(v);
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Assemble the flat CSV (header + one line per row). Pure — exported so the
 * column behavior is verifiable without a live DB. Builds the dynamic column
 * set (union of raw_payload keys across rows, minus RAW_SPECIAL_KEYS, plus an
 * rp_<key>_explanation column per medical key) on top of the fixed columns.
 */
export function buildSubmissionsCsv(rows: SubmissionRow[]): string {
  const rawKeys = new Set<string>();
  const explanationKeys = new Set<string>();
  for (const r of rows) {
    const raw = asRecord(r.rawPayload);
    for (const k of Object.keys(raw)) {
      if (!RAW_SPECIAL_KEYS.has(k)) rawKeys.add(k);
    }
    for (const k of Object.keys(asRecord(raw.medicalDetails))) {
      explanationKeys.add(k);
    }
  }
  const rawCols = [...rawKeys].sort();
  const explCols = [...explanationKeys].sort();

  const header = [
    ...FIXED_COLUMNS.map((c) => c.header),
    ...rawCols.map((k) => `rp_${k}`),
    ...explCols.map((k) => `rp_${k}_explanation`),
  ];

  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    const raw = asRecord(r.rawPayload);
    const details = asRecord(raw.medicalDetails);
    const cells = [
      ...FIXED_COLUMNS.map((c) => cell(c.get(r))),
      ...rawCols.map((k) => cell(raw[k])),
      ...explCols.map((k) => cell(details[k])),
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Admin-only — viewers get 403 even though the UI hides the Export button.
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const q = req.query;
  const formTypeParam = firstOf(q.form_type);
  const search = firstOf(q.search);
  const startDate = parseDateStart(q.start_date);
  const endDateExclusive = parseDateEndExclusive(q.end_date);

  const filters = [];
  if (formTypeParam && ALLOWED_FORM_TYPES.has(formTypeParam)) {
    filters.push(eq(submissions.formType, formTypeParam));
  }
  if (startDate) filters.push(gte(submissions.createdAt, startDate));
  if (endDateExclusive) filters.push(lte(submissions.createdAt, endDateExclusive));
  if (search && search.trim().length > 0) {
    const pattern = `%${search.trim()}%`;
    const clause = or(
      ilike(submissions.email, pattern),
      ilike(submissions.firstName, pattern),
      ilike(submissions.lastName, pattern),
    );
    if (clause) filters.push(clause);
  }
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const rows = (await db
    .select()
    .from(submissions)
    .where(whereClause)
    .orderBy(desc(submissions.createdAt))) as SubmissionRow[];

  const csv = buildSubmissionsCsv(rows);

  // Audit (HIPAA): IDs + counts + filter shape only. The search TEXT is PHI,
  // so record only whether a search was applied — never its value.
  console.log(
    "[admin] submissions_export " +
      JSON.stringify({
        ts: new Date().toISOString(),
        actor_email: auth.user.email,
        row_count: rows.length,
        filters: {
          form_type: formTypeParam ?? null,
          start_date: firstOf(q.start_date) ?? null,
          end_date: firstOf(q.end_date) ?? null,
          searched: Boolean(search && search.trim()),
        },
      }),
  );

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="drsnip-submissions-${stamp}.csv"`,
  );
  return res.status(200).send(csv);
}
