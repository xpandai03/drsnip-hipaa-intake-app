// Phase 3 — Consultation PDF template: ordered sections + each field's
// raw_payload key, human label, and render kind (see PHASE_3_PLAN.md §4.3,
// Phase 3 task §6). Sections mirror the Consultation form's screen titles
// (artifacts/intake-form/src/pages/Consultation.tsx).

import type { PdfSection } from "../layout/sections";

export const CONSULTATION_SECTIONS: PdfSection[] = [
  {
    title: "About You",
    fields: [
      { key: "firstName", label: "First Name", kind: "text" },
      { key: "lastName", label: "Last Name", kind: "text" },
      { key: "email", label: "Email", kind: "text" },
      { key: "phone", label: "Phone Number", kind: "text" },
      { key: "dateOfBirth", label: "Date of Birth", kind: "text" },
      { key: "occupation", label: "Field of Work / Occupation", kind: "text" },
      { key: "employer", label: "Employer", kind: "text" },
      { key: "jobTitle", label: "Job Title", kind: "text" },
      { key: "jobDemands", label: "Job Demands", kind: "text" },
    ],
  },
  {
    title: "Relationship",
    fields: [
      { key: "relationshipStatus", label: "Relationship Status", kind: "text" },
      { key: "relationshipStatusOther", label: "Relationship status — please specify", kind: "text" },
      { key: "partnerFirstName", label: "Partner / Spouse's First Name", kind: "text" },
      { key: "partnerLastName", label: "Partner / Spouse's Last Name", kind: "text" },
      { key: "partnerPhone", label: "Partner / Spouse's Phone", kind: "text" },
      { key: "partnerShareConsent", label: "Consent to share information with the partner if they contact us directly", kind: "text" },
      { key: "partnerAge", label: "Partner / Spouse's Age", kind: "text" },
      { key: "partnerOccupation", label: "Partner / Spouse's Field of Work", kind: "text" },
      { key: "partnerEducation", label: "Partner / Spouse's Education", kind: "text" },
      { key: "yearsInRelationship", label: "Years in this relationship", kind: "text" },
      { key: "marriageNumberSelf", label: "Which marriage is this for you?", kind: "text" },
      { key: "marriageNumberSpouse", label: "Which marriage is this for your spouse?", kind: "text" },
    ],
  },
  {
    title: "Children",
    fields: [
      { key: "childCount", label: "How many children do you have?", kind: "text" },
      { key: "children", label: "Children", kind: "children" },
    ],
  },
  {
    title: "Family Planning",
    fields: [
      { key: "wantMoreChildren", label: "Do you wish to have more children in the future?", kind: "text" },
      { key: "considerAdoption", label: "Would you consider adoption if you chose to have more children?", kind: "text" },
      { key: "vasectomyConsideredDuration", label: "For how long have you considered a vasectomy?", kind: "text" },
      { key: "consideredTubal", label: "Have you considered tubal ligation as an alternative sterilization choice?", kind: "text" },
      { key: "consideredTemporaryBC", label: "Have you considered temporary birth control methods (condoms, diaphragm, etc.)?", kind: "text" },
    ],
  },
  {
    title: "Birth Control",
    fields: [
      { key: "currentBC", label: "Current birth control methods", kind: "array" },
      { key: "currentBCOther", label: "Other current birth control methods", kind: "text" },
      { key: "priorBC", label: "Prior methods of birth control", kind: "array" },
    ],
  },
  {
    title: "Medical & Personal Considerations",
    fields: [
      { key: "religionConflict", label: "Does a vasectomy conflict with your religion?", kind: "text" },
      { key: "sexualConcerns", label: "Do you, or does your partner, have any sexual problems or concerns?", kind: "text" },
      { key: "sexualConcernsDetails", label: "Sexual problems or concerns — details", kind: "text" },
      { key: "geneticCondition", label: "Are you choosing sterilization because of a genetic condition concerning you or your partner?", kind: "text" },
      { key: "geneticConditionDetails", label: "Genetic condition — details", kind: "text" },
    ],
  },
  {
    title: "Emergency Contact & Referral",
    fields: [
      { key: "emergencyName", label: "Emergency Contact Name", kind: "text" },
      { key: "emergencyPhone", label: "Emergency Contact Phone Number", kind: "text" },
      { key: "emergencyRelationship", label: "Emergency Contact Relationship", kind: "text" },
      { key: "howHeard", label: "How did you hear about DrSnip?", kind: "text" },
      { key: "howHeardOther", label: "How did you hear about DrSnip — please specify", kind: "text" },
      { key: "referringProfessional", label: "Referring medical professional (name and specialty)", kind: "text" },
      { key: "additionalNotes", label: "Is there anything else you'd like to share with DrSnip before your appointment?", kind: "text" },
    ],
  },
];
