// Phase 3 — section + field renderers. Every body section below the page-1
// header renders as a two-column table: question label on the left, answer on
// the right, one row per question, with a thin rule between rows. All
// renderers call cursor.ensureSpace() before drawing a row, so page breaks
// always fall between rows — never mid-row.

import type { PDFFont } from "pdf-lib";
import { PdfCursor, COLOR, TABLE, wrapText } from "../cursor";

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
}

// ---- Shared two-column table row -----------------------------------------

type CellColor = typeof COLOR.text;

interface ValueCell {
  /** Already word-wrapped to TABLE.valueWidth by the caller. */
  lines: string[];
  font: PDFFont;
  size: number;
  color: CellColor;
}

/**
 * Draw one two-column table row — label (left) + value cell (right), both
 * top-aligned — with a hairline rule along the bottom edge. The row is an
 * atomic unit for pagination: if it won't fit, the whole row moves to the
 * next page. `omitRule` suppresses the bottom rule so a follow-on row (e.g. a
 * medical explanation) reads as part of the same group.
 */
function drawRow(
  cursor: PdfCursor,
  label: string,
  value: ValueCell,
  omitRule = false,
): void {
  const labelLines = wrapText(
    label,
    cursor.fonts.regular,
    TABLE.labelSize,
    TABLE.labelWidth,
  );
  const valueLineH = value.size + 3;
  const contentH = Math.max(
    labelLines.length * TABLE.labelLineH,
    value.lines.length * valueLineH,
  );
  const rowH = Math.max(contentH + TABLE.rowPadV * 2, TABLE.rowMinHeight);

  cursor.ensureSpace(rowH);
  const page = cursor.page;
  const top = cursor.y;
  const valueX = cursor.left + TABLE.labelWidth + TABLE.colGap;

  // Label column — muted, top-aligned.
  let ly = top - TABLE.rowPadV - TABLE.labelSize;
  for (const line of labelLines) {
    page.drawText(line, {
      x: cursor.left,
      y: ly,
      size: TABLE.labelSize,
      font: cursor.fonts.regular,
      color: COLOR.muted,
    });
    ly -= TABLE.labelLineH;
  }

  // Value column — top-aligned.
  let vy = top - TABLE.rowPadV - value.size;
  for (const line of value.lines) {
    page.drawText(line, {
      x: valueX,
      y: vy,
      size: value.size,
      font: value.font,
      color: value.color,
    });
    vy -= valueLineH;
  }

  // Bottom rule (skipped when a grouped follow-on row comes next).
  if (!omitRule) {
    page.drawLine({
      start: { x: cursor.left, y: top - rowH },
      end: { x: cursor.right, y: top - rowH },
      thickness: 0.5,
      color: COLOR.separator,
    });
  }

  cursor.y = top - rowH;
}

/** Wrap a plain string into the value column at the given style. */
function wrapValue(text: string, font: PDFFont, size: number): string[] {
  return wrapText(text, font, size, TABLE.valueWidth);
}

// ---- Field renderers -----------------------------------------------------

/** Labelled field as a two-column row. Empty values render "—". */
export function renderKeyValue(
  cursor: PdfCursor,
  label: string,
  value: string,
): void {
  const v = value && value.trim() ? value.trim() : EMPTY;
  const isEmpty = v === EMPTY;
  const font = isEmpty ? cursor.fonts.regular : cursor.fonts.bold;
  drawRow(cursor, label, {
    lines: wrapValue(v, font, TABLE.valueSize),
    font,
    size: TABLE.valueSize,
    color: isEmpty ? COLOR.faint : COLOR.text,
  });
}

/** A question that was skipped — renders "—" so the doctor sees it was asked. */
export function renderEmpty(cursor: PdfCursor, label: string): void {
  renderKeyValue(cursor, label, "");
}

/**
 * Medical-history Yes/No answer as a table row. On "Yes" with a patient
 * explanation, a second row follows — blank label cell, italic explanation
 * in the value column.
 */
export function renderMedicalAnswer(
  cursor: PdfCursor,
  label: string,
  answer: string,
  explanation: string,
): void {
  const a = answer && answer.trim() ? answer.trim() : EMPTY;
  const isYes = a.toLowerCase() === "yes";
  const isEmpty = a === EMPTY;
  const hasExplanation = isYes && Boolean(explanation && explanation.trim());

  // The Yes/No row; its bottom rule is suppressed when an explanation row
  // follows, so the two read as one grouped answer.
  drawRow(
    cursor,
    label,
    {
      lines: wrapValue(a, cursor.fonts.bold, TABLE.valueSize),
      font: cursor.fonts.bold,
      size: TABLE.valueSize,
      color: isEmpty ? COLOR.faint : isYes ? COLOR.brand : COLOR.text,
    },
    hasExplanation,
  );

  if (hasExplanation) {
    drawRow(cursor, "", {
      lines: wrapValue(explanation.trim(), cursor.fonts.oblique, 9),
      font: cursor.fonts.oblique,
      size: 9,
      color: COLOR.muted,
    });
  }
}

/** Multi-select as a table row — comma-joined when short, else a bullet list. */
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
  let lines: string[];
  if (joined.length <= 60) {
    lines = wrapValue(joined, cursor.fonts.bold, TABLE.valueSize);
  } else {
    lines = [];
    for (const item of clean) {
      lines.push(
        ...wrapValue(`•  ${item}`, cursor.fonts.bold, TABLE.valueSize),
      );
    }
  }
  drawRow(cursor, label, {
    lines,
    font: cursor.fonts.bold,
    size: TABLE.valueSize,
    color: COLOR.text,
  });
}

/**
 * Children subsection — kept as its own per-child layout (not forced into the
 * two-column table), but visually harmonized with a hairline rule under each
 * child, matching the table treatment.
 */
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
  cursor.gap(4);

  if (children.length === 0) {
    cursor.drawText(EMPTY, {
      x: cursor.left + 12,
      size: 10,
      font: cursor.fonts.regular,
      color: COLOR.faint,
      maxWidth: cursor.width - 12,
    });
    cursor.gap(6);
    return;
  }

  children.forEach((c, i) => {
    cursor.ensureSpace(30);
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
    ];
    cursor.drawText(parts.join("    ·    "), {
      x: cursor.left + 24,
      size: 10,
      font: cursor.fonts.regular,
      color: COLOR.text,
      maxWidth: cursor.width - 24,
    });
    cursor.gap(5);
    cursor.page.drawLine({
      start: { x: cursor.left, y: cursor.y },
      end: { x: cursor.right, y: cursor.y },
      thickness: 0.5,
      color: COLOR.separator,
    });
    cursor.gap(4);
  });
  cursor.gap(2);
}

function val(s: string | undefined): string {
  return s && s.trim() ? s.trim() : EMPTY;
}
