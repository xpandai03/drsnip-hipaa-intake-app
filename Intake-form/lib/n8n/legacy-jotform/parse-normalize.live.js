// UNCHANGED copy of the live "Parse & Normalize" node (Function v1) of
// "Patient Intake — Jotform → Sheets → DrChrono" (6warkNFZSSzuasMB), kept so
// tests run the real legacy transformation. NOT deployed by this repo: the
// subscriber fix reads q35-q38 in the PDF node instead, so this node and the
// auto-mapped Sheets audit behind it stay exactly as they are.

// Parse & normalize Jotform payload for DrSnip Registration Form

const raw = items[0].json;

// ---------- STEP 1: Extract source safely ----------
let src = {};

if (raw.body?.rawRequest) {
  try {
    src = JSON.parse(raw.body.rawRequest);
  } catch {
    src = raw.body;
  }
} else if (raw.rawRequest) {
  try {
    src = JSON.parse(raw.rawRequest);
  } catch {
    src = raw;
  }
} else {
  src = raw.body || raw;
}

// ---------- HELPERS ----------
const pick = (...keys) => {
  for (const k of keys) {
    if (src[k] !== undefined && src[k] !== null && String(src[k]).trim() !== '') {
      return src[k];
    }
  }
  return '';
};

const normDob = () => {
  const d = src.q8_q8_datetime6;
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  if (typeof d === 'object') {
    const y = d.year;
    const m = String(d.month || '').padStart(2, '0');
    const day = String(d.day || '').padStart(2, '0');
    if (y && m && day) return `${y}-${m}-${day}`;
  }
  return '';
};

const parseAddress = () => {
  const a = src.q9_q9_address7;
  if (!a || typeof a !== 'object') {
    return { street: '', city: '', state: '', zip: '' };
  }
  return {
    street: [a.addr_line1, a.addr_line2].filter(Boolean).join(' '),
    city: a.city || '',
    state: a.state || '',
    zip: a.postal || ''
  };
};

const parsePhone = () => {
  const p = src.q10_q10_phone8;
  if (p && typeof p === 'object') return p.full || '';
  if (typeof p === 'string') return p;
  return '';
};

const parseInsuranceCardUrls = () => {
  // Jotform exposes file upload answers under any key matching /fileupload/i
  // (and the question number can shift if the form is edited). Scan all keys.
  const out = [];
  for (const key of Object.keys(src)) {
    if (!/fileupload/i.test(key)) continue;
    const v = src[key];
    if (!v) continue;
    const arr = Array.isArray(v) ? v : [v];
    for (const item of arr) {
      if (typeof item === 'string' && /^https?:\/\//.test(item)) {
        out.push(item);
      }
    }
  }
  return out;
};

// Human-readable medical history question labels (Jotform q16-q28)
const Q_LABELS = {
  q16: 'Have you ever had testicle abnormality, scrotal abnormality, hernia, infection, or tumor?',
  q17: 'Have you ever had a serious injury to, or surgery of, the testicles or scrotal area?',
  q18: 'Have you ever had AIDS, Chlamydia, Epididymitis, Gonorrhea, Hepatitis, or Prostatitis?',
  q19: 'Do you have a kidney abnormality or abnormal kidney function?',
  q20: 'Is there medication you take regularly or have you taken any medication in the last 2 weeks?',
  q21: 'Have you had any surgeries?',
  q22: 'Have you ever fainted or almost fainted during, or after, a medical procedure?',
  q23: 'Do you have any allergies to a drug, medication, or anesthetic?',
  q24: 'Have you had any major medical problems or do you have any chronic medical problems?',
  q25: 'Do you, or does anyone in your family, have a tendency to bleed easily?',
  q26: 'Have you had any complications or excessive pain or bleeding after surgery?',
  q27: 'Do you think you are more sensitive to pain than the average person?',
  q28: 'Are you currently taking any aspirin products, or anticipate taking aspirin in the five days leading up to your procedure?'
};

// Extract medical history yes/no fields (q16-q28 inclusive)
const parseMedicalHistory = () => {
  const out = [];
  for (const key of Object.keys(src)) {
    const m = key.match(/^q(\d+)_/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n < 16 || n > 28) continue;
    const val = src[key];
    let display;
    if (typeof val === 'string') display = val;
    else if (Array.isArray(val)) display = val.join(', ');
    else if (val == null) display = '';
    else if (typeof val === 'object') display = JSON.stringify(val);
    else display = String(val);
    const label = Q_LABELS['q' + n] || key;
    out.push({ key, label, value: display });
  }
  // sort by question number for stable order
  out.sort((a, b) => {
    const na = parseInt((a.key.match(/^q(\d+)_/) || [])[1] || '0', 10);
    const nb = parseInt((b.key.match(/^q(\d+)_/) || [])[1] || '0', 10);
    return na - nb;
  });
  return out;
};

// ---------- CORE DATA ----------
const addr = parseAddress();
const insuranceCardUrls = parseInsuranceCardUrls();
const medicalHistory = parseMedicalHistory();

const submissionId =
  raw.body?.submissionID ||
  raw.submissionID ||
  src.submissionID ||
  src.submission_id ||
  '';

const clean = {
  submission_id: submissionId,
  timestamp: new Date().toISOString(),

  first_name: pick('q4_q4_textbox2'),
  last_name: pick('q7_q7_textbox5'),
  dob: normDob(),
  email: pick('q13_q13_email11'),
  phone: parsePhone(),

  address_street: addr.street,
  address_city: addr.city,
  address_state: addr.state,
  address_zip: addr.zip,

  insurance_status: pick('q31_q31_radio29'),
  insurance_provider: pick('q32_q32_textbox30'),
  insurance_member_id: pick('q33_q33_textbox31'),
  insurance_group_id: pick('q34_q34_textbox32'),

  consent_hipaa: pick('q11_q11_radio9') === 'Yes',
  consent_treatment: pick('q12_q12_radio10') === 'Yes',

  office_location: pick('q3_q3_dropdown1'),
  preferred_first_name: pick('q5_q5_textbox3'),
  primary_care_physician: pick('q15_q15_textbox13'),
  surgery_details: pick('q29_q29_textarea27'),

  insurance_card_urls: insuranceCardUrls,
  has_insurance_cards: insuranceCardUrls.length > 0,

  medical_history: medicalHistory,

  _debug_submission_id: submissionId
};

return [
  {
    json: {
      ...clean,
      original: clean
    }
  }
];