// Which characters a registration document can show EXACTLY, and what to show
// when it cannot. One rule for every document path:
//   * the n8n Registration v2 + legacy Jotform PDF nodes (a line-for-line JS
//     copy lives in lib/n8n/pdf-unicode.block.js — api/_test/pdf-unicode.test.ts
//     keeps the two in agreement), and
//   * the console PDF (lib/pdf/generator.ts).
//
// Names are never transliterated and never get '?' substituted. A value is
// either rendered exactly (standard WinAnsi font, or the embedded Noto Sans
// subset) or replaced by an explicit notice that sends the reader to the
// intake console, where the stored value is unchanged.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** WinAnsiEncoding bytes 0x80-0x9F (0xA0-0xFF are Latin-1 as-is). */
export const WINANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

export function winAnsiByte(ch: string): number | undefined {
  const c = ch.codePointAt(0)!;
  if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
  return WINANSI_EXTRA[c];
}

/** Script names used in the "cannot be shown" notice (first match wins). */
const SCRIPT_NAMES: Array<[RegExp, string]> = [
  [/\p{Script=Han}/u, "Chinese/Japanese"],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "Japanese"],
  [/\p{Script=Hangul}/u, "Korean"],
  [/\p{Script=Arabic}/u, "Arabic"],
  [/\p{Script=Hebrew}/u, "Hebrew"],
  [/[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]/u, "Indic"],
  [/\p{Script=Thai}/u, "Thai"],
  [/\p{Script=Armenian}/u, "Armenian"],
  [/\p{Script=Georgian}/u, "Georgian"],
  [/\p{Script=Ethiopic}/u, "Ethiopic"],
  [/\p{Extended_Pictographic}/u, "emoji"],
  [/\p{M}/u, "combining accent"],
  [/\p{Script=Latin}/u, "accented Latin"],
  [/\p{Script=Greek}/u, "Greek"],
  [/\p{Script=Cyrillic}/u, "Cyrillic"],
];

export function describeUnsupported(chars: string[]): string {
  const names: string[] = [];
  for (const ch of chars) {
    const hit = SCRIPT_NAMES.find(([re]) => re.test(ch));
    const name = hit ? hit[1] : "special";
    if (!names.includes(name)) names.push(name);
  }
  return names.join(", ");
}

export const NOTICE_PREFIX = "[Cannot be shown exactly in this document";

export function unsupportedNotice(chars: string[]): string {
  return `${NOTICE_PREFIX} (${describeUnsupported(chars)} characters) - see the DrSnip intake console for the exact text]`;
}

export type TextPlan =
  | { kind: "winansi"; text: string }
  | { kind: "unicode"; text: string }
  | { kind: "unsupported"; text: string; unsupported: string[] };

/**
 * Classify one value. `hasGlyph` is the embedded font's coverage, or null
 * when no embedded font is available (then only WinAnsi text is exact).
 * NFC only recombines canonically-equivalent sequences (e + ◌́ -> é); control
 * characters and line breaks become spaces, as before.
 */
export function planText(
  input: unknown,
  hasGlyph: ((cp: number) => boolean) | null,
): TextPlan {
  const text = String(input ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ");
  let winAnsi = true;
  const unsupported: string[] = [];
  for (const ch of text) {
    if (winAnsiByte(ch) !== undefined) continue;
    winAnsi = false;
    if (!hasGlyph || !hasGlyph(ch.codePointAt(0)!)) unsupported.push(ch);
  }
  if (winAnsi) return { kind: "winansi", text };
  if (unsupported.length) return { kind: "unsupported", text: unsupportedNotice(unsupported), unsupported };
  return { kind: "unicode", text };
}

// ---- the shared font asset ---------------------------------------------------

export interface FontAssetWeight {
  psName: string;
  unitsPerEm: number;
  cmap: number[];
  widths: number[];
  length1: number;
  sha256: string;
  ttfDeflateB64: string;
}
export interface FontAsset {
  version: number;
  fonts: { regular: FontAssetWeight; bold: FontAssetWeight; italic: FontAssetWeight };
}

// The built SPA travels in the runtime image (like the logo); in dev/tests the
// source copy is read.
const ASSET_PATHS = [
  "artifacts/intake-form/dist/public/pdf-fonts/noto-sans-v1.json",
  "artifacts/intake-form/public/pdf-fonts/noto-sans-v1.json",
];

let cached: FontAsset | null = null;
export function loadFontAsset(root = process.cwd()): FontAsset {
  if (cached) return cached;
  let lastErr: unknown;
  for (const p of ASSET_PATHS) {
    try {
      cached = JSON.parse(readFileSync(join(root, p), "utf8")) as FontAsset;
      return cached;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Codepoints every weight covers — exact only where all three have the glyph. */
export function commonCoverage(asset: FontAsset): (cp: number) => boolean {
  const sets = Object.values(asset.fonts).map((w) => {
    const s = new Set<number>();
    for (let i = 0; i < w.cmap.length; i += 2) s.add(w.cmap[i]);
    return s;
  });
  return (cp) => sets.every((s) => s.has(cp));
}
