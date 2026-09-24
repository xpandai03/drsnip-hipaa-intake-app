// Generate a self-contained PDF of the registration form (no external deps).
// HIPAA-safe: PDF is built in-process and never sent to a third-party renderer.
// Source of truth: Intake-form/lib/n8n/legacy-jotform/generate-registration-pdf.js
// (deployed verbatim to "Patient Intake — Jotform → Sheets → DrChrono").

const data = $('Parse & Normalize').first().json;

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

// ---------- Policyholder (insured) — read straight from the Jotform request ----------
// Parse & Normalize (and the auto-mapped Sheets audit behind it) are left
// untouched; the PDF reads the four insured questions itself. Jotform shows
// them only for "Partner's Insurance" and "Both" (form conditions), so they
// are used only for those coverages. Meanings from the published form:
//   q35 control_fullname "Insured's Legal First Name" {first, last}
//   q36 control_textbox  "Insured's Legal Last Name"
//   q37 control_datetime "Insured's Date of Birth" {month, day, year}
//   q38 control_textbox  "Insured's Employer"
function jotformSource() {
  try {
    const w = $('Webhook').first().json || {};
    const raw = w.body && w.body.rawRequest ? w.body.rawRequest : w.rawRequest;
    if (typeof raw === 'string') return JSON.parse(raw);
    return (w.body && typeof w.body === 'object') ? w.body : w;
  } catch (e) {
    return {};
  }
}
function trimS(v) { return typeof v === 'string' ? v.trim() : ''; }
function realDate(y, m, d) {
  const Y = Number(y), M = Number(m), D = Number(d);
  if (!Number.isInteger(Y) || !Number.isInteger(M) || !Number.isInteger(D) || Y < 1900 || M < 1 || M > 12 || D < 1) return '';
  const t = new Date(Date.UTC(Y, M - 1, D));
  if (t.getUTCFullYear() !== Y || t.getUTCMonth() !== M - 1 || t.getUTCDate() !== D) return '';
  if (t.getTime() > Date.now() + 86400000) return '';
  return Y + '-' + String(M).padStart(2, '0') + '-' + String(D).padStart(2, '0');
}
const src = jotformSource();
const coverage = trimS(data.insurance_status);
const holderApplies = coverage === "Partner's Insurance" || coverage === 'Both';
const q35 = src.q35_q35_fullname33 && typeof src.q35_q35_fullname33 === 'object' ? src.q35_q35_fullname33 : {};
const q37 = src.q37_q37_datetime35;
const holder = { first: '', last: '', lastConflict: false, dob: '', dobInvalid: false, employer: '' };
if (holderApplies) {
  const lastFromName = trimS(q35.last);
  const lastField = trimS(src.q36_q36_textbox34);
  holder.first = trimS(q35.first);
  holder.last = lastField || lastFromName;
  holder.lastConflict = !!(lastField && lastFromName && lastField.toLowerCase() !== lastFromName.toLowerCase());
  holder.employer = trimS(src.q38_q38_textbox36);
  if (q37 && typeof q37 === 'object') {
    const any = trimS(q37.year) || trimS(q37.month) || trimS(q37.day);
    holder.dob = realDate(q37.year, q37.month, q37.day);
    holder.dobInvalid = !!any && !holder.dob;
  } else if (typeof q37 === 'string' && q37.trim()) {
    const m = q37.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/) || null;
    const us = q37.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/) || null;
    holder.dob = m ? realDate(m[1], m[2], m[3]) : (us ? realDate(us[3], us[1], us[2]) : '');
    holder.dobInvalid = !holder.dob;
  }
}

// Embedded font only when needed (never throws; falls back to explicit notices).
const docValues = { data: data, holder: holder };
await pdfuLoad(this, pdfuNeeds(docValues));
const needsReview = pdfuAnyUnsupported(docValues);

// ---------- Build content rows ----------
const rows = [];
const sec = (t) => rows.push({ type: 'section', text: t });
const kv = (k, v) => rows.push({
  type: 'kv',
  key: k,
  value: String(v == null || v === '' ? '—' : v)
});

