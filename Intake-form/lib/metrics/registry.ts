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
  | "appointment_evidence_insurance";

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
  "Appointment history is a stored snapshot, not continuously current. A patient with no " +
  "record found may still have one: per-patient history retrieval is incomplete, so 'not " +
  "found' is bounded by what was retrieved and by the swept date horizon.";

export const JOURNEY_METRICS: Record<JourneyMetricId, MetricSpec> = {
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
    reason:
      "Not available yet. Most appointments have no status-transition history retrieved, so an " +
      "absent history means 'not looked up', not 'did not arrive'. The clinic also has not yet " +
      "confirmed which of its status values mean the patient arrived.",
    blockers: [
      "Per-patient transition retrieval is incomplete.",
      "No approved mapping from clinic status values to 'arrived'.",
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
