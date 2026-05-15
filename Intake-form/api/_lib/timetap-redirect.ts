// TimeTap self-scheduling redirect. Pure function — no DB, no HTTP, no env.
//
// After /api/submit posts a qualifying lead to Salesforce, the response
// can carry a redirectUrl that the frontend uses to send the user
// straight to the matching TimeTap booking calendar (CJC has SIX of them,
// one per rank/score tier). The mapping below is the contract.
//
// Qualifying = scored A or B+. Anything else (B, C, N/A, or an A-rank
// lead whose score didn't byte-match any tier) returns null — there is
// NO fallback calendar by design. Misrouted leads are worse than no
// redirect; the user falls back to the existing thank-you page and
// Crystal handles outreach manually.
//
// The score strings are byte-exact (irregular two-space spacing matches
// lib/scoring/src/v1-rule-set.ts and the existing Lead_Score__c literals
// stored in Salesforce). Do not normalize.
//
// Held leads (hold_a7_for_review valve ON + Lead_Score__c='7  ($0-$350k)')
// must NOT receive a redirect; the held experience is silent-on-purpose.
// The caller (api/submit.ts) is responsible for skipping this function
// in the held branch.

export type RedirectLeadFields = {
  firstName: string;
  lastName: string;
  email: string;
  /** Phone may be empty after the form (validated as required at submit
   *  time, but we treat it defensively here — empty string survives
   *  through the URL with no encoded undefined/null). */
  phone?: string | null;
};

// ---------------------------------------------------------------------------
// Calendar mapping table. Byte-exact score keys.
// ---------------------------------------------------------------------------
//
// Source: task brief. The six subdomains are CJC's existing TimeTap
// calendars — kept as plain strings here so any future calendar move is
// a single-line edit. Not env vars (per task brief).

const A_RANK_CALENDARS: Record<string, string> = {
  "10  (over $1mm)": "myadvisor.timetap.com",
  "9 ($601k - $1mm)": "advisorscheduling.timetap.com",
  "8  ($351k-$600k)": "advisorschedule.timetap.com",
  "7  ($0-$350k)": "advisorscheduler.timetap.com",
};

const B_PLUS_CALENDAR = "advisorconsult.timetap.com";

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------
//
// TimeTap's pre-fill URL pattern is documented as:
//   https://<subdomain>/?CF_CLIENT_FIRSTNAME=...&CF_CLIENT_LASTNAME=...
//     &CF_CLIENT_EMAILADDRESS=...&CF_CLIENT_MOBILE_PHONE=...#/
// The trailing `#/` is part of TimeTap's SPA route shape. Preserve it
// verbatim — without it the booking widget doesn't pick up the params.
//
// All four params are always present in the output (even if phone is
// empty), per the task brief: `include the param with empty string, not
// undefined or null`. URLSearchParams handles encoding correctly for
// spaces, apostrophes, accented chars, '+', '&', etc.

function buildTimeTapUrl(
  subdomain: string,
  lead: RedirectLeadFields,
): string {
  const params = new URLSearchParams();
  params.set("CF_CLIENT_FIRSTNAME", lead.firstName ?? "");
  params.set("CF_CLIENT_LASTNAME", lead.lastName ?? "");
  params.set("CF_CLIENT_EMAILADDRESS", lead.email ?? "");
  params.set("CF_CLIENT_MOBILE_PHONE", lead.phone ?? "");
  return `https://${subdomain}/?${params.toString()}#/`;
}

// ---------------------------------------------------------------------------
// getTimeTapRedirectUrl
// ---------------------------------------------------------------------------

/**
 * Returns the TimeTap booking URL for a qualifying lead, or null if the
 * lead doesn't fit any of the six mapped calendars.
 *
 * Rules:
 *   - rank 'A' + leadScore that byte-matches one of the four A-rank tiers
 *     → that tier's calendar URL.
 *   - rank 'B+' (any score, including null/undefined) → the B+ calendar URL.
 *   - everything else (B, C, N/A, A with unmapped or null score) → null.
 *
 * The caller is responsible for the consultation-question gate
 * (preRetirementReview === 'Yes') and the held-lead skip. Keeping those
 * outside this function preserves it as a pure mapping primitive —
 * easier to test, harder to misuse.
 */
export function getTimeTapRedirectUrl(
  rank: string | null | undefined,
  leadScore: string | null | undefined,
  lead: RedirectLeadFields,
): string | null {
  if (rank === "A") {
    if (leadScore == null) return null;
    const subdomain = A_RANK_CALENDARS[leadScore];
    if (!subdomain) return null;
    return buildTimeTapUrl(subdomain, lead);
  }
  if (rank === "B+") {
    return buildTimeTapUrl(B_PLUS_CALENDAR, lead);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test-only export — the mapping table itself, so the snapshot test can
// assert exact subdomain values without re-typing them.
// ---------------------------------------------------------------------------

export const TIMETAP_CALENDARS = {
  A_RANK: { ...A_RANK_CALENDARS },
  B_PLUS: B_PLUS_CALENDAR,
} as const;
