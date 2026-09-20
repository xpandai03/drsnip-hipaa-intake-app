// Coverage model — what we are entitled to say about each patient.
//
// The governing rule: A POSITIVE MATCH PROVES EXISTENCE; A NEGATIVE PROVES
// NOTHING BEYOND THE SCOPE THAT WAS SEARCHED.
//
// Finding an appointment for a patient is decisive: it exists. Finding none is
// only ever "none within what we retrieved", and that scope has to travel with
// the number. Conflating the two is how "1,412 patients have appointments"
// became a claim that 1,436 patients were "definitively answered" — which the
// ledger does not support, because only 101 patients have had their complete
// history retrieved.

/** Where a linked patient sits relative to the completed scheduled-date sweep. */
export type SweepMembership =
  /** An intake submission with no DrChrono patient id: outside every patient metric. */
  | "unlinked_submission"
  /** Linked before the sweep finished, so the sweep's windows covered them. */
  | "in_sweep_snapshot"
  /** Linked after the sweep's last window completed; needs a catch-up pass. */
  | "added_after_sweep";

/** How much of a patient's own history has been retrieved. */
export type HistoryCoverage =
  /** ?patient= with since=1970 completed: the patient's WHOLE history is known. */
  | "history_complete"
  /** A probe was attempted and did not finish, or errored. */
  | "history_partial_or_failed"
  /** Never probed. Only the horizon-bounded sweep covers this patient. */
  | "history_not_retrieved";

/** What is known about this patient's appointments within the searched scope. */
export type AppointmentEvidence =
  | "appointment_found_in_scope"
  | "no_appointment_in_scope";

/** Per-APPOINTMENT transition retrieval state. */
export type TransitionCoverage =
  /** A verbose fetch covered it and it genuinely has no transitions. */
  | "transitions_retrieved_empty"
  /** A verbose fetch covered it and returned history. */
  | "transitions_retrieved_present"
  /**
   * Never fetched verbosely. The absence of transition rows means NOTHING here.
   * Phase A of the backfill was non-verbose, so most appointments are in this
   * state, and a metric that reads "no transitions" as "never progressed" would
   * be reading the retrieval strategy, not the patient.
   */
  | "transitions_not_retrieved";

/**
 * The horizon the scheduled-date sweep actually covered, proven contiguous from
 * the window ledger rather than asserted. Any "no appointment" statement that
 * rests on the sweep alone is bounded by these dates.
 */
export type SweepHorizon = {
  from: string;
  to: string;
  contiguous: boolean;
  windows_complete: number;
};

/**
 * The exact sentence a negative result is allowed to be reported with.
 *
 * This exists so the bound is written once and reused, instead of being
 * paraphrased (and softened) at each call site.
 */
export function boundedNegativeClaim(
  history: HistoryCoverage,
  horizon: SweepHorizon,
  asOf: string,
): string {
  if (history === "history_complete") {
    return (
      `No appointment on record at all: a patient-filtered retrieval with no date bound ` +
      `completed for this patient as at ${asOf}.`
    );
  }
  return (
    `No appointment scheduled between ${horizon.from} and ${horizon.to} ` +
    `(a contiguous, gap-free sweep of ${horizon.windows_complete} windows), as at ${asOf}. ` +
    `This does NOT establish that the patient has never booked: an appointment scheduled ` +
    `outside that horizon would not have been seen, and no patient-filtered retrieval has ` +
    `been completed for them.`
  );
}

/**
 * Whether a creation-time outcome window can be answered exactly for a patient.
 *
 * Subtle and important: a metric keyed on when an appointment RECORD WAS
 * CREATED can be satisfied by an appointment SCHEDULED far in the future. The
 * sweep is bounded by scheduled date, not creation date, so an appointment
 * created inside the window but scheduled beyond the horizon is invisible to
 * it. Only a completed patient-filtered retrieval closes that hole.
 *
 * So: positives from the sweep are real, but "none" is exact only for
 * history-complete patients. Everyone else yields a LOWER BOUND.
 */
export function canAnswerCreationWindowExactly(history: HistoryCoverage): boolean {
  return history === "history_complete";
}

/** SQL fragments, kept beside the model they implement. */
export const COVERAGE_SQL = {
  /** Patients whose complete history has been retrieved. */
  historyComplete: `
    SELECT patient_source_id
      FROM appointment_sync_windows
     WHERE strategy = 'patient_history' AND state = 'complete'
       AND patient_source_id IS NOT NULL`,

  /** A probe exists but did not complete. */
  historyPartial: `
    SELECT patient_source_id
      FROM appointment_sync_windows
     WHERE strategy = 'patient_history' AND state <> 'complete'
       AND patient_source_id IS NOT NULL`,

  /**
   * Proof that the sweep's union is contiguous, computed rather than trusted.
   * `gaps` must be 0 for any horizon-bounded negative claim to hold.
   */
  horizonProof: `
    WITH w AS (
      SELECT range_start, range_end,
             lag(range_end) OVER (ORDER BY range_start) AS prev_end
        FROM appointment_sync_windows
       WHERE strategy = 'scheduled_window' AND state = 'complete')
    SELECT count(*)::int                                   AS windows_complete,
           min(range_start)::text                          AS horizon_from,
           max(range_end)::text                            AS horizon_to,
           count(*) FILTER (WHERE prev_end IS NOT NULL
                              AND range_start <> prev_end + 1)::int AS gaps
      FROM w`,

  /**
   * Per-appointment transition retrieval state.
   *
   * An appointment counts as verbosely retrieved when its patient's full
   * history was retrieved, OR when it already carries at least one transition
   * (which only a verbose response could have produced). Anything else is
   * unknown — NOT empty.
   */
  transitionState: `
    CASE
      WHEN EXISTS (SELECT 1 FROM appointment_status_transitions t
                    WHERE t.source_appointment_id = s.source_appointment_id)
        THEN 'transitions_retrieved_present'
      WHEN s.patient_source_id IN (
             SELECT patient_source_id FROM appointment_sync_windows
              WHERE strategy = 'patient_history' AND state = 'complete')
        THEN 'transitions_retrieved_empty'
      ELSE 'transitions_not_retrieved'
    END`,
} as const;
