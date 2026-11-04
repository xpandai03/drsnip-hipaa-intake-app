// The client's definition of "converted" (Jeffrey Cho; first given on the
// 2026-09-21 call, restated with additions on the 2026-10-27 call).
//
// THE DATABASE IS THE SOURCE OF TRUTH for every number the console shows:
// outcome_status_rules v3, seeded by migration 0025 and applied by
// public.drsnip_conversion_status_class(). This module mirrors those lists so
// that (a) the client's statuses are unit-tested without a database and (b) the
// labels and explanations the page shows come from one place. A test fails if
// the lists here and in 0025 ever drift apart.
//
// "unclassified" is the class name the database uses for an IGNORED status: a
// blank one, or any label in neither list. Ignored is never "not converted",
// and a patient whose appointments are all ignored is not counted at all.

export type StatusClass = "converted" | "not_converted" | "unclassified";

export const CONVERSION_RULES = {
  version: "3",
  converted: [
    "complete", "signed no review", "procedure not performed", "checked in",
    "checked in online", "arrived", "in session", "scheduled", "confirmed", "rescheduled",
  ],
  // DrChrono's "Ready in 1".."Ready in 4" and its numberless "In Room".
  converted_patterns: ["^(ready in (room )?[0-9]+|in room( [0-9]+)?)$"],
  not_converted: [
    "cancelled", "canceled", "late cancel within 48 hrs", "late canceled",
    "late cancelled", "no show", "no-show",
  ],
  // `\M` is PostgreSQL's end-of-word; `\b` is its JavaScript equivalent here.
  not_converted_patterns: ["^cancell?ed\\M", "^late cancel", "^no[- ]?show$"],
  // Known ignored labels. Anything in neither list above is ignored as well.
  ignored: ["", "md in", "md out"],
} as const;

/** The client's statuses exactly as listed on 2026-10-27, and what each must be. */
export const CLIENT_STATUS_LIST: ReadonlyArray<{ status: string; drchrono: string[]; is: StatusClass }> = [
  { status: "Complete", drchrono: ["Complete"], is: "converted" },
  { status: "Signed no review", drchrono: ["Signed No Review"], is: "converted" },
  { status: "Procedure not performed", drchrono: ["Procedure Not Performed"], is: "converted" },
  { status: "Checked in", drchrono: ["Checked In"], is: "converted" },
  { status: "Checked in online", drchrono: ["Checked In Online"], is: "converted" },
  { status: "Arrived", drchrono: ["Arrived"], is: "converted" },
  { status: "Ready / In room (all rooms)", drchrono: ["Ready in 1", "Ready in 2", "Ready in 3", "Ready in 4", "Ready in room 12", "In Room", "In room 3"], is: "converted" },
  { status: "In session", drchrono: ["In Session"], is: "converted" },
  { status: "Scheduled", drchrono: ["Scheduled"], is: "converted" },
  { status: "Confirmed", drchrono: ["Confirmed"], is: "converted" },
  { status: "Rescheduled", drchrono: ["Rescheduled"], is: "converted" },
  { status: "Canceled", drchrono: ["Cancelled", "Cancelled - Will Call Back"], is: "not_converted" },
  { status: "Late canceled", drchrono: ["Late Cancel within 48 hrs"], is: "not_converted" },
  { status: "No-show", drchrono: ["No Show"], is: "not_converted" },
];

/** Same normalisation as the SQL: trim, collapse whitespace, lower-case. */
export function normalizeStatus(s: string | null | undefined): string {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

const jsPattern = (p: string) => new RegExp(p.replace(/\\M/g, "\\b"));

/** TypeScript mirror of public.drsnip_conversion_status_class(). */
export function classifyStatus(s: string | null | undefined): StatusClass {
  const n = normalizeStatus(s);
  if (n === "") return "unclassified";
  if ((CONVERSION_RULES.converted as readonly string[]).includes(n)
      || CONVERSION_RULES.converted_patterns.some((p) => jsPattern(p).test(n))) return "converted";
  if ((CONVERSION_RULES.not_converted as readonly string[]).includes(n)
      || CONVERSION_RULES.not_converted_patterns.some((p) => jsPattern(p).test(n))) return "not_converted";
  return "unclassified";
}

export type ConversionForm = "registration" | "insurance";
export const CONVERSION_FORMS: Record<ConversionForm, { label: string; entryNoun: string }> = {
  registration: { label: "Registration", entryNoun: "registration" },
  insurance: { label: "Insurance inquiry", entryNoun: "insurance inquiry" },
};
export const isConversionForm = (v: unknown): v is ConversionForm =>
  v === "registration" || v === "insurance";

/**
 * The three buckets of the counted cohort, in reading order. A patient whose
 * appointments all have an ignored status is not in the cohort (rules v3).
 */
export const OUTCOME_BUCKETS = {
  converted: {
    label: "Converted",
    means: "At least one appointment on the chart has a converted status.",
  },
  not_converted: {
    label: "Not converted",
    means: "No converted appointment; at least one was canceled, late canceled or a no-show.",
  },
  no_appointment: {
    label: "No appointment",
    means: "No appointment on the chart at all.",
  },
} as const;
export const OUTCOME_BUCKET_KEYS = ["converted", "not_converted", "no_appointment"] as const;

export const RULE_EXPLANATION =
  "Converted: Complete, Signed no review, Procedure not performed, Checked in, Checked in online, " +
  "Arrived, Ready / In room (all rooms), In session, Scheduled, Confirmed, Rescheduled. Not converted: " +
  "Canceled, Late canceled, No-show. A blank or any other status is ignored, not counted as not " +
  "converted. A patient converts if ANY appointment on their chart is in the converted set; each " +
  "patient is counted once, in the month of their earliest form of that type.";
