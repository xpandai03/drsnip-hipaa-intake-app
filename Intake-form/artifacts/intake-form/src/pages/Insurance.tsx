import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  CheckCircle2,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { TextField, SelectField, FieldShell } from "@/components/ui/form-fields";
import { DatePicker } from "@/components/ui/DatePicker";
import { FileUploadStub, type StubFileRef } from "@/components/ui/FileUploadStub";
import { cn } from "@/lib/utils";
import { postConversion } from "@/lib/conversion";

// ===========================================================================
// DrSnip — native Insurance form (Phase 1: form + route + embed + DB storage).
//
// This route is an EMBEDDABLE WIDGET: it renders inside an <iframe> on the
// WordPress marketing site (drsnip.com/cost-insurance/), replacing the current
// third-party Jotform (232897179531165). See insurance-form-recon-2026-07-25.md
// for the field parity table (§2), embed design (§5), and brand tokens (§5).
//
// PHASE BOUNDARIES (deliberate):
//   • Phase 1 (this): two-step form, marketing-brand theme, iframe auto-height,
//     DB-first storage via POST /api/submit with formType 'insurance'. The n8n
//     bridge is NOT wired — api/submit.ts short-circuits 'insurance' to a
//     'not_applicable' status by construction (there is no insurance workflow).
//   • Phase 2 (separate scope): n8n workflow, DrChrono attach, notifications,
//     PDF, reporting/admin polish, conversion tracking.
//
// This shell is intentionally NOT the app's MultiStepForm: that component is a
// full-viewport shell (min-h-screen + a fixed bottom footer) which breaks
// iframe auto-height (100vh feedback loop; a fixed footer detaches on resize).
// We reuse every FIELD PRIMITIVE (TextField/SelectField/DatePicker/
// FileUploadStub/FieldShell) and the {id,title,render,isValid} screen pattern,
// and swap only the viewport shell for a content-height-driven one.
// ===========================================================================

// --- Brand tokens (marketing site, from recon §5) --------------------------
// Scoped to THIS route only via a CSS-var override on the root wrapper, so the
// app's admin theme (--primary #0F4C81) never leaks in and this never leaks out.
// #5B89B4 ≈ hsl(209 37% 53%); Tailwind's `primary` utilities read hsl(var(--primary)).
const BRAND_PRIMARY_HSL = "209 37% 53%"; // #5B89B4
const BRAND_ACCENT = "#F9B050"; // CTA orange
const BRAND_ACCENT_HOVER = "#EFA143";
const BRAND_BG = "#FAFAFA";
const POPPINS_HREF =
  "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap";

// --- Embed height protocol (recon §5) --------------------------------------
// Origin-locked BOTH directions: the parent snippet checks e.origin ===
// intake.drsnip.com before applying; here we post to explicit parent origins
// only (never '*'). The browser silently drops messages whose targetOrigin
// doesn't match the real parent, so looping the allowlist is safe + locked.
const ALLOWED_PARENT_ORIGINS = [
  "https://drsnip.com",
  "https://www.drsnip.com",
  ...(import.meta.env.DEV
    ? ["http://localhost:5173", "http://localhost:4173"]
    : []),
];
const HEIGHT_MESSAGE_TYPE = "drsnip:height";

// --- Field option sets -----------------------------------------------------
// Office: the insurance form offers only Portland/Seattle (recon §2), but we use
// the registration pipeline's exact string format so officeLocation maps cleanly
// in Phase 2 (registration uses "Seattle, WA" / "Portland, OR" / "Plano, TX").
const OFFICE_LOCATIONS = ["Seattle, WA", "Portland, OR"];
// DEVIATION (noted in PR): registration collects no Sex field to copy wording
// from, so we define a standard DrChrono-compatible set. Required per the brief
// for future profile creation.
const SEX_OPTIONS = ["Male", "Female", "Other"];
const RELATIONSHIP_OPTIONS = ["Self", "Spouse", "Child", "Parent", "Other"];

