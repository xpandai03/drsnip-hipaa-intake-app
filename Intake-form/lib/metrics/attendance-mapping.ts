// Attendance mapping — a versioned, approvable contract, deliberately NOT a
// guess dressed up as a definition.
//
// WHY THIS FILE EXISTS. The appointment history is now complete: every stored
// appointment has retrieved status transitions. What is still missing is not
// data, it is a DECISION — which of the clinic's status values mean the patient
// physically arrived. That is a clinical/operational fact about how this
// practice uses DrChrono, and nobody outside the clinic can supply it.
//
// A previous agent listed a plausible arrival set. THAT IS A RECOMMENDATION,
// NOT AN APPROVAL. `approval.state` below stays "awaiting_clinic_confirmation"
// until a human at the clinic confirms it, and every consumer must check that
// flag rather than reading the candidate list and assuming.

/** Exact source status strings observed, with no interpretation attached. */
export type SourceStatus = string;

export type ApprovalState =
  /** Nobody has confirmed the meaning of these statuses. Attendance is unavailable. */
  | "awaiting_clinic_confirmation"
  /** A named person at the clinic confirmed this mapping on a given date. */
  | "approved"
  /** Previously approved, now withdrawn or superseded. */
  | "superseded";

export type AttendanceMapping = {
  /** Bump on ANY change to the status sets, so a number stays attributable. */
  version: string;
  approval: {
    state: ApprovalState;
    /**
     * Who confirmed it and how — a name and a date, or a document reference.
     * Null while unapproved. "A prior agent proposed it" is NOT provenance.
     */
    provenance: string | null;
    approved_on: string | null;
  };
  /**
   * Statuses that would mean the patient physically arrived, IF approved.
   * Listed as candidates so the decision can be made concretely.
   */
  arrival_candidates: SourceStatus[];
  /** Statuses that would mean the visit did not happen. */
  non_arrival_candidates: SourceStatus[];
  /**
   * Statuses whose meaning is genuinely unclear and that must be resolved
   * explicitly rather than folded into either set by default.
   */
  ambiguous: { status: SourceStatus; question: string }[];
  /** How to resolve an appointment whose history contains both kinds. */
  conflict_rule: string;
  /** What counts as the attendance observation, once approved. */
  effective_definition: string;
};

/**
 * THE CURRENT MAPPING — UNAPPROVED.
 *
 * The candidate lists come from the observed vocabulary and from §10 of
 * DRSNIP_PATIENT_JOURNEY_DEFINITIONS.md, which poses them as QUESTIONS. They
 * are here so the clinic can answer concretely, not so code can use them.
 */
export const CURRENT_MAPPING: AttendanceMapping = {
  version: "0.1.0-draft",
  approval: {
    state: "awaiting_clinic_confirmation",
    provenance: null,
    approved_on: null,
  },
  arrival_candidates: [
    "Arrived",
    "Checked In",
    "Checked In Online",
    "Ready in 1",
    "Ready in 2",
    "Ready in 3",
    "Ready in 4",
    "In Room",
    "In Session",
    "MD In",
    "MD Out",
  ],
  non_arrival_candidates: [
    "Cancelled",
    "Late Cancel within 48 hrs",
    "No Show",
    "Rescheduled",
  ],
  ambiguous: [
    {
      status: "Complete",
      question:
        "Does 'Complete' mean the patient attended, that the chart work was finished, or " +
        "simply that the slot closed? It is the third most common status, so it changes the " +
        "answer materially.",
    },
    {
      status: "Signed No Review",
      question: "Is this a charting state that implies the visit happened, or an administrative one?",
    },
    {
      status: "Procedure Not Performed",
      question:
        "Does this imply the patient arrived but no procedure occurred? If so it is an ARRIVAL " +
        "with no procedure — which is exactly why attendance and procedure completion must " +
        "stay separate measures.",
    },
    {
      status: "",
      question:
        "A blank status is the single largest group in the transition history. Is it a default " +
        "that carries no meaning, or does it stand for something specific?",
    },
    {
      status: "Scheduled",
      question: "Confirmed as a booking state only, with no bearing on arrival?",
    },
    {
      status: "Confirmed",
      question:
        "Does 'Confirmed' mean the PATIENT confirmed they will attend (still not arrival), or " +
        "something stronger?",
    },
  ],
  conflict_rule:
    "If an appointment's history contains both an arrival status and a non-arrival status, the " +
    "EARLIEST qualifying arrival transition is taken as evidence the patient arrived, and a " +
    "later cancellation does not erase it — a patient who arrived and was then marked cancelled " +
    "still arrived. A later CORRECTION that removes the arrival transition entirely is a " +
    "different case and is handled by re-reading the history, not by inference.",
  effective_definition:
    "Attendance = the earliest transition whose to_status is in the approved arrival set, " +
    "observed on an appointment belonging to the patient's journey within the stated " +
    "observation window. Procedure completion is NOT part of this definition and is measured " +
    "separately, if at all.",
};

/** The only gate. Consumers must call this, never read the candidate lists. */
export function attendanceIsApproved(m: AttendanceMapping = CURRENT_MAPPING): boolean {
  return m.approval.state === "approved" && m.arrival_candidates.length > 0;
}

/** The exact, unchanging reason shown wherever attendance would appear. */
export const ATTENDANCE_UNAVAILABLE_REASON =
  "Appointment history loaded; attendance definition awaiting clinic confirmation.";

/**
 * Classify one status against a mapping.
 *
 * Returns "unknown" for anything the mapping does not name — including new
 * statuses the clinic starts using. Silently treating an unknown status as
 * non-arrival would quietly understate attendance forever.
 */
export function classifyStatus(
  status: SourceStatus | null,
  m: AttendanceMapping = CURRENT_MAPPING,
): "arrival" | "non_arrival" | "ambiguous" | "unknown" {
  const s = status === null ? "" : status;
  if (m.arrival_candidates.includes(s)) return "arrival";
  if (m.non_arrival_candidates.includes(s)) return "non_arrival";
  if (m.ambiguous.some((a) => a.status === s)) return "ambiguous";
  return "unknown";
}

/** The decision the clinic still has to make, in the words they need to answer. */
export function outstandingDecision(m: AttendanceMapping = CURRENT_MAPPING): {
  blocking: boolean;
  questions: string[];
} {
  if (attendanceIsApproved(m)) return { blocking: false, questions: [] };
  return {
    blocking: true,
    questions: [
      `Confirm which of these mean the patient physically arrived: ${m.arrival_candidates.join(", ")}.`,
      ...m.ambiguous.map((a) => `${a.status === "" ? "(blank status)" : a.status}: ${a.question}`),
      "Separately: does any field establish that a procedure was performed? " +
        "Attendance does not require this, and must not wait on it.",
    ],
  };
}
