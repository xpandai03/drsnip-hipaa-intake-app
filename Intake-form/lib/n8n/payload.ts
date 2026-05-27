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
    sexualConcerns: string;
    sexualConcernsDetails: string;
    geneticCondition: string;
    geneticConditionDetails: string;
  };
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
      sexualConcerns: str((body as Record<string, unknown>).sexualConcerns),
      sexualConcernsDetails: str(
        (body as Record<string, unknown>).sexualConcernsDetails,
      ),
      geneticCondition: str((body as Record<string, unknown>).geneticCondition),
      geneticConditionDetails: str(
        (body as Record<string, unknown>).geneticConditionDetails,
      ),
    },
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
