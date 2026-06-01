import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { RadioCard } from "@/components/ui/RadioCard";
import { cn } from "@/lib/utils";
import { formatPhone } from "@/lib/phone";

// Shared form-field kit (Phase 2 — DrSnip). Thin, labelled compositions of the
// existing Input / RadioCard / native controls so the Registration and
// Consultation forms stay readable and consistent. No new visual patterns —
// just the existing ones, wrapped.

// ---- Labelled shell for line inputs --------------------------------------

export function FieldShell({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-500 ml-1">
        {label}
        {required && <span className="text-primary"> *</span>}
      </label>
      {hint && <p className="text-xs text-slate-400 ml-1 -mt-1">{hint}</p>}
      {children}
    </div>
  );
}

/** Larger label for question-style fields (yes/no, choice grids). */
export function QuestionLabel({
  children,
  required,
}: {
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block text-base font-semibold text-slate-700">
      {children}
      {required && <span className="text-primary"> *</span>}
    </label>
  );
}

// ---- Text / email / tel / number -----------------------------------------

export function TextField({
  label,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
  hint,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: "text" | "email" | "tel" | "number";
  placeholder?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <FieldShell label={label} required={required} hint={hint}>
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        // Phone fields auto-format live to (xxx) xxx-xxxx; the formatter is
        // idempotent so pasting an already-formatted/partial number is safe.
        onChange={(e) =>
          onChange(type === "tel" ? formatPhone(e.target.value) : e.target.value)
        }
      />
    </FieldShell>
  );
}

// ---- Textarea ------------------------------------------------------------

export function TextAreaField({
  label,
  value,
  onChange,
  required,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <FieldShell label={label} required={required} hint={hint}>
      <textarea
        className="w-full min-h-[120px] p-5 text-base transition-all duration-200 bg-white border-2 rounded-2xl border-slate-200 focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 placeholder:text-slate-400 shadow-sm resize-none text-slate-800"
        // Optional fields get a neutral empty placeholder (no "(Optional)"
        // label treatment) — required-ness is signalled by the "*" alone.
        placeholder={placeholder ?? ""}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}

// ---- Native select -------------------------------------------------------

export function SelectField({
  label,
  value,
  onChange,
  options,
  required,
  placeholder = "Select…",
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <FieldShell label={label} required={required} hint={hint}>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-5 py-4 text-lg appearance-none bg-white border-2 rounded-2xl border-slate-200 focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 shadow-sm cursor-pointer text-slate-800"
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <div className="absolute right-5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </div>
    </FieldShell>
  );
}

// ---- Yes / No ------------------------------------------------------------

export function YesNoField({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div className="space-y-3">
      <QuestionLabel required={required}>{label}</QuestionLabel>
      <div className="grid gap-3 sm:grid-cols-2 max-w-md">
        {["Yes", "No"].map((opt) => (
          <RadioCard
            key={opt}
            label={opt}
            selected={value === opt}
            onClick={() => onChange(opt)}
          />
        ))}
      </div>
    </div>
  );
}

// ---- Single-select choice grid -------------------------------------------

export function ChoiceField({
  label,
  value,
  onChange,
  options,
  required,
  columns = 2,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  required?: boolean;
  columns?: 1 | 2 | 3;
}) {
  const colClass =
    columns === 1
      ? "sm:grid-cols-1"
      : columns === 3
        ? "sm:grid-cols-3"
        : "sm:grid-cols-2";
  return (
    <div className="space-y-3">
      <QuestionLabel required={required}>{label}</QuestionLabel>
      <div className={cn("grid gap-3", colClass)}>
        {options.map((opt) => (
          <RadioCard
            key={opt}
            label={opt}
            selected={value === opt}
            onClick={() => onChange(opt)}
          />
        ))}
      </div>
    </div>
  );
}

// ---- Multi-select toggle chips -------------------------------------------

export function MultiChoiceField({
  label,
  values,
  onChange,
  options,
  hint,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  options: string[];
  hint?: string;
}) {
  const toggle = (opt: string) => {
    onChange(
      values.includes(opt)
        ? values.filter((v) => v !== opt)
        : [...values, opt],
    );
  };
  return (
    <div className="space-y-3">
      <QuestionLabel>{label}</QuestionLabel>
      {hint && <p className="text-xs text-slate-400 ml-1 -mt-1">{hint}</p>}
      <div className="flex flex-wrap gap-2.5">
        {options.map((opt) => {
          const on = values.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-colors",
                on
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-slate-200 bg-white text-slate-700 hover:border-primary/40",
              )}
            >
              {on && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Conditional reveal --------------------------------------------------

/** AnimatePresence height reveal — the inline-reveal pattern carried from CJC. */
export function Reveal({
  show,
  children,
}: {
  show: boolean;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, height: 0, marginTop: 0 }}
          animate={{ opacity: 1, height: "auto", marginTop: 16 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          className="space-y-4 overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
