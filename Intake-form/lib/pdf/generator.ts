// Phase 3 — generateSubmissionPdf: the PDF entrypoint (PHASE_3_PLAN.md §6, §8).
//
// Pure function — takes a `submissions` row, returns PDF bytes. No HTTP, no
// auth, no side effects, no disk writes. This is the seam: the admin download
// endpoint calls it today; a future n8n -> DrChrono webhook handler can call
// the exact same function.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, type PDFImage } from "pdf-lib";
import type { Submission } from "@workspace/db";
import { calculateAge } from "./age";
import { PdfCursor, stampFooters, type PdfFonts } from "./cursor";
import { renderHeader, type HeaderData } from "./layout/header";
import {
  renderArrayValue,
  renderChildrenBlock,
  renderKeyValue,
  renderMedicalAnswer,
  type ChildRow,
} from "./layout/sections";
import { REGISTRATION_SECTIONS } from "./templates/registration";
import { CONSULTATION_SECTIONS } from "./templates/consultation";
import { INSURANCE_SECTIONS } from "./templates/insurance";

// The built SPA (and thus the logo) travels in the runtime image at this path.
const LOGO_PATH = "artifacts/intake-form/dist/public/images/drsnip-logo.png";

/** Build a doctor-friendly PDF (Uint8Array) for one submission. */
export async function generateSubmissionPdf(
  submission: Submission,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`DrSnip Intake — ${submission.id}`);

  const fonts: PdfFonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    oblique: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const logo = await loadLogo(doc);

  const raw = asRecord(submission.rawPayload);
  const isConsultation = submission.formType === "consultation";
  // Train D: insurance is a third form type. Kept as its own flag rather than
  // folding into isConsultation so every existing branch below reads unchanged.
  const isInsurance = submission.formType === "insurance";
  const children = toChildren(raw.children);

  const cursor = new PdfCursor(doc, fonts);

  // ---- Page-1 header (form-type-aware) ---------------------------------
  const header: HeaderData = {
    formType: isInsurance
      ? "insurance"
      : isConsultation
        ? "consultation"
        : "registration",
    patientName:
      `${submission.firstName} ${submission.lastName}`.trim() ||
      "Unknown Patient",
    // Spouse + children only exist on Consultation submissions (Option A).
    spouseName: isConsultation ? buildSpouseName(raw) : null,
    childCount: isConsultation ? children.length : null,
    age: calculateAge(submission.dateOfBirth),
    dateOfBirth: submission.dateOfBirth ?? null,
    // Insurance summaries are read by the benefits team against clinic hours,
    // so they carry Pacific rather than UTC. Registration/Consultation keep UTC
    // — changing those would alter documents already in patient charts.
    submittedAt: isInsurance
      ? formatTimestampPacific(submission.createdAt)
      : formatTimestamp(submission.createdAt),
    submissionId: submission.id,
    logo,
  };
  renderHeader(cursor, header);

  // ---- Full submission, section by section -----------------------------
  const sections = isInsurance
    ? INSURANCE_SECTIONS
    : isConsultation
      ? CONSULTATION_SECTIONS
      : REGISTRATION_SECTIONS;
  const medicalDetails = asRecord(raw.medicalDetails);

  for (const section of sections) {
    cursor.heading(section.title);
    for (const field of section.fields) {
      switch (field.kind) {
        case "medical":
          renderMedicalAnswer(
            cursor,
            field.label,
            scalar(lookupPath(raw, field.key)),
            scalar(medicalDetails[field.key]),
          );
          break;
        case "array":
          renderArrayValue(cursor, field.label, toStringArray(lookupPath(raw, field.key)));
          break;
        case "children":
          renderChildrenBlock(cursor, children);
          break;
        case "file":
          renderKeyValue(cursor, field.label, fileRefToString(lookupPath(raw, field.key)));
          break;
        default:
          renderKeyValue(cursor, field.label, scalar(lookupPath(raw, field.key)));
      }
    }
  }

  // ---- Footer on every page (now that the total is known) --------------
  // PDF-D1: patient name leads every page's footer so separated pages re-match.
  stampFooters(doc, fonts.regular, submission.id, header.patientName);

  return doc.save();
}

// ---- helpers -------------------------------------------------------------

async function loadLogo(doc: PDFDocument): Promise<PDFImage | null> {
  try {
    const bytes = readFileSync(join(process.cwd(), LOGO_PATH));
    return await doc.embedPng(bytes);
  } catch {
    // Missing/unreadable logo → header falls back to a text wordmark.
    return null;
  }
}

function buildSpouseName(raw: Record<string, unknown>): string | null {
  const name = `${scalar(raw.partnerFirstName)} ${scalar(raw.partnerLastName)}`
    .trim();
  return name || null;
}

/**
 * Resolve a template field key against raw_payload. A plain key ("firstName")
 * is a direct property read, byte-for-byte the previous behavior. A dotted key
 * ("insurance.primary.carrier") walks nested objects, which the insurance form
 * needs because it nests carrier data. Any missing or non-object link in the
 * chain yields undefined, which every renderer already displays as "—".
 * Exported for direct testing.
 */
export function lookupPath(
  root: Record<string, unknown>,
  key: string,
): unknown {
  if (!key.includes(".")) return root[key];
  let node: unknown = root;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function formatTimestamp(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "Aug 19, 2026, 2:41 PM PT" — clinic-local, for the insurance summary. */
function formatTimestampPacific(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return `${s} PT`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function scalar(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map((x) => scalar(x)).filter((s) => s !== "")
    : [];
}

function toChildren(v: unknown): ChildRow[] {
  if (!Array.isArray(v)) return [];
  // raw_payload.children is already sliced to the stated count at submit time,
  // so every row here is a declared child (blank fields render as "—").
  return v.map((c) => {
    const r = asRecord(c);
    return {
      age: scalar(r.age),
      relation: scalar(r.relation),
      gender: scalar(r.gender),
    };
  });
}

function fileRefToString(v: unknown): string {
  const filename = scalar(asRecord(v).filename);
  return filename ? `${filename} — image attached separately` : "";
}
