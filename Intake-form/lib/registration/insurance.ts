// Registration insurance rules — ONE definition shared by the form
// (artifacts/intake-form/src/pages/Home.tsx) and the server (/api/submit), so
// the client-side step validation and the server-side rejection can never
// drift apart. Pure: no DB, no network, no DOM.
//
// Policy semantics (unchanged from B.4):
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

/**
 * Patch to apply when the coverage selection changes. The flat (primary)
 * fields belong to the partner under "Partner's Insurance" but to the patient
 * under "Own" / "Both". `fieldsOwner` is whose details the primary fields
 * currently hold (the owner at the last policy-bearing selection — it survives
 * a detour through "No Insurance"). When the new selection belongs to the
 * other person the primary set is cleared rather than silently re-labelled as
 * their policy. Otherwise values are kept, so re-selecting restores them.
 */
export function coverageChangePatch(
  fieldsOwner: "patient" | "partner" | "",
  next: string,
): Record<string, string | null> {
  const to = primaryPolicyOwner(next);
  if (!fieldsOwner || !to || fieldsOwner === to) return {};
  const patch: Record<string, string | null> = {};
  for (const k of PRIMARY_POLICY_KEYS) patch[k] = "";
  for (const k of PRIMARY_CARD_KEYS) patch[k] = null;
  return patch;
}
