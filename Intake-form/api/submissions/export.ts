// GET /api/submissions/export — per-form CSV download (Phase 7).
//
// ADMIN ONLY (requireAdmin → 403 for viewers). Requires a `form_type` of
// `registration` OR `consultation` and exports ONLY that form's rows, using an
// EXPLICIT, ordered, schema-driven column list for that form (see
// REGISTRATION_COLUMNS / CONSULTATION_COLUMNS below). Every form field always
// gets a column — blank when unanswered — so optional fields and per-question
// explanations never silently vanish (the old data-driven `rp_` sweep did that).
// Honors the same optional date/search filters as the list view. The two admin
// "Export Registration" / "Export Consultation" buttons each call this with the
// matching form_type.
//
// HIPAA: every export is audit-logged with { ts, actor_email, form_type,
// row_count, filters } — NEVER any PHI field value (the `search` term itself can
// be PHI, so we record only WHETHER a search was applied). Insurance-card
// columns are FILENAMES ONLY — the base64 image bytes are stripped at submit
// (api/submit.ts sanitizeForPersistence) and are never read here.

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

type SubmissionRow = typeof submissions.$inferSelect;
type FormType = "registration" | "consultation";
const FORM_TYPES = new Set<FormType>(["registration", "consultation"]);

const MAX_CHILDREN = 8;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

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

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function toIso(v: Date | string | null): string {
  if (v == null) return "";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Scalar stringify. Objects/arrays → "" here on purpose: arrays use joinArr()
// and nested objects (cards, children) have dedicated getters. This guarantees
// no object (e.g. an insurance-card object with base64Data) is ever stringified
// into a cell.
function scalar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return "";
}

function raw(r: SubmissionRow): Record<string, unknown> {
  return asRecord(r.rawPayload);
}

/** Read a scalar form field out of raw_payload by key. */
function rp(key: string): (r: SubmissionRow) => string {
  return (r) => scalar(raw(r)[key]);
}

/** Multi-select array → single readable cell, joined with " | ". */
function rpArray(key: string): (r: SubmissionRow) => string {
  return (r) => {
    const v = raw(r)[key];
    return Array.isArray(v)
      ? v.map((x) => (x == null ? "" : String(x))).filter((x) => x !== "").join(" | ")
      : "";
  };
}

/** Per-question explanation stored under raw_payload.medicalDetails.<key>. */
function rpMedicalDetail(key: string): (r: SubmissionRow) => string {
  return (r) => {
    const v = asRecord(raw(r).medicalDetails)[key];
    return typeof v === "string" ? v : "";
  };
}

/**
 * Insurance-card column = FILENAME ONLY. Reads raw_payload.<key>.filename and
 * NOTHING else — base64Data is never touched (and is already stripped from
 * raw_payload at submit). This preserves the HIPAA card-bytes stripping.
 */
function cardFilename(key: string): (r: SubmissionRow) => string {
  return (r) => {
    const card = asRecord(raw(r)[key]);
    return typeof card.filename === "string" ? card.filename : "";
  };
}

/** A single child's field from raw_payload.children[index]. */
function childField(index: number, field: "age" | "relation" | "gender"): (r: SubmissionRow) => string {
  return (r) => {
    const arr = raw(r).children;
    if (!Array.isArray(arr) || index >= arr.length) return "";
    return scalar(asRecord(arr[index])[field]);
  };
}

type Column = { header: string; get: (r: SubmissionRow) => string };

/** Medical Yes/No question → answer column + a dedicated details column. */
function medicalQ(label: string, key: string): Column[] {
  return [
    { header: label, get: rp(key) },
    { header: `${label} — Details`, get: rpMedicalDetail(key) },
  ];
}

/** A flat Yes/No + its flat details field (Consultation considerations). */
function flatQWithDetail(label: string, key: string, detailKey: string): Column[] {
  return [
    { header: label, get: rp(key) },
    { header: `${label} — Details`, get: rp(detailKey) },
  ];
}

// Meta / ops columns — placed at the END (clinical answer data leads).
const META_COLUMNS: Column[] = [
  { header: "Submission ID", get: (r) => r.id },
  { header: "Submitted At", get: (r) => toIso(r.createdAt) },
  { header: "Form Type", get: (r) => r.formType },
  { header: "DrChrono Sync Status", get: (r) => scalar(r.n8nStatus) },
  { header: "DrChrono Patient ID", get: (r) => (r.n8nPatientId == null ? "" : String(r.n8nPatientId)) },
  { header: "DrChrono Sync At", get: (r) => toIso(r.n8nResponseAt) },
];

