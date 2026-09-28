// Registration insurance rules — ONE definition shared by the form
// (artifacts/intake-form/src/pages/Home.tsx) and the server (/api/submit), so
// the client-side step validation and the server-side rejection can never
// drift apart. Pure: no DB, no network, no DOM.
//
// Policy semantics ON THE WIRE (unchanged from B.4 — the form keeps its own
// two-record model and maps to this at submit, see insuranceForSubmission):
//   * "Own Insurance"       — the flat insurance*/insured* fields are the
//                             patient's own policy.
//   * "Partner's Insurance" — the SAME flat fields hold the partner's policy;
//                             the insured (policyholder) is the partner.
//   * "Both"                — flat fields = patient's own policy; the
//                             partnerInsurance*/partnerInsured* fields are the
//                             partner's policy.
//   * "No Insurance"        — no policy.
//
// Subscriber incident (DRSNIP_SUBSCRIBER_DETAILS_INCIDENT_INVESTIGATION.md):
// the policyholder's name and DOB are REQUIRED wherever the policyholder is the
// partner — the primary set under "Partner's Insurance", the partner set under
// "Both". They stay optional for the patient's own policy.

export const COVERAGE_OWN = "Own Insurance";
export const COVERAGE_PARTNER = "Partner's Insurance";
export const COVERAGE_BOTH = "Both";
export const COVERAGE_NONE = "No Insurance";

/** Keys of the primary (flat) policy. */
export const PRIMARY_POLICY_KEYS = [
  "insuranceCompany",
  "insuranceIdNo",
  "insuranceGroupNo",
  "insuredFirstName",
  "insuredLastName",
  "insuredDob",
  "insuredEmployer",
] as const;
export const PRIMARY_CARD_KEYS = ["insuranceCardFront", "insuranceCardBack"] as const;

/** Keys of the partner's (secondary) policy — "Both" only. */
export const PARTNER_POLICY_KEYS = [
  "partnerInsuranceCompany",
  "partnerInsuranceIdNo",
  "partnerInsuranceGroupNo",
  "partnerInsuredFirstName",
  "partnerInsuredLastName",
  "partnerInsuredDob",
  "partnerInsuredEmployer",
] as const;
export const PARTNER_CARD_KEYS = [
  "partnerInsuranceCardFront",
  "partnerInsuranceCardBack",
] as const;

export function showsPrimaryPolicy(coverage: string): boolean {
  return coverage !== "" && coverage !== COVERAGE_NONE;
}

export function showsPartnerPolicy(coverage: string): boolean {
  return coverage === COVERAGE_BOTH;
}

/** Whose policy the flat (primary) fields describe. */
export function primaryPolicyOwner(coverage: string): "patient" | "partner" | "" {
  if (coverage === COVERAGE_PARTNER) return "partner";
  if (coverage === COVERAGE_OWN || coverage === COVERAGE_BOTH) return "patient";
  return "";
}

/**
 * True for a real calendar date written as YYYY-MM-DD, from 1900-01-01 up to
 * `today` (plus one day of slack so a client ahead of the server's UTC day is
 * not rejected). Parsed as UTC components only — no timezone conversion, so
 * the stored string is exactly what the person picked.
 */
export function isValidDob(value: unknown, today: Date = new Date()): boolean {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return false;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d
  ) {
    return false; // e.g. 2023-02-30
  }
  const latest = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + 1,
  );
  return t <= latest;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

type Loose = Record<string, unknown>;

function policyholderErrorsFor(
  body: Loose,
  keys: { first: string; last: string; dob: string },
  whose: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (text(body[keys.first]) === "")
    errors[keys.first] = `Enter the ${whose} policyholder's legal first name.`;
  if (text(body[keys.last]) === "")
    errors[keys.last] = `Enter the ${whose} policyholder's legal last name.`;
  if (text(body[keys.dob]) === "")
    errors[keys.dob] = `Enter the ${whose} policyholder's date of birth.`;
  else if (!isValidDob(body[keys.dob]))
    errors[keys.dob] = `The ${whose} policyholder's date of birth must be a real date (YYYY-MM-DD), not in the future.`;
  return errors;
}

/**
 * Field-level errors for the required policyholder details. Empty object when
 * the submission is complete. Only the partner-policyholder branches are
 * checked; every other coverage returns {}.
 */
