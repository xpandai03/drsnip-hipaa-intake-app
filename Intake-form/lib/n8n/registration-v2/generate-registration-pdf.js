// Generate doctor-friendly Registration Intake PDF (pure JS, no external deps).
// Mirrors the Phase 3 visual approved by Jeff: blue header band + DrSnip wordmark,
// large centered patient name, Age + DOB stat tiles, tabular medical record with
// rule separators between rows, full consent question text, footer on every
// page. HIPAA-safe — assembled in-process, never sent to a third-party renderer.
const data = $('Parse & Normalize').first().json;
const resolved = $input.first().json;

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

// Fetch the embedded-font asset only when some value is outside WinAnsi.
await pdfuLoad(this, pdfuNeeds(data));
const needsReview = pdfuAnyUnsupported(data);

const PAGE_W = 612, PAGE_H = 792;
const ML = 54, MR = 54, MT = 54, MB = 54;
const FOOTER_RESERVE = 36;
const CONTENT_W = PAGE_W - ML - MR;
const LABEL_W = 196, COL_GAP = 12;
const VALUE_W = CONTENT_W - LABEL_W - COL_GAP;
const LABEL_SIZE = 9, VALUE_SIZE = 10;
const LABEL_LINE_H = 12, VALUE_LINE_H = 13;
const ROW_PAD_V = 4, ROW_MIN_H = 20;
const BAND_H = 80;

const C = {
  brand: [0x0f / 255, 0x4c / 255, 0x81 / 255],
  text: [0.12, 0.16, 0.22],
  muted: [0.42, 0.47, 0.53],
  faint: [0.62, 0.66, 0.70],
  line: [0.86, 0.88, 0.91],
  separator: [0xe5 / 255, 0xe7 / 255, 0xeb / 255],
  tile: [0.96, 0.97, 0.98],
  white: [1, 1, 1]
};

function charW(ch, font) {
  if (ch === ' ') return 0.28;
  if (ch === 'i' || ch === 'l' || ch === 'I' || ch === '.' || ch === ',' || ch === ';' || ch === ':' || ch === '!' || ch === "'" || ch === '|') return 0.30;
  if (ch >= 'A' && ch <= 'Z') return font === 'F2' ? 0.70 : 0.66;
  if (ch >= 'a' && ch <= 'z') return font === 'F2' ? 0.56 : 0.51;
  if (ch >= '0' && ch <= '9') return 0.56;
  if (ch === '(' || ch === ')' || ch === '-' || ch === '/' || ch === '[' || ch === ']') return 0.33;
  return font === 'F2' ? 0.56 : 0.51;
}
function tw(s, font, size) {
  if (pdfuIsU(font)) return pdfuWidth(s, font, size);
  let w = 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) w += charW(str[i], font);
  return w * size;
}

