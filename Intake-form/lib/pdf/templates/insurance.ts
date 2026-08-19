// Train D — Insurance Inquiry PDF template: the summary the clinic's
// verification team reads instead of squinting at card photos.
//
// Contents are deliberately NARROW. The insurance form collects no medical
// history and no consents, and none belong on a benefits-verification document,
// so this template renders identity + office + carrier/policy data ONLY. A test
// asserts no medical-history key can reach this PDF.
//
// NESTED KEYS: unlike Registration's flat raw_payload, the insurance form nests
// carrier data (Insurance.tsx builds `insurance.primary` / `insurance.secondary`
// with a `subscriberName: {first, last}` sub-object). Dotted paths below are
// resolved by lookupPath() in ../generator.ts; a key with no dot behaves exactly
// as before, so the Registration and Consultation templates are unaffected.
//
// The secondary section renders "—" throughout when the patient supplied no
// secondary carrier. That is intentional: a blank-but-present block tells the
// verifier "asked, none given" rather than leaving them wondering whether the
// question was skipped.

import type { PdfSection } from "../layout/sections";

export const INSURANCE_SECTIONS: PdfSection[] = [
  {
    title: "Patient Information",
    fields: [
      { key: "firstName", label: "First Name", kind: "text" },
      { key: "lastName", label: "Last Name", kind: "text" },
      { key: "dateOfBirth", label: "Date of Birth", kind: "text" },
      { key: "sex", label: "Sex", kind: "text" },
      { key: "officeLocation", label: "Preferred Clinic", kind: "text" },
    ],
  },
  {
    title: "Contact",
    fields: [
      { key: "streetAddress", label: "Street Address", kind: "text" },
      { key: "addressLine2", label: "Address Line 2", kind: "text" },
      { key: "city", label: "City", kind: "text" },
      { key: "state", label: "State", kind: "text" },
      { key: "postalCode", label: "ZIP Code", kind: "text" },
      { key: "phone", label: "Phone", kind: "text" },
      { key: "email", label: "Email", kind: "text" },
    ],
  },
  {
    title: "Primary Insurance",
    fields: [
      { key: "insurance.primary.carrier", label: "Insurance Company", kind: "text" },
      { key: "insurance.primary.policyNo", label: "Policy No.", kind: "text" },
      { key: "insurance.primary.groupNo", label: "Group No.", kind: "text" },
      { key: "insurance.primary.subscriberName.first", label: "Subscriber First Name", kind: "text" },
      { key: "insurance.primary.subscriberName.last", label: "Subscriber Last Name", kind: "text" },
      { key: "insurance.primary.subscriberDob", label: "Subscriber Date of Birth", kind: "text" },
      { key: "insurance.primary.relationship", label: "Subscriber's Relationship to Patient", kind: "text" },
    ],
  },
  {
    title: "Secondary Insurance",
    fields: [
      { key: "insurance.secondary.carrier", label: "Insurance Company", kind: "text" },
      { key: "insurance.secondary.policyNo", label: "Policy No.", kind: "text" },
      { key: "insurance.secondary.groupNo", label: "Group No.", kind: "text" },
      { key: "insurance.secondary.subscriberName.first", label: "Subscriber First Name", kind: "text" },
      { key: "insurance.secondary.subscriberName.last", label: "Subscriber Last Name", kind: "text" },
      { key: "insurance.secondary.subscriberDob", label: "Subscriber Date of Birth", kind: "text" },
      { key: "insurance.secondary.relationship", label: "Subscriber's Relationship to Patient", kind: "text" },
    ],
  },
  {
    // Metadata only — the images themselves are uploaded to the chart as their
    // own documents. This section records WHAT was attached so a verifier
    // reading the printed summary knows to look for them.
    title: "Insurance Cards Submitted",
    fields: [
      { key: "insuranceCardFront", label: "Primary card — front", kind: "file" },
      { key: "insuranceCardBack", label: "Primary card — back", kind: "file" },
      { key: "partnerInsuranceCardFront", label: "Secondary card — front", kind: "file" },
      { key: "partnerInsuranceCardBack", label: "Secondary card — back", kind: "file" },
    ],
  },
];