sec('Patient Demographics');
kv('Full Name', `${data.first_name || ''} ${data.last_name || ''}`.trim());
kv('Preferred Name', data.preferred_first_name);
kv('Date of Birth', data.dob);
kv('Email', data.email);
kv('Phone', data.phone);
kv('Street', data.address_street);
kv('City', data.address_city);
kv('State', data.address_state);
kv('ZIP', data.address_zip);
kv('Office Location', data.office_location);
kv('Primary Care Physician', data.primary_care_physician);

sec('Insurance');
kv('Insurance Status', data.insurance_status);
if (coverage === 'Both') {
  // This form collects ONE policy for "Both" and never says whose it is.
  // Stated plainly instead of guessed.
  kv('Policy ownership', 'NOT SPECIFIED - this form collects one policy for "Both" and does not say whether it is the patient\'s or the partner\'s. Confirm both policies with the patient.');
} else if (coverage === "Partner's Insurance") {
  kv('Policy ownership', "Partner's policy - the partner is the policyholder");
}
kv('Provider', data.insurance_provider);
kv('Member ID', data.insurance_member_id);
kv('Group ID', data.insurance_group_id);
if (holderApplies) {
  const notGiven = 'Not provided on the form';
  const holderName = [holder.first, holder.last].filter(Boolean).join(' ');
  kv(coverage === 'Both' ? 'Policyholder (insured) name - as entered' : 'Policyholder (insured) name', holderName || notGiven);
  if (holder.lastConflict) kv('Policyholder last name - check', 'The form has two different last names for the policyholder; the separate last-name answer is shown above. Confirm with the patient.');
  kv('Policyholder (insured) date of birth', holder.dob || (holder.dobInvalid ? 'Not a valid date on the form - confirm with the patient' : notGiven));
  kv('Policyholder (insured) employer', holder.employer || notGiven);
}
kv('Insurance Cards Attached', (data.insurance_card_urls || []).length);

sec('Consent');
kv('HIPAA Consent', data.consent_hipaa ? 'Yes' : 'No');
kv('Treatment Consent', data.consent_treatment ? 'Yes' : 'No');

sec('Medical History');
const hist = data.medical_history || [];
if (hist.length === 0) {
  kv('(no responses captured)', '');
} else {
  for (const h of hist) kv(h.label || h.key, h.value);
}

sec('Surgery Details');
kv('Notes', data.surgery_details || '—');

sec('Submission Metadata');
kv('Submission ID', data.submission_id);
kv('Timestamp', data.timestamp);

// ---------- Hand-built minimal PDF ----------
const PAGE_W = 612;
const PAGE_H = 792;
const ML = 54, MR = 54, MT = 54, MB = 54;
const LEAD = 14;
const SZ_TITLE = 16, SZ_SECTION = 12, SZ_BODY = 10;

// Width-aware wrapping (breaks over-long words too). Helvetica widths are
// approximated as before; embedded-font widths are exact.
const CONTENT_W = PAGE_W - ML - MR;
const approxW = (s, size) => String(s).length * size * 0.52;
const tw = (s, font, size) => (pdfuIsU(font) ? pdfuWidth(s, font, size) : approxW(s, size));
const wrap = (s, font, size, maxW) => {
  const words = String(s == null ? '' : s).split(/\s+/).filter(Boolean);
  if (!words.length) return Array.of(''); // (not `return [...]`: n8n's static validator reads that as the node's output)
  const out = [];
  let line = '';
  for (const word of words) {
    let parts = [word];
    if (tw(word, font, size) > maxW) {
      parts = [];
      let rest = word;
      while (rest.length) {
        let cut = rest.length;
        while (cut > 1 && tw(rest.slice(0, cut), font, size) > maxW) cut--;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
    }
    for (const piece of parts) {
      const cand = line ? line + ' ' + piece : piece;
      if (line && tw(cand, font, size) > maxW) { out.push(line); line = piece; } else line = cand;
    }
  }
  if (line) out.push(line);
  return out;
};

const pages = [];
let cur = [];
let y = PAGE_H - MT;

const pushPage = () => {
  if (cur.length) pages.push(cur);
  cur = [];
  y = PAGE_H - MT;
};

const writeLine = (text, size, font, x = ML) => {
  if (y - size < MB) pushPage();
  cur.push({ text, size, font, x, y });
  y -= LEAD;
};

writeLine('DrSnip - Patient Registration Intake', SZ_TITLE, 'F2');
writeLine(`Generated: ${new Date().toISOString().slice(0, 19)}Z`, SZ_BODY, 'F1');
y -= 6;
if (needsReview) {
  y -= 6;
  writeLine('Review needed', SZ_SECTION, 'F2');
  for (const ln of wrap(PDFU_REVIEW_TEXT, 'F1', SZ_BODY, CONTENT_W)) writeLine(ln, SZ_BODY, 'F1');
}

for (const r of rows) {
  if (r.type === 'section') {
    y -= 6;
    writeLine(r.text, SZ_SECTION, 'F2');
  } else {
    // Key and value are prepared separately: a value that cannot be shown
    // exactly becomes an explicit notice without touching its label.
    const kp = pdfuPrepare(r.key, 'F1', null);
    const vp = pdfuPrepare(r.value, 'F1', r.key);
    const lines = wrap(kp.text + ':', kp.font, SZ_BODY, CONTENT_W);
    if (!vp.flagged) {
      // One line, as before. The embedded font also covers the ASCII label.
      const f = kp.font === 'U1' || vp.font === 'U1' ? 'U1' : 'F1';
      for (const ln of wrap(kp.text + ': ' + vp.text, f, SZ_BODY, CONTENT_W)) writeLine(ln, SZ_BODY, f);
    } else {
      for (const ln of lines) writeLine(ln, SZ_BODY, kp.font);
      for (const ln of wrap(vp.text, vp.font, SZ_BODY, CONTENT_W - 12)) writeLine(ln, SZ_BODY, vp.font, ML + 12);
    }
  }
}
if (cur.length) pages.push(cur);

// Assemble PDF objects
const objects = [];
const add = (s) => { objects.push(s); return objects.length; };

const catalogId = add('PLACEHOLDER_CATALOG');
const pagesId = add('PLACEHOLDER_PAGES');
const helvId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const helvBoldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
const helvOblId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');

// Render every page first so the embedded fonts know which glyphs are used.
const streams = pages.map((p) => p.map((t) => `BT /${t.font} ${t.size} Tf ${t.x} ${t.y} Td ${pdfuShow(t.text, t.font)} Tj ET\n`).join(''));
const unicodeFonts = pdfuFontObjects(add);
const pageIds = [];
for (const stream of streams) {
  const len = Buffer.byteLength(stream, 'binary');
  const streamId = add(`<< /Length ${len} >>\nstream\n${stream}endstream`);
  const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${helvId} 0 R /F2 ${helvBoldId} 0 R /F3 ${helvOblId} 0 R${unicodeFonts} >> >> /Contents ${streamId} 0 R >>`);
  pageIds.push(pageId);
}

objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] >>`;

let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf, 'binary'));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(pdf, 'binary');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) {
  pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

const buffer = Buffer.from(pdf, 'binary');
const safe = `${data.first_name || 'patient'}_${data.last_name || ''}`.replace(/[^a-zA-Z0-9_-]+/g, '_');
const fileName = `registration_${safe}_${(data.timestamp || '').slice(0, 10)}.pdf`;

return [
  {
    json: {
      patient_id: $json.patient_id,
      has_insurance_cards: $json.has_insurance_cards,
      insurance_card_urls: $json.insurance_card_urls,
      pdf_filename: fileName,
      // Labels only (never values): what the document could not show exactly.
      pdf_review: pdfuSummary()
    },
    binary: {
      pdf: {
        data: buffer.toString('base64'),
        mimeType: 'application/pdf',
        fileName: fileName,
        fileExtension: 'pdf'
      }
    }
  }
];