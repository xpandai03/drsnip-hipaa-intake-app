// Phase 3 — PdfCursor: a thin pagination/flow helper over pdf-lib
// (see PHASE_3_PLAN.md §4.4). pdf-lib is low-level (draw text at x/y); this
// tracks a top-down y cursor, word-wraps, and breaks pages automatically.

import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";

export const PAGE = { width: 612, height: 792 } as const; // US Letter
export const MARGIN = 54;
const FOOTER_RESERVE = 36; // keep flowing content this far above the page bottom

export const COLOR = {
  brand: rgb(0x0f / 255, 0x4c / 255, 0x81 / 255), // #0F4C81 clinical blue
  text: rgb(0.12, 0.16, 0.22),
  muted: rgb(0.42, 0.47, 0.53),
  faint: rgb(0.62, 0.66, 0.7),
  line: rgb(0.86, 0.88, 0.91),
  separator: rgb(0xe5 / 255, 0xe7 / 255, 0xeb / 255), // #E5E7EB table rule
  tile: rgb(0.96, 0.97, 0.98),
  white: rgb(1, 1, 1),
};

// Two-column table layout for the body sections (see sections.ts). The label
// column carries the long question text; the value column carries mostly short
// answers ("Yes"/"No", names, IDs). C.3 (Phase 4B) re-balances the split — a
// wider label column (~50%) means the long medical questions wrap to fewer
// lines, which (since the label drives row height) is the biggest
// readability-safe lever toward the Registration 2-page target. Font sizes are
// unchanged; only padding is tightened.
const CONTENT_WIDTH = PAGE.width - 2 * MARGIN; // 504
const LABEL_WIDTH = 250;
export const TABLE = {
  labelWidth: LABEL_WIDTH,
  colGap: 12,
  valueWidth: CONTENT_WIDTH - LABEL_WIDTH - 12, // 242
  rowMinHeight: 18,
  rowPadV: 3, // vertical padding inside each row, top & bottom
  labelSize: 9,
  valueSize: 10,
  labelLineH: 12,
  valueLineH: 13,
} as const;

export type PdfFonts = {
  regular: PDFFont;
  bold: PDFFont;
  oblique: PDFFont;
};

export interface DrawTextOpts {
  x: number;
  size: number;
  font: PDFFont;
  color: ReturnType<typeof rgb>;
  maxWidth: number;
  lineGap?: number;
}

export class PdfCursor {
  page: PDFPage;
  y: number;
  readonly left = MARGIN;
  readonly right = PAGE.width - MARGIN;
  readonly width = PAGE.width - 2 * MARGIN;

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: PdfFonts,
  ) {
    this.page = doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  /** Start a fresh page; content resumes from the top margin. */
  addPage(): void {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  /** Break to a new page if `needed` points won't fit above the footer zone. */
  ensureSpace(needed: number): void {
    if (this.y - needed < MARGIN + FOOTER_RESERVE) this.addPage();
  }

  /** Advance the cursor down by `h` points (vertical spacing). */
  gap(h: number): void {
    this.y -= h;
  }

  /** Full-width hairline divider. */
  divider(): void {
    this.ensureSpace(8);
    this.page.drawLine({
      start: { x: this.left, y: this.y },
      end: { x: this.right, y: this.y },
      thickness: 0.75,
      color: COLOR.line,
    });
    this.y -= 8;
  }

  /** Section heading — brand accent bar + bold title + underline. */
  heading(title: string): void {
    this.gap(10);
    // Reserve room for the heading itself + ~2 table rows so a heading is
    // never orphaned at the foot of a page.
    this.ensureSpace(30 + 2 * TABLE.rowMinHeight);
    this.page.drawRectangle({
      x: this.left,
      y: this.y - 13,
      width: 3,
      height: 13,
      color: COLOR.brand,
    });
    this.page.drawText(title, {
      x: this.left + 9,
      y: this.y - 12,
      size: 12,
      font: this.fonts.bold,
      color: COLOR.brand,
    });
    this.y -= 17;
    this.page.drawLine({
      start: { x: this.left, y: this.y },
      end: { x: this.right, y: this.y },
      thickness: 0.75,
      color: COLOR.line,
    });
    // Bottom padding so the table doesn't butt up against the heading rule.
    this.y -= 10;
  }

  /** Draw word-wrapped text at `x`; paginates per line; advances y. */
  drawText(text: string, opts: DrawTextOpts): number {
    const lineGap = opts.lineGap ?? 3;
    const lineH = opts.size + lineGap;
    const lines = wrapText(text, opts.font, opts.size, opts.maxWidth);
    for (const line of lines) {
      this.ensureSpace(lineH);
      this.page.drawText(line, {
        x: opts.x,
        y: this.y - opts.size,
        size: opts.size,
        font: opts.font,
        color: opts.color,
      });
      this.y -= lineH;
    }
    return lines.length * lineH;
  }
}

/** Word-wrap to `maxWidth`, honoring \n and hard-breaking over-long tokens. */
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      for (const piece of fitToken(word, font, size, maxWidth)) {
        const candidate = line ? `${line} ${piece}` : piece;
        if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
          out.push(line);
          line = piece;
        } else {
          line = candidate;
        }
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

/** Split a single token that itself exceeds maxWidth into character chunks. */
function fitToken(
  word: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) return [word];
  const pieces: string[] = [];
  let piece = "";
  for (const ch of word) {
    if (piece && font.widthOfTextAtSize(piece + ch, size) > maxWidth) {
      pieces.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * Final pass — paint the footer on EVERY page once the total is known
 * (PHASE_3_PLAN.md §4.5). Done as one pass rather than split between
 * addPage() + a number-stamp pass: simpler, identical result.
 *
 *   DrSnip Patient Intake — CONFIDENTIAL / PHI   ·   Page X of Y   ·   Submission <id>
 */
export function stampFooters(
  doc: PDFDocument,
  font: PDFFont,
  submissionId: string,
): void {
  const pages = doc.getPages();
  const total = pages.length;
  const size = 7;
  const y = 30;
  pages.forEach((page, i) => {
    const left = "DrSnip Patient Intake — CONFIDENTIAL / PHI";
    const center = `Page ${i + 1} of ${total}`;
    const right = `Submission ${submissionId}`;
    page.drawLine({
      start: { x: MARGIN, y: y + 12 },
      end: { x: PAGE.width - MARGIN, y: y + 12 },
      thickness: 0.5,
      color: COLOR.line,
    });
    page.drawText(left, { x: MARGIN, y, size, font, color: COLOR.faint });
    const centerW = font.widthOfTextAtSize(center, size);
    page.drawText(center, {
      x: (PAGE.width - centerW) / 2,
      y,
      size,
      font,
      color: COLOR.faint,
    });
    const rightW = font.widthOfTextAtSize(right, size);
    page.drawText(right, {
      x: PAGE.width - MARGIN - rightW,
      y,
      size,
      font,
      color: COLOR.faint,
    });
  });
}
