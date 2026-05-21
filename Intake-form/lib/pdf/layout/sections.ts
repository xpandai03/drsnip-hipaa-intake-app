// Phase 3 — section + field renderers (see PHASE_3_PLAN.md §4.3). All
// renderers call cursor.ensureSpace() before drawing so pagination is
// automatic — content never silently truncates.

import { PdfCursor, COLOR } from "../cursor";

const EMPTY = "—";

// ---- Template descriptor types -------------------------------------------

/** How a single raw_payload field is rendered into the PDF. */
export type FieldKind = "text" | "medical" | "array" | "children" | "file";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
}

export interface PdfSection {
  title: string;
  fields: FieldDef[];
}

/** One child row from the Consultation form's dynamic Child 1–8 block. */
export interface ChildRow {
  age?: string;
  relation?: string;
  gender?: string;
  dependent?: string;
}

// ---- Field renderers -----------------------------------------------------

/** Labelled field — label (muted) on its own line, value bold below it. */
export function renderKeyValue(
  cursor: PdfCursor,
  label: string,
  value: string,
): void {
  const v = value && value.trim() ? value.trim() : EMPTY;
  cursor.ensureSpace(32);
  cursor.drawText(label, {
    x: cursor.left,
    size: 9,
    font: cursor.fonts.regular,
    color: COLOR.muted,
    maxWidth: cursor.width,
    lineGap: 2,
  });
  cursor.gap(1);
  cursor.drawText(v, {
    x: cursor.left + 12,
    size: 10,
    font: cursor.fonts.bold,
    color: v === EMPTY ? COLOR.faint : COLOR.text,
    maxWidth: cursor.width - 12,
  });
  cursor.gap(7);
}

/** A question that was skipped — renders "—" so the doctor sees it was asked. */
export function renderEmpty(cursor: PdfCursor, label: string): void {
  renderKeyValue(cursor, label, "");
}

/**
 * Medical-history Yes/No answer. On "Yes" with a patient explanation, the
 * explanation is rendered indented + italic directly underneath.
 */
export function renderMedicalAnswer(
  cursor: PdfCursor,
  label: string,
  answer: string,
  explanation: string,
): void {
  const a = answer && answer.trim() ? answer.trim() : EMPTY;
  const isYes = a.toLowerCase() === "yes";
  cursor.ensureSpace(32);
  cursor.drawText(label, {
    x: cursor.left,
    size: 9,
    font: cursor.fonts.regular,
    color: COLOR.muted,
    maxWidth: cursor.width,
    lineGap: 2,
  });
  cursor.gap(1);
  cursor.drawText(a, {
    x: cursor.left + 12,
    size: 10,
    font: cursor.fonts.bold,
    color: a === EMPTY ? COLOR.faint : isYes ? COLOR.brand : COLOR.text,
    maxWidth: cursor.width - 12,
  });
  if (isYes && explanation && explanation.trim()) {
    cursor.gap(2);
    cursor.drawText(explanation.trim(), {
      x: cursor.left + 24,
      size: 9,
      font: cursor.fonts.oblique,
      color: COLOR.muted,
      maxWidth: cursor.width - 24,
    });
  }
  cursor.gap(7);
}

/** Multi-select — comma-joined when short, bulleted when long. */
export function renderArrayValue(
  cursor: PdfCursor,
  label: string,
  values: string[],
): void {
  const clean = values.filter((v) => v && v.trim()).map((v) => v.trim());
  if (clean.length === 0) {
    renderKeyValue(cursor, label, "");
    return;
  }
  const joined = clean.join(", ");
  if (joined.length <= 64) {
    renderKeyValue(cursor, label, joined);
    return;
  }
  cursor.ensureSpace(28);
  cursor.drawText(label, {
    x: cursor.left,
    size: 9,
    font: cursor.fonts.regular,
    color: COLOR.muted,
    maxWidth: cursor.width,
    lineGap: 2,
  });
  cursor.gap(1);
  for (const item of clean) {
    cursor.drawText(`•  ${item}`, {
      x: cursor.left + 12,
      size: 10,
      font: cursor.fonts.regular,
      color: COLOR.text,
      maxWidth: cursor.width - 12,
    });
  }
  cursor.gap(7);
}

/** Children subsection — one compact row per child actually submitted. */
export function renderChildrenBlock(
  cursor: PdfCursor,
  children: ChildRow[],
): void {
  cursor.ensureSpace(20);
  cursor.drawText("Children", {
    x: cursor.left,
    size: 10,
    font: cursor.fonts.bold,
    color: COLOR.text,
    maxWidth: cursor.width,
  });
  cursor.gap(3);

  if (children.length === 0) {
    cursor.drawText(EMPTY, {
      x: cursor.left + 12,
      size: 10,
      font: cursor.fonts.regular,
      color: COLOR.faint,
      maxWidth: cursor.width - 12,
    });
    cursor.gap(7);
    return;
  }

  children.forEach((c, i) => {
    cursor.ensureSpace(26);
    cursor.drawText(`Child ${i + 1}`, {
      x: cursor.left + 12,
      size: 9,
      font: cursor.fonts.bold,
      color: COLOR.muted,
      maxWidth: cursor.width - 12,
    });
    const parts = [
      `Age ${val(c.age)}`,
      `Relation: ${val(c.relation)}`,
      `Gender: ${val(c.gender)}`,
      `Dependent: ${val(c.dependent)}`,
    ];
    cursor.drawText(parts.join("    ·    "), {
      x: cursor.left + 24,
      size: 10,
      font: cursor.fonts.regular,
      color: COLOR.text,
      maxWidth: cursor.width - 24,
    });
    cursor.gap(5);
  });
  cursor.gap(3);
}

function val(s: string | undefined): string {
  return s && s.trim() ? s.trim() : EMPTY;
}