type FileKey =
  | "insuranceCardFront"
  | "insuranceCardBack"
  | "partnerInsuranceCardFront"
  | "partnerInsuranceCardBack";

type InsuranceData = {
  // Step 1 — contact / patient
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  sex: string;
  officeLocation: string;
  streetAddress: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  // Step 2 — primary insurance (required)
  primaryCarrier: string;
  primarySubscriberFirst: string;
  primarySubscriberLast: string;
  primaryPolicyNo: string;
  primaryGroupNo: string;
  primarySubscriberDob: string;
  primaryRelationship: string;
  // Step 2 — secondary insurance (optional)
  hasSecondary: boolean;
  secondaryCarrier: string;
  secondarySubscriberFirst: string;
  secondarySubscriberLast: string;
  secondaryPolicyNo: string;
  secondaryGroupNo: string;
  secondarySubscriberDob: string;
  secondaryRelationship: string;
  // Card images. Keys reuse the FOUR names api/submit.ts already strips base64
  // from (sanitizeForPersistence) so no card bytes ever land in raw_payload and
  // no third backend change is needed: primary → insuranceCard*, secondary →
  // partnerInsuranceCard*.
  insuranceCardFront: StubFileRef | null;
  insuranceCardBack: StubFileRef | null;
  partnerInsuranceCardFront: StubFileRef | null;
  partnerInsuranceCardBack: StubFileRef | null;
};

const initialData: InsuranceData = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  sex: "",
  officeLocation: "",
  streetAddress: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  primaryCarrier: "",
  primarySubscriberFirst: "",
  primarySubscriberLast: "",
  primaryPolicyNo: "",
  primaryGroupNo: "",
  primarySubscriberDob: "",
  primaryRelationship: "",
  hasSecondary: false,
  secondaryCarrier: "",
  secondarySubscriberFirst: "",
  secondarySubscriberLast: "",
  secondaryPolicyNo: "",
  secondaryGroupNo: "",
  secondarySubscriberDob: "",
  secondaryRelationship: "",
  insuranceCardFront: null,
  insuranceCardBack: null,
  partnerInsuranceCardFront: null,
  partnerInsuranceCardBack: null,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readSourceParam(): string {
  if (typeof window === "undefined") return "";
  const s = new URLSearchParams(window.location.search).get("source");
  return (s ?? "").slice(0, 120);
}