// ---------------------------------------------------------------------------
// Registration column schema (mirrors Home.tsx field set, post-Phase 6)
// ---------------------------------------------------------------------------
const REGISTRATION_COLUMNS: Column[] = [
  // Patient Information
  { header: "Office Location", get: rp("officeLocation") },
  { header: "Legal First Name", get: rp("legalFirstName") },
  { header: "Preferred First Name", get: rp("preferredFirstName") },
  { header: "Middle Initial", get: rp("middleInitial") },
  { header: "Legal Last Name", get: rp("legalLastName") },
  { header: "Date of Birth", get: rp("dateOfBirth") },
  // Contact & Consent
  { header: "Street Address", get: rp("streetAddress") },
  { header: "City", get: rp("city") },
  { header: "State", get: rp("state") },
  { header: "ZIP Code", get: rp("postalCode") },
  { header: "Mobile Number", get: rp("mobileNumber") },
  { header: "Email", get: rp("email") },
  { header: "Consent: Voicemail", get: rp("consentVoicemail") },
  { header: "Consent: Text Messages", get: rp("consentText") },
  // Medical History (PCP + 11 questions, each answer + details)
  { header: "Primary Care Physician", get: rp("primaryCarePhysician") },
  ...medicalQ("Bleeds Easily", "mhBleeding"),
  ...medicalQ("Kidney Abnormality", "mhKidney"),
  ...medicalQ("STI History", "mhSTI"),
  ...medicalQ("Hernia / Testicle or Scrotum Abnormality", "mhTesticleAbnormality"),
  ...medicalQ("Testicle Injury or Surgery", "mhTesticleInjury"),
  ...medicalQ("Prior Surgeries", "mhSurgeries"),
  ...medicalQ("Surgery Complications", "mhSurgeryComplications"),
  ...medicalQ("Current / Recent Medications", "mhMedications"),
  ...medicalQ("Aspirin Use", "mhAspirin"),
  ...medicalQ("Drug Allergies", "mhAllergies"),
  ...medicalQ("Chronic / Major Medical Problems", "mhChronic"),
  // Insurance — own
  { header: "Insurance Coverage", get: rp("insuranceCoverage") },
  { header: "Insurance Company", get: rp("insuranceCompany") },
  { header: "Insurance ID No.", get: rp("insuranceIdNo") },
  { header: "Insurance Group No.", get: rp("insuranceGroupNo") },
  { header: "Insured First Name", get: rp("insuredFirstName") },
  { header: "Insured Last Name", get: rp("insuredLastName") },
  { header: "Insured Date of Birth", get: rp("insuredDob") },
  { header: "Insured Employer", get: rp("insuredEmployer") },
  { header: "Insurance Card Front (filename)", get: cardFilename("insuranceCardFront") },
  { header: "Insurance Card Back (filename)", get: cardFilename("insuranceCardBack") },
  // Insurance — partner ("Both" coverage). Metadata/filenames ONLY — no bytes.
  { header: "Partner Insurance Company", get: rp("partnerInsuranceCompany") },
  { header: "Partner Insurance ID No.", get: rp("partnerInsuranceIdNo") },
  { header: "Partner Insurance Group No.", get: rp("partnerInsuranceGroupNo") },
  { header: "Partner Insured First Name", get: rp("partnerInsuredFirstName") },
  { header: "Partner Insured Last Name", get: rp("partnerInsuredLastName") },
  { header: "Partner Insured Date of Birth", get: rp("partnerInsuredDob") },
  { header: "Partner Insured Employer", get: rp("partnerInsuredEmployer") },
  { header: "Partner Insurance Card Front (filename)", get: cardFilename("partnerInsuranceCardFront") },
  { header: "Partner Insurance Card Back (filename)", get: cardFilename("partnerInsuranceCardBack") },
  { header: "Insurance Cards Uploaded", get: (r) => (r.hasInsuranceCards ? "Yes" : "No") },
  // Ops / meta last
  ...META_COLUMNS,
];

// ---------------------------------------------------------------------------
// Consultation column schema (mirrors Consultation.tsx field set, post-Phase 6)
// ---------------------------------------------------------------------------
function childColumns(): Column[] {
  const cols: Column[] = [];
  for (let i = 0; i < MAX_CHILDREN; i++) {
    cols.push({ header: `Child ${i + 1} Age`, get: childField(i, "age") });
    cols.push({ header: `Child ${i + 1} Relation`, get: childField(i, "relation") });
    cols.push({ header: `Child ${i + 1} Gender`, get: childField(i, "gender") });
  }
  return cols;
}

