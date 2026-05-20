import { useState } from "react";
import { MultiStepForm, type FormScreen } from "@/components/MultiStepForm";
import {
  TextField,
  TextAreaField,
  SelectField,
  YesNoField,
  ChoiceField,
  MultiChoiceField,
  Reveal,
  FieldShell,
  QuestionLabel,
} from "@/components/ui/form-fields";
import { DatePicker } from "@/components/ui/DatePicker";

// DrSnip — Pre-appointment Consultation Intake. Six screens covering work &
// demographics, relationship, children, family planning, medical/personal
// considerations, and emergency contact/referral. Question content is sourced
// from the DrSnip Consultation Jotform — see DRSNIP_FORMS.md.
//
// The Jotform's repeating "Child 1–8" block is rendered here as a dynamic
// repeat driven by the children count (see PHASE_2_NOTES.md).

// ---- Reference data -------------------------------------------------------

const JOB_DEMANDS = ["Sedentary", "Light", "Moderate", "Heavy"];
const EDUCATION = [
  "High school",
  "Some college",
  "Associate degree",
  "Bachelor's degree",
  "Graduate degree",
  "Other",
];
const ETHNICITY = [
  "American Indian or Alaska Native",
  "Asian",
  "Black or African American",
  "Hispanic or Latino",
  "Native Hawaiian or Pacific Islander",
  "White",
  "Two or more races",
  "Prefer not to say",
];
const RELATIONSHIP_STATUS = [
  "Single",
  "Married",
  "Partnered",
  "Divorced",
  "Widowed",
  "Other",
];
const MARRIAGE_NUMBER = ["1st", "2nd", "3rd or more"];
const CHILD_RELATION = ["Biological", "Step", "Adopted", "Other"];
const CHILD_GENDER = ["Male", "Female", "Other"];
const BC_METHODS = [
  "None",
  "Condoms",
  "Birth control pill",
  "IUD",
  "Implant",
  "Injection",
  "Diaphragm",
  "Withdrawal",
  "Fertility awareness",
  "Other",
];
const HOW_HEARD = [
  "Google / Search",
  "Social media",
  "Friend or family",
  "Doctor referral",
  "Insurance provider",
  "Other",
];
const PARTNER_RELATIONSHIPS = ["Married", "Partnered"];

const MAX_CHILDREN = 8;

// ---- Form state ----------------------------------------------------------

type ChildRow = {
  age: string;
  relation: string;
  gender: string;
  dependent: string;
};

const emptyChild: ChildRow = {
  age: "",
  relation: "",
  gender: "",
  dependent: "",
};

type ConsultationData = {
  // Screen 1 — About You
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  occupation: string;
  employer: string;
  jobTitle: string;
  jobDemands: string;
  education: string;
  educationOther: string;
  ethnicity: string;
  // Screen 2 — Relationship
  relationshipStatus: string;
  relationshipStatusOther: string;
  partnerFirstName: string;
  partnerLastName: string;
  partnerPhone: string;
  partnerShareConsent: string;
  partnerAge: string;
  partnerOccupation: string;
  partnerEducation: string;
  yearsInRelationship: string;
  marriageNumberSelf: string;
  marriageNumberSpouse: string;
  // Screen 3 — Children
  childCount: string;
  children: ChildRow[];
  // Screen 4 — Family Planning & Birth Control
  wantMoreChildren: string;
  considerAdoption: string;
  vasectomyConsideredDuration: string;
  consideredTubal: string;
  consideredTemporaryBC: string;
  currentBC: string[];
  currentBCOther: string;
  priorBC: string[];
  // Screen 5 — Medical & Personal Considerations
  religionConflict: string;
  sexualConcerns: string;
  sexualConcernsDetails: string;
  geneticCondition: string;
  geneticConditionDetails: string;
  // Screen 6 — Emergency Contact, Referral & Notes
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelationship: string;
  howHeard: string;
  howHeardOther: string;
  referringProfessional: string;
  additionalNotes: string;
};