export default function Insurance() {
  const [data, setData] = useState<InsuranceData>(initialData);
  const [stepIndex, setStepIndex] = useState(0);
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "success"
  >("idle");
  const [showErrors, setShowErrors] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const source = useMemo(readSourceParam, []);

  const update = (patch: Partial<InsuranceData>) =>
    setData((d) => ({ ...d, ...patch }));
  const setFile = (key: FileKey, f: StubFileRef | null) =>
    update({ [key]: f } as Partial<InsuranceData>);

  // --- Poppins, loaded via the route (not a global import) -----------------
  useEffect(() => {
    if (document.querySelector('link[data-drsnip-insurance-font="1"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = POPPINS_HREF;
    link.setAttribute("data-drsnip-insurance-font", "1");
    document.head.appendChild(link);
  }, []);

  // --- Auto-height: post the content height to the parent iframe ----------
  const postHeight = useCallback(() => {
    if (typeof window === "undefined" || window.parent === window) return;
    const h = Math.ceil(
      rootRef.current?.getBoundingClientRect().height ??
        document.body.scrollHeight,
    );
    for (const origin of ALLOWED_PARENT_ORIGINS) {
      try {
        window.parent.postMessage({ type: HEIGHT_MESSAGE_TYPE, height: h }, origin);
      } catch {
        /* targetOrigin mismatch — browser drops it; expected for non-parents */
      }
    }
  }, []);

  // Fire on mount, and whenever the rendered size changes (step change, error
  // reveal, file add/remove, secondary expand — all change the root's height).
  useEffect(() => {
    postHeight();
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => postHeight());
    ro.observe(el);
    return () => ro.disconnect();
  }, [postHeight]);
  // Belt-and-suspenders explicit re-post on state that changes layout.
  useEffect(() => {
    postHeight();
  }, [stepIndex, submitState, showErrors, data.hasSecondary, postHeight]);

  // --- Validation ----------------------------------------------------------
  const step1Valid = useMemo(() => {
    return (
      data.firstName.trim() !== "" &&
      data.lastName.trim() !== "" &&
      EMAIL_RE.test(data.email.trim()) &&
      data.phone.trim() !== "" &&
      data.dateOfBirth !== "" && // DEVIATION: required (DrChrono matching needs it)
      data.sex !== "" &&
      data.officeLocation !== "" &&
      data.streetAddress.trim() !== "" &&
      data.city.trim() !== "" &&
      data.state.trim() !== "" &&
      data.postalCode.trim() !== ""
    );
  }, [data]);

  const step2Valid = useMemo(() => {
    return (
      data.primaryCarrier.trim() !== "" &&
      data.primarySubscriberFirst.trim() !== "" &&
      data.primarySubscriberLast.trim() !== "" &&
      data.primaryPolicyNo.trim() !== "" &&
      data.primaryGroupNo.trim() !== "" &&
      data.primaryRelationship !== ""
    );
    // Secondary block is entirely optional (recon §2); card upload is optional
    // (the Jotform did not require it).
  }, [data]);

  const steps = [
    { id: "contact", title: "Your details", valid: step1Valid },
    { id: "insurance", title: "Insurance information", valid: step2Valid },
  ];
  const total = steps.length;
  const isLast = stepIndex === total - 1;
  const current = steps[stepIndex];
  const submitting = submitState === "submitting";

  // --- Submit --------------------------------------------------------------
  const onSubmit = async (): Promise<boolean> => {
    const payload = {
      formType: "insurance" as const,
      // Required by the /api/submit zod schema:
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      email: data.email.trim(),
      phone: data.phone.trim(),
      dateOfBirth: data.dateOfBirth,
      // Passthrough → raw_payload (Phase 2 pipeline reads these):
      sex: data.sex,
      officeLocation: data.officeLocation,
      stateResidence: data.state.trim(),
      streetAddress: data.streetAddress.trim(),
      addressLine2: data.addressLine2.trim(),
      city: data.city.trim(),
      state: data.state.trim(),
      postalCode: data.postalCode.trim(),
      source,
      insurance: {
        primary: {
          carrier: data.primaryCarrier.trim(),
          subscriberName: {
            first: data.primarySubscriberFirst.trim(),
            last: data.primarySubscriberLast.trim(),
          },
          policyNo: data.primaryPolicyNo.trim(),
          groupNo: data.primaryGroupNo.trim(),
          subscriberDob: data.primarySubscriberDob,
          relationship: data.primaryRelationship,
        },
        secondary: data.hasSecondary
          ? {
              carrier: data.secondaryCarrier.trim(),
              subscriberName: {
                first: data.secondarySubscriberFirst.trim(),
                last: data.secondarySubscriberLast.trim(),
              },
              policyNo: data.secondaryPolicyNo.trim(),
              groupNo: data.secondaryGroupNo.trim(),
              subscriberDob: data.secondarySubscriberDob,
              relationship: data.secondaryRelationship,
            }
          : null,
      },
      // Card bytes — top-level keys so api/submit.ts strips base64 before
      // persistence (metadata stays in raw_payload; bytes ride to Phase 2 storage,
      // and today are simply dropped since the bridge is skipped).
      insuranceCardFront: data.insuranceCardFront,
      insuranceCardBack: data.insuranceCardBack,
      partnerInsuranceCardFront: data.partnerInsuranceCardFront,
      partnerInsuranceCardBack: data.partnerInsuranceCardBack,
    };
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const handleNext = async () => {
    if (!current.valid) {
      setShowErrors(true);
      toast.error("Please complete the required fields marked with *.");
      return;
    }
    setShowErrors(false);
    if (isLast) {
      setSubmitState("submitting");
      const ok = await onSubmit();
      if (ok) {
        // Dormant conversion signal (Phase 2): inert unless
        // VITE_CONVERSION_TRACKING_ENABLED is on AND we're embedded. Emits only
        // a PII-free { event, form_type } postMessage to the parent site — no
        // third-party script ever runs here.
        postConversion("insurance");
        setSubmitState("success");
      } else {
        setSubmitState("idle");
        toast.error("We couldn't submit your form. Please try again.");
      }
      return;
    }
    setStepIndex((i) => Math.min(i + 1, total - 1));
  };

  const handleBack = () => {
    setShowErrors(false);
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  // --- Scoped theme wrapper ------------------------------------------------
  const themeStyle = {
    // Override the app's --primary ONLY within this subtree.
    ["--primary" as string]: BRAND_PRIMARY_HSL,
    ["--primary-foreground" as string]: "0 0% 100%",
    fontFamily: "'Poppins', ui-sans-serif, system-ui, sans-serif",
    backgroundColor: BRAND_BG,
  } as React.CSSProperties;

  return (
    <div ref={rootRef} style={themeStyle} className="w-full min-w-0 text-slate-800">
      <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-6 sm:py-8">
        {submitState === "success" ? (
          <SuccessCard />
        ) : (
          <div className="rounded-3xl bg-white shadow-xl shadow-black/5 ring-1 ring-slate-100 p-5 sm:p-8">
            {/* Header + progress */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h1 className="text-xl sm:text-2xl font-semibold text-slate-900">
                  {current.title}
                </h1>
                <span className="text-xs font-medium text-slate-400 shrink-0 ml-3">
                  Step {stepIndex + 1} of {total}
                </span>
              </div>
              <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${((stepIndex + 1) / total) * 100}%`,
                    backgroundColor: `hsl(${BRAND_PRIMARY_HSL})`,
                  }}
                />
              </div>
            </div>

            {stepIndex === 0 ? (
              <ContactStep data={data} update={update} showErrors={showErrors} />
            ) : (
              <InsuranceStep
                data={data}
                update={update}
                setFile={setFile}
                showErrors={showErrors}
              />
            )}

            {/* Nav (inline, not fixed — flows with content for auto-height) */}
            <div className="mt-8 flex items-center justify-between gap-4">
              {stepIndex > 0 ? (
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors disabled:opacity-40"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
              ) : (
                <span className="inline-flex items-center gap-2 text-xs text-slate-400">
                  <ShieldCheck className="w-4 h-4" />
                  Private &amp; secure
                </span>
              )}

              <button
                type="button"
                onClick={() => void handleNext()}
                disabled={submitting}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white shadow-sm transition-colors disabled:opacity-60"
                style={{ backgroundColor: BRAND_ACCENT }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor = BRAND_ACCENT_HOVER)
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = BRAND_ACCENT)
                }
                data-testid="insurance-next"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Submitting…
                  </>
                ) : isLast ? (
                  "Submit"
                ) : (
                  <>
                    Continue
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — contact / patient
// ---------------------------------------------------------------------------
function ContactStep({
  data,
  update,
  showErrors,
}: {
  data: InsuranceData;
  update: (p: Partial<InsuranceData>) => void;
  showErrors: boolean;
}) {
  return (
    <div className="grid gap-5">
      <p className="text-sm text-slate-500 -mt-2">
        Fields marked <span style={{ color: `hsl(${BRAND_PRIMARY_HSL})` }}>*</span>{" "}
        are required.
      </p>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="First Name"
          value={data.firstName}
          onChange={(v) => update({ firstName: v })}
          placeholder="e.g. James"
          required
        />
        <TextField
          label="Last Name"
          value={data.lastName}
          onChange={(v) => update({ lastName: v })}
          placeholder="e.g. Carter"
          required
        />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Email"
          type="email"
          value={data.email}
          onChange={(v) => update({ email: v })}
          placeholder="you@example.com"
          required
        />
        <TextField
          label="Phone Number"
          type="tel"
          value={data.phone}
          onChange={(v) => update({ phone: v })}
          placeholder="(000) 000-0000"
          required
        />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <FieldShell label="Date of Birth" required>
          <DatePicker
            value={data.dateOfBirth}
            onChange={(v) => update({ dateOfBirth: v })}
            placeholder="Select your date of birth"
          />
        </FieldShell>
        <SelectField
          label="Sex"
          value={data.sex}
          onChange={(v) => update({ sex: v })}
          options={SEX_OPTIONS}
          required
        />
      </div>
      <SelectField
        label="Preferred Clinic"
        value={data.officeLocation}
        onChange={(v) => update({ officeLocation: v })}
        options={OFFICE_LOCATIONS}
        required
      />
      <TextField
        label="Street Address"
        value={data.streetAddress}
        onChange={(v) => update({ streetAddress: v })}
        placeholder="123 Main St"
        required
      />
      <TextField
        label="Apt / Suite / Unit (optional)"
        value={data.addressLine2}
        onChange={(v) => update({ addressLine2: v })}
        placeholder="Apt 4B"
      />
      <div className="grid gap-5 sm:grid-cols-3">
        <TextField
          label="City"
          value={data.city}
          onChange={(v) => update({ city: v })}
          required
        />
        <TextField
          label="State"
          value={data.state}
          onChange={(v) => update({ state: v })}
          placeholder="WA"
          required
        />
        <TextField
          label="ZIP"
          value={data.postalCode}
          onChange={(v) => update({ postalCode: v })}
          placeholder="98101"
          required
        />
      </div>
      {showErrors && (
        <p className="text-sm text-rose-600">
          Please complete all required fields before continuing.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — insurance details + card uploads
// ---------------------------------------------------------------------------
function InsuranceStep({
  data,
  update,
  setFile,
  showErrors,
}: {
  data: InsuranceData;
  update: (p: Partial<InsuranceData>) => void;
  setFile: (key: FileKey, f: StubFileRef | null) => void;
  showErrors: boolean;
}) {
  return (
    <div className="grid gap-6">
      <p className="text-sm text-slate-500 -mt-2">
        Enter your primary insurance. A photo of the front and back of your card
        helps us verify benefits faster.
      </p>

      {/* Primary insurance */}
      <fieldset className="grid gap-5 rounded-2xl border border-slate-100 p-4 sm:p-5">
        <legend className="px-2 text-sm font-semibold text-slate-700">
          Primary insurance
        </legend>
        <TextField
          label="Insurance Company"
          value={data.primaryCarrier}
          onChange={(v) => update({ primaryCarrier: v })}
          placeholder="e.g. Blue Cross Blue Shield"
          required
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Subscriber First Name"
            value={data.primarySubscriberFirst}
            onChange={(v) => update({ primarySubscriberFirst: v })}
            required
          />
          <TextField
            label="Subscriber Last Name"
            value={data.primarySubscriberLast}
            onChange={(v) => update({ primarySubscriberLast: v })}
            required
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Policy / Member No."
            value={data.primaryPolicyNo}
            onChange={(v) => update({ primaryPolicyNo: v })}
            required
          />
          <TextField
            label="Group No."
            value={data.primaryGroupNo}
            onChange={(v) => update({ primaryGroupNo: v })}
            required
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <FieldShell label="Subscriber's Date of Birth">
            <DatePicker
              value={data.primarySubscriberDob}
              onChange={(v) => update({ primarySubscriberDob: v })}
              placeholder="Subscriber DOB"
            />
          </FieldShell>
          <SelectField
            label="Relationship to Patient"
            value={data.primaryRelationship}
            onChange={(v) => update({ primaryRelationship: v })}
            options={RELATIONSHIP_OPTIONS}
            required
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <FileUploadStub
            label="Card — front"
            value={data.insuranceCardFront}
            onChange={(f) => setFile("insuranceCardFront", f)}
          />
          <FileUploadStub
            label="Card — back"
            value={data.insuranceCardBack}
            onChange={(f) => setFile("insuranceCardBack", f)}
          />
        </div>
      </fieldset>

      {/* Secondary insurance — optional, collapsible */}
      {!data.hasSecondary ? (
        <button
          type="button"
          onClick={() => update({ hasSecondary: true })}
          className="inline-flex items-center gap-2 text-sm font-medium self-start rounded-xl border-2 border-dashed border-slate-200 px-4 py-3 text-slate-600 hover:border-slate-300 transition-colors"
        >
          <ChevronDown className="w-4 h-4" />
          Add secondary insurance (optional)
        </button>
      ) : (
        <fieldset className="grid gap-5 rounded-2xl border border-slate-100 p-4 sm:p-5">
          <legend className="px-2 text-sm font-semibold text-slate-700">
            Secondary insurance (optional)
          </legend>
          <TextField
            label="Insurance Company"
            value={data.secondaryCarrier}
            onChange={(v) => update({ secondaryCarrier: v })}
            placeholder="e.g. Aetna"
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="Subscriber First Name"
              value={data.secondarySubscriberFirst}
              onChange={(v) => update({ secondarySubscriberFirst: v })}
            />
            <TextField
              label="Subscriber Last Name"
              value={data.secondarySubscriberLast}
              onChange={(v) => update({ secondarySubscriberLast: v })}
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="Policy / Member No."
              value={data.secondaryPolicyNo}
              onChange={(v) => update({ secondaryPolicyNo: v })}
            />
            <TextField
              label="Group No."
              value={data.secondaryGroupNo}
              onChange={(v) => update({ secondaryGroupNo: v })}
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <FieldShell label="Subscriber's Date of Birth">
              <DatePicker
                value={data.secondarySubscriberDob}
                onChange={(v) => update({ secondarySubscriberDob: v })}
                placeholder="Subscriber DOB"
              />
            </FieldShell>
            <SelectField
              label="Relationship to Patient"
              value={data.secondaryRelationship}
              onChange={(v) => update({ secondaryRelationship: v })}
              options={RELATIONSHIP_OPTIONS}
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <FileUploadStub
              label="Card — front"
              value={data.partnerInsuranceCardFront}
              onChange={(f) => setFile("partnerInsuranceCardFront", f)}
            />
            <FileUploadStub
              label="Card — back"
              value={data.partnerInsuranceCardBack}
              onChange={(f) => setFile("partnerInsuranceCardBack", f)}
            />
          </div>
          <button
            type="button"
            onClick={() =>
              update({
                hasSecondary: false,
                secondaryCarrier: "",
                secondarySubscriberFirst: "",
                secondarySubscriberLast: "",
                secondaryPolicyNo: "",
                secondaryGroupNo: "",
                secondarySubscriberDob: "",
                secondaryRelationship: "",
                partnerInsuranceCardFront: null,
                partnerInsuranceCardBack: null,
              })
            }
            className="text-xs text-slate-400 hover:text-slate-600 self-start"
          >
            Remove secondary insurance
          </button>
        </fieldset>
      )}

      {showErrors && (
        <p className="text-sm text-rose-600">
          Please complete the required primary-insurance fields before
          submitting.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-place success (no redirect — matches the widget pattern)
// ---------------------------------------------------------------------------
function SuccessCard() {
  return (
    <div className="rounded-3xl bg-white shadow-xl shadow-black/5 ring-1 ring-slate-100 p-8 sm:p-12 text-center">
      <div
        className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full"
        style={{ backgroundColor: `hsl(${BRAND_PRIMARY_HSL} / 0.1)` }}
      >
        <CheckCircle2
          className="h-9 w-9"
          style={{ color: `hsl(${BRAND_PRIMARY_HSL})` }}
        />
      </div>
      <h2 className="text-2xl font-semibold text-slate-900 mb-3">
        Thank you — we've got your insurance details
      </h2>
      <p className="text-slate-600 max-w-md mx-auto leading-relaxed">
        Our team will run your insurance and reach out with an estimate of your
        costs. If we need anything else, we'll be in touch at the email or phone
        number you provided.
      </p>
    </div>
  );
}
