import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isEmbedded } from "@/lib/embed-frame";
import { useEmbedHeight } from "@/hooks/use-embed-height";

// Shared multi-step form shell (Phase 2 — DrSnip). Drives the step index,
// per-screen validation, animated transitions, and the success screen for both
// the Registration and Consultation forms. Each form supplies its own data
// state and `screens` array (the `Screen[]` pattern carried over from CJC) and
// an `onSubmit` that performs the POST.
//
// EMBED MODE (opt-in via `embeddable`, registration only): inside an iframe the
// full-viewport shell breaks auto-height — `min-h-screen` is 100vh OF THE FRAME
// (each parent resize re-grows it) and the `fixed` footer anchors to the frame
// viewport, covering fields. So when embedded the shell drops min-h-screen,
// puts the Back/Continue bar in the document flow after the step, and posts
// its height via the insurance form's protocol (lib/embed-frame.ts). Detection
// is the insurance form's: window.parent !== window. Not embedded — or a form
// that doesn't pass `embeddable` — renders exactly as before.

export type FormScreen = {
  id: string;
  title: string;
  description?: string;
  render: () => ReactNode;
  isValid: () => boolean;
};

const DRSNIP_LOGO = "/images/drsnip-logo.png";

const variants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 50 : -50,
    opacity: 0,
    scale: 0.98,
  }),
  center: { zIndex: 1, x: 0, opacity: 1, scale: 1 },
  exit: (direction: number) => ({
    zIndex: 0,
    x: direction < 0 ? 50 : -50,
    opacity: 0,
    scale: 0.98,
  }),
};

export function MultiStepForm({
  screens,
  onSubmit,
  successTitle,
  successMessage,
  onStepChange,
  embeddable = false,
}: {
  screens: FormScreen[];
  /** true = submitted; false = generic failure; a string = an actionable
   *  message from the server to show instead of the generic one. */
  onSubmit: () => Promise<boolean | string>;
  successTitle: string;
  successMessage: string;
  /** Optional: called with the new (0-based) step index when the user ADVANCES
   *  past a valid step. Used by Registration for drop-off capture; other forms
   *  simply don't pass it. Never affects wizard flow. */
  onStepChange?: (nextIndex: number) => void;
  /** Opt in to embed mode when rendered inside an iframe (see header). */
  embeddable?: boolean;
}) {
  const [embedded] = useState(() => embeddable && isEmbedded());
  const rootRef = useRef<HTMLDivElement>(null);
  const postHeight = useEmbedHeight(rootRef, embedded);
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "success"
  >("idle");

  const total = screens.length;
  const current = screens[stepIndex];
  const isLast = stepIndex === total - 1;
  const submitting = submitState === "submitting";

  const handleNext = async () => {
    if (!current.isValid() || submitting) return;
    if (isLast) {
      setSubmitState("submitting");
      try {
        const ok = await onSubmit();
        if (ok === true) {
          setSubmitState("success");
        } else {
          setSubmitState("idle");
          toast.error(
            typeof ok === "string" && ok
              ? ok
              : "We couldn't submit your form. Please try again.",
          );
        }
      } catch {
        setSubmitState("idle");
        toast.error("We couldn't submit your form. Please try again.");
      }
      return;
    }
    setDirection(1);
    setStepIndex((i) => i + 1);
    // The current step passed validation and we're advancing — notify (used for
    // registration drop-off capture). Guarded so it never throws into the wizard.
    try {
      onStepChange?.(stepIndex + 1);
    } catch {
      /* capture must never affect the form */
    }
  };

  const handleBack = () => {
    if (stepIndex > 0) {
      setDirection(-1);
      setStepIndex((i) => i - 1);
    }
  };

  // Enter advances the current screen when it's valid (or submits on the last
  // screen) — `handleNext` already no-ops when invalid or submitting. Enter
  // inside a <textarea> is left alone (newline), and modifier+Enter is
  // reserved. The effect re-registers each render so the listener always
  // closes over the latest `current.isValid()` (which reads live form data).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.tagName === "TEXTAREA") return;
      if (submitState !== "idle") return;
      if (!current.isValid()) return;
      e.preventDefault();
      void handleNext();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Belt-and-suspenders explicit re-post on state that changes layout (the
  // ResizeObserver also catches these, including the success screen's shrink).
  useEffect(() => {
    postHeight();
  }, [stepIndex, submitState, postHeight]);

  // Embedded: one measured wrapper around the wizard AND the success screen,
  // so the observer survives the swap and reports the shrink.
  const frame = (content: ReactNode) =>
    embedded ? (
      <div ref={rootRef} data-drsnip-embed="">
        {content}
      </div>
    ) : (
      content
    );

  if (submitState === "success") {
    return frame(
      <SuccessScreen
        title={successTitle}
        message={successMessage}
        embedded={embedded}
      />,
    );
  }

  const canProceed = current.isValid() && !submitting;

  return frame(
    <div
      className={cn(
        "flex flex-col font-sans relative overflow-hidden bg-primary",
        !embedded && "min-h-screen",
      )}
    >
      <header className="relative z-10 w-full pt-6 px-6 flex justify-center">
        <img
          src={DRSNIP_LOGO}
          alt="DrSnip"
          className="h-12 sm:h-14 w-auto object-contain"
        />
      </header>

      <div className="relative z-10 w-full max-w-5xl mx-auto px-6 mt-6 mb-2 flex justify-end">
        <span className="text-sm font-medium text-white/70">
          Step {stepIndex + 1} of {total}
        </span>
      </div>

      <div className="relative z-10 w-full max-w-5xl mx-auto px-6 mb-8">
        <div className="h-1.5 w-full bg-white/20 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-white rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${((stepIndex + 1) / total) * 100}%` }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
          />
        </div>
      </div>

      <main
        className={cn(
          "relative z-10 flex-1 flex flex-col items-center px-6",
          embedded ? "pb-8" : "pb-32",
        )}
      >
        <div className="w-full max-w-3xl flex-1 flex flex-col relative pt-4 md:pt-8">
          <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 p-8 md:p-12 min-h-[340px]">
            <AnimatePresence mode="wait" custom={direction} initial={false}>
              <motion.div
                key={current.id}
                custom={direction}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="w-full"
              >
                <h2 className="text-3xl md:text-4xl font-bold text-slate-900 leading-tight mb-3">
                  {current.title}
                </h2>
                {current.description && (
                  <p className="text-base text-slate-500 mb-7 max-w-2xl">
                    {current.description}
                  </p>
                )}
                <div className={cn("w-full", !current.description && "mt-7")}>
                  {current.render()}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </main>

      <footer
        className={cn(
          "w-full z-20 bg-primary/95 backdrop-blur-xl border-t border-white/10",
          embedded ? "relative" : "fixed bottom-0 left-0",
        )}
      >
        <div className="w-full max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center">
            {stepIndex > 0 ? (
              <button
                onClick={handleBack}
                disabled={submitting}
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
                  ? "bg-white text-primary hover:bg-white/90 shadow-black/20 hover:shadow-xl hover:-translate-y-0.5"
                  : "bg-white/20 text-white/40 cursor-not-allowed shadow-none",
              )}
            >
              {submitting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  {isLast ? "Submit" : "Continue"}
                  {isLast ? (
                    <CheckCircle2 className="w-5 h-5" />
                  ) : (
                    <ArrowRight className="w-5 h-5" />
                  )}
                </>
              )}
            </button>
          </div>
        </div>
      </footer>
    </div>,
  );
}

function SuccessScreen({
  title,
  message,
  embedded = false,
}: {
  title: string;
  message: string;
  embedded?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col font-sans items-center justify-center bg-primary px-6 py-12",
        !embedded && "min-h-screen",
      )}
    >
      <div className="relative z-10 w-full max-w-2xl mx-auto">
        <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 p-10 md:p-14 text-center">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 20 }}
            className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center shadow-lg mx-auto mb-6"
          >
            <CheckCircle2 className="w-10 h-10 text-primary" />
          </motion.div>
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-3">
            {title}
          </h1>
          <p className="text-base text-slate-500 max-w-xl mx-auto leading-relaxed">
            {message}
          </p>
        </div>
      </div>
    </div>
  );
}
