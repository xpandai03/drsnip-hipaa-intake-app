// Marketing attribution capture (Phase 2). Reads channel params from the
// landing URL so a submission can record which campaign produced it.
//
// Passive metadata only: capture never blocks or alters submission handling —
// a bare URL simply yields an empty object (→ NULLs server-side → the
// "untagged / direct" bucket on the dashboard).
//
// patient_id is NOT an attribution parameter and is deliberately NOT read here
// (the consultation form reads it separately for chart matching). It must never
// be stored as attribution or forwarded to any analytics target.

export type Attribution = {
  source?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  gclid?: string;
  fbclid?: string;
};

const MAX_LEN = 200; // defensive cap; these are short campaign tokens

function pick(params: URLSearchParams, key: string): string | undefined {
  const v = params.get(key);
  if (!v) return undefined;
  const trimmed = v.trim().slice(0, MAX_LEN);
  return trimmed === "" ? undefined : trimmed;
}

/** Read attribution params from the current URL. Safe on SSR (returns {}). */
export function readAttribution(): Attribution {
  if (typeof window === "undefined") return {};
  const p = new URLSearchParams(window.location.search);
  const a: Attribution = {
    source: pick(p, "source"),
    utmSource: pick(p, "utm_source"),
    utmMedium: pick(p, "utm_medium"),
    utmCampaign: pick(p, "utm_campaign"),
    utmTerm: pick(p, "utm_term"),
    utmContent: pick(p, "utm_content"),
    gclid: pick(p, "gclid"),
    fbclid: pick(p, "fbclid"),
  };
  // Drop undefined keys so the payload stays clean.
  return Object.fromEntries(
    Object.entries(a).filter(([, v]) => v !== undefined),
  ) as Attribution;
}