const initialData: ConsultationData = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  occupation: "",
  employer: "",
  jobTitle: "",
  jobDemands: "",
  education: "",
  educationOther: "",
  ethnicity: "",
  relationshipStatus: "",
  relationshipStatusOther: "",
  partnerFirstName: "",
  partnerLastName: "",
  partnerPhone: "",
  partnerShareConsent: "",
  partnerAge: "",
  partnerOccupation: "",
  partnerEducation: "",
  yearsInRelationship: "",
  marriageNumberSelf: "",
  marriageNumberSpouse: "",
  childCount: "",
  children: Array.from({ length: MAX_CHILDREN }, () => ({ ...emptyChild })),
  wantMoreChildren: "",
  considerAdoption: "",
  vasectomyConsideredDuration: "",
  consideredTubal: "",
  consideredTemporaryBC: "",
  currentBC: [],
  currentBCOther: "",
  priorBC: [],
  religionConflict: "",
  sexualConcerns: "",
  sexualConcernsDetails: "",
  geneticCondition: "",
  geneticConditionDetails: "",
  emergencyName: "",
  emergencyPhone: "",
  emergencyRelationship: "",
  howHeard: "",
  howHeardOther: "",
  referringProfessional: "",
  additionalNotes: "",
};

// patient_id is read once from the URL so consultation submissions can be
// linked to an existing patient downstream.
function readPatientId(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("patient_id") ?? "";
}

// ---- Component -----------------------------------------------------------

