import { useState } from "react";
import { MultiStepForm, type FormScreen } from "@/components/MultiStepForm";
import {
  TextField,
  TextAreaField,
  SelectField,
  YesNoField,
  Reveal,
} from "@/components/ui/form-fields";
import { DatePicker } from "@/components/ui/DatePicker";
import { FieldShell } from "@/components/ui/form-fields";
import {
  FileUploadStub,
  type StubFileRef,
} from "@/components/ui/FileUploadStub";

// DrSnip — Patient Registration form. Five screens: Patient Information,
// Contact & Consent, Medical Background, Insurance, Review & Submit.
// Question content is sourced from the DrSnip Registration Jotform — see
// DRSNIP_FORMS.md.

// ---- Reference data -------------------------------------------------------

// DrSnip clinic locations (per drsnip.com).
const OFFICE_LOCATIONS = ["Seattle, WA", "Portland, OR", "Plano, TX"];

// Insurance coverage status — mirrors the DrSnip Registration Jotform (B.4):
// the patient's own policy, a partner's policy, both, or none. "Both" captures
// a second (partner) policy via the additive partnerInsurance* fields below.
const INSURANCE_OPTIONS = [
  "Own Insurance",
  "Partner's Insurance",
  "Both",
  "No Insurance",
];

type MedicalKey =
  | "mhMentalIllness"
  | "mhPainSensitive"
  | "mhFainting"
  | "mhBleeding"
  | "mhKidney"
  | "mhSTI"
  | "mhTesticleAbnormality"
  | "mhTesticleInjury"
  | "mhSurgeries"
  | "mhSurgeryComplications"
  | "mhMedications"
  | "mhAspirin"
  | "mhAllergies"
  | "mhChronic";

// The 14 medical-history screening questions (all Yes/No), in Jeff's
// requested order. `explanationPlaceholder` overrides the default placeholder
// in the per-question "Yes" reveal — used for the STI question, where the
// physician needs the specific disease(s) and year(s).
const MEDICAL_QUESTIONS: {
  key: MedicalKey;
  label: string;
  explanationPlaceholder?: string;
}[] = [
  { key: "mhMentalIllness", label: "Does mental illness or depression affect your decision making?" },
  { key: "mhPainSensitive", label: "Do you think you are more sensitive to pain than the average person?" },
  { key: "mhFainting", label: "Have you ever fainted during, or after, a medical procedure?" },
  { key: "mhBleeding", label: "Do you, or does anyone in your family, have a tendency to bleed easily?" },
  { key: "mhKidney", label: "Do you have a kidney abnormality or abnormal kidney function?" },
  {
    key: "mhSTI",
    label: "Have you ever had AIDS, Chlamydia, Epididymitis, Gonorrhea, Hepatitis, or Prostatitis?",
    explanationPlaceholder: "Please list which condition(s) and the year(s) you had each one.",
  },
  { key: "mhTesticleAbnormality", label: "Have you ever had Testicle abnormality, scrotum abnormality, hernia, infection, or tumor?" },
  { key: "mhTesticleInjury", label: "Have you ever had a serious injury to, or surgery of, the testicles or scrotal area?" },
  { key: "mhSurgeries", label: "Have you had any surgeries?" },
  { key: "mhSurgeryComplications", label: "Have you had any complications or excessive pain or bleeding after surgery?" },
  { key: "mhMedications", label: "Is there medication you take regularly or have you taken any medication in the last 2 weeks?" },
  { key: "mhAspirin", label: "Are you currently taking any aspirin products, or anticipate taking aspirin in the five days leading up to your procedure?" },
  { key: "mhAllergies", label: "Do you have any allergies to a drug, medication, or anesthetic?" },
  { key: "mhChronic", label: "Have you had any major medical problems or do you have any chronic medical problems?" },
];

const medicalQuestion = (key: MedicalKey) =>
  MEDICAL_QUESTIONS.find((q) => q.key === key)!;