const CONSULTATION_COLUMNS: Column[] = [
  // About You
  { header: "First Name", get: rp("firstName") },
  { header: "Last Name", get: rp("lastName") },
  { header: "Email", get: rp("email") },
  { header: "Phone", get: rp("phone") },
  { header: "Date of Birth", get: rp("dateOfBirth") },
  { header: "Occupation", get: rp("occupation") },
  { header: "Employer", get: rp("employer") },
  { header: "Job Title", get: rp("jobTitle") },
  { header: "Job Demands", get: rp("jobDemands") },
  // Relationship
  { header: "Relationship Status", get: rp("relationshipStatus") },
  { header: "Relationship Status (Other)", get: rp("relationshipStatusOther") },
  { header: "Partner First Name", get: rp("partnerFirstName") },
  { header: "Partner Last Name", get: rp("partnerLastName") },
  { header: "Partner Phone", get: rp("partnerPhone") },
  { header: "Partner Share Consent", get: rp("partnerShareConsent") },
  { header: "Partner Age", get: rp("partnerAge") },
  { header: "Partner Occupation", get: rp("partnerOccupation") },
  { header: "Years in Relationship", get: rp("yearsInRelationship") },
  { header: "Marriage # (Self)", get: rp("marriageNumberSelf") },
  { header: "Marriage # (Spouse)", get: rp("marriageNumberSpouse") },
  // Children
  { header: "Number of Children", get: rp("childCount") },
  ...childColumns(),
  // Family Planning
  { header: "Wants More Children", get: rp("wantMoreChildren") },
  { header: "Would Consider Adoption", get: rp("considerAdoption") },
  { header: "Vasectomy Considered — Duration", get: rp("vasectomyConsideredDuration") },
  // Birth Control
  { header: "Considered Tubal Ligation", get: rp("consideredTubal") },
  { header: "Considered Temporary Birth Control", get: rp("consideredTemporaryBC") },
  { header: "Current Birth Control", get: rpArray("currentBC") },
  { header: "Current Birth Control (Other)", get: rp("currentBCOther") },
  { header: "Prior Birth Control", get: rpArray("priorBC") },
  // Medical & Personal Considerations (flat answer + flat details)
  ...flatQWithDetail("Vasectomy Conflicts with Religion", "religionConflict", "religionConflictDetails"),
  ...flatQWithDetail("Sexual Problems / Concerns", "sexualConcerns", "sexualConcernsDetails"),
  ...flatQWithDetail("Sterilization Due to Genetic Condition", "geneticCondition", "geneticConditionDetails"),
  // Relocated medical questions (Phase 6) — answer + medicalDetails-based detail
  ...medicalQ("Mental Illness / Depression Affects Decisions", "mhMentalIllness"),
  ...medicalQ("More Sensitive to Pain than Average", "mhPainSensitive"),
  ...medicalQ("Ever Fainted During/After a Procedure", "mhFainting"),
  // Emergency Contact & Referral
  { header: "Emergency Contact Name", get: rp("emergencyName") },
  { header: "Emergency Contact Phone", get: rp("emergencyPhone") },
  { header: "Emergency Contact Relationship", get: rp("emergencyRelationship") },
  { header: "How Heard About DrSnip", get: rpArray("howHeard") },
  { header: "How Heard (Other)", get: rp("howHeardOther") },
  { header: "Referring Professional", get: rp("referringProfessional") },
  { header: "Additional Notes", get: rp("additionalNotes") },
  // Ops / meta last (+ the linked patient ref from the consultation URL)
  { header: "Linked Patient ID (from link)", get: rp("patientId") },
  ...META_COLUMNS,
];

export const COLUMNS_BY_FORM: Record<FormType, Column[]> = {
  registration: REGISTRATION_COLUMNS,
  consultation: CONSULTATION_COLUMNS,
};

/**
 * Build a single-form CSV from an explicit, ordered column schema. Every column
 * is always emitted (blank when the field is absent) — pure, exported so the
 * column behavior is verifiable without a live DB.
 */
export function buildFormCsv(rows: SubmissionRow[], columns: Column[]): string {
  const lines = [columns.map((c) => csvEscape(c.header)).join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => csvEscape(c.get(r))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Admin-only — viewers get 403 even though the UI hides the Export button.
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const q = req.query;
  // Phase 7: each form exports as its own file — form_type is REQUIRED and
  // selects the column schema. (The old combined "all" export is gone.)
  const formTypeParam = firstOf(q.form_type);
  if (!formTypeParam || !FORM_TYPES.has(formTypeParam as FormType)) {
    return res
      .status(400)
      .json({ error: "form_type query param is required (registration | consultation)" });
  }
  const formType = formTypeParam as FormType;

  const search = firstOf(q.search);
  const startDate = parseDateStart(q.start_date);
  const endDateExclusive = parseDateEndExclusive(q.end_date);

  const filters = [eq(submissions.formType, formType)];
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

  const rows = (await db
    .select()
    .from(submissions)
    .where(and(...filters))
    .orderBy(desc(submissions.createdAt))) as SubmissionRow[];

  const csv = buildFormCsv(rows, COLUMNS_BY_FORM[formType]);

  // Audit (HIPAA): IDs + counts + filter shape only. The search TEXT is PHI,
  // so record only whether a search was applied — never its value.
  console.log(
    "[admin] submissions_export " +
      JSON.stringify({
        ts: new Date().toISOString(),
        actor_email: auth.user.email,
        form_type: formType,
        row_count: rows.length,
        filters: {
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
    `attachment; filename="drsnip-${formType}-${stamp}.csv"`,
  );
  return res.status(200).send(csv);
}
