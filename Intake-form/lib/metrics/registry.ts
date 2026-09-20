import { ATTENDANCE_UNAVAILABLE_REASON } from "./attendance-mapping.js";

// The metric registry — the allow-list, and the words shown to a person.
//
// Kept in one place so the API, the UI and the tests cannot disagree about what
// a metric is called or what it means. Labels here are deliberately literal:
// "form submitted" and "record found" are what the data supports. Nothing here
// says "booked", "arrived" or "attended", because none of those is established.

export const SUPPORTED_WINDOWS = [7, 14, 30] as const;

export type JourneyMetricId =
  | "registration_to_consultation"
  | "insurance_to_registration"
  | "appointment_evidence_registration"
  | "appointment_evidence_insurance"
  | "booking_registration"
  | "booking_insurance";

export type MetricSpec = {
  /** Name passed to the database function's allow-list. */
  fnName: string;
  version: string;
  label: string;
  unit: "distinct_patient_ids";
  /** One plain sentence: exactly what is being counted. */
  countsWhat: string;
  /** Names for the metric-specific secondary counts. */
  secondaryLabels: { a: string | null; b: string | null; c: string | null };
  coverageNote: string;
  providerScope: string;
  /**
   * True when a "not found" is bounded by retrieval, so the value is a floor
   * rather than a complete rate. The UI must label these differently.
   */
  isObservedMinimum: boolean;
};

const ALL_PROVIDERS =
  "All providers and all appointment types. Appointment profile names are not resolvable " +
  "(/api/appointment_profiles returns 403), so these are NOT confirmed vasectomy bookings.";

const APPT_COVERAGE =
  "Per-patient appointment history retrieval is COMPLETE for every linked patient as at the " +
  "instant below, so 'no appointment recorded' is a real negative within that scope — not an " +
  "unknown. That instant is carried forward hourly by an incremental last-modified sync, and it " +
  "advances only on a run that read its whole window, so it always means 'complete to', never " +
  "'last attempted'. It remains bounded by what this credential can see, and a patient linked " +
  "after the last run is reported separately as not covered until their first history read.";

const FORM_AND_EVIDENCE_METRICS: Record<
  "registration_to_consultation" | "insurance_to_registration"
  | "appointment_evidence_registration" | "appointment_evidence_insurance",
  MetricSpec
> = {
  registration_to_consultation: {
    fnName: "registration_to_consultation",
    version: "1.0.0",
    label: "Consultation form submitted after registration",
    unit: "distinct_patient_ids",
    countsWhat:
      "Patients whose first registration falls in the period, and who later submitted the " +
      "consultation form. Both are forms the patient filled in — this is not a booking and " +
      "not an appointment.",
    secondaryLabels: { a: null, b: null, c: null },
    coverageNote:
      "Computed entirely from intake submissions, which have no retrieval-coverage gap.",
    providerScope: "Not applicable — intake forms only.",
    isObservedMinimum: false,
  },
  insurance_to_registration: {
    fnName: "insurance_to_registration",
    version: "1.0.0",
    label: "Registration after insurance inquiry",
    unit: "distinct_patient_ids",
    countsWhat:
      "Patients whose first insurance inquiry falls in the period and who later submitted a " +
      "registration form. Patients already registered before inquiring cannot convert and are " +
      "reported separately, never inside the denominator.",
    secondaryLabels: { a: "Already registered before inquiring", b: null, c: null },
    coverageNote:
      "Computed entirely from intake submissions. 'Not previously registered' can only mean " +
      "'not in the intake data we hold', which begins 2026-06-15.",
    providerScope: "Not applicable — intake forms only.",
    isObservedMinimum: false,
  },
  appointment_evidence_registration: {
    fnName: "appointment_evidence_registration",
    version: "1.0.0",
    label: "Appointment record found after registration",
    unit: "distinct_patient_ids",
    countsWhat:
      "Patients with at least one appointment RECORD created after their registration and " +
      "within the window. This is the timestamp on the record, not proof of when a human booked.",
    secondaryLabels: {
      a: "Forward-scheduled (record created before its scheduled time)",
      b: "Record created at or after its scheduled time",
      c: "Had an appointment record predating registration",
    },
    coverageNote: APPT_COVERAGE,
    providerScope: ALL_PROVIDERS,
    isObservedMinimum: true,
  },
  appointment_evidence_insurance: {
    fnName: "appointment_evidence_insurance",
    version: "1.0.0",
    label: "Appointment record found after insurance inquiry",
    unit: "distinct_patient_ids",
    countsWhat:
      "Patients with at least one appointment RECORD created after their insurance inquiry and " +
      "within the window.",
    secondaryLabels: {
      a: "Forward-scheduled (record created before its scheduled time)",
      b: "Record created at or after its scheduled time",
      c: "Had an appointment record predating the inquiry",
    },
    coverageNote: APPT_COVERAGE,
    providerScope: ALL_PROVIDERS,
    isObservedMinimum: true,
  },
};