// The 14 medical-history questions, grouped into 5 clinically themed screens
// of at most 3 single-select questions each. Order and grouping per Jeff's
// 2026-05 feedback.
const MEDICAL_SCREENS: { id: string; title: string; keys: MedicalKey[] }[] = [
  {
    id: "medical-mental-pain",
    title: "Mental Health & Pain Tolerance",
    keys: ["mhMentalIllness", "mhPainSensitive", "mhFainting"],
  },
  {
    id: "medical-bleeding-kidney",
    title: "Bleeding, Kidney & Infections",
    keys: ["mhBleeding", "mhKidney", "mhSTI"],
  },
  {
    id: "medical-surgical-reproductive",
    title: "Surgical & Reproductive History",
    keys: ["mhTesticleAbnormality", "mhTesticleInjury", "mhSurgeries"],
  },
  {
    id: "medical-complications-meds",
    title: "Surgery Complications & Medications",
    keys: ["mhSurgeryComplications", "mhMedications", "mhAspirin"],
  },
  {
    id: "medical-allergies-chronic",
    title: "Allergies & Chronic Conditions",
    keys: ["mhAllergies", "mhChronic"],
  },
];

// ---- Form state ----------------------------------------------------------

type RegistrationData = Record<MedicalKey, string> & {
  // Screen 1 — Patient Information
  officeLocation: string;
  legalFirstName: string;
  preferredFirstName: string;
  middleInitial: string;
  legalLastName: string;
  dateOfBirth: string;
  // Screen 2 — Contact & Consent. Address is captured as three structured
  // fields (Phase-3 address-split): the §C.1 contract has always called for
  // streetAddress / city / postalCode separately and DrChrono's Create
  // Patient API requires city and zip_code non-blank.
  streetAddress: string;
  city: string;
  postalCode: string;
  state: string;
  mobileNumber: string;
  email: string;
  consentVoicemail: string;
  consentText: string;
  // Screen 3 — Medical Background
  primaryCarePhysician: string;
  // Per-question explanation for each medical question answered "Yes".
  medicalDetails: Partial<Record<MedicalKey, string>>;
  // Screen 4 — Insurance.
  // `insuranceCoverage` is one of Own / Partner's / Both / No Insurance (B.4).
  // The flat insurance*/insured* fields below are the PRIMARY policy (the
  // patient's own for "Own"/"Both", the partner's for "Partner's Insurance").
  insuranceCoverage: string;
  insuranceCompany: string;
  insuranceIdNo: string;
  insuranceGroupNo: string;
  insuredFirstName: string;
  insuredLastName: string;
  insuredDob: string;
  insuredEmployer: string;
  insuranceCardFront: StubFileRef | null;
  insuranceCardBack: StubFileRef | null;
  // Secondary (partner's) policy — only collected when coverage is "Both".
  // Additive: existing primary keys are untouched (see PHASE_4_BLOCK_B_PLAN.md).
  partnerInsuranceCompany: string;
  partnerInsuranceIdNo: string;
  partnerInsuranceGroupNo: string;
  partnerInsuredFirstName: string;
  partnerInsuredLastName: string;
  partnerInsuredDob: string;
  partnerInsuredEmployer: string;
  partnerInsuranceCardFront: StubFileRef | null;
  partnerInsuranceCardBack: StubFileRef | null;
};

const initialData: RegistrationData = {
  officeLocation: "",
  legalFirstName: "",
  preferredFirstName: "",
  middleInitial: "",
  legalLastName: "",
  dateOfBirth: "",
  streetAddress: "",
  city: "",
  postalCode: "",
  state: "",
  mobileNumber: "",
  email: "",
  consentVoicemail: "",
  consentText: "",
  primaryCarePhysician: "",
  mhMentalIllness: "",
  mhTesticleAbnormality: "",
  mhTesticleInjury: "",
  mhSTI: "",
  mhKidney: "",
  mhMedications: "",
  mhSurgeries: "",
  mhFainting: "",
  mhAllergies: "",
  mhChronic: "",
  mhBleeding: "",
  mhSurgeryComplications: "",
  mhPainSensitive: "",
  mhAspirin: "",
  medicalDetails: {},
  insuranceCoverage: "",
  insuranceCompany: "",
  insuranceIdNo: "",
  insuranceGroupNo: "",
  insuredFirstName: "",
  insuredLastName: "",
  insuredDob: "",
  insuredEmployer: "",
  insuranceCardFront: null,
  insuranceCardBack: null,
  partnerInsuranceCompany: "",
  partnerInsuranceIdNo: "",
  partnerInsuranceGroupNo: "",
  partnerInsuredFirstName: "",
  partnerInsuredLastName: "",
  partnerInsuredDob: "",
  partnerInsuredEmployer: "",
  partnerInsuranceCardFront: null,
  partnerInsuranceCardBack: null,
};

// ---- Component -----------------------------------------------------------

