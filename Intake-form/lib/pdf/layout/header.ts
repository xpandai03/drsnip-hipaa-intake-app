// Phase 3 — page-1 header (see PHASE_3_PLAN.md §4.2).
//
// Form-type-aware: Registration omits the spouse line and the Children tile
// (Option A — resolved decision). Consultation shows all five header fields.

import type { PDFImage } from "pdf-lib";
import { PdfCursor, PAGE, MARGIN, COLOR } from "../cursor";

export interface HeaderData {
  formType: "registration" | "consultation";
  patientName: string;
  /** null on Registration, or when no spouse was given. */
  spouseName: string | null;
  /** null on Registration. */
  childCount: number | null;
  age: number | null;
  dateOfBirth: string | null;
  submittedAt: string;
  submissionId: string;
  /** Pre-embedded logo image, or null if the logo file was unreadable. */
  logo: PDFImage | null;
}

export function renderHeader(cursor: PdfCursor, d: HeaderData): void {
  const page = cursor.page;
  const { regular, bold, oblique } = cursor.fonts;

  // ---- Brand band -------------------------------------------------------
  // C.3 (Phase 4B): the header is vertically compressed to give the body more
  // room (toward the Registration 2-page target) without losing any element.
  const bandH = 64;
  const bandY = PAGE.height - bandH;
  page.drawRectangle({
    x: 0,
    y: bandY,
    width: PAGE.width,
    height: bandH,
    color: COLOR.brand,
  });

  // White logo on the blue band (falls back to a wordmark if unreadable).
  if (d.logo) {
    const logoH = 34;
    const logoW = (d.logo.width / d.logo.height) * logoH;
    page.drawImage(d.logo, {
      x: MARGIN,
      y: bandY + (bandH - logoH) / 2,
      width: logoW,
      height: logoH,
    });
  } else {
    page.drawText("DrSnip", {
      x: MARGIN,
      y: bandY + bandH / 2 - 9,
      size: 22,
      font: bold,
      color: COLOR.white,
    });
  }

  // Form-type badge, top-right.
  const badge =
    d.formType === "consultation"
      ? "Consultation Intake"
      : "Registration Intake";
  const badgeW = bold.widthOfTextAtSize(badge, 11);
  page.drawText(badge, {
    x: PAGE.width - MARGIN - badgeW,
    y: bandY + bandH / 2 - 5,
    size: 11,
    font: bold,
    color: COLOR.white,
  });

  cursor.y = bandY - 22;

  // ---- Patient name (large, centered) ----------------------------------
  drawCentered(cursor, d.patientName, bold, 20, COLOR.text);
  cursor.y -= 4;

  // ---- Spouse line (Consultation only) ---------------------------------
  if (d.spouseName) {
    drawCentered(cursor, `Spouse: ${d.spouseName}`, oblique, 12, COLOR.muted);
    cursor.y -= 4;
  }

  cursor.y -= 12;

  // ---- Stat tiles ------------------------------------------------------
  // DOB is intentionally NOT shown here (C.1, Phase 4B) — it reads in the body
  // (Patient Information / About You). `d.dateOfBirth` is still carried on
  // HeaderData; the underlying submission data is untouched.
  const tiles: { label: string; value: string }[] = [
    { label: "Age", value: d.age != null ? String(d.age) : "—" },
  ];
  if (d.formType === "consultation") {
    tiles.push({
      label: "Children",
      value: d.childCount != null ? String(d.childCount) : "—",
    });
  }

  const TW = 156;
  const TH = 46;
  const TG = 16;
  const totalW = tiles.length * TW + (tiles.length - 1) * TG;
  let tx = (PAGE.width - totalW) / 2;
  const tileTop = cursor.y;
  for (const t of tiles) {
    page.drawRectangle({
      x: tx,
      y: tileTop - TH,
      width: TW,
      height: TH,
      color: COLOR.tile,
      borderColor: COLOR.line,
      borderWidth: 1,
    });
    const label = t.label.toUpperCase();
    const labelW = regular.widthOfTextAtSize(label, 8);
    page.drawText(label, {
      x: tx + (TW - labelW) / 2,
      y: tileTop - 16,
      size: 8,
      font: regular,
      color: COLOR.muted,
    });
    const valW = bold.widthOfTextAtSize(t.value, 17);
    page.drawText(t.value, {
      x: tx + (TW - valW) / 2,
      y: tileTop - 38,
      size: 17,
      font: bold,
      color: COLOR.brand,
    });
    tx += TW + TG;
  }
  cursor.y = tileTop - TH - 14;

  // ---- Submission meta -------------------------------------------------
  page.drawText(`Submitted: ${d.submittedAt}`, {
    x: cursor.left,
    y: cursor.y - 9,
    size: 9,
    font: regular,
    color: COLOR.muted,
  });
  cursor.y -= 13;
  page.drawText(`Submission ID: ${d.submissionId}`, {
    x: cursor.left,
    y: cursor.y - 8,
    size: 8,
    font: regular,
    color: COLOR.faint,
  });
  cursor.y -= 14;

  cursor.divider();
}

function drawCentered(
  cursor: PdfCursor,
  text: string,
  font: import("pdf-lib").PDFFont,
  size: number,
  color: ReturnType<typeof import("pdf-lib").rgb>,
): void {
  const w = font.widthOfTextAtSize(text, size);
  cursor.page.drawText(text, {
    x: (PAGE.width - w) / 2,
    y: cursor.y - size,
    size,
    font,
    color,
  });
  cursor.y -= size;
}