function wrap(text, font, size, maxWidth) {
  const out = [];
  const lines = String(text == null ? '' : text).split('\n');
  for (const rawLine of lines) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(''); continue; }
    let line = '';
    for (const word of words) {
      let parts = [word];
      if (tw(word, font, size) > maxWidth) {
        parts = [];
        let rest = word;
        while (rest.length > 0) {
          let cut = rest.length;
          while (cut > 0 && tw(rest.slice(0, cut), font, size) > maxWidth) cut--;
          if (cut === 0) cut = 1;
          parts.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
      }
      for (const piece of parts) {
        const candidate = line ? line + ' ' + piece : piece;
        if (line && tw(candidate, font, size) > maxWidth) {
          out.push(line);
          line = piece;
        } else {
          line = candidate;
        }
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}


const pages = [];
let curOps = [];
let y = PAGE_H - MT;

function newPage() {
  pages.push(curOps);
  curOps = [];
  y = PAGE_H - MT;
}
function ensure(needed) {
  if (y - needed < MB + FOOTER_RESERVE) newPage();
}
function emitText(text, x, yy, size, font, color) {
  curOps.push({ k: 't', text: text, x: x, y: yy, size: size, font: font, color: color });
}
function emitRect(x, yy, w, h, fill) {
  curOps.push({ k: 'r', x: x, y: yy, w: w, h: h, fill: fill });
}
function emitRectBorder(x, yy, w, h, fill, stroke) {
  curOps.push({ k: 'rb', x: x, y: yy, w: w, h: h, fill: fill, stroke: stroke });
}
function emitLine(x1, y1, x2, y2, color, width) {
  curOps.push({ k: 'l', x1: x1, y1: y1, x2: x2, y2: y2, color: color, width: width });
}

function renderHeader(opts) {
  const bandY = PAGE_H - BAND_H;
  emitRect(0, bandY, PAGE_W, BAND_H, C.brand);
  emitText('DrSnip', ML, bandY + BAND_H / 2 - 9, 22, 'F2', C.white);
  const badge = opts.formType === 'consultation' ? 'Consultation Intake' : 'Registration Intake';
  const bw = tw(badge, 'F2', 11);
  emitText(badge, PAGE_W - MR - bw, bandY + BAND_H / 2 - 5, 11, 'F2', C.white);

  y = bandY - 30;
  const pn = pdfuPrepare(opts.patientName, 'F2', 'Patient name');
  const pnSize = pn.flagged ? 11 : 24;
  const pnLines = pn.flagged ? wrap(pn.text, pn.font, pnSize, CONTENT_W) : [pn.text];
  for (let li = 0; li < pnLines.length; li++) {
    const nw = tw(pnLines[li], pn.font, pnSize);
    emitText(pnLines[li], (PAGE_W - nw) / 2, y - pnSize - li * (pnSize + 3), pnSize, pn.font, pn.flagged ? C.muted : C.text);
  }
  if (pnLines.length > 1) y -= (pnLines.length - 1) * (pnSize + 3);
  y -= 24 + 6;

  if (opts.spouseName) {
    const sLabel = 'Spouse: ' + opts.spouseName;
    const sw = tw(sLabel, 'F3', 12);
    emitText(sLabel, (PAGE_W - sw) / 2, y - 12, 12, 'F3', C.muted);
    y -= 12 + 4;
  }
  y -= 16;

  const tiles = [{ label: 'AGE', value: opts.age != null ? String(opts.age) : '—' }];
  if (opts.formType === 'consultation') {
    tiles.push({ label: 'CHILDREN', value: opts.childCount != null ? String(opts.childCount) : '—' });
  }

  const TW = 156, TH = 56, TG = 16;
  const totalW = tiles.length * TW + (tiles.length - 1) * TG;
  let tx = (PAGE_W - totalW) / 2;
  const tileTop = y;
  for (const t of tiles) {
    emitRectBorder(tx, tileTop - TH, TW, TH, C.tile, C.line);
    const lw = tw(t.label, 'F1', 8);
    emitText(t.label, tx + (TW - lw) / 2, tileTop - 19, 8, 'F1', C.muted);
    const vw = tw(t.value, 'F2', 17);
    emitText(t.value, tx + (TW - vw) / 2, tileTop - 44, 17, 'F2', C.brand);
    tx += TW + TG;
  }
  y = tileTop - TH - 18;

  emitText('Submitted: ' + opts.submittedAt, ML, y - 9, 9, 'F1', C.muted);
  y -= 13;
  emitText('Submission ID: ' + opts.submissionId, ML, y - 8, 8, 'F1', C.faint);
  y -= 14;

  emitLine(ML, y, PAGE_W - MR, y, C.line, 0.75);
  y -= 8;
}

function heading(title) {
  y -= 10;
  ensure(30 + 2 * ROW_MIN_H);
  emitRect(ML, y - 13, 3, 13, C.brand);
  emitText(title, ML + 9, y - 12, 12, 'F2', C.brand);
  y -= 17;
  emitLine(ML, y, PAGE_W - MR, y, C.line, 0.75);
  y -= 10;
}

function row(label, value, valueFont, valueColor, omitRule) {
  const lp = pdfuPrepare(label, 'F1', null);
  const vp = pdfuPrepare(value, valueFont, label || 'Additional detail');
  if (vp.flagged) valueColor = C.brand;
  const labelLines = wrap(lp.text, lp.font, LABEL_SIZE, LABEL_W);
  const valueLines = wrap(vp.text, vp.font, VALUE_SIZE, VALUE_W);
  const contentH = Math.max(labelLines.length * LABEL_LINE_H, valueLines.length * VALUE_LINE_H);
  const rowH = Math.max(contentH + ROW_PAD_V * 2, ROW_MIN_H);
  ensure(rowH);
  const top = y;
  const valueX = ML + LABEL_W + COL_GAP;
  let ly = top - ROW_PAD_V - LABEL_SIZE;
  for (const ln of labelLines) {
    emitText(ln, ML, ly, LABEL_SIZE, lp.font, C.muted);
    ly -= LABEL_LINE_H;
  }
  let vy = top - ROW_PAD_V - VALUE_SIZE;
  for (const ln of valueLines) {
    emitText(ln, valueX, vy, VALUE_SIZE, vp.font, valueColor);
    vy -= VALUE_LINE_H;
  }
  if (!omitRule) {
    emitLine(ML, top - rowH, PAGE_W - MR, top - rowH, C.separator, 0.5);
  }
  y = top - rowH;
}

function kv(label, value) {
  const trimmed = (value != null && String(value).trim()) ? String(value).trim() : '—';
  const isEmpty = trimmed === '—';
  row(label, trimmed, isEmpty ? 'F1' : 'F2', isEmpty ? C.faint : C.text, false);
}

function mh(label, answer, explanation) {
  const a = (answer && String(answer).trim()) ? String(answer).trim() : '—';
  const isYes = a.toLowerCase() === 'yes';
  const isEmpty = a === '—';
  const hasExp = isYes && explanation && String(explanation).trim();
  row(label, a, 'F2', isEmpty ? C.faint : (isYes ? C.brand : C.text), hasExp);
  if (hasExp) {
    row('', String(explanation).trim(), 'F3', C.muted, false);
  }
}

function calcAge(dob) {
  if (!dob) return null;
  const d = new Date(dob + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const t = new Date();
  let a = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--;
  return a < 0 ? 0 : a;
}

const patientName = ((data.first_name || '') + ' ' + (data.last_name || '')).trim() || '(Unknown Patient)';
const submittedAt = ((data.timestamp || '').slice(0, 16).replace('T', ' ')) + ' UTC';

renderHeader({
  formType: 'registration',
  patientName: patientName,
  spouseName: null,
  age: calcAge(data.dob),
  childCount: null,
  dob: data.dob,
  submittedAt: submittedAt,
  submissionId: data.submission_id || ''
});

if (needsReview) {
  heading('Review needed');
  row('Characters not shown', PDFU_REVIEW_TEXT, 'F2', C.brand, false);
}

const mhMap = {};
for (const m of (data.medical_history || [])) {
  if (m && m.key) mhMap[m.key] = m;
}
const mhA = function (key) { return (mhMap[key] || {}).answer || ''; };
const mhD = function (key) { return (mhMap[key] || {}).details || ''; };

heading('Patient Information');
kv('Legal First Name', data.first_name);
kv('Preferred First Name (if different)', data.preferred_first_name);
kv('Middle Initial', data.middle_initial);
kv('Legal Last Name', data.last_name);
kv('Date of Birth', data.dob);
kv('Office Location', data.office_location);

heading('Contact & Consent');
const streetFull = [data.address_line1, data.address_line2].filter(Boolean).join(', ');
kv('Street Address', streetFull);
kv('City', data.address_city);
kv('State', data.address_state);
kv('ZIP', data.address_zip);
kv('Mobile Number', data.phone);
kv('Email', data.email);
kv(data.consent_voicemail_question || 'Voicemail consent', data.consent_voicemail_answer);
kv(data.consent_text_question || 'Text consent', data.consent_text_answer);

heading('Medical History');
kv('Current Primary Care Physician (name and location)', data.primary_care_physician);
mh('Do you, or does anyone in your family, have a tendency to bleed easily?', mhA('mhBleeding'), mhD('mhBleeding'));
mh('Do you have a kidney abnormality or abnormal kidney function?', mhA('mhKidney'), mhD('mhKidney'));
mh('Have you ever had AIDS, Chlamydia, Epididymitis, Gonorrhea, Hepatitis, or Prostatitis?', mhA('mhSTI'), mhD('mhSTI'));
mh('Have you ever had a hernia or any abnormality, infection, or tumor of the testicle or scrotum?', mhA('mhTesticleAbnormality'), mhD('mhTesticleAbnormality'));
mh('Have you ever had a serious injury to, or surgery of, the testicles or scrotal area?', mhA('mhTesticleInjury'), mhD('mhTesticleInjury'));
mh('Have you had any surgeries?', mhA('mhSurgeries'), mhD('mhSurgeries'));
mh('Have you had any complications or excessive pain or bleeding after surgery?', mhA('mhSurgyComplications'), mhD('mhSurgyComplications'));
mh('Is there medication you take regularly or have you taken any medication in the last 2 weeks?', mhA('mhMedications'), mhD('mhMedications'));
mh('Are you currently taking, or do you plan to take in the 5 days before your procedure, any aspirin or aspirin-containing products? Examples include low-dose/baby aspirin, Excedrin, Ecotrin, Anacin, or Alka-Seltzer Original.', mhA('mhAspirin'), mhD('mhAspirin'));
mh('Do you have any allergies to a drug, medication, or anesthetic?', mhA('mhAllergies'), mhD('mhAllergies'));
mh('Have you had any major medical problems or do you have any chronic medical problems?', mhA('mhChronic'), mhD('mhChronic'));

// ---- Insurance (subscriber incident, 2026-09) ---------------------------
// Each policy is rendered as its own block with its own policyholder, so the
// partner's identity can never be read as belonging to the patient's policy
// (or vice versa). Missing values are stated, not left blank:
//   * payload from before the policyholder release -> "Not transmitted ..."
//   * new payload, field empty                      -> "Not provided"
function subheading(title) {
  // Keep a policy block (heading + its ~8 rows) together on one page.
  ensure(22 + 8 * ROW_MIN_H);
  y -= 6;
  emitText(title, ML, y - 10, 10, 'F2', C.text);
  y -= 16;
}
function note(label, text) {
  row(label, text, 'F3', C.muted, false);
}
const NOT_TRANSMITTED = 'Not transmitted by the intake app for this submission ' +
  '(sent before policyholder details were included) - check the DrSnip intake console';
function holderRow(label, value) {
  const v = value != null ? String(value).trim() : '';
  if (v) { kv(label, v); return; }
  note(label, data.insurance_policyholder_contract ? 'Not provided' : NOT_TRANSMITTED);
}
function policyBlock(p) {
  kv('Insurance Company', p.provider);
  kv('ID No.', p.memberId);
  kv('Group No.', p.groupId);
  const name = [p.first, p.last].filter(function (x) { return x && String(x).trim(); }).join(' ');
  holderRow('Policyholder (insured) name', name);
  holderRow('Policyholder (insured) date of birth', p.dob);
  holderRow('Policyholder (insured) employer', p.employer);
}

const coverage = (data.insurance_status || '').trim();
const owner = data.insurance_policy_owner ||
  (coverage === "Partner's Insurance" ? 'partner'
    : (coverage === 'Own Insurance' || coverage === 'Both') ? 'patient' : '');

// Keep the section heading + coverage row with the first policy block.
if (owner) ensure(60 + 22 + 8 * ROW_MIN_H);
heading('Insurance');
kv('Current insurance coverage', data.insurance_status);
if (owner) {
  subheading(coverage === 'Both'
    ? "Patient's own policy (primary)"
    : (owner === 'partner' ? "Partner's policy - the partner is the policyholder" : "Patient's own policy"));
}
if (owner) {
  policyBlock({
    provider: data.insurance_provider,
    memberId: data.insurance_member_id,
    groupId: data.insurance_group_id,
    first: data.insurance_insured_first_name,
    last: data.insurance_insured_last_name,
    dob: data.insurance_insured_dob,
    employer: data.insurance_insured_employer
  });
} else {
  // No Insurance / blank coverage: unchanged rows, no policyholder block.
  kv('Insurance Company', data.insurance_provider);
  kv('ID No.', data.insurance_member_id);
  kv('Group No.', data.insurance_group_id);
}
kv('Insurance card — front', data.insurance_card_front_filename ? data.insurance_card_front_filename + ' (uploaded)' : '');
kv('Insurance card — back', data.insurance_card_back_filename ? data.insurance_card_back_filename + ' (uploaded)' : '');

if (coverage === 'Both') {
  subheading("Partner's policy (secondary) - the partner is the policyholder");
  if (data.partner_policy_present) {
    policyBlock({
      provider: data.partner_insurance_provider,
      memberId: data.partner_insurance_member_id,
      groupId: data.partner_insurance_group_id,
      first: data.partner_insured_first_name,
      last: data.partner_insured_last_name,
      dob: data.partner_insured_dob,
      employer: data.partner_insured_employer
    });
    const pc = Number(data.partner_cards_uploaded) || 0;
    note('Partner insurance cards', pc > 0
      ? pc + ' uploaded - stored in the DrSnip intake console, not attached to this chart'
      : 'None uploaded');
  } else {
    note("Partner's policy details", NOT_TRANSMITTED);
  }
}

if (curOps.length) {
  pages.push(curOps);
  curOps = [];
}

const totalPages = pages.length;
const subId = data.submission_id || '';
for (let idx = 0; idx < pages.length; idx++) {
  const ops = pages[idx];
  const fy = 30;
  ops.push({ k: 'l', x1: ML, y1: fy + 12, x2: PAGE_W - MR, y2: fy + 12, color: C.line, width: 0.5 });
  const fp = pdfuPrepare(patientName, 'F1', null);
  const left = (patientName && patientName !== '(Unknown Patient)' && !fp.flagged) ? (fp.text + ' · CONFIDENTIAL / PHI') : 'DrSnip Patient Intake — CONFIDENTIAL / PHI';
  const leftFont = fp.flagged ? 'F1' : fp.font;
  const center = 'Page ' + (idx + 1) + ' of ' + totalPages;
  const right = 'Submission ' + subId;
  const cw = tw(center, 'F1', 7);
  const rw = tw(right, 'F1', 7);
  ops.push({ k: 't', text: left, x: ML, y: fy, size: 7, font: leftFont, color: C.faint });
  ops.push({ k: 't', text: center, x: (PAGE_W - cw) / 2, y: fy, size: 7, font: 'F1', color: C.faint });
  ops.push({ k: 't', text: right, x: PAGE_W - MR - rw, y: fy, size: 7, font: 'F1', color: C.faint });
}

function fmtColor(c) { return c[0].toFixed(3) + ' ' + c[1].toFixed(3) + ' ' + c[2].toFixed(3); }
function renderOps(ops) {
  let s = '';
  let curFill = null, curStroke = null, curLW = null;
  for (const op of ops) {
    if (op.k === 't') {
      const key = op.color.join(',');
      if (key !== curFill) { s += fmtColor(op.color) + ' rg\n'; curFill = key; }
      s += 'BT /' + op.font + ' ' + op.size + ' Tf ' + op.x.toFixed(2) + ' ' + op.y.toFixed(2) + ' Td ' + pdfuShow(op.text, op.font) + ' Tj ET\n';
    } else if (op.k === 'r') {
      const key = op.fill.join(',');
      if (key !== curFill) { s += fmtColor(op.fill) + ' rg\n'; curFill = key; }
      s += op.x.toFixed(2) + ' ' + op.y.toFixed(2) + ' ' + op.w.toFixed(2) + ' ' + op.h.toFixed(2) + ' re f\n';
    } else if (op.k === 'rb') {
      const fk = op.fill.join(',');
      if (fk !== curFill) { s += fmtColor(op.fill) + ' rg\n'; curFill = fk; }
      const sk = op.stroke.join(',');
      if (sk !== curStroke) { s += fmtColor(op.stroke) + ' RG\n'; curStroke = sk; }
      if (curLW !== 1) { s += '1 w\n'; curLW = 1; }
      s += op.x.toFixed(2) + ' ' + op.y.toFixed(2) + ' ' + op.w.toFixed(2) + ' ' + op.h.toFixed(2) + ' re B\n';
    } else if (op.k === 'l') {
      const sk = op.color.join(',');
      if (sk !== curStroke) { s += fmtColor(op.color) + ' RG\n'; curStroke = sk; }
      if (curLW !== op.width) { s += op.width + ' w\n'; curLW = op.width; }
      s += op.x1.toFixed(2) + ' ' + op.y1.toFixed(2) + ' m ' + op.x2.toFixed(2) + ' ' + op.y2.toFixed(2) + ' l S\n';
    }
  }
  return s;
}

const objects = [];
function addObj(s) { objects.push(s); return objects.length; }
const catalogId = addObj('PLACEHOLDER');
const pagesId = addObj('PLACEHOLDER');
const helvId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const helvBoldId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
const helvOblId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');

// Render every page first so the embedded fonts know which glyphs are used.
const streams = pages.map(renderOps);
const unicodeFonts = pdfuFontObjects(addObj);
const pageIds = [];
for (const stream of streams) {
  const len = Buffer.byteLength(stream, 'binary');
  const streamId = addObj('<< /Length ' + len + ' >>\nstream\n' + stream + 'endstream');
  const pageObj = '<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 ' + helvId + ' 0 R /F2 ' + helvBoldId + ' 0 R /F3 ' + helvOblId + ' 0 R' + unicodeFonts + ' >> >> /Contents ' + streamId + ' 0 R >>';
  pageIds.push(addObj(pageObj));
}
objects[catalogId - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
objects[pagesId - 1] = '<< /Type /Pages /Count ' + pageIds.length + ' /Kids [' + pageIds.map(function (i) { return i + ' 0 R'; }).join(' ') + '] >>';

let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf, 'binary'));
  pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
}
const xrefStart = Buffer.byteLength(pdf, 'binary');
pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';

const buffer = Buffer.from(pdf, 'binary');
const safeLast = ((data.last_name || 'patient') + '').replace(/[^a-zA-Z0-9_-]+/g, '_');
const pid = resolved.patient_id || data.submission_id || 'unknown';
const fileName = 'registration_' + safeLast + '_' + pid + '.pdf';

return [{
  json: {
    patient_id: resolved.patient_id,
    drchrono_action: resolved.drchrono_action,
    pdf_filename: fileName,
    // Labels only (never values): what the document could not show exactly.
    pdf_review: pdfuSummary()
  },
  binary: {
    pdf: { data: buffer.toString('base64'), mimeType: 'application/pdf', fileName: fileName, fileExtension: 'pdf' }
  }
}];