export default function Home() {
  const [data, setData] = useState<RegistrationData>(initialData);
  const update = (patch: Partial<RegistrationData>) =>
    setData((d) => ({ ...d, ...patch }));

  // Records a per-question explanation for a "Yes" medical answer.
  const updateMedicalDetail = (key: MedicalKey, value: string) =>
    setData((d) => ({
      ...d,
      medicalDetails: { ...d.medicalDetails, [key]: value },
    }));

  // A primary policy is collected for every coverage except "No Insurance".
  // The partner's (secondary) policy is collected only for "Both" (B.4).
  const showPrimaryInsurance =
    data.insuranceCoverage !== "" &&
    data.insuranceCoverage !== "No Insurance";
  const showPartnerInsurance = data.insuranceCoverage === "Both";
  // Whose policy the primary set represents — partner's when "Partner's
  // Insurance" is the sole selection, otherwise the patient's own.
  const primaryInsuranceTitle =
    data.insuranceCoverage === "Partner's Insurance"
      ? "Partner's insurance"
      : "Your insurance";

  const screens: FormScreen[] = [
    {
      id: "patient-info",
      title: "Patient Information",
      description: "Let's start with the basics. Fields marked * are required.",
      render: () => (
        <div className="grid gap-6">
          <SelectField
            label="Office Location"
            value={data.officeLocation}
            onChange={(v) => update({ officeLocation: v })}
            options={OFFICE_LOCATIONS}
            required
          />
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="Legal First Name"
              value={data.legalFirstName}
              onChange={(v) => update({ legalFirstName: v })}
              placeholder="e.g. James"
              required
            />
            <TextField
              label="Legal Last Name"
              value={data.legalLastName}
              onChange={(v) => update({ legalLastName: v })}
              placeholder="e.g. Carter"
              required
            />
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="Preferred First Name (if different)"
              value={data.preferredFirstName}
              onChange={(v) => update({ preferredFirstName: v })}
            />
            <TextField
              label="Middle Initial"
              value={data.middleInitial}
              onChange={(v) => update({ middleInitial: v.slice(0, 1) })}
            />
          </div>
          <FieldShell label="Date of Birth" required>
            <DatePicker
              value={data.dateOfBirth}
              onChange={(v) => update({ dateOfBirth: v })}
              placeholder="Select your date of birth"
            />
          </FieldShell>
        </div>
      ),
      isValid: () =>
        data.officeLocation !== "" &&
        data.legalFirstName.trim() !== "" &&
        data.legalLastName.trim() !== "" &&
        data.dateOfBirth !== "",
    },
    {
      id: "contact",
      title: "Contact & Consent",
      description: "How can the DrSnip team reach you about your appointment?",
      render: () => (
        <div className="grid gap-6">
          <TextField
            label="Street Address"
            value={data.streetAddress}
            onChange={(v) => update({ streetAddress: v })}
            placeholder="123 Main Street"
            required
          />
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="City"
              value={data.city}
              onChange={(v) => update({ city: v })}
              placeholder="Seattle"
              required
            />
            <TextField
              label="ZIP Code"
              value={data.postalCode}
              onChange={(v) => update({ postalCode: v })}
              placeholder="98101"
              required
            />
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="State"
              value={data.state}
              onChange={(v) => update({ state: v })}
              placeholder="e.g. WA"
              required
            />
            <TextField
              label="Mobile Number"
              type="tel"
              value={data.mobileNumber}
              onChange={(v) => update({ mobileNumber: v })}
              placeholder="(555) 000-0000"
              required
            />
          </div>
          <TextField
            label="Email"
            type="email"
            value={data.email}
            onChange={(v) => update({ email: v })}
            placeholder="james.carter@example.com"
            hint="I agree to receive emails about my appointment."
            required
          />
          <YesNoField
            label="I consent to receiving detailed voicemails at the phone number provided."
            value={data.consentVoicemail}
            onChange={(v) => update({ consentVoicemail: v })}
            required
          />
          <YesNoField
            label="I consent to receiving care-related text messages at the phone number provided."
            value={data.consentText}
            onChange={(v) => update({ consentText: v })}
            required
          />
        </div>
      ),
      isValid: () =>
        data.streetAddress.trim() !== "" &&
        data.city.trim() !== "" &&
        // State is required: DrChrono's Create Patient API rejects a blank
        // state ("This field may not be blank."), which silently drops the
        // patient record. Block advancing until it's filled.
        data.state.trim() !== "" &&
        // ZIP: US 5-digit, optional +4 extension. Matches the patient-form
        // promise so the n8n bridge always sees a clean zip_code value.
        /^\d{5}(-\d{4})?$/.test(data.postalCode.trim()) &&
        data.mobileNumber.trim() !== "" &&
        data.email.trim() !== "" &&
        data.consentVoicemail !== "" &&
        data.consentText !== "",
    },
    ...MEDICAL_SCREENS.map(
      (ms, msIndex): FormScreen => ({
        id: ms.id,
        title: ms.title,
        description:
          msIndex === 0
            ? "These help our physicians prepare for your visit. Answer every question."
            : "Answer every question on this screen.",
        render: () => (
          <div className="grid gap-7">
            {msIndex === 0 && (
              <TextField
                label="Current Primary Care Physician (name and location)"
                value={data.primaryCarePhysician}
                onChange={(v) => update({ primaryCarePhysician: v })}
                placeholder="Name & Location"
              />
            )}
            {ms.keys.map((key) => {
              const q = medicalQuestion(key);
              return (
                <div key={key}>
                  <YesNoField
                    label={q.label}
                    value={data[key]}
                    onChange={(v) =>
                      update({ [key]: v } as Partial<RegistrationData>)
                    }
                    required
                  />
                  {/* A "Yes" reveals an explanation box directly under that
                      question — its answer is "Yes" plus this detail. */}
                  <Reveal show={data[key] === "Yes"}>
                    <TextAreaField
                      label="Please share details, including a general timeframe."
                      placeholder={q.explanationPlaceholder}
                      value={data.medicalDetails[key] ?? ""}
                      onChange={(v) => updateMedicalDetail(key, v)}
                      required
                    />
                  </Reveal>
                </div>
              );
            })}
          </div>
        ),
        // Every question must be answered, and any "Yes" answer must have a
        // non-blank explanation before the screen can advance (B.3).
        isValid: () =>
          ms.keys.every(
            (key) =>
              data[key] !== "" &&
              (data[key] !== "Yes" ||
                (data.medicalDetails[key] ?? "").trim() !== ""),
          ),
      }),
    ),
    {
      id: "insurance",
      title: "Insurance",
      description: "If you're using insurance, add your plan details below.",
      render: () => (
        <div className="grid gap-6">
          <SelectField
            label="Select your current insurance coverage"
            value={data.insuranceCoverage}
            onChange={(v) => update({ insuranceCoverage: v })}
            options={INSURANCE_OPTIONS}
            required
          />
          <Reveal show={showPrimaryInsurance}>
            <div className="grid gap-6">
              <p className="text-sm font-semibold text-primary">
                {primaryInsuranceTitle}
              </p>
              <TextField
                label="Insurance Company"
                value={data.insuranceCompany}
                onChange={(v) => update({ insuranceCompany: v })}
                required
              />
              <div className="grid gap-6 sm:grid-cols-2">
                <TextField
                  label="ID No."
                  value={data.insuranceIdNo}
                  onChange={(v) => update({ insuranceIdNo: v })}
                  required
                />
                <TextField
                  label="Group No."
                  value={data.insuranceGroupNo}
                  onChange={(v) => update({ insuranceGroupNo: v })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <TextField
                  label="Insured's Legal First Name"
                  value={data.insuredFirstName}
                  onChange={(v) => update({ insuredFirstName: v })}
                />
                <TextField
                  label="Insured's Legal Last Name"
                  value={data.insuredLastName}
                  onChange={(v) => update({ insuredLastName: v })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <FieldShell label="Insured's Date of Birth">
                  <DatePicker
                    value={data.insuredDob}
                    onChange={(v) => update({ insuredDob: v })}
                  />
                </FieldShell>
                <TextField
                  label="Insured's Employer"
                  value={data.insuredEmployer}
                  onChange={(v) => update({ insuredEmployer: v })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <FileUploadStub
                  label="Insurance card — front"
                  value={data.insuranceCardFront}
                  onChange={(f) => update({ insuranceCardFront: f })}
                />
                <FileUploadStub
                  label="Insurance card — back"
                  value={data.insuranceCardBack}
                  onChange={(f) => update({ insuranceCardBack: f })}
                />
              </div>
            </div>
          </Reveal>
          <Reveal show={showPartnerInsurance}>
            <div className="grid gap-6">
              <p className="text-sm font-semibold text-primary">
                Partner's insurance
              </p>
              <TextField
                label="Insurance Company"
                value={data.partnerInsuranceCompany}
                onChange={(v) => update({ partnerInsuranceCompany: v })}
                required
              />
              <div className="grid gap-6 sm:grid-cols-2">
                <TextField
                  label="ID No."
                  value={data.partnerInsuranceIdNo}
                  onChange={(v) => update({ partnerInsuranceIdNo: v })}
                  required
                />
                <TextField
                  label="Group No."
                  value={data.partnerInsuranceGroupNo}
                  onChange={(v) => update({ partnerInsuranceGroupNo: v })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <TextField
                  label="Insured's Legal First Name"
                  value={data.partnerInsuredFirstName}
                  onChange={(v) => update({ partnerInsuredFirstName: v })}
                />
                <TextField
                  label="Insured's Legal Last Name"
                  value={data.partnerInsuredLastName}
                  onChange={(v) => update({ partnerInsuredLastName: v })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <FieldShell label="Insured's Date of Birth">
                  <DatePicker
                    value={data.partnerInsuredDob}
                    onChange={(v) => update({ partnerInsuredDob: v })}
                  />
                </FieldShell>
                <TextField
                  label="Insured's Employer"
                  value={data.partnerInsuredEmployer}
                  onChange={(v) => update({ partnerInsuredEmployer: v })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <FileUploadStub
                  label="Insurance card — front"
                  value={data.partnerInsuranceCardFront}
                  onChange={(f) => update({ partnerInsuranceCardFront: f })}
                />
                <FileUploadStub
                  label="Insurance card — back"
                  value={data.partnerInsuranceCardBack}
                  onChange={(f) => update({ partnerInsuranceCardBack: f })}
                />
              </div>
            </div>
          </Reveal>
        </div>
      ),
      isValid: () =>
        data.insuranceCoverage !== "" &&
        (!showPrimaryInsurance ||
          (data.insuranceCompany.trim() !== "" &&
            data.insuranceIdNo.trim() !== "")) &&
        (!showPartnerInsurance ||
          (data.partnerInsuranceCompany.trim() !== "" &&
            data.partnerInsuranceIdNo.trim() !== "")),
    },
    {
      id: "review",
      title: "Review & Submit",
      description:
        "Please confirm your information is accurate, then submit your registration.",
      render: () => (
        <div className="grid gap-3">
          <ReviewRow label="Name" value={`${data.legalFirstName} ${data.legalLastName}`.trim()} />
          <ReviewRow label="Date of Birth" value={data.dateOfBirth} />
          <ReviewRow label="Office" value={data.officeLocation} />
          <ReviewRow label="Email" value={data.email} />
          <ReviewRow label="Mobile" value={data.mobileNumber} />
          <ReviewRow label="Insurance" value={data.insuranceCoverage} />
          <ReviewRow
            label="Insurance cards"
            value={
              [
                data.insuranceCardFront,
                data.insuranceCardBack,
                data.partnerInsuranceCardFront,
                data.partnerInsuranceCardBack,
              ].filter(Boolean).length + " uploaded"
            }
          />
          <p className="text-sm text-slate-500 mt-4 leading-relaxed">
            By submitting, you confirm the information above is accurate to the
            best of your knowledge.
          </p>
        </div>
      ),
      isValid: () => true,
    },
  ];

  const onSubmit = async (): Promise<boolean> => {
    const payload = {
      ...data,
      formType: "registration" as const,
      firstName: data.legalFirstName,
      lastName: data.legalLastName,
      email: data.email,
      phone: data.mobileNumber,
      dateOfBirth: data.dateOfBirth,
      stateResidence: data.state,
      insuranceCardFront: data.insuranceCardFront,
      insuranceCardBack: data.insuranceCardBack,
    };
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      return res.ok && json.success === true;
    } catch {
      // HIPAA: never log the submission body.
      return false;
    }
  };

  return (
    <MultiStepForm
      screens={screens}
      onSubmit={onSubmit}
      successTitle="Thank you — your registration is in."
      successMessage="Our team at DrSnip will review your information and reach out to schedule your consultation. If we need anything else, we'll contact you at the email or phone number you provided."
    />
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-slate-100">
      <span className="text-sm font-medium text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-slate-900 text-right">
        {value || "—"}
      </span>
    </div>
  );
}
