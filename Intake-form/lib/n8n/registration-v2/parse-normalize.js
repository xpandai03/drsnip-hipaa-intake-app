// Parse & normalize the DrSnip custom-app Registration payload.
// Reads the clean JSON shape posted by the intake app (no JotForm rawRequest).
const raw = $input.first().json;
const body = raw.body || raw;

const patient = body.patient || {};
const consent = body.consent || {};
const medical = body.medicalHistory || {};
const insurance = body.insurance || {};

const phoneDigits = (patient.phone || '').replace(/\D/g, '');

// ----- Address resilience (2026-05-27 bridge-link patch) -----------------
// The custom-app form (artifacts/intake-form/src/pages/Home.tsx) currently
// captures Street Address as a single freeform textarea with placeholder
// "Street, city, ZIP" and a separate State field. The N8N_CUTOVER_NOTES
// §C.1 contract has separate city / postalCode / addressLine2 / country
// fields. When those structured fields aren't populated we defensively
// extract from the freeform blob so DrChrono Create Patient doesn't 400 on
// empty zip_code / city.
//
// Sentinels: when neither the structured field nor the regex extract finds
// a value, fall back to '00000' (zip) and 'Unspecified' (city). These are
// clearly bad data — they keep DrChrono happy (non-blank validation passes)
// while making it easy for an admin to identify rows that need a
// follow-up correction in the chart.
//
// HIPAA: address components are PHI in combination with other identifiers.
// We never log the extracted values.
function trimStr(v) { return typeof v === 'string' ? v.trim() : ''; }
function extractZip(blob) {
  if (!blob) return '';
  const m = String(blob).match(/\b(\d{5}(?:-\d{4})?)\b/);
  return m ? m[1] : '';
}
function extractCity(blob, zip, state) {
  if (!blob) return '';
  let s = String(blob);
  if (zip) s = s.replace(zip, '');
  if (state) {
    const escaped = state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('\\b' + escaped + '\\b', 'i'), '');
  }
  // Common shape: "<street>, <city>, <state> <zip>". After stripping zip
  // and state the last non-empty comma-separated chunk is usually the city.
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1];
  return '';
}

const streetBlob = trimStr(patient.streetAddress);
const directZip = trimStr(patient.postalCode);
const directCity = trimStr(patient.city);
const directState = trimStr(patient.state);
const directAddrLine2 = trimStr(patient.addressLine2);
const directCountry = trimStr(patient.country);

const extractedZip = directZip || extractZip(streetBlob);
const extractedCity = directCity || extractCity(streetBlob, extractedZip, directState);

// Final fallbacks for DrChrono's non-blank validation.
const finalZip = extractedZip || '00000';
const finalCity = extractedCity || 'Unspecified';

// Medical history in the Phase-3 (Jeff feedback) order.
const MEDICAL_ORDER = [
  ['mhMentalIllness', 'Does mental illness or depression affect your decision making?'],
  ['mhPainSensitive', 'Do you think you are more sensitive to pain than the average person?'],
  ['mhFainting', 'Have you ever fainted during, or after, a medical procedure?'],
  ['mhBleeding', 'Do you, or does anyone in your family, have a tendency to bleed easily?'],
  ['mhKidney', 'Do you have a kidney abnormality or abnormal kidney function?'],
  ['mhSTI', 'Have you ever had AIDS, Chlamydia, Epididymitis, Gonorrhea, Hepatitis, or Prostatitis?'],
  ['mhTesticleAbnormality', 'Have you ever had Testicle abnormality, scrotum abnormality, hernia, infection, or tumor?'],
  ['mhTesticleInjury', 'Have you ever had a serious injury to, or surgery of, the testicles or scrotal area?'],
  ['mhSurgeries', 'Have you had any surgeries?'],
  ['mhSurgyComplications', 'Have you had any complications or excessive pain or bleeding after surgery?'],
  ['mhMedications', 'Is there medication you take regularly or have you taken any medication in the last 2 weeks?'],
  ['mhAspirin', 'Are you currently taking any aspirin products, or anticipate taking aspirin in the five days leading up to your procedure?'],
  ['mhAllergies', 'Do you have any allergies to a drug, medication, or anesthetic?'],
  ['mhChronic', 'Have you had any major medical problems or do you have any chronic medical problems?'],
];

const medicalHistory = MEDICAL_ORDER.map(([key, label]) => {
  const m = medical[key] || {};
  return { key, label, answer: m.answer || '', details: m.details || '' };
});

