// Generate doctor-friendly Registration Intake PDF (pure JS, no external deps).
// Mirrors the Phase 3 visual approved by Jeff: blue header band + DrSnip wordmark,
// large centered patient name, Age + DOB stat tiles, tabular medical record with
// rule separators between rows, full consent question text, footer on every
// page. HIPAA-safe — assembled in-process, never sent to a third-party renderer.
const data = $('Parse & Normalize').first().json;
const resolved = $input.first().json;

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

function pdfEsc(s) {
  return String(s == null ? '' : s)
    // Fold accents to their base letter (José -> Jose) before the WinAnsi
    // fallback below, which would otherwise print '?' for them.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/—/g, '\\227')
    .replace(/–/g, '\\226')
    .replace(/’/g, '\\222')
    .replace(/‘/g, '\\221')
    .replace(/“/g, '\\223')
    .replace(/”/g, '\\224')
    .replace(/·/g, '\\267')
    .replace(/•/g, '\\225')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[-￿]/g, '?');
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
  const nw = tw(opts.patientName, 'F2', 24);
  emitText(opts.patientName, (PAGE_W - nw) / 2, y - 24, 24, 'F2', C.text);
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
  const labelLines = wrap(label, 'F1', LABEL_SIZE, LABEL_W);
  const valueLines = wrap(value, valueFont, VALUE_SIZE, VALUE_W);
  const contentH = Math.max(labelLines.length * LABEL_LINE_H, valueLines.length * VALUE_LINE_H);
  const rowH = Math.max(contentH + ROW_PAD_V * 2, ROW_MIN_H);
  ensure(rowH);
  const top = y;
  const valueX = ML + LABEL_W + COL_GAP;
  let ly = top - ROW_PAD_V - LABEL_SIZE;
  for (const ln of labelLines) {
    emitText(ln, ML, ly, LABEL_SIZE, 'F1', C.muted);
    ly -= LABEL_LINE_H;
  }
  let vy = top - ROW_PAD_V - VALUE_SIZE;
  for (const ln of valueLines) {
    emitText(ln, valueX, vy, VALUE_SIZE, valueFont, valueColor);
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
  const left = (patientName && patientName !== '(Unknown Patient)') ? (patientName + ' · CONFIDENTIAL / PHI') : 'DrSnip Patient Intake — CONFIDENTIAL / PHI';
  const center = 'Page ' + (idx + 1) + ' of ' + totalPages;
  const right = 'Submission ' + subId;
  const cw = tw(center, 'F1', 7);
  const rw = tw(right, 'F1', 7);
  ops.push({ k: 't', text: left, x: ML, y: fy, size: 7, font: 'F1', color: C.faint });
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
      s += 'BT /' + op.font + ' ' + op.size + ' Tf ' + op.x.toFixed(2) + ' ' + op.y.toFixed(2) + ' Td (' + pdfEsc(op.text) + ') Tj ET\n';
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

const pageIds = [];
for (const ops of pages) {
  const stream = renderOps(ops);
  const len = Buffer.byteLength(stream, 'binary');
  const streamId = addObj('<< /Length ' + len + ' >>\nstream\n' + stream + 'endstream');
  const pageObj = '<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 ' + helvId + ' 0 R /F2 ' + helvBoldId + ' 0 R /F3 ' + helvOblId + ' 0 R >> >> /Contents ' + streamId + ' 0 R >>';
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
    pdf_filename: fileName
  },
  binary: {
    pdf: { data: buffer.toString('base64'), mimeType: 'application/pdf', fileName: fileName, fileExtension: 'pdf' }
  }
}];
