// Monthly patient outcomes — the allow-list, and the words shown to a person.
//
// A CURRENT-POSITION measure: for the patients who entered in a clinic month,
// where do they stand at the appointment evidence cutoff. It is not the booking
// metric (a record created within N days) and it never produces a rate.
//
// The reporting DEFINITION — which profiles count, what statuses mean — lives
// in the database (migration 0021) and is resolved there. Nothing in this file
// names a profile id, so the definition cannot drift between the API and SQL.

export type OutcomeMetricId = "outcome_registration" | "outcome_insurance";

export type OutcomeMetricSpec = {
  /** Name passed to drsnip_outcome_metric()'s allow-list. */
  fnName: OutcomeMetricId;
  version: string;
  label: string;
  entryForm: "registration" | "insurance";
  countsWhat: string;
  cohortNote: string;
};

export const OUTCOME_METRICS: Record<OutcomeMetricId, OutcomeMetricSpec> = {
  outcome_registration: {
    fnName: "outcome_registration",
    version: "1.0.0",
    label: "Where registration patients stand now",
    entryForm: "registration",
    countsWhat:
      "Each linked patient chart whose FIRST registration falls in the month, placed in exactly one " +
      "outcome as at the appointment evidence cutoff.",
    cohortNote:
      "A repeat registration never creates a second entry. Registrations no chart was linked to are " +
      "counted separately, as submissions, not people.",
  },
  outcome_insurance: {
    fnName: "outcome_insurance",
    version: "1.0.0",
    label: "Where insurance-inquiry patients stand now",
    entryForm: "insurance",
    countsWhat:
      "Each linked patient chart whose FIRST insurance inquiry falls in the month, placed in exactly " +
      "one outcome as at the appointment evidence cutoff.",
    cohortNote:
      "Everyone who inquired is in the cohort, including patients already registered before the " +
      "inquiry; how many that is appears as its own count. This is NOT the inquiry-to-registration " +
      "denominator, which excludes them.",
  },
};

export function isOutcomeMetric(v: unknown): v is OutcomeMetricId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(OUTCOME_METRICS, v);
}

/** The only scope that exists today. A provisional engineering preview. */
export const DEFAULT_OUTCOME_SCOPE = "selected_procedure_types";
export const SCOPE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Whole clinic months only — see 0021 on why arbitrary day ranges are refused. */
export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const EARLIEST_MONTH = "2026-01";
export const MAX_MONTHS = 13;

export const BUCKETS = {
  completed: {
    label: "Completed",
    means:
      "Completion recorded for an included appointment type (Complete or Signed No Review). It " +
      "records that an appointment was completed — it does not by itself show a procedure was performed.",
  },
  scheduled: {
    label: "Currently scheduled",
    means:
      "An included appointment is booked (Scheduled or Confirmed) for a date after the data cutoff, " +
      "and no qualifying completion is recorded.",
  },
  unknown: {
    label: "Unknown",
    means:
      "Missing or ambiguous evidence prevents classification — for example a past appointment still " +
      "marked Scheduled, a blank status, a reschedule with no later appointment visible, or an " +
      "appointment type whose inclusion is undecided. Missing evidence is never counted as a negative.",
  },
  neither: {
    label: "Neither established",
    means:
      "Neither a qualifying completion nor a current booking is established from the available " +
      "evidence. It does not mean the patient was lost, did not attend, or should be contacted.",
  },
} as const;

/** How each profile role is treated, in words. Shown beside the exact names. */
export const ROLE_LABELS = {
  qualifying: {
    label: "Counted in this view",
    means: "Completed and scheduled counts come only from these appointment types.",
  },
  comparison: {
    label: "Shown for comparison, not counted",
    means:
      "Consultation-only outcomes are listed beside each month so their effect is visible. They are " +
      "not silently treated as qualifying.",
  },
  inclusion_undecided: {
    label: "Not counted — inclusion not yet decided",
    means:
      "A completed or booked appointment of one of these types makes the patient Unknown rather than " +
      "counting either way, until the clinic decides.",
  },
  excluded_known: {
    label: "Not counted — follow-up testing and administrative records",
    means: "These are not initial procedure bookings and can never make a patient Completed or Scheduled.",
  },
  unknown_profile: {
    label: "Appointment types with no known name",
    means: "Treated like an undecided type: evidence on them can make a patient Unknown, never a positive.",
  },
} as const;

/** What each status establishes, in words. The label lists come from the database rules. */
export const STATUS_EXPLANATIONS = [
  {
    key: "completion",
    means:
      "Completed appointment. Signed No Review means the appointment was completed and a review " +
      "request was withheld (clinic, 21 Sep 2026 call).",
  },
  {
    key: "procedure_not_performed",
    means:
      "The consultation took place and the procedure did not. Not counted as Completed in this " +
      "provisional definition; shown separately in each month's details.",
  },
  {
    key: "active_if_future",
    means: "A booking. Counts as Currently scheduled only when dated after the data cutoff.",
  },
  {
    key: "ended_not_active",
    means:
      "That appointment is no longer active. No Show is treated this way by engineering inference; " +
      "the clinic has not defined it.",
  },
  {
    key: "replaced",
    means:
      "That appointment was replaced. The patient's other appointments are evaluated; a replacement " +
      "is never assumed.",
  },
  {
    key: "other",
    means: "Blank, in-clinic or unrecognised statuses establish nothing and can make a patient Unknown.",
  },
] as const;

export const UNKNOWN_REASONS = {
  past_dated_open: "A counted appointment's date has passed and it is still Scheduled or Confirmed",
  status_unresolved: "A counted appointment has a blank, in-clinic or unrecognised status",
  rescheduled_no_replacement: "A counted appointment was Rescheduled and no later record is visible",
  conflicting_history: "A counted appointment once reached Complete, and its current status no longer says so",
  deleted_completion: "A completion is recorded only on an appointment deleted at the source",
  undecided_profile: "A completed or active appointment is of a type whose inclusion is not yet decided",
  unknown_profile: "A completed or active appointment is of a type with no known name",
} as const;

export const ANNOTATIONS = {
  completed_with_future_booking: "Completed, and also holds a future counted booking",
  completed_review_withheld_only: "Completed only via Signed No Review",
  procedure_not_performed: "Not completed; a counted appointment ended Procedure Not Performed",
  comparison_completed: "Not completed; completed a comparison-type appointment (e.g. Consultation Only)",
  comparison_scheduled: "Not completed or scheduled; holds a future comparison-type appointment",
  positive_booked_before_entry: "Completed or scheduled on a record created before the form was submitted",
  prior_completion_before_entry: "Had a counted completion dated before entering this cohort",
  registered_before_inquiry: "Insurance only: already registered before the inquiry",
  repeat_submitters: "Submitted this form more than once (counted once, at the first)",
} as const;

export const NO_COMBINED_MEASURE =
  "No conversion rate and no completed-plus-scheduled total is returned. The qualifying " +
  "definition is provisional; the two counts are published separately until the clinic settles it.";