// Policyholder (insured / subscriber) details — subscriber incident, 2026-09.
// `policyholderContract === 1` marks payloads from the intake-app release that
// sends these blocks. An older payload (sent before that release, e.g. one in
// flight during the deploy) has no blocks: it is flagged so the document says
// "not transmitted" instead of rendering a blank that looks complete. The
// patient's identity is NEVER substituted for an unknown policyholder.
const hasPolicyholderContract = insurance.policyholderContract === 1;
const insured = insurance.insured || {};
const partnerPolicy = insurance.partnerPolicy || null;
const partnerInsured = (partnerPolicy && partnerPolicy.insured) || {};

const front = insurance.cardFront || null;
const back = insurance.cardBack || null;
const hasCards = !!(front && front.base64Data) || !!(back && back.base64Data);

return [{ json: {
  submission_id: body.submissionId || '',
  form_type: body.formType || 'registration',
  timestamp: body.submittedAt || new Date().toISOString(),
  source: 'custom-app-v2',

  first_name: patient.legalFirstName || '',
  last_name: patient.legalLastName || '',
  preferred_first_name: patient.preferredFirstName || '',
  middle_initial: patient.middleInitial || '',
  dob: patient.dateOfBirth || '',
  email: (patient.email || '').toLowerCase().trim(),
  phone: patient.phone || '',
  phone_digits: phoneDigits,

  address_line1: streetBlob,
  address_line2: directAddrLine2,
  address_city: finalCity,
  address_state: directState,
  address_zip: finalZip,
  address_country: directCountry,

  // Debug breadcrumb for the audit Sheet / admin console: did we have to
  // synthesize either field from the freeform blob (or fall back to sentinel)?
  address_extracted: !directZip || !directCity,
  address_zip_sentinel: !extractedZip,
  address_city_sentinel: !extractedCity,

  office_location: patient.officeLocation || '',
  primary_care_physician: patient.primaryCarePhysician || '',

  consent_voicemail_question: consent.voicemailQuestion || 'Do you give consent for DrSnip to leave voicemails at the number provided?',
  consent_voicemail_answer: consent.voicemail === true ? 'Yes' : (consent.voicemail === false ? 'No' : ''),
  consent_text_question: consent.textQuestion || 'Do you give consent for DrSnip to send text messages to the number provided?',
  consent_text_answer: consent.text === true ? 'Yes' : (consent.text === false ? 'No' : ''),

  medical_history: medicalHistory,
  mh_mental_illness: ((medical.mhMentalIllness || {}).answer) || '',

  insurance_status: insurance.status || '',
  insurance_provider: insurance.provider || '',
  insurance_member_id: insurance.memberId || '',
  insurance_group_id: insurance.groupId || '',
  insurance_policyholder_contract: hasPolicyholderContract,
  insurance_policy_owner: trimStr(insurance.policyOwner),
  insurance_insured_first_name: trimStr(insured.firstName),
  insurance_insured_last_name: trimStr(insured.lastName),
  insurance_insured_dob: trimStr(insured.dob),
  insurance_insured_employer: trimStr(insured.employer),

  partner_policy_present: !!partnerPolicy,
  partner_insurance_provider: partnerPolicy ? trimStr(partnerPolicy.provider) : '',
  partner_insurance_member_id: partnerPolicy ? trimStr(partnerPolicy.memberId) : '',
  partner_insurance_group_id: partnerPolicy ? trimStr(partnerPolicy.groupId) : '',
  partner_insured_first_name: trimStr(partnerInsured.firstName),
  partner_insured_last_name: trimStr(partnerInsured.lastName),
  partner_insured_dob: trimStr(partnerInsured.dob),
  partner_insured_employer: trimStr(partnerInsured.employer),
  partner_cards_uploaded: partnerPolicy && typeof partnerPolicy.cardsUploaded === 'number' ? partnerPolicy.cardsUploaded : 0,

  has_insurance_cards: hasCards,
  insurance_card_front_b64: (front && front.base64Data) || '',
  insurance_card_front_mime: (front && front.contentType) || 'image/jpeg',
  insurance_card_front_filename: (front && front.filename) || '',
  insurance_card_back_b64: (back && back.base64Data) || '',
  insurance_card_back_mime: (back && back.contentType) || 'image/jpeg',
  insurance_card_back_filename: (back && back.filename) || ''
}}];