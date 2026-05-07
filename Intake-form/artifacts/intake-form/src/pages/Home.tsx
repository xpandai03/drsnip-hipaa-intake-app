import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, ArrowLeft, ShieldCheck, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { RadioCard } from "@/components/ui/RadioCard";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import cjLogo from "@assets/cj-ss_1773942560897.png";

// --- Feature flags ---

const SHOW_FEEDBACK_QUESTIONS = true;

// --- Types & State ---

type FormData = {
  // Q1 ABOUT YOU
  firstName: string;
  lastName: string;
  // Q2 Contact Information
  email: string;
  phone: string;
  stateResidence: string;
  // Q3 Agency
  agency: string;
  agencyOther: string;
  // Q4 Speaker rating (feedback)
  speakerRating: string;
  // Q5 Workshop content (feedback)
  workshopContent: string;
  // Q6 Pre-retirement review (qualifying — always shown)
  preRetirementReview: string;
  // Q7 Eval comments (feedback)
  evalComments: string;
  // Q8 Years to retire
  yearsToRetire: string;
  // Q9 Age
  age: string;
  // Q10 Separating
  separating: string;
  // Q11 Marital
  maritalStatus: string;
  // Q12 Maxing TSP
  maxingTsp: string;
  tspContributionPct: string;
  // Q13 Contributing elsewhere
  externalInvestments: string;
  // Q14 TSP balance
  tspBalance: string;
  // Q15 Areas of concern
  areasOfConcern: string;
  // Source attribution (URL params, not user-facing)
  source: string;
  leadSource: string;
  surveyDetail: string;
  campaign: string;
  event: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
};

const initialData: FormData = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  stateResidence: "",
  agency: "",
  agencyOther: "",
  speakerRating: "",
  workshopContent: "",
  preRetirementReview: "",
  evalComments: "",
  yearsToRetire: "",
  age: "",
  separating: "",
  maritalStatus: "",
  maxingTsp: "",
  tspContributionPct: "",
  externalInvestments: "",
  tspBalance: "",
  areasOfConcern: "",
  source: "federal",
  leadSource: "SOFA: Webinar",
  surveyDetail: "DC SOFA",
  campaign: "",
  event: "",
  utmSource: "",
  utmMedium: "",
  utmCampaign: "",
};

const AGENCIES = [
  "Architect of the Capitol", "DC Courts", "Dept of Agriculture (USDA)", "Dept of Commerce (DOC)",
  "Dept of Defense (DOD)", "Dept of Education", "Dept of Energy", "Dept of Health & Human Services",
  "Dept of Homeland Security", "Dept of Housing & Urban Development", "Dept of Interior",
  "Dept of Justice", "Dept of Labor", "Dept of State", "Dept of Transportation", "Dept of Treasury",
  "Dept of Veterans Affairs", "EPA", "FAA", "FBI", "Federal Reserve", "GSA", "HUD", "NASA", "NIH",
  "NSA", "Social Security Admin", "US Postal Service", "Other"
];

const SOURCE_MAP: Record<string, string> = {
  fnn: "FNN: Webinar",
  internal: "Internal: Webinar",
  federal: "SOFA: Webinar",
};

// Maps the URL ?source= param to the Salesforce `Survey_Detail__c` value that
// LeadHandler.addLeadInCampaign reads to route the Lead to a Campaign.
//   "DC SOFA 3" -> FNN Marketing Campaign
//   "DC SOFA 2" -> Internal Marketing Campaign
//   "DC SOFA"   -> falls through to Federal_Agency__c lookup (agency-specific Campaign)
const SURVEY_DETAIL_MAP: Record<string, string> = {
  fnn: "DC SOFA 3",
  internal: "DC SOFA 2",
  federal: "DC SOFA",
};
const SURVEY_DETAIL_DEFAULT = "DC SOFA";

// --- Animation Variants ---

const variants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 50 : -50,
    opacity: 0,
    scale: 0.98,
  }),
  center: {
    zIndex: 1,
    x: 0,
    opacity: 1,
    scale: 1,
  },
  exit: (direction: number) => ({
    zIndex: 0,
    x: direction < 0 ? 50 : -50,
    opacity: 0,
    scale: 0.98,
  }),
};

// --- Screen type ---

