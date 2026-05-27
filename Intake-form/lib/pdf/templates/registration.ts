// Phase 3 — Registration PDF template: ordered sections + each field's
// raw_payload key, human label, and render kind (see PHASE_3_PLAN.md §4.3).
// Labels match the DrSnip Registration form
// (artifacts/intake-form/src/pages/Home.tsx); the 14 medical labels are the
// exact MEDICAL_QUESTIONS strings.
//
// Jeff feedback (2026-05): medical block reordered into 5 clinically themed
// sub-sections; new "Mental Illness" screening question added at the top of
// the medical history; consent labels render the full question text the
// patient saw on the form (not abbreviated field names).

import type { PdfSection } from "../layout/sections";

export const REGISTRATION_SECTIONS: PdfSection[] = [
  {
    title: "Patient Information",
    fields: [
      { key: "legalFirstName", label: "Legal First Name", kind: "text" },
      { key: "preferredFirstName", label: "Preferred First Name (if different)", kind: "text" },
      { key: "middleInitial", label: "Middle Initial", kind: "text" },
      { key: "legalLastName", label: "Legal Last Name", kind: "text" },
      { key: "dateOfBirth", label: "Date of Birth", kind: "text" },
      { key: "officeLocation", label: "Office Location", kind: "text" },
    ],
  },
  {
    title: "Contact & Consent",
    fields: [
      { key: "streetAddress", label: "Street Address", kind: "text" },
      { key: "state", label: "State", kind: "text" },
      { key: "mobileNumber", label: "Mobile Number", kind: "text" },
      { key: "email", label: "Email", kind: "text" },
      // Consent Yes/No answers render with the full question text the patient
      // saw on the form (Jeff feedback). renderKeyValue / wrapText will wrap
      // the label cell across multiple lines as needed.
      { key: "consentVoicemail", label: "I consent to receiving detailed voicemails at the phone number provided.", kind: "text" },
      { key: "consentText", label: "I consent to receiving care-related text messages at the phone number provided.", kind: "text" },
    ],
  },
  {
    title: "Medical Background — Mental Health & Pain Tolerance",
    fields: [
      { key: "primaryCarePhysician", label: "Current Primary Care Physician (name and location)", kind: "text" },
      { key: "mhMentalIllness", label: "Does mental illness or depression affect your decision making?", kind: "medical" },
      { key: "mhPainSensitive", label: "Do you think you are more sensitive to pain than the average person?", kind: "medical" },
      { key: "mhFainting", label: "Have you ever fainted during, or after, a medical procedure?", kind: "medical" },
    ],
  },
  {
    title: "Medical Background — Bleeding, Kidney & Infections",
    fields: [
      { key: "mhBleeding", label: "Do you, or does anyone in your family, have a tendency to bleed easily?", kind: "medical" },
      { key: "mhKidney", label: "Do you have a kidney abnormality or abnormal kidney function?", kind: "medical" },
      { key: "mhSTI", label: "Have you ever had AIDS, Chlamydia, Epididymitis, Gonorrhea, Hepatitis, or Prostatitis?", kind: "medical" },
    ],
  },
  {
    title: "Medical Background — Surgical & Reproductive History",
    fields: [
      { key: "mhTesticleAbnormality", label: "Have you ever had Testicle abnormality, scrotum abnormality, hernia, infection, or tumor?", kind: "medical" },
      { key: "mhTesticleInjury", label: "Have you ever had a serious injury to, or surgery of, the testicles or scrotal area?", kind: "medical" },
      { key: "mhSurgeries", label: "Have you had any surgeries?", kind: "medical" },
    ],
  },
  {
    title: "Medical Background — Surgery Complications & Medications",
    fields: [
      { key: "mhSurgeryComplications", label: "Have you had any complications or excessive pain or bleeding after surgery?", kind: "medical" },
      { key: "mhMedications", label: "Is there medication you take regularly or have you taken any medication in the last 2 weeks?", kind: "medical" },
      { key: "mhAspirin", label: "Are you currently taking any aspirin products, or anticipate taking aspirin in the five days leading up to your procedure?", kind: "medical" },
    ],
  },
  {
    title: "Medical Background — Allergies & Chronic Conditions",
    fields: [
      { key: "mhAllergies", label: "Do you have any allergies to a drug, medication, or anesthetic?", kind: "medical" },
      { key: "mhChronic", label: "Have you had any major medical problems or do you have any chronic medical problems?", kind: "medical" },
    ],
  },
  {
    title: "Insurance",
    fields: [
      { key: "insuranceCoverage", label: "Current insurance coverage", kind: "text" },
      { key: "insuranceCompany", label: "Insurance Company", kind: "text" },
      { key: "insuranceIdNo", label: "ID No.", kind: "text" },
      { key: "insuranceGroupNo", label: "Group No.", kind: "text" },
      { key: "insuredFirstName", label: "Insured's Legal First Name", kind: "text" },
      { key: "insuredLastName", label: "Insured's Legal Last Name", kind: "text" },
      { key: "insuredDob", label: "Insured's Date of Birth", kind: "text" },
      { key: "insuredEmployer", label: "Insured's Employer", kind: "text" },
      { key: "insuranceCardFront", label: "Insurance card — front", kind: "file" },
      { key: "insuranceCardBack", label: "Insurance card — back", kind: "file" },
    ],
  },
];
