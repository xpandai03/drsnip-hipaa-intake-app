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
  const children = toChildren(raw.children);

  const cursor = new PdfCursor(doc, fonts);

  // ---- Page-1 header (form-type-aware) ---------------------------------
  const header: HeaderData = {
    formType: isConsultation ? "consultation" : "registration",
    patientName:
      `${submission.firstName} ${submission.lastName}`.trim() ||
      "Unknown Patient",
    // Spouse + children only exist on Consultation submissions (Option A).
    spouseName: isConsultation ? buildSpouseName(raw) : null,
    childCount: isConsultation ? children.length : null,
    age: calculateAge(submission.dateOfBirth),
    dateOfBirth: submission.dateOfBirth ?? null,
    submittedAt: formatTimestamp(submission.createdAt),
    submissionId: submission.id,
    logo,
  };
  renderHeader(cursor, header);

  // ---- Full submission, section by section -----------------------------
  const sections = isConsultation
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
            scalar(raw[field.key]),
            scalar(medicalDetails[field.key]),
          );
          break;
        case "array":
          renderArrayValue(cursor, field.label, toStringArray(raw[field.key]));
          break;
        case "children":
          renderChildrenBlock(cursor, children);
          break;
        case "file":
          renderKeyValue(cursor, field.label, fileRefToString(raw[field.key]));
          break;
        default:
          renderKeyValue(cursor, field.label, scalar(raw[field.key]));
      }
    }
  }

  // ---- Footer on every page (now that the total is known) --------------
  stampFooters(doc, fonts.regular, submission.id);

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

function formatTimestamp(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
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
      dependent: scalar(r.dependent),
    };
  });
}

function fileRefToString(v: unknown): string {
  const filename = scalar(asRecord(v).filename);
  return filename ? `${filename} — image not stored (demo mode)` : "";
}