type Screen = {
  id: string;
  category?: "feedback";
  title: string;
  description?: string;
  render: () => React.ReactNode;
  isValid: () => boolean;
};

// --- Main Component ---

export default function Home() {
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const [data, setData] = useState<FormData>(initialData);
  const [isClient, setIsClient] = useState(false);
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "success-yes" | "success-no"
  >("idle");

  useEffect(() => {
    setIsClient(true);
    const params = new URLSearchParams(window.location.search);
    const sourceKey = (params.get("source") ?? "").toLowerCase();
    const knownSource = sourceKey in SOURCE_MAP ? sourceKey : "federal";
    const leadSource = SOURCE_MAP[knownSource] ?? "SOFA: Webinar";
    const surveyDetail = SURVEY_DETAIL_MAP[knownSource] ?? SURVEY_DETAIL_DEFAULT;
    setData((prev) => ({
      ...prev,
      source: knownSource,
      leadSource,
      surveyDetail,
      campaign: params.get("campaign") ?? "",
      event: params.get("event") ?? "",
      utmSource: params.get("utm_source") ?? "",
      utmMedium: params.get("utm_medium") ?? "",
      utmCampaign: params.get("utm_campaign") ?? "",
    }));
  }, []);

  const updateData = (fields: Partial<FormData>) => {
    setData((prev) => ({ ...prev, ...fields }));
  };

  const allScreens: Screen[] = [
    {
      id: "about-you",
      title: "About You",
      render: () => (
        <div className="grid gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-500 ml-1">First Name</label>
              <Input
                placeholder="e.g. Jane"
                value={data.firstName}
                onChange={(e) => updateData({ firstName: e.target.value })}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-500 ml-1">Last Name</label>
              <Input
                placeholder="e.g. Doe"
                value={data.lastName}
                onChange={(e) => updateData({ lastName: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-500 ml-1">Email Address</label>
            <Input
              type="email"
              placeholder="jane.doe@example.com"
              value={data.email}
              onChange={(e) => updateData({ email: e.target.value })}
            />
          </div>
        </div>
      ),
      isValid: () =>
        data.firstName.trim() !== "" &&
        data.lastName.trim() !== "" &&
        data.email.trim() !== "",
    },
    {
      id: "contact",
      title: "Contact Details",
      render: () => (
        <div className="grid gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-500 ml-1">Phone Number</label>
              <Input
                type="tel"
                placeholder="(555) 000-0000"
                value={data.phone}
                onChange={(e) => updateData({ phone: e.target.value })}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-500 ml-1">State of Residence</label>
              <Input
                placeholder="e.g. California"
                value={data.stateResidence}
                onChange={(e) => updateData({ stateResidence: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-500 ml-1">Federal Agency</label>
            <div className="relative">
              <select
                value={data.agency}
                onChange={(e) => updateData({ agency: e.target.value })}
                className="w-full px-5 py-4 text-lg appearance-none bg-white border-2 rounded-2xl border-slate-200 focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 shadow-sm cursor-pointer text-slate-800"
              >
                <option value="" disabled>Select your agency...</option>
                {AGENCIES.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              <div className="absolute right-5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>
            <AnimatePresence>
              {data.agency === "Other" && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: "auto", marginTop: 16 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  className="space-y-2 overflow-hidden"
                >
                  <label className="text-sm font-medium text-slate-500 ml-1">Please specify your agency</label>
                  <Input
                    placeholder="Enter your agency name"
                    value={data.agencyOther}
                    onChange={(e) => updateData({ agencyOther: e.target.value })}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      ),
      isValid: () =>
        data.phone.trim() !== "" &&
        data.stateResidence.trim() !== "" &&
        data.agency !== "" &&
        (data.agency !== "Other" || data.agencyOther.trim() !== ""),
    },
    {
      id: "feedback",
      category: "feedback",
      title: "Presentation Feedback",
      render: () => (
        <div className="grid gap-8">
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">
              How would you rate the effectiveness of the speaker?
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {["Excellent", "Good", "Average", "Needs work"].map((opt) => (
                <RadioCard
                  key={opt}
                  label={opt}
                  selected={data.speakerRating === opt}
                  onClick={() => updateData({ speakerRating: opt })}
                />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">
              Was the workshop content informative?
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              {["Helpful", "Neutral", "Needs work"].map((opt) => (
                <RadioCard
                  key={opt}
                  label={opt}
                  selected={data.workshopContent === opt}
                  onClick={() => updateData({ workshopContent: opt })}
                />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">
              Any additional comments or questions?
            </label>
            <textarea
              className="w-full min-h-[120px] p-5 text-base transition-all duration-200 bg-white border-2 rounded-2xl border-slate-200 focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 placeholder:text-slate-400 shadow-sm resize-none text-slate-800"
              placeholder="Optional"
              value={data.evalComments}
              onChange={(e) => updateData({ evalComments: e.target.value })}
            />
          </div>
        </div>
      ),
      isValid: () => data.speakerRating !== "" && data.workshopContent !== "",
    },
    {
      id: "pre-retirement",
      title: "Would you like a complimentary pre-retirement review?",
      description: "Recommended for those within ten years of retirement.",
      render: () => (
        <div className="grid gap-4 sm:grid-cols-2 max-w-xl">
          {["Yes", "No"].map((opt) => (
            <RadioCard
              key={opt}
              label={opt}
              selected={data.preRetirementReview === opt}
              onClick={() => updateData({ preRetirementReview: opt })}
            />
          ))}
        </div>
      ),
      isValid: () => data.preRetirementReview !== "",
    },
    {
      id: "demographics",
      title: "Demographics",
      render: () => (
        <div className="grid gap-8">
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">What is your age?</label>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {["59 1/2 or over", "55 - 59", "50-54", "40-49", "below 40"].map((opt) => (
                <RadioCard
                  key={opt}
                  label={opt}
                  selected={data.age === opt}
                  onClick={() => updateData({ age: opt })}
                />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">Are you married?</label>
            <div className="grid gap-3 sm:grid-cols-4">
              {["Yes", "No", "DIVORCED", "WIDOWED"].map((opt) => (
                <RadioCard
                  key={opt}
                  label={opt}
                  selected={data.maritalStatus === opt}
                  onClick={() => updateData({ maritalStatus: opt })}
                />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">
              How many years until you plan to retire?
            </label>
            <Input
              type="number"
              min="0"
              placeholder="e.g. 5"
              value={data.yearsToRetire}
              onChange={(e) => updateData({ yearsToRetire: e.target.value })}
              className="text-xl py-5 max-w-xs"
            />
          </div>
        </div>
      ),
      isValid: () =>
        data.age !== "" &&
        data.maritalStatus !== "" &&
        data.yearsToRetire.trim() !== "",
    },
    {
      id: "financials",
      title: "Financials",
      render: () => (
        <div className="grid gap-8">
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">
              Which category best describes your TSP balance?
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {["Over $1 million", "$600k - $1 million", "$350k - $600k", "Under $350k"].map((opt) => (
                <RadioCard
                  key={opt}
                  label={opt}
                  selected={data.tspBalance === opt}
                  onClick={() => updateData({ tspBalance: opt })}
                />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">
              Are you maxing out your TSP/401K/403B/457 contributions?
            </label>
            <div className="grid gap-3 sm:grid-cols-2 max-w-md">
              {["YES", "NO"].map((opt) => (
                <RadioCard
                  key={opt}
                  label={opt}
                  selected={data.maxingTsp === opt}
                  onClick={() => updateData({ maxingTsp: opt })}
                />
              ))}
            </div>
            <AnimatePresence>
              {data.maxingTsp === "NO" && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: "auto", marginTop: 12 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  className="space-y-2 overflow-hidden"
                >
                  <label className="text-sm font-medium text-slate-500 ml-1">
                    If NO, what percentage are you contributing?
                  </label>
                  <div className="relative max-w-xs">
                    <Input
                      type="number"
                      placeholder="e.g. 5"
                      value={data.tspContributionPct}
                      onChange={(e) => updateData({ tspContributionPct: e.target.value })}
                      className="pr-12"
                    />
                    <span className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 font-medium">%</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">
              Are you regularly contributing money elsewhere (brokerage acct, savings, credit unions, IRA, Roth IRA etc)?
            </label>
            <div className="grid gap-3 sm:grid-cols-2 max-w-md">
              {["YES", "NO"].map((opt) => (
                <RadioCard
                  key={opt}
                  label={opt}
                  selected={data.externalInvestments === opt}
                  onClick={() => updateData({ externalInvestments: opt })}
                />
              ))}
            </div>
          </div>
        </div>
      ),
      isValid: () =>
        data.tspBalance !== "" &&
        data.maxingTsp !== "" &&
        (data.maxingTsp !== "NO" || data.tspContributionPct.trim() !== "") &&
        data.externalInvestments !== "",
    },
    {
      id: "status",
      title: "Status & Comments",
      render: () => (
        <div className="grid gap-8">
          <div className="space-y-3">
            <label className="text-base font-semibold text-slate-700">
              Are you separating from Federal service within the next two months (or are you already separated)?
            </label>
            <div className="grid gap-3 sm:grid-cols-2 max-w-md">
              {["YES", "NO"].map((opt) => (
                <RadioCard
                  key={opt}
                  label={opt}
                  selected={data.separating === opt}
                  onClick={() => updateData({ separating: opt })}
                />
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-base font-semibold text-slate-700">
              Anything else you'd like us to know?
            </label>
            <p className="text-sm text-slate-500">
              Areas of concern/focus (debt consolidation, investments, retirement, etc.)
            </p>
            <textarea
              className="w-full min-h-[150px] p-5 text-base transition-all duration-200 bg-white border-2 rounded-2xl border-slate-200 focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 placeholder:text-slate-400 shadow-sm resize-none text-slate-800 mt-2"
              placeholder="Optional"
              value={data.areasOfConcern}
              onChange={(e) => updateData({ areasOfConcern: e.target.value })}
            />
          </div>
        </div>
      ),
      isValid: () => data.separating !== "",
    },
  ];

  const screens = allScreens.filter(
    (s) => s.category !== "feedback" || SHOW_FEEDBACK_QUESTIONS,
  );

  const currentScreen = screens[stepIndex];
  const totalSteps = screens.length;
  const isLastStep = stepIndex === totalSteps - 1;
  const isPreRetirementNo =
    currentScreen?.id === "pre-retirement" && data.preRetirementReview === "No";
  const isFinalAction = isLastStep || isPreRetirementNo;

  const submit = async () => {
    setSubmitState("submitting");
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Submission failed");
      }
      setSubmitState(data.preRetirementReview === "Yes" ? "success-yes" : "success-no");
    } catch (err) {
      console.error("Form submission failed:", err);
      toast.error("We couldn't submit your form. Please try again.");
      setSubmitState("idle");
    }
  };

  const handleNext = () => {
    if (!currentScreen?.isValid()) return;
    if (isFinalAction) {
      submit();
      return;
    }
    setDirection(1);
    setStepIndex((prev) => prev + 1);
  };

  const handleBack = () => {
    if (stepIndex > 0) {
      setDirection(-1);
      setStepIndex((prev) => prev - 1);
    }
  };

  if (!isClient) return null;

  if (submitState === "success-yes" || submitState === "success-no") {
    return (
      <SuccessScreen
        variant={submitState === "success-yes" ? "yes" : "no"}
        firstName={data.firstName}
      />
    );
  }

  const isSubmitting = submitState === "submitting";
  const canProceed = currentScreen.isValid() && !isSubmitting;

  return (
    <div
      className="min-h-screen flex flex-col font-sans relative overflow-hidden"
      style={{ background: "linear-gradient(135deg, #8B1A1A 0%, #A82020 40%, #C0282B 100%)" }}
    >
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-white/5" />
        <div className="absolute top-1/3 -left-24 w-64 h-64 rounded-full bg-white/4" />
        <div className="absolute bottom-0 right-1/4 w-80 h-80 rounded-full bg-black/10" />
        <div className="absolute top-1/2 right-0 w-48 h-96 bg-white/3 rounded-l-full" />
      </div>

      <header className="relative z-10 w-full max-w-5xl mx-auto px-6 py-6 flex items-center justify-between">
        <div className="flex items-center">
          <img
            src={cjLogo}
            alt="CJ Wealth Management"
            className="h-14 w-auto object-contain rounded-lg"
          />
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-white/70">
          <span>Step {stepIndex + 1} of {totalSteps}</span>
        </div>
      </header>

      <div className="relative z-10 w-full max-w-5xl mx-auto px-6 mb-8">
        <div className="h-1.5 w-full bg-white/20 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-white rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${((stepIndex + 1) / totalSteps) * 100}%` }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
          />
        </div>
      </div>

      <main className="relative z-10 flex-1 flex flex-col items-center px-6 pb-32">
        <div className="w-full max-w-3xl flex-1 flex flex-col relative pt-4 md:pt-8">
          <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 p-8 md:p-12 min-h-[340px]">
            <AnimatePresence mode="wait" custom={direction} initial={false}>
              <motion.div
                key={currentScreen.id}
                custom={direction}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="w-full"
              >
                <StepContainer
                  title={currentScreen.title}
                  description={currentScreen.description}
                >
                  {currentScreen.render()}
                </StepContainer>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </main>

      <footer
        className="fixed bottom-0 left-0 w-full z-20 backdrop-blur-xl border-t border-white/10"
        style={{ background: "rgba(120, 20, 20, 0.85)" }}
      >
        <div className="w-full max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center">
            {stepIndex > 0 ? (
              <button
                onClick={handleBack}
                disabled={isSubmitting}
                className="flex items-center gap-2 px-4 py-3 text-white/80 font-semibold rounded-xl hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowLeft className="w-5 h-5" />
                Back
              </button>
            ) : (
              <div />
            )}
          </div>

          <div className="flex items-center gap-6">
            <div className="hidden sm:flex items-center gap-2 text-sm text-white/60 font-medium">
              <ShieldCheck className="w-4 h-4 text-white/70" />
              Private &amp; Confidential
            </div>
            <button
              onClick={handleNext}
              disabled={!canProceed}
              className={cn(
                "flex items-center gap-2 px-8 py-3.5 font-semibold rounded-xl shadow-lg transition-all duration-300",
                canProceed
                  ? "bg-white text-[#A82020] hover:bg-white/90 shadow-black/20 hover:shadow-xl hover:-translate-y-0.5"
                  : "bg-white/20 text-white/40 cursor-not-allowed shadow-none",
              )}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  {isFinalAction ? "Submit" : "Continue"}
                  {isFinalAction ? <CheckCircle2 className="w-5 h-5" /> : <ArrowRight className="w-5 h-5" />}
                </>
              )}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

// --- Helpers ---

function StepContainer({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full">
      <h2 className="text-3xl md:text-4xl lg:text-4xl font-bold text-slate-900 leading-tight mb-3">
        {title}
      </h2>
      {description && (
        <p className="text-base text-slate-500 mb-7 max-w-2xl">{description}</p>
      )}
      <div className={cn("w-full", !description && "mt-7")}>{children}</div>
    </div>
  );
}

function SuccessScreen({
  variant,
  firstName,
}: {
  variant: "yes" | "no";
  firstName: string;
}) {
  const headline =
    variant === "yes"
      ? "Thanks — we'll be in touch shortly"
      : "Thanks for attending — we appreciate your time";
  const subhead =
    variant === "yes"
      ? "A member of the CJC team will reach out within 24 hours to schedule your consultation."
      : "Feel free to reach out anytime if your situation changes.";

  return (
    <div
      className="min-h-screen flex flex-col font-sans relative overflow-hidden items-center justify-center"
      style={{ background: "linear-gradient(135deg, #8B1A1A 0%, #A82020 40%, #C0282B 100%)" }}
    >
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-white/5" />
        <div className="absolute top-1/3 -left-24 w-64 h-64 rounded-full bg-white/4" />
        <div className="absolute bottom-0 right-1/4 w-80 h-80 rounded-full bg-black/10" />
      </div>
      <div className="relative z-10 w-full max-w-3xl mx-auto px-6 py-12">
        <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 p-10 md:p-14 text-center">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 20 }}
            className="w-20 h-20 rounded-2xl bg-red-100 flex items-center justify-center shadow-lg mx-auto mb-6"
          >
            <CheckCircle2 className="w-10 h-10 text-[#A82020]" />
          </motion.div>
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-3">
            {headline}
            {firstName ? `, ${firstName}` : ""}.
          </h1>
          <p className="text-base text-slate-500 max-w-xl mx-auto leading-relaxed">
            {subhead}
          </p>
        </div>
      </div>
    </div>
  );
}
