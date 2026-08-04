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