export default function Consultation() {
  const [data, setData] = useState<ConsultationData>(initialData);
  const update = (patch: Partial<ConsultationData>) =>
    setData((d) => ({ ...d, ...patch }));

  const updateChild = (index: number, patch: Partial<ChildRow>) =>
    setData((d) => ({
      ...d,
      children: d.children.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    }));

  const hasPartner = PARTNER_RELATIONSHIPS.includes(data.relationshipStatus);
  const childCount = Math.min(Number(data.childCount) || 0, MAX_CHILDREN);

  const screens: FormScreen[] = [
    {
      id: "about-you",
      title: "About You",
      description:
        "A bit about you and your work. Fields marked * are required.",
      render: () => (
        <div className="grid gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="First Name"
              value={data.firstName}
              onChange={(v) => update({ firstName: v })}
              required
            />
            <TextField
              label="Last Name"
              value={data.lastName}
              onChange={(v) => update({ lastName: v })}
              required
            />
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="Email"
              type="email"
              value={data.email}
              onChange={(v) => update({ email: v })}
              required
            />
            <TextField
              label="Phone Number"
              type="tel"
              value={data.phone}
              onChange={(v) => update({ phone: v })}
              required
            />
          </div>
          <FieldShell label="Date of Birth" required>
            <DatePicker
              value={data.dateOfBirth}
              onChange={(v) => update({ dateOfBirth: v })}
              placeholder="Select your date of birth"
            />
          </FieldShell>
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="Field of Work / Occupation"
              value={data.occupation}
              onChange={(v) => update({ occupation: v })}
            />
            <TextField
              label="Employer"
              value={data.employer}
              onChange={(v) => update({ employer: v })}
            />
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="Job Title"
              value={data.jobTitle}
              onChange={(v) => update({ jobTitle: v })}
            />
            <SelectField
              label="Job Demands"
              value={data.jobDemands}
              onChange={(v) => update({ jobDemands: v })}
              options={JOB_DEMANDS}
            />
          </div>
          <SelectField
            label="Education"
            value={data.education}
            onChange={(v) => update({ education: v })}
            options={EDUCATION}
          />
          <Reveal show={data.education === "Other"}>
            <TextField
              label="Please specify your education"
              value={data.educationOther}
              onChange={(v) => update({ educationOther: v })}
            />
          </Reveal>
          <SelectField
            label="Ethnicity"
            value={data.ethnicity}
            onChange={(v) => update({ ethnicity: v })}
            options={ETHNICITY}
          />
        </div>
      ),
      isValid: () =>
        data.firstName.trim() !== "" &&
        data.lastName.trim() !== "" &&
        data.email.trim() !== "" &&
        data.phone.trim() !== "" &&
        data.dateOfBirth !== "",
    },
    {
      id: "relationship",
      title: "Relationship",
      description: "Tell us about your relationship and partner, if applicable.",
      render: () => (
        <div className="grid gap-6">
          <SelectField
            label="Relationship Status"
            value={data.relationshipStatus}
            onChange={(v) => update({ relationshipStatus: v })}
            options={RELATIONSHIP_STATUS}
            required
          />
          <Reveal show={data.relationshipStatus === "Other"}>
            <TextField
              label="Please specify your relationship status"
              value={data.relationshipStatusOther}
              onChange={(v) => update({ relationshipStatusOther: v })}
            />
          </Reveal>
          <Reveal show={hasPartner}>
            <div className="grid gap-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <TextField
                  label="Partner / Spouse's First Name"
                  value={data.partnerFirstName}
                  onChange={(v) => update({ partnerFirstName: v })}
                />
                <TextField
                  label="Partner / Spouse's Last Name"
                  value={data.partnerLastName}
                  onChange={(v) => update({ partnerLastName: v })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <TextField
                  label="Partner / Spouse's Phone"
                  type="tel"
                  value={data.partnerPhone}
                  onChange={(v) => update({ partnerPhone: v })}
                />
                <TextField
                  label="Partner / Spouse's Age"
                  type="number"
                  value={data.partnerAge}
                  onChange={(v) => update({ partnerAge: v })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <TextField
                  label="Partner / Spouse's Field of Work"
                  value={data.partnerOccupation}
                  onChange={(v) => update({ partnerOccupation: v })}
                />
                <SelectField
                  label="Partner / Spouse's Education"
                  value={data.partnerEducation}
                  onChange={(v) => update({ partnerEducation: v })}
                  options={EDUCATION}
                />
              </div>
              <TextField
                label="Years in this relationship"
                type="number"
                value={data.yearsInRelationship}
                onChange={(v) => update({ yearsInRelationship: v })}
              />
              <div className="grid gap-6 sm:grid-cols-2">
                <SelectField
                  label="Which marriage is this for you?"
                  value={data.marriageNumberSelf}
                  onChange={(v) => update({ marriageNumberSelf: v })}
                  options={MARRIAGE_NUMBER}
                />
                <SelectField
                  label="Which marriage is this for your spouse?"
                  value={data.marriageNumberSpouse}
                  onChange={(v) => update({ marriageNumberSpouse: v })}
                  options={MARRIAGE_NUMBER}
                />
              </div>
              <YesNoField
                label="Do you consent to us sharing information with your partner should they contact us directly?"
                value={data.partnerShareConsent}
                onChange={(v) => update({ partnerShareConsent: v })}
              />
            </div>
          </Reveal>
        </div>
      ),
      isValid: () => data.relationshipStatus !== "",
    },
    {
      id: "children",
      title: "Children",
      description: "How many children do you have, and a little about each.",
      render: () => (
        <div className="grid gap-7">
          <SelectField
            label="How many children do you have?"
            value={data.childCount}
            onChange={(v) => update({ childCount: v })}
            options={Array.from({ length: MAX_CHILDREN + 1 }, (_, i) =>
              String(i),
            )}
            required
          />
          {Array.from({ length: childCount }, (_, i) => (
            <div
              key={i}
              className="grid gap-5 p-5 rounded-2xl border-2 border-slate-100 bg-slate-50"
            >
              <p className="text-sm font-semibold text-primary">
                Child {i + 1}
              </p>
              <div className="grid gap-5 sm:grid-cols-2">
                <TextField
                  label="Age"
                  type="number"
                  value={data.children[i].age}
                  onChange={(v) => updateChild(i, { age: v })}
                />
                <SelectField
                  label="Relation"
                  value={data.children[i].relation}
                  onChange={(v) => updateChild(i, { relation: v })}
                  options={CHILD_RELATION}
                />
                <SelectField
                  label="Gender"
                  value={data.children[i].gender}
                  onChange={(v) => updateChild(i, { gender: v })}
                  options={CHILD_GENDER}
                />
                <SelectField
                  label="Dependent?"
                  value={data.children[i].dependent}
                  onChange={(v) => updateChild(i, { dependent: v })}
                  options={["Yes", "No"]}
                />
              </div>
            </div>
          ))}
        </div>
      ),
      isValid: () => data.childCount !== "",
    },
    {
      id: "family-planning",
      title: "Family Planning",
      description: "Your family-planning history helps guide the consultation.",
      render: () => (
        <div className="grid gap-7">
          <ChoiceField
            label="Do you wish to have more children in the future?"
            value={data.wantMoreChildren}
            onChange={(v) => update({ wantMoreChildren: v })}
            options={["Yes", "No", "Unsure"]}
            columns={3}
            required
          />
          <YesNoField
            label="Would you consider adoption if you chose to have more children?"
            value={data.considerAdoption}
            onChange={(v) => update({ considerAdoption: v })}
          />
          <TextField
            label="For how long have you considered a vasectomy?"
            value={data.vasectomyConsideredDuration}
            onChange={(v) => update({ vasectomyConsideredDuration: v })}
            placeholder="e.g. about a year"
          />
        </div>
      ),
      isValid: () => data.wantMoreChildren !== "",
    },
    {
      id: "birth-control",
      title: "Birth Control",
      description: "Your birth-control history — current and prior methods.",
      render: () => (
        <div className="grid gap-7">
          <YesNoField
            label="Have you considered tubal ligation as an alternative sterilization choice?"
            value={data.consideredTubal}
            onChange={(v) => update({ consideredTubal: v })}
          />
          <YesNoField
            label="Have you considered temporary birth control methods (condoms, diaphragm, etc.)?"
            value={data.consideredTemporaryBC}
            onChange={(v) => update({ consideredTemporaryBC: v })}
          />
          <MultiChoiceField
            label="Select your current birth control methods"
            values={data.currentBC}
            onChange={(v) => update({ currentBC: v })}
            options={BC_METHODS}
          />
          <Reveal show={data.currentBC.includes("Other")}>
            <TextField
              label="Other current birth control methods"
              value={data.currentBCOther}
              onChange={(v) => update({ currentBCOther: v })}
            />
          </Reveal>
          <MultiChoiceField
            label="Select all prior methods of birth control"
            values={data.priorBC}
            onChange={(v) => update({ priorBC: v })}
            options={BC_METHODS}
          />
        </div>
      ),
      isValid: () => true,
    },
    {
      id: "considerations",
      title: "Medical & Personal Considerations",
      description: "A few personal considerations our physicians like to know.",
      render: () => (
        <div className="grid gap-7">
          <YesNoField
            label="Does a vasectomy conflict with your religion?"
            value={data.religionConflict}
            onChange={(v) => update({ religionConflict: v })}
            required
          />
          <YesNoField
            label="Do you, or does your partner, have any sexual problems or concerns?"
            value={data.sexualConcerns}
            onChange={(v) => update({ sexualConcerns: v })}
            required
          />
          <Reveal show={data.sexualConcerns === "Yes"}>
            <TextAreaField
              label="Details"
              value={data.sexualConcernsDetails}
              onChange={(v) => update({ sexualConcernsDetails: v })}
            />
          </Reveal>
          <YesNoField
            label="Are you choosing sterilization because of a genetic condition concerning you or your partner?"
            value={data.geneticCondition}
            onChange={(v) => update({ geneticCondition: v })}
            required
          />
          <Reveal show={data.geneticCondition === "Yes"}>
            <TextAreaField
              label="Details"
              value={data.geneticConditionDetails}
              onChange={(v) => update({ geneticConditionDetails: v })}
            />
          </Reveal>
        </div>
      ),
      isValid: () =>
        data.religionConflict !== "" &&
        data.sexualConcerns !== "" &&
        data.geneticCondition !== "",
    },
    {
      id: "emergency-referral",
      title: "Emergency Contact & Referral",
      description: "Almost done — an emergency contact and how you found us.",
      render: () => (
        <div className="grid gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              label="Emergency Contact Name"
              value={data.emergencyName}
              onChange={(v) => update({ emergencyName: v })}
              required
            />
            <TextField
              label="Emergency Contact Phone Number"
              type="tel"
              value={data.emergencyPhone}
              onChange={(v) => update({ emergencyPhone: v })}
              required
            />
          </div>
          <TextField
            label="Emergency Contact Relationship"
            value={data.emergencyRelationship}
            onChange={(v) => update({ emergencyRelationship: v })}
            placeholder="e.g. Spouse, Parent, Sibling"
            required
          />
          <SelectField
            label="How did you hear about DrSnip?"
            value={data.howHeard}
            onChange={(v) => update({ howHeard: v })}
            options={HOW_HEARD}
          />
          <Reveal show={data.howHeard === "Other"}>
            <TextField
              label="Please specify"
              value={data.howHeardOther}
              onChange={(v) => update({ howHeardOther: v })}
            />
          </Reveal>
          <Reveal show={data.howHeard === "Doctor referral"}>
            <TextField
              label="Referring medical professional (name and specialty)"
              value={data.referringProfessional}
              onChange={(v) => update({ referringProfessional: v })}
            />
          </Reveal>
          <TextAreaField
            label="Is there anything else you'd like to share with DrSnip before your appointment?"
            value={data.additionalNotes}
            onChange={(v) => update({ additionalNotes: v })}
          />
        </div>
      ),
      isValid: () =>
        data.emergencyName.trim() !== "" &&
        data.emergencyPhone.trim() !== "" &&
        data.emergencyRelationship.trim() !== "",
    },
  ];

  const onSubmit = async (): Promise<boolean> => {
    const payload = {
      ...data,
      // Trim the children array to the stated count for a clean payload.
      children: data.children.slice(0, childCount),
      formType: "consultation" as const,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone,
      dateOfBirth: data.dateOfBirth,
      patientId: readPatientId(),
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
      successTitle="Thank you — we've got your consultation intake."
      successMessage="Our team at DrSnip will review your responses ahead of your appointment. If we need any clarification, we'll reach out at the contact details you provided."
    />
  );
}