export function policyholderErrors(body: Loose): Record<string, string> {
  const coverage = text(body.insuranceCoverage);
  if (coverage === COVERAGE_PARTNER) {
    return policyholderErrorsFor(
      body,
      { first: "insuredFirstName", last: "insuredLastName", dob: "insuredDob" },
      "partner's",
    );
  }
  if (coverage === COVERAGE_BOTH) {
    return policyholderErrorsFor(
      body,
      {
        first: "partnerInsuredFirstName",
        last: "partnerInsuredLastName",
        dob: "partnerInsuredDob",
      },
      "partner's",
    );
  }
  return {};
}

/**
 * Blank the policy fields that do not apply to the selected coverage, so a
 * value typed before switching options can never travel under the wrong
 * policy. Hidden fields keep their state in the wizard (Back/forward keeps
 * them), and this runs at submit time on both client and server.
 *   * not "Both"      -> partner policy blanked (cards -> null)
 *   * "No Insurance"  -> primary policy blanked too
 * An empty/unknown coverage keeps the primary set (historic behaviour) and
 * blanks only the partner set.
 */
export function withApplicableInsurance<T extends Loose>(body: T): T {
  const coverage = text(body.insuranceCoverage);
  const out: Loose = { ...body };
  const blank = (keys: readonly string[], cards: readonly string[]) => {
    for (const k of keys) if (k in out) out[k] = "";
    for (const k of cards) if (k in out) out[k] = null;
  };
  if (!showsPartnerPolicy(coverage)) blank(PARTNER_POLICY_KEYS, PARTNER_CARD_KEYS);
  if (coverage === COVERAGE_NONE) blank(PRIMARY_POLICY_KEYS, PRIMARY_CARD_KEYS);
  return out as T;
}

/** Map a partner-policy key to its flat (primary) counterpart. */
const PARTNER_TO_PRIMARY: Record<string, string> = {
  partnerInsuranceCompany: "insuranceCompany",
  partnerInsuranceIdNo: "insuranceIdNo",
  partnerInsuranceGroupNo: "insuranceGroupNo",
  partnerInsuredFirstName: "insuredFirstName",
  partnerInsuredLastName: "insuredLastName",
  partnerInsuredDob: "insuredDob",
  partnerInsuredEmployer: "insuredEmployer",
  partnerInsuranceCardFront: "insuranceCardFront",
  partnerInsuranceCardBack: "insuranceCardBack",
};

/**
 * The form keeps TWO canonical records while the patient edits:
 *   * the flat insurance / insured fields = the patient's OWN policy, always;
 *   * the partnerInsurance / partnerInsured fields = the PARTNER's policy, always.
 * Switching coverage never moves, clears or relabels either record, so
 * Partner's <-> Both keeps everything typed and neither person's details can
 * be attached to the other's policy.
 *
 * At submit this maps the two records onto the existing payload contract
 * (unchanged, see the header comment): for "Partner's Insurance" the partner
 * record is sent in the flat fields; "Both" sends both; "Own" sends the own
 * record; "No Insurance" sends neither. Fields that do not apply are blanked.
 */
export function insuranceForSubmission<T extends Loose>(form: T): T {
  const coverage = text(form.insuranceCoverage);
  if (coverage !== COVERAGE_PARTNER) return withApplicableInsurance(form);
  const out: Loose = { ...form };
  for (const [partnerKey, flatKey] of Object.entries(PARTNER_TO_PRIMARY)) {
    out[flatKey] = form[partnerKey] ?? (PARTNER_CARD_KEYS.includes(partnerKey as never) ? null : "");
  }
  return withApplicableInsurance(out as T);
}

function hasAny(form: Loose, keys: readonly string[]): boolean {
  return keys.some((k) => {
    const v = form[k];
    return typeof v === "string" ? v.trim() !== "" : v != null;
  });
}

/**
 * A plain-language note when details the patient typed are kept on the page
 * but will NOT be sent with the current coverage choice. Nothing is discarded
 * by switching; this says so instead of silently hiding it. null = no note.
 */
export function hiddenPolicyNote(form: Loose): string | null {
  const coverage = text(form.insuranceCoverage);
  const own = hasAny(form, [...PRIMARY_POLICY_KEYS, ...PRIMARY_CARD_KEYS]);
  const partner = hasAny(form, [...PARTNER_POLICY_KEYS, ...PARTNER_CARD_KEYS]);
  if (coverage === COVERAGE_NONE && (own || partner))
    return "The policy details you entered are kept on this page but won't be sent with \"No Insurance\".";
  if (coverage === COVERAGE_OWN && partner)
    return "Your partner's policy details are kept on this page but won't be sent unless you choose \"Partner's Insurance\" or \"Both\".";
  if (coverage === COVERAGE_PARTNER && own)
    return "Your own policy details are kept on this page but won't be sent unless you choose \"Own Insurance\" or \"Both\".";
  return null;
}
