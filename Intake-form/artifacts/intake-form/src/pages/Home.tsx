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

const INSURANCE_OPTIONS = [
  "Private / Commercial insurance",
  "Medicare",
  "Medicaid",
  "Self-pay / No insurance",
  "Other",
];

// The 13 medical-history screening questions (all Yes/No).
const MEDICAL_QUESTIONS: { key: MedicalKey; label: string }[] = [
  { key: "mhTesticleAbnormality", label: "Have you ever had a testicle abnormality, scrotum abnormality, hernia, infection, or tumor?" },
  { key: "mhTesticleInjury", label: "Have you ever had a serious injury to, or surgery of, the testicles or scrotal area?" },
  { key: "mhSTI", label: "Have you ever had AIDS, Chlamydia, Epididymitis, Gonorrhea, Hepatitis, or Prostatitis?" },
  { key: "mhKidney", label: "Do you have a kidney abnormality or abnormal kidney function?" },
  { key: "mhMedications", label: "Do you take medication regularly, or have you taken any in the last 2 weeks?" },
  { key: "mhSurgeries", label: "Have you had any surgeries?" },
  { key: "mhFainting", label: "Have you ever fainted, or almost fainted, during or after a medical procedure?" },
  { key: "mhAllergies", label: "Do you have any allergies to a drug, medication, or anesthetic?" },
  { key: "mhChronic", label: "Do you have any major or chronic medical problems?" },
  { key: "mhBleeding", label: "Do you, or does anyone in your family, have a tendency to bleed easily?" },
  { key: "mhSurgeryComplications", label: "Have you had complications, or excessive pain or bleeding, after surgery?" },
  { key: "mhPainSensitive", label: "Do you think you are more sensitive to pain than the average person?" },
  { key: "mhAspirin", label: "Are you taking — or will you take — aspirin products in the 5 days before your procedure?" },
];

type MedicalKey =
  | "mhTesticleAbnormality"
  | "mhTesticleInjury"
  | "mhSTI"
  | "mhKidney"
  | "mhMedications"
  | "mhSurgeries"
  | "mhFainting"
  | "mhAllergies"
  | "mhChronic"
  | "mhBleeding"
  | "mhSurgeryComplications"
  | "mhPainSensitive"
  | "mhAspirin";

// ---- Form state ----------------------------------------------------------

type RegistrationData = Record<MedicalKey, string> & {
  // Screen 1 — Patient Information
  officeLocation: string;
  legalFirstName: string;
  preferredFirstName: string;
  middleInitial: string;
  legalLastName: string;
  dateOfBirth: string;
  // Screen 2 — Contact & Consent
  streetAddress: string;
  state: string;
  mobileNumber: string;
  email: string;
  consentVoicemail: string;
  consentText: string;
  // Screen 3 — Medical Background
  primaryCarePhysician: string;
  mhDetails: string;
  // Screen 4 — Insurance
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
};

const initialData: RegistrationData = {
  officeLocation: "",
  legalFirstName: "",
  preferredFirstName: "",
  middleInitial: "",
  legalLastName: "",
  dateOfBirth: "",
  streetAddress: "",
  state: "",
  mobileNumber: "",
  email: "",
  consentVoicemail: "",
  consentText: "",
  primaryCarePhysician: "",
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
  mhDetails: "",
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
};

// ---- Component -----------------------------------------------------------

export default function Home() {
  const [data, setData] = useState<RegistrationData>(initialData);
  const update = (patch: Partial<RegistrationData>) =>
    setData((d) => ({ ...d, ...patch }));

  const anyMedicalYes = MEDICAL_QUESTIONS.some(
    (q) => data[q.key] === "Yes",
  );
  const needsInsurance =
    data.insuranceCoverage !== "" &&
    data.insuranceCoverage !== "Self-pay / No insurance";

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
          <TextAreaField
            label="Street Address"
            value={data.streetAddress}
            onChange={(v) => update({ streetAddress: v })}
            placeholder="Street, city, ZIP"
            required
          />
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="State"
              value={data.state}
              onChange={(v) => update({ state: v })}
              placeholder="e.g. WA"
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
        data.mobileNumber.trim() !== "" &&
        data.email.trim() !== "" &&
        data.consentVoicemail !== "" &&
        data.consentText !== "",
    },
    {
      id: "medical",
      title: "Medical Background",
      description:
        "These help our physicians prepare for your visit. Answer every question.",
      render: () => (
        <div className="grid gap-7">
          <TextField
            label="Current Primary Care Physician (name and location)"
            value={data.primaryCarePhysician}
            onChange={(v) => update({ primaryCarePhysician: v })}
            placeholder="Optional"
          />
          {MEDICAL_QUESTIONS.map((q) => (
            <YesNoField
              key={q.key}
              label={q.label}
              value={data[q.key]}
              onChange={(v) => update({ [q.key]: v } as Partial<RegistrationData>)}
              required
            />
          ))}
          <Reveal show={anyMedicalYes}>
            <TextAreaField
              label="You answered Yes above — please share details, including a general timeframe."
              value={data.mhDetails}
              onChange={(v) => update({ mhDetails: v })}
            />
          </Reveal>
        </div>
      ),
      isValid: () => MEDICAL_QUESTIONS.every((q) => data[q.key] !== ""),
    },
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
          <Reveal show={needsInsurance}>
            <div className="grid gap-6">
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
        </div>
      ),
      isValid: () =>
        data.insuranceCoverage !== "" &&
        (!needsInsurance ||
          (data.insuranceCompany.trim() !== "" &&
            data.insuranceIdNo.trim() !== "")),
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
              [data.insuranceCardFront, data.insuranceCardBack].filter(Boolean)
                .length + " uploaded"
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
