// Map raw /api/submit body → the JotForm-replacement payload shape that the
// v2 n8n webhooks expect (per N8N_CUTOVER_NOTES.md §C). These are pure
// functions: no I/O, no DB, no logging. The bridge calls them just before
// POSTing to n8n.
//
// HIPAA: this module never logs. The body it receives is PHI; treat it as
// opaque and pass it through to the payload shape only.
//
// The Registration form (artifacts/intake-form/src/pages/Home.tsx) uses
// `mhSurgeryComplications` (no typo) for the surgery-complications question.
// The n8n parser expects `mhSurgyComplications` (the original JotForm key,
// typo and all). The mapper here re-keys it on the way out.

// ---------------------------------------------------------------------------
// Input — what /api/submit accepts. Mirrors the .passthrough() shape from
// api/submit.ts: known identity fields plus arbitrary form answers. We type
// the body as a permissive record so callers don't have to upgrade their
// types when new form fields land.
// ---------------------------------------------------------------------------

import { formatPacific } from "./insurance-notify";

export type SubmissionBody = Record<string, unknown> & {
  formType?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
};

// ---------------------------------------------------------------------------
// Output — the n8n payload contracts (N8N_CUTOVER_NOTES.md §C).
// ---------------------------------------------------------------------------

export interface CardFile {
  filename: string;
  contentType: string;
  base64Data: string;
}

export interface RegistrationN8nPayload {
  submissionId: string;
  formType: "registration";
  submittedAt: string;
  patient: {
    officeLocation: string;
    legalFirstName: string;
    preferredFirstName: string;
    middleInitial: string;
    legalLastName: string;
    dateOfBirth: string;
    streetAddress: string;
    addressLine2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone: string;
    email: string;
    primaryCarePhysician: string;
  };
  consent: {
    voicemail: boolean;
    text: boolean;
    voicemailQuestion: string;
    textQuestion: string;
  };
  medicalHistory: Record<string, { answer: string; details: string }>;
  insurance: {
    status: string;
    provider: string;
    memberId: string;
    groupId: string;
    cardFront?: CardFile;
    cardBack?: CardFile;
  };
}

export interface ConsultationN8nPayload {
  submissionId: string;
  formType: "consultation";
  patientId?: string;
  submittedAt: string;
  patient: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dateOfBirth: string;
  };
  aboutYou: {
    occupation: string;
    employer: string;
    jobTitle: string;
    jobDemands: string;
  };
  relationship: {
    status: string;
    statusOther: string;
    partnerFirstName: string;
    partnerLastName: string;
    partnerPhone: string;
    partnerShareConsent: boolean | string;
    partnerAge: number | string;
    partnerOccupation: string;
    partnerEducation: string;
    yearsInRelationship: number | string;
    marriageNumberSelf: number | string;
    marriageNumberSpouse: number | string;
  };
  children: {
    count: number;
    details: Array<{
      age: number | string;
      relation: string;
      gender: string;
    }>;
  };
  familyPlanning: {
    wantMoreChildren: string;
    considerAdoption: string;
    vasectomyConsideredDuration: string;
  };
  birthControl: {
    consideredTubal: string;
    consideredTemporaryBC: string;
    currentBC: string[];
    currentBCOther: string;
    priorBC: string[];
  };
  medicalPersonal: {
    religionConflict: string;
    religionConflictDetails: string;
    sexualConcerns: string;
    sexualConcernsDetails: string;
    geneticCondition: string;
    geneticConditionDetails: string;
  };
  // Phase 6 (MOVE): the 3 medical-history questions relocated from Registration
  // to Consultation (PRs #13/#14). Same {answer, details} shape and the same
  // medicalDetail() contract as the Registration payload.
  medicalHistory: Record<string, { answer: string; details: string }>;
  emergencyReferral: {
    name: string;
    phone: string;
    relationship: string;
    howHeard: string;
    howHeardOther: string;
    referringProfessional: string;
    additionalNotes: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VOICEMAIL_QUESTION =
  "I consent to receiving detailed voicemails at the phone number provided.";
const TEXT_QUESTION =
  "I consent to receiving care-related text messages at the phone number provided.";

// 14 medical-history keys in the order the n8n Code node renders them.
// The Registration form's local key for question #10 is `mhSurgeryComplications`
// (corrected spelling); the n8n contract expects the JotForm typo
// `mhSurgyComplications`. Map happens here.
const MEDICAL_KEYS: Array<[localKey: string, n8nKey: string]> = [
  ["mhMentalIllness", "mhMentalIllness"],
  ["mhPainSensitive", "mhPainSensitive"],
  ["mhFainting", "mhFainting"],
  ["mhBleeding", "mhBleeding"],
  ["mhKidney", "mhKidney"],
  ["mhSTI", "mhSTI"],
  ["mhTesticleAbnormality", "mhTesticleAbnormality"],
  ["mhTesticleInjury", "mhTesticleInjury"],
  ["mhSurgeries", "mhSurgeries"],
  ["mhSurgeryComplications", "mhSurgyComplications"], // typo preserved for n8n
  ["mhMedications", "mhMedications"],
  ["mhAspirin", "mhAspirin"],
  ["mhAllergies", "mhAllergies"],
  ["mhChronic", "mhChronic"],
];

// Phase 6 (MOVE): the 3 medical-history questions now collected on the
// Consultation form (relocated from Registration in PRs #13/#14). Local key ===
// n8n key, same as the others above.
const CONSULTATION_MEDICAL_KEYS: Array<[localKey: string, n8nKey: string]> = [
  ["mhMentalIllness", "mhMentalIllness"],
  ["mhPainSensitive", "mhPainSensitive"],
  ["mhFainting", "mhFainting"],
];

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "yes" || s === "true" || s === "y";
  }
  return false;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function arrOfStr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter((s) => s !== "") : [];
}

