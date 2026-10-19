// ==== BEGIN DRSNIP PDF UNICODE (shared block — source of truth: lib/n8n/pdf-unicode.block.js; synced into each PDF node by lib/n8n/sync-pdf-unicode.mjs) ====
// Exact text in hand-built PDFs. Every value is either
//   * WinAnsi -> the standard Helvetica fonts, written with exact WinAnsi bytes;
//   * other text the embedded Noto Sans subset covers (Latin incl. Vietnamese,
//     Greek, Cyrillic) -> an embedded Type0/Identity-H font with a ToUnicode map;
//   * anything else (CJK, Arabic, Hebrew, Indic, emoji, leftover combining
//     marks, or any non-WinAnsi text when the font asset cannot be fetched)
//     -> an explicit "[Cannot be shown exactly …]" notice, recorded for review.
// Never transliterated, never '?'. Mirrors lib/pdf-unicode/support.ts.
const PDFU_ASSET_URL = 'https://intake.drsnip.com/pdf-fonts/noto-sans-v1.json';
const PDFU_WINANSI_EXTRA = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f
};
function pdfuWinAnsiByte(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
  return PDFU_WINANSI_EXTRA[c];
}
const PDFU_SCRIPT_NAMES = [
  [/\p{Script=Han}/u, 'Chinese/Japanese'],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'Japanese'],
  [/\p{Script=Hangul}/u, 'Korean'],
  [/\p{Script=Arabic}/u, 'Arabic'],
  [/\p{Script=Hebrew}/u, 'Hebrew'],
  [/[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]/u, 'Indic'],
  [/\p{Script=Thai}/u, 'Thai'],
  [/\p{Script=Armenian}/u, 'Armenian'],
  [/\p{Script=Georgian}/u, 'Georgian'],
  [/\p{Script=Ethiopic}/u, 'Ethiopic'],
  [/\p{Extended_Pictographic}/u, 'emoji'],
  [/\p{M}/u, 'combining accent'],
  [/\p{Script=Latin}/u, 'accented Latin'],
  [/\p{Script=Greek}/u, 'Greek'],
  [/\p{Script=Cyrillic}/u, 'Cyrillic']
];
function pdfuDescribe(chars) {
  const names = [];
  for (const ch of chars) {
    const hit = PDFU_SCRIPT_NAMES.find(function (e) { return e[0].test(ch); });
    const name = hit ? hit[1] : 'special';
    if (names.indexOf(name) < 0) names.push(name);
  }
  return names.join(', ');
}
const PDFU_NOTICE_PREFIX = '[Cannot be shown exactly in this document';
function pdfuNotice(chars) {
  return PDFU_NOTICE_PREFIX + ' (' + pdfuDescribe(chars) + ' characters) - see the DrSnip intake console for the exact text]';
}
const PDFU = { status: 'not-needed', fonts: null, coverage: null, used: { U1: new Map(), U2: new Map(), U3: new Map() }, flagged: [], leaked: 0 };
const PDFU_WEIGHT = { U1: 'regular', U2: 'bold', U3: 'italic' };
const PDFU_UNICODE_FOR = { F1: 'U1', F2: 'U2', F3: 'U3' };
function pdfuIsU(font) { return font === 'U1' || font === 'U2' || font === 'U3'; }
/** True when any string inside `obj` has a character outside WinAnsi. */
function pdfuNeeds(obj) {
  const seen = [];
  const walk = function (v, key) {
    if (typeof v === 'string') {
      if (/b64|base64/i.test(key || '')) return false;
      for (const ch of v) if (pdfuWinAnsiByte(ch) === undefined && !/[\u0000-\u001f]/.test(ch)) return true;
      return false;
    }
    if (v && typeof v === 'object') {
      if (seen.indexOf(v) >= 0) return false;
      seen.push(v);
      for (const k of Object.keys(v)) if (walk(v[k], k)) return true;
    }
    return false;
  };
  return walk(obj, '');
}
/** Fetch the Noto Sans subset only when the document needs it. Never throws. */
async function pdfuLoad(ctx, needed) {
  if (!needed) return;
  try {
    const res = await ctx.helpers.httpRequest({ method: 'GET', url: PDFU_ASSET_URL, json: true, timeout: 15000 });
    const a = typeof res === 'string' ? JSON.parse(res) : res;
    if (!a || a.version !== 1 || !a.fonts || !a.fonts.regular) throw new Error('unexpected font asset');
    const fonts = {};
    for (const k of ['regular', 'bold', 'italic']) {
      const w = a.fonts[k];
      const map = new Map();
      for (let i = 0; i < w.cmap.length; i += 2) map.set(w.cmap[i], w.cmap[i + 1]);
      fonts[k] = Object.assign({}, w, { map: map });
    }
    // Exact only where EVERY weight has the glyph (the subsets differ slightly).
    const coverage = new Set();
    for (const cp of fonts.regular.map.keys()) if (fonts.bold.map.has(cp) && fonts.italic.map.has(cp)) coverage.add(cp);
    PDFU.fonts = fonts;
    PDFU.coverage = coverage;
    PDFU.status = 'embedded';
  } catch (e) {
    PDFU.fonts = null;
    PDFU.coverage = null;
    PDFU.status = 'unavailable';
  }
}
function pdfuPlan(input) {
  const text = String(input == null ? '' : input).normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  let winAnsi = true;
  const unsupported = [];
  for (const ch of text) {
    if (pdfuWinAnsiByte(ch) !== undefined) continue;
    winAnsi = false;
    if (!PDFU.fonts || !PDFU.coverage.has(ch.codePointAt(0))) unsupported.push(ch);
  }
  if (winAnsi) return { kind: 'winansi', text: text };
  if (unsupported.length) return { kind: 'unsupported', text: pdfuNotice(unsupported), unsupported: unsupported };
  return { kind: 'unicode', text: text };
}
/** Prepare one value for drawing in base font F1/F2/F3. `label` names the
 *  field in the review list when the value cannot be shown exactly. */
function pdfuPrepare(input, baseFont, label) {
  const p = pdfuPlan(input);
  if (p.kind === 'unsupported') {
    if (label && PDFU.flagged.indexOf(label) < 0) PDFU.flagged.push(label);
    return { text: p.text, font: 'F3', flagged: true };
  }
  return { text: p.text, font: p.kind === 'unicode' ? PDFU_UNICODE_FOR[baseFont] : baseFont, flagged: false };
}
function pdfuWidth(text, font, size) {
  const f = PDFU.fonts[PDFU_WEIGHT[font]];
  let w = 0;
  for (const ch of String(text)) {
    const g = f.map.get(ch.codePointAt(0)) || 0;
    w += f.widths[g] || 0;
  }
  return w * size / f.unitsPerEm;
}
/** The Tj operand for `text` in `font`: a WinAnsi literal or a glyph-id hex string. */
function pdfuShow(text, font) {
  if (pdfuIsU(font)) {
    const f = PDFU.fonts[PDFU_WEIGHT[font]];
    const used = PDFU.used[font];
    let hex = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      const g = f.map.get(cp) || 0;
      if (!used.has(g)) used.set(g, cp);
      hex += g.toString(16).padStart(4, '0');
    }
    return '<' + hex + '>';
  }
  let out = '';
  for (const ch of String(text)) {
    let b = pdfuWinAnsiByte(ch);
    if (b === undefined) { PDFU.leaked++; b = 0x3f; } // unreachable: pdfuPrepare routes these away
    if (b === 0x5c || b === 0x28 || b === 0x29) out += '\\' + String.fromCharCode(b);
    else if (b >= 0x80) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return '(' + out + ')';
}
function pdfuUtf16Hex(cp) {
  if (cp < 0x10000) return cp.toString(16).padStart(4, '0');
  const v = cp - 0x10000;
  return (0xd800 + (v >> 10)).toString(16) + (0xdc00 + (v & 0x3ff)).toString(16);
}
/** Emit the embedded font objects actually used; returns the resource entries
 *  (e.g. " /U2 12 0 R") to append to every page's /Font dictionary. Call after
 *  all page streams have been rendered. */
function pdfuFontObjects(addObj) {
  let res = '';
  for (const key of ['U1', 'U2', 'U3']) {
    const used = PDFU.used[key];
    if (!used.size) continue;
    const f = PDFU.fonts[PDFU_WEIGHT[key]];
    const tag = { U1: 'DRSNPR', U2: 'DRSNPB', U3: 'DRSNPI' }[key] + '+' + f.psName;
    const scale = 1000 / f.unitsPerEm;
    const bin = Buffer.from(f.ttfDeflateB64, 'base64').toString('latin1');
    const ff = addObj('<< /Length ' + bin.length + ' /Length1 ' + f.length1 + ' /Filter /FlateDecode >>\nstream\n' + bin + '\nendstream');
    const fd = addObj('<< /Type /FontDescriptor /FontName /' + tag + ' /Flags ' + (f.italicAngle ? 96 : 32) +
      ' /FontBBox [' + f.bbox.map(function (v) { return Math.round(v * scale); }).join(' ') + '] /ItalicAngle ' + f.italicAngle +
      ' /Ascent ' + Math.round(f.ascent * scale) + ' /Descent ' + Math.round(f.descent * scale) +
      ' /CapHeight ' + Math.round(f.capHeight * scale) + ' /StemV 80 /FontFile2 ' + ff + ' 0 R >>');
    const gids = Array.from(used.keys()).sort(function (a, b) { return a - b; });
    const W = '[' + gids.map(function (g) { return g + ' [' + Math.round((f.widths[g] || 0) * scale) + ']'; }).join(' ') + ']';
    const cid = addObj('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /' + tag +
      ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + fd +
      ' 0 R /DW 1000 /W ' + W + ' /CIDToGIDMap /Identity >>');
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < gids.length; i += 100) {
      const chunk = gids.slice(i, i + 100);
      cmap += chunk.length + ' beginbfchar\n' + chunk.map(function (g) { return '<' + g.toString(16).padStart(4, '0') + '> <' + pdfuUtf16Hex(used.get(g)) + '>'; }).join('\n') + '\nendbfchar\n';
    }
    cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
    const tu = addObj('<< /Length ' + cmap.length + ' >>\nstream\n' + cmap + 'endstream');
    const t0 = addObj('<< /Type /Font /Subtype /Type0 /BaseFont /' + tag + ' /Encoding /Identity-H /DescendantFonts [' + cid + ' 0 R] /ToUnicode ' + tu + ' 0 R >>');
    res += ' /' + key + ' ' + t0 + ' 0 R';
  }
  return res;
}
const PDFU_REVIEW_TEXT = 'Some entries contain characters this document cannot show exactly. They are marked below; the exact text is unchanged in the DrSnip intake console.';
/** True when some value in `obj` would be replaced by a notice (call after pdfuLoad). */
function pdfuAnyUnsupported(obj) {
  const seen = [];
  const walk = function (v, key) {
    if (typeof v === 'string') return !/b64|base64/i.test(key || '') && pdfuPlan(v).kind === 'unsupported';
    if (v && typeof v === 'object') {
      if (seen.indexOf(v) >= 0) return false;
      seen.push(v);
      for (const k of Object.keys(v)) if (walk(v[k], k)) return true;
    }
    return false;
  };
  return walk(obj, '');
}
function pdfuSummary() {
  return { unicode_font: PDFU.status, unrenderable_fields: PDFU.flagged.slice(), leaked: PDFU.leaked };
}
// ==== END DRSNIP PDF UNICODE ====