/**
 * Booking measures, keyed to the appointment snapshot.
 *
 * Reported as EXACT rates over an eligible denominator, because per-patient
 * retrieval is complete. Their denominator is smaller than the cohort on
 * purpose: patients whose follow-up window extends past the snapshot are
 * immature and excluded, rather than being counted as people who did not book.
 */
const BOOKING_BASE = {
  version: "2.0.0",
  unit: "distinct_patient_ids" as const,
  coverageNote: APPT_COVERAGE,
  providerScope: ALL_PROVIDERS,
  isObservedMinimum: false,
  secondaryLabels: {
    a: "Advance booking recorded (created before its scheduled time)",
    b: "Recorded at or after its scheduled time",
    c: "Had an appointment record predating entry",
  },
};

export const BOOKING_METRICS: Record<"booking_registration" | "booking_insurance", MetricSpec> = {
  booking_registration: {
    ...BOOKING_BASE,
    fnName: "booking_registration",
    label: "Appointment recorded after registration",
    countsWhat:
      "Patients whose first registration falls in the period and for whom an appointment RECORD " +
      "was created after that registration, within the follow-up window. This is the timestamp " +
      "on the record — it is not proof of when a human booked, and it is not attendance.",
  },
  booking_insurance: {
    ...BOOKING_BASE,
    fnName: "booking_insurance",
    label: "Appointment recorded after insurance inquiry",
    countsWhat:
      "Patients whose first insurance inquiry falls in the period and for whom an appointment " +
      "RECORD was created after that inquiry, within the follow-up window.",
  },
};

export const JOURNEY_METRICS: Record<JourneyMetricId, MetricSpec> = {
  ...FORM_AND_EVIDENCE_METRICS,
  ...BOOKING_METRICS,
};

export function isJourneyMetric(v: unknown): v is JourneyMetricId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(JOURNEY_METRICS, v);
}

export function describeMetric(id: JourneyMetricId): MetricSpec {
  return JOURNEY_METRICS[id];
}

/**
 * Metrics that exist as a contract but cannot be computed yet.
 *
 * Attendance is blocked on two things, and procedure completion is NOT one of
 * them — that is a separate question with its own separate answer. Listing it
 * as an attendance prerequisite (as an earlier draft did) overstates what is
 * required to unblock attendance.
 */
export const UNAVAILABLE_METRICS = [
  {
    id: "appointment_attendance_rate",
    label: "Attendance",
    // The data blocker is GONE: every stored appointment now has retrieved
    // history. What remains is a decision, not a retrieval gap, and saying
    // otherwise would be stale.
    reason: ATTENDANCE_UNAVAILABLE_REASON,
    blockers: [
      "No approved mapping from this clinic's status values to 'the patient arrived'.",
    ],
  },
  {
    id: "procedure_completed",
    label: "Procedure completed",
    reason:
      "Not available. No stored field establishes procedure completion, and an appointment's " +
      "'Complete' status is not confirmed to mean it.",
    blockers: ["No confirmed source field for procedure completion."],
  },
] as const;