// Pull the per-question explanation for a "Yes" medical answer. The form
// stores them under `medicalDetails.<localKey>` (see Home.tsx).
function medicalDetail(medicalDetails: Record<string, unknown>, localKey: string): string {
  const v = medicalDetails[localKey];
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Registration payload
// ---------------------------------------------------------------------------

export function buildRegistrationPayload(
  submissionId: string,
  body: SubmissionBody,
  submittedAt: Date,
): RegistrationN8nPayload {
  const medicalDetails = rec((body as Record<string, unknown>).medicalDetails);

  const medicalHistory: Record<string, { answer: string; details: string }> = {};
  for (const [local, n8nKey] of MEDICAL_KEYS) {
    const answer = str((body as Record<string, unknown>)[local]);
    medicalHistory[n8nKey] = {
      answer,
      details: medicalDetail(medicalDetails, local),
    };
  }

  const cardFront = rec((body as Record<string, unknown>).insuranceCardFront);
  const cardBack = rec((body as Record<string, unknown>).insuranceCardBack);
  const hasFront = typeof cardFront.base64Data === "string" && cardFront.base64Data !== "";
  const hasBack = typeof cardBack.base64Data === "string" && cardBack.base64Data !== "";

  const payload: RegistrationN8nPayload = {
    submissionId,
    formType: "registration",
    submittedAt: submittedAt.toISOString(),
    patient: {
      officeLocation: str((body as Record<string, unknown>).officeLocation),
      legalFirstName:
        str((body as Record<string, unknown>).legalFirstName) ||
        str(body.firstName),
      preferredFirstName: str((body as Record<string, unknown>).preferredFirstName),
      middleInitial: str((body as Record<string, unknown>).middleInitial),
      legalLastName:
        str((body as Record<string, unknown>).legalLastName) ||
        str(body.lastName),
      dateOfBirth: str(body.dateOfBirth),
      streetAddress: str((body as Record<string, unknown>).streetAddress),
      addressLine2: str((body as Record<string, unknown>).addressLine2),
      city: str((body as Record<string, unknown>).city),
      // The form stores the address state under `state`; the n8n payload
      // expects `state`. /api/submit also surfaces it as `stateResidence`.
      state:
        str((body as Record<string, unknown>).state) ||
        str((body as Record<string, unknown>).stateResidence),
      postalCode: str((body as Record<string, unknown>).postalCode),
      country: str((body as Record<string, unknown>).country),
      phone: str(body.phone),
      email: str(body.email),
      primaryCarePhysician: str((body as Record<string, unknown>).primaryCarePhysician),
    },
    consent: {
      voicemail: bool((body as Record<string, unknown>).consentVoicemail),
      text: bool((body as Record<string, unknown>).consentText),
      voicemailQuestion: VOICEMAIL_QUESTION,
      textQuestion: TEXT_QUESTION,
    },
    medicalHistory,
    insurance: {
      status: str((body as Record<string, unknown>).insuranceCoverage),
      provider: str((body as Record<string, unknown>).insuranceCompany),
      memberId: str((body as Record<string, unknown>).insuranceIdNo),
      groupId: str((body as Record<string, unknown>).insuranceGroupNo),
    },
  };

  // Insurance cards: stubbed in the custom app today — base64Data only
  // exists if a future phase wires real upload. Omit cleanly when missing
  // (n8n's IF: Has Insurance Cards? handles the absence).
  if (hasFront) {
    payload.insurance.cardFront = {
      filename: str(cardFront.filename) || "insurance_card_front.jpg",
      contentType: str(cardFront.contentType) || "image/jpeg",
      base64Data: str(cardFront.base64Data),
    };
  }
  if (hasBack) {
    payload.insurance.cardBack = {
      filename: str(cardBack.filename) || "insurance_card_back.jpg",
      contentType: str(cardBack.contentType) || "image/jpeg",
      base64Data: str(cardBack.base64Data),
    };
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Consultation payload
// ---------------------------------------------------------------------------

export function buildConsultationPayload(
  submissionId: string,
  body: SubmissionBody,
  submittedAt: Date,
): ConsultationN8nPayload {
  const childrenRaw = (body as Record<string, unknown>).children;
  const childrenArr = Array.isArray(childrenRaw)
    ? childrenRaw.map(rec)
    : [];
  // The form already trims the array to childCount on submit (Consultation.tsx
  // onSubmit) — keep that contract: only declared children get rendered.
  const trimmed = childrenArr.filter((c) => {
    const age = str(c.age);
    const relation = str(c.relation);
    const gender = str(c.gender);
    return age !== "" || relation !== "" || gender !== "";
  });
  const childCount = trimmed.length;

  // MOVE: per-question "Yes" explanations live under raw_payload.medicalDetails,
  // same contract as the Registration payload. Blank/absent → {answer:"",details:""}.
  const medicalDetails = rec((body as Record<string, unknown>).medicalDetails);
  const medicalHistory: Record<string, { answer: string; details: string }> = {};
  for (const [local, n8nKey] of CONSULTATION_MEDICAL_KEYS) {
    medicalHistory[n8nKey] = {
      answer: str((body as Record<string, unknown>)[local]),
      details: medicalDetail(medicalDetails, local),
    };
  }

  const payload: ConsultationN8nPayload = {
    submissionId,
    formType: "consultation",
    submittedAt: submittedAt.toISOString(),
    patient: {
      firstName: str(body.firstName),
      lastName: str(body.lastName),
      email: str(body.email),
      phone: str(body.phone),
      dateOfBirth: str(body.dateOfBirth),
    },
    aboutYou: {
      occupation: str((body as Record<string, unknown>).occupation),
      employer: str((body as Record<string, unknown>).employer),
      jobTitle: str((body as Record<string, unknown>).jobTitle),
      jobDemands: str((body as Record<string, unknown>).jobDemands),
    },
    relationship: {
      status: str((body as Record<string, unknown>).relationshipStatus),
      statusOther: str((body as Record<string, unknown>).relationshipStatusOther),
      partnerFirstName: str((body as Record<string, unknown>).partnerFirstName),
      partnerLastName: str((body as Record<string, unknown>).partnerLastName),
      partnerPhone: str((body as Record<string, unknown>).partnerPhone),
      partnerShareConsent: bool(
        (body as Record<string, unknown>).partnerShareConsent,
      ),
      partnerAge: str((body as Record<string, unknown>).partnerAge),
      partnerOccupation: str((body as Record<string, unknown>).partnerOccupation),
      partnerEducation: str((body as Record<string, unknown>).partnerEducation),
      yearsInRelationship: str(
        (body as Record<string, unknown>).yearsInRelationship,
      ),
      marriageNumberSelf: str(
        (body as Record<string, unknown>).marriageNumberSelf,
      ),
      marriageNumberSpouse: str(
        (body as Record<string, unknown>).marriageNumberSpouse,
      ),
    },
    children: {
      count: childCount,
      details: trimmed.map((c) => ({
        age: str(c.age),
        relation: str(c.relation),
        gender: str(c.gender),
      })),
    },
    familyPlanning: {
      wantMoreChildren: str((body as Record<string, unknown>).wantMoreChildren),
      considerAdoption: str((body as Record<string, unknown>).considerAdoption),
      vasectomyConsideredDuration: str(
        (body as Record<string, unknown>).vasectomyConsideredDuration,
      ),
    },
    birthControl: {
      consideredTubal: str((body as Record<string, unknown>).consideredTubal),
      consideredTemporaryBC: str(
        (body as Record<string, unknown>).consideredTemporaryBC,
      ),
      currentBC: arrOfStr((body as Record<string, unknown>).currentBC),
      currentBCOther: str((body as Record<string, unknown>).currentBCOther),
      priorBC: arrOfStr((body as Record<string, unknown>).priorBC),
    },
    medicalPersonal: {
      religionConflict: str((body as Record<string, unknown>).religionConflict),
      // #14 added a conditional details field for the religion question.
      religionConflictDetails: str(
        (body as Record<string, unknown>).religionConflictDetails,
      ),
      sexualConcerns: str((body as Record<string, unknown>).sexualConcerns),
      sexualConcernsDetails: str(
        (body as Record<string, unknown>).sexualConcernsDetails,
      ),
      geneticCondition: str((body as Record<string, unknown>).geneticCondition),
      geneticConditionDetails: str(
        (body as Record<string, unknown>).geneticConditionDetails,
      ),
    },
    medicalHistory,
    emergencyReferral: {
      name: str((body as Record<string, unknown>).emergencyName),
      phone: str((body as Record<string, unknown>).emergencyPhone),
      relationship: str((body as Record<string, unknown>).emergencyRelationship),
      howHeard: str((body as Record<string, unknown>).howHeard),
      howHeardOther: str((body as Record<string, unknown>).howHeardOther),
      referringProfessional: str(
        (body as Record<string, unknown>).referringProfessional,
      ),
      additionalNotes: str((body as Record<string, unknown>).additionalNotes),
    },
  };

  const patientId = str((body as Record<string, unknown>).patientId);
  if (patientId) payload.patientId = patientId;

  return payload;
}

// ---------------------------------------------------------------------------
// Insurance payload (Train C)
// ---------------------------------------------------------------------------
// The embedded insurance form (artifacts/intake-form/src/pages/Insurance.tsx)
// posts a DIFFERENT shape from Registration: it nests carrier data under
// `insurance.primary` / `insurance.secondary`, collects `sex` (which
// Registration does not), and captures a fully structured address (so the
// `00000` / `Unspecified` sentinel path in n8n's Parse & Normalize is not
// reachable from this form).
//
// HARD RULE — no card bytes. This payload NEVER carries base64Data, for any of
// the four card slots. n8n fetches the bytes out-of-band from the internal
// service-token endpoints (FINDINGS-bridge-insurance.md §4 option C). Putting
// them here is what produced 38–85 MB n8n execution records and OOM-killed
// production n8n twice (notification-audit-2026-07-13.md §0). Only the non-PHI
// presence flag + count travel with the payload; filenames are deliberately
// omitted (they can carry identifiers).

export interface InsuranceCarrierBlock {
  carrier: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  policyNo: string;
  groupNo: string;
  subscriberDateOfBirth: string;
  relationship: string;
}

export interface InsuranceN8nPayload {
  submissionId: string;
  formType: "insurance";
  submittedAt: string;
  /** Train E: submission time already rendered in clinic-local Pacific, e.g.
   *  "Aug 19, 2:14 PM PT". Formatted here rather than in an n8n expression so
   *  the notification's timestamp is unit-testable and cannot quietly render in
   *  UTC if a workflow template is edited. */
  submittedAtPacific: string;
  patient: {
    officeLocation: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
    streetAddress: string;
    addressLine2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone: string;
    email: string;
  };
  insurance: {
    primary: InsuranceCarrierBlock;
    secondary: InsuranceCarrierBlock | null;
  };
  /** Non-PHI card presence signal only. NEVER bytes, NEVER filenames. */
  cards: {
    hasCards: boolean;
    count: number;
  };
  /** Train D. `enabled` is the document kill switch, evaluated per submission
   *  in the app and carried here so n8n can gate its whole document branch on
   *  it. Deliberately NOT an n8n env var: toggling that would require
   *  restarting the n8n machine, which would drop in-flight registration and
   *  consultation webhooks — chart creation outranks document delivery. */
  documents: {
    enabled: boolean;
  };
}

export interface InsurancePayloadOptions {
  /** Value of N8N_INSURANCE_DOCS_ENABLED, read by the caller. Kept as a
   *  parameter so this module stays pure (no env reads, no I/O). */
  documentsEnabled?: boolean;
}

// The four card slots api/submit.ts recognizes (see api/_lib/card-files.ts).
// Used ONLY to count what was attached — never to forward content.
const CARD_SLOTS = [
  "insuranceCardFront",
  "insuranceCardBack",
  "partnerInsuranceCardFront",
  "partnerInsuranceCardBack",
] as const;

function carrierBlock(v: unknown): InsuranceCarrierBlock {
  const c = rec(v);
  const name = rec(c.subscriberName);
  return {
    carrier: str(c.carrier),
    subscriberFirstName: str(name.first),
    subscriberLastName: str(name.last),
    policyNo: str(c.policyNo),
    groupNo: str(c.groupNo),
    subscriberDateOfBirth: str(c.subscriberDob),
    relationship: str(c.relationship),
  };
}

/** True when a carrier block carries any content at all. An absent/blank
 *  secondary must serialize as `null`, not as a block of empty strings, so the
 *  workflow's "has secondary?" check is unambiguous. */
function carrierHasContent(b: InsuranceCarrierBlock): boolean {
  return Object.values(b).some((v) => v !== "");
}

export function buildInsurancePayload(
  submissionId: string,
  body: SubmissionBody,
  submittedAt: Date,
  options: InsurancePayloadOptions = {},
): InsuranceN8nPayload {
  const raw = body as Record<string, unknown>;
  const ins = rec(raw.insurance);

  const secondaryBlock = carrierBlock(ins.secondary);

  const cardCount = CARD_SLOTS.filter((slot) => {
    const ref = rec(raw[slot]);
    return typeof ref.base64Data === "string" && ref.base64Data !== "";
  }).length;

  return {
    submissionId,
    formType: "insurance",
    submittedAt: submittedAt.toISOString(),
    submittedAtPacific: formatPacific(submittedAt),
    patient: {
      officeLocation: str(raw.officeLocation),
      firstName: str(body.firstName),
      lastName: str(body.lastName),
      dateOfBirth: str(body.dateOfBirth),
      sex: str(raw.sex),
      streetAddress: str(raw.streetAddress),
      addressLine2: str(raw.addressLine2),
      city: str(raw.city),
      // The form writes the same value to `state` and `stateResidence`; prefer
      // `state` and fall back, mirroring buildRegistrationPayload.
      state: str(raw.state) || str(raw.stateResidence),
      postalCode: str(raw.postalCode),
      // Not collected by the insurance form; present for shape parity with the
      // registration contract so n8n's parser can be a near-copy.
      country: str(raw.country),
      phone: str(body.phone),
      email: str(body.email),
    },
    insurance: {
      primary: carrierBlock(ins.primary),
      secondary: carrierHasContent(secondaryBlock) ? secondaryBlock : null,
    },
    cards: {
      hasCards: cardCount > 0,
      count: cardCount,
    },
    documents: {
      enabled: options.documentsEnabled === true,
    },
  };
}
