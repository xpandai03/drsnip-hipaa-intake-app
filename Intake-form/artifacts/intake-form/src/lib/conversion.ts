// Dormant client-side conversion hook (Phase 2). On a genuine submission
// success in an embedded/iframe context, postMessage a minimal, PII-FREE event
// to the parent window so the marketing site (never the intake app) can forward
// it to the agency. Ships OFF: no message fires unless VITE_CONVERSION_TRACKING_ENABLED
// is exactly "true" at build time.
//
// HARD RULES:
//   • No third-party script ever runs in the intake app. This only emits a
//     postMessage; the parent decides what to do with it.
//   • Payload whitelist is EXACTLY { event, form_type }. No cookies, no URL, no
//     name/email/phone/DOB/patient reference — nothing else.
//   • Origin-locked: posts only to known parent origins, never "*".

export const CONVERSION_EVENT = "intake_conversion";

const ALLOWED_PARENT_ORIGINS = [
  "https://drsnip.com",
  "https://www.drsnip.com",
];

/**
 * Build-state marker. Vite inlines the flag, so exactly ONE of these two
 * literals survives in the production bundle. The Docker build runs
 * scripts/assert-conversion-bundle.mjs, which fails the image (and so the
 * deploy) unless the ENABLED literal is present — a plain `fly deploy` without
 * the build arg can no longer silently compile conversions off, as it did from
 * release v75 (16 Sep 2026). main.tsx writes it to <html data-drsnip-conversion>
 * so it is never tree-shaken and can be read on the live page.
 */
export function conversionBuildState(): string {
  // Read lazily (inside a function) so importing this module outside Vite —
  // e.g. under node:test, where import.meta.env is undefined — never throws.
  return import.meta.env.VITE_CONVERSION_TRACKING_ENABLED === "true"
    ? "drsnip-conversion-build:enabled"
    : "drsnip-conversion-build:disabled";
}

/** Master flag — build-time env, default OFF. */
export function conversionEnabled(): boolean {
  return import.meta.env.VITE_CONVERSION_TRACKING_ENABLED === "true";
}

/** Pure decision: fire only when enabled AND actually embedded (iframe). */
export function shouldPostConversion(enabled: boolean, isEmbedded: boolean): boolean {
  return enabled && isEmbedded;
}

/** Pure payload builder — the ONLY shape ever sent. No PII by construction. */
export function buildConversionMessage(formType: string): {
  event: string;
  form_type: string;
} {
  return { event: CONVERSION_EVENT, form_type: formType };
}

/**
 * Fire the dormant conversion postMessage. Inert by default: returns without
 * posting anything unless the flag is on and we're in an iframe. Never throws.
 */
export function postConversion(formType: string): void {
  try {
    const isEmbedded =
      typeof window !== "undefined" && window.parent !== window;
    if (!shouldPostConversion(conversionEnabled(), isEmbedded)) return;
    const msg = buildConversionMessage(formType);
    for (const origin of ALLOWED_PARENT_ORIGINS) {
      window.parent.postMessage(msg, origin);
    }
  } catch {
    /* conversion signalling must never affect the patient's experience */
  }
}
