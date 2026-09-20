// Journey metric SQL. One place, so a definition cannot quietly differ between
// a dashboard, an export and a report.
//
// CONVENTIONS THAT APPLY TO EVERY QUERY HERE
//
// 1. Entry periods filter on the PACIFIC CALENDAR DAY of the entry instant.
//    "Which month did this patient come in" is a local-calendar question.
// 2. Follow-up windows are ELAPSED DURATIONS (N x 24h from the entry instant),
//    never calendar days, and they are written as `(N * 24) || ' hours'` for a
//    concrete reason: in PostgreSQL `timestamptz + interval '7 days'` is
//    CALENDAR arithmetic evaluated in the SESSION time zone, so across a DST
//    boundary it spans 169 or 167 hours, not 168. Two cohorts would then get
//    different amounts of time and stop being comparable, and the result would
//    silently depend on the connection's TimeZone setting. Interval arithmetic
//    in hours is immune to both. Instants are stored as UTC and never shifted.
// 3. FIRST ENTRY IS COMPUTED ACROSS ALL AVAILABLE HISTORY, THEN the entry
//    period filter is applied. Doing it the other way round makes a returning
//    patient look like a new one whenever their earlier submission falls
//    outside the selected month.
// 4. Cohorts are counted in DISTINCT LINKED PATIENT IDS. Where one human could
//    hold two charts, that is a chart count, not a person count, and the label
//    says so.
// 5. Registration and insurance cohorts overlap by design. Never add them.

export const DEFINITION_VERSION = "1.0.0";

/** Pacific-day bounds for an entry period. $1 = from, $2 = to (exclusive). */
const ENTRY_PERIOD_FILTER = `
      AND (e.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= $1::date
      AND (e.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  $2::date`;

/**
 * Registration -> consultation FORM SUBMITTED.
 *
 * Deliberately named for what it measures. It is not booking and not
 * attendance: both forms are things a patient filled in.
 *
 * Entry  : the patient's FIRST identified registration, across all history.
 * Outcome: their FIRST consultation submitted strictly after that entry.
 *
 * A consultation that predates the registration is not an outcome, but it also
 * does not disqualify the patient — a later one still counts, which is why the
 * outcome is a correlated subquery rather than a global min() joined on.
 *
 * $1 from (Pacific day), $2 to exclusive, $3 as_of instant, $4 window days.
 */
export const REGISTRATION_TO_CONSULTATION = `
WITH first_registration AS (
  SELECT n8n_patient_id::text AS patient_id, min(created_at) AS entry_at
    FROM submissions
   WHERE form_type = 'registration' AND n8n_patient_id IS NOT NULL
   GROUP BY 1
),
entries AS (
  SELECT e.patient_id, e.entry_at,
         (SELECT min(s.created_at) FROM submissions s
           WHERE s.n8n_patient_id::text = e.patient_id
             AND s.form_type = 'consultation'
             AND s.created_at > e.entry_at) AS outcome_at
    FROM first_registration e
   WHERE true ${ENTRY_PERIOD_FILTER}
)
SELECT
  count(*)::int                                                        AS cohort,
  count(*) FILTER (WHERE outcome_at IS NOT NULL)::int                  AS observed_converted,
  -- Mature denominator: only entries that have HAD the full window available.
  count(*) FILTER (WHERE entry_at + (($4::int * 24) || ' hours')::interval <= $3::timestamptz)::int
                                                                       AS mature_cohort,
  count(*) FILTER (WHERE entry_at + (($4::int * 24) || ' hours')::interval <= $3::timestamptz
                     AND outcome_at IS NOT NULL
                     AND outcome_at <= entry_at + (($4::int * 24) || ' hours')::interval)::int
                                                                       AS mature_converted,
  count(*) FILTER (WHERE outcome_at IS NOT NULL)::int                  AS matched,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (outcome_at - entry_at)) / 86400.0)
    FILTER (WHERE outcome_at IS NOT NULL)                              AS p50_days,
  percentile_cont(0.75) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (outcome_at - entry_at)) / 86400.0)
    FILTER (WHERE outcome_at IS NOT NULL)                              AS p75_days,
  percentile_cont(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (outcome_at - entry_at)) / 86400.0)
    FILTER (WHERE outcome_at IS NOT NULL)                              AS p90_days
FROM entries`;

/**
 * Insurance inquiry -> registration.
 *
 * Eligibility is the whole difficulty. A patient who was ALREADY registered
 * before the inquiry cannot "convert" to registration, so they are reported
 * separately rather than sitting in the denominator dragging the rate down.
 *
 * "Not previously registered" is bounded by the intake history we hold, which
 * starts 2026-06-15. For an inquiry near that boundary we cannot see whether an
 * earlier registration existed, so eligibility there is UNKNOWN rather than
 * assumed — `eligibility_unknown` counts those and they are excluded from the
 * rate instead of being silently treated as eligible.
 *
 * $1 from, $2 to exclusive, $3 as_of, $4 window days, $5 intake history start.
 */
export const INSURANCE_TO_REGISTRATION = `
WITH first_inquiry AS (
  SELECT n8n_patient_id::text AS patient_id, min(created_at) AS entry_at
    FROM submissions
   WHERE form_type = 'insurance' AND n8n_patient_id IS NOT NULL
   GROUP BY 1
),
entries AS (
  SELECT e.patient_id, e.entry_at,
         (SELECT min(s.created_at) FROM submissions s
           WHERE s.n8n_patient_id::text = e.patient_id
             AND s.form_type = 'registration') AS first_reg_any,
         (SELECT min(s.created_at) FROM submissions s
           WHERE s.n8n_patient_id::text = e.patient_id
             AND s.form_type = 'registration'
             AND s.created_at > e.entry_at)   AS outcome_at
    FROM first_inquiry e
   WHERE true ${ENTRY_PERIOD_FILTER}
),
classified AS (
  SELECT *,
    CASE
      WHEN first_reg_any IS NOT NULL AND first_reg_any <= entry_at THEN 'already_registered'
      -- Too close to the start of intake history to rule out an earlier one.
      WHEN first_reg_any IS NULL
           AND entry_at < $5::timestamptz + interval '1 day'        THEN 'eligibility_unknown'
      ELSE 'eligible'
    END AS eligibility
    FROM entries
)
SELECT
  count(*)::int                                                            AS entries_total,
  count(*) FILTER (WHERE eligibility = 'already_registered')::int          AS already_registered,
  count(*) FILTER (WHERE eligibility = 'eligibility_unknown')::int         AS eligibility_unknown,
  count(*) FILTER (WHERE eligibility = 'eligible')::int                    AS eligible,
  count(*) FILTER (WHERE eligibility = 'eligible' AND outcome_at IS NOT NULL)::int
                                                                           AS observed_converted,
  count(*) FILTER (WHERE eligibility = 'eligible'
                     AND entry_at + (($4::int * 24) || ' hours')::interval <= $3::timestamptz)::int
                                                                           AS mature_cohort,
  count(*) FILTER (WHERE eligibility = 'eligible'
                     AND entry_at + (($4::int * 24) || ' hours')::interval <= $3::timestamptz
                     AND outcome_at IS NOT NULL
                     AND outcome_at <= entry_at + (($4::int * 24) || ' hours')::interval)::int
                                                                           AS mature_converted,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (outcome_at - entry_at)) / 86400.0)
    FILTER (WHERE eligibility = 'eligible' AND outcome_at IS NOT NULL)     AS p50_days
FROM classified`;

/**
 * Appointment-record evidence following intake.
 *
 * WHAT THIS IS NOT: proof that a human booked at that moment. It is the
 * timestamp on the appointment RECORD. A record can be created by staff long
 * after the call, or back-filled after the visit. The names say "record".
 *
 * Four mutually-exclusive-by-definition measures come out of one pass:
 *
 *  record_created_after_entry        — a record was created after entry and
 *                                      within the window. Plain evidence.
 *  forward_scheduled                 — the above, AND created before the time
 *                                      it was scheduled for. Conservative: it
 *                                      is the subset that looks like a genuine
 *                                      forward booking.
 *  created_at_or_after_scheduled     — created at or after its own scheduled
 *                                      time. Its own category: neither bad data
 *                                      to discard nor an advance booking.
 *  predates_intake                   — a record that existed before entry,
 *                                      split into a PAST visit and an ALREADY
 *                                      SCHEDULED future visit. Having one of
 *                                      these does not disqualify a patient from
 *                                      the booking measures above.
 *
 * DELETED / CANCELLED / ARCHIVED: counted as evidence that a record was
 * created, because that is what these measure. Current state is reported
 * separately so a cancelled booking is never silently erased from history.
 *
 * $1 from, $2 to exclusive, $3 as_of, $4 window days, $5 entry form_type.
 */
export const APPOINTMENT_EVIDENCE_AFTER_ENTRY = `
WITH first_entry AS (
  SELECT n8n_patient_id::text AS patient_id, min(created_at) AS entry_at
    FROM submissions
   WHERE form_type = $5 AND n8n_patient_id IS NOT NULL
   GROUP BY 1
),
entries AS (
  SELECT e.patient_id, e.entry_at FROM first_entry e
   WHERE true ${ENTRY_PERIOD_FILTER}
),
history_complete AS (
  SELECT patient_source_id FROM appointment_sync_windows
   WHERE strategy = 'patient_history' AND state = 'complete' AND patient_source_id IS NOT NULL
),
-- Every appointment for cohort patients, classified once. A patient may have
-- many; they are aggregated per patient below so nobody is counted twice.
appt AS (
  SELECT e.patient_id, e.entry_at, s.source_appointment_id,
         s.source_created_at, s.scheduled_time, s.deleted_flag, s.current_status,
         (s.source_created_at >  e.entry_at
          AND s.source_created_at <= e.entry_at + (($4::int * 24) || ' hours')::interval) AS in_window,
         (s.source_created_at <  s.scheduled_time)                            AS forward,
         (s.source_created_at >= s.scheduled_time)                            AS at_or_after,
         (s.source_created_at <= e.entry_at)                                  AS predates_entry,
         (s.scheduled_time    <  e.entry_at)                                  AS past_visit
    FROM entries e
    JOIN appointment_snapshots s ON s.patient_source_id = e.patient_id
   WHERE s.source_created_at IS NOT NULL
),
per_patient AS (
  SELECT e.patient_id,
         (e.patient_id IN (SELECT patient_source_id FROM history_complete)) AS history_complete,
         -- COALESCE IS LOAD-BEARING: bool_or over no rows returns NULL, and
         -- NOT NULL is itself NULL, so a patient with NO appointments at all would
         -- fall out of every FILTER below, including the unresolved count, which
         -- exists precisely to account for them.
         COALESCE(bool_or(a.in_window), false)                       AS any_in_window,
         COALESCE(bool_or(a.in_window AND a.forward), false)         AS any_forward,
         COALESCE(bool_or(a.in_window AND a.at_or_after), false)     AS any_at_or_after,
         COALESCE(bool_or(a.predates_entry AND a.past_visit), false) AS any_prior_past_visit,
         COALESCE(bool_or(a.predates_entry AND NOT a.past_visit), false) AS any_prior_future_booking,
         -- earliest qualifying creation, for time-to-record. Other appointments
         -- are deliberately NOT discarded; they stay in the appt CTE for later use.
         min(a.source_created_at) FILTER (WHERE a.in_window)         AS first_in_window_created,
         COALESCE(bool_or(a.in_window AND a.deleted_flag), false)    AS any_in_window_deleted
    FROM entries e
    LEFT JOIN appt a ON a.patient_id = e.patient_id
   GROUP BY 1, 2
)
SELECT
  count(*)::int                                                    AS cohort,
  count(*) FILTER (WHERE history_complete)::int                    AS cohort_history_complete,
  count(*) FILTER (WHERE entry_matured)::int                       AS mature_cohort,
  count(*) FILTER (WHERE any_in_window)::int                       AS record_created_after_entry,
  count(*) FILTER (WHERE any_forward)::int                         AS forward_scheduled,
  count(*) FILTER (WHERE any_at_or_after)::int                     AS created_at_or_after_scheduled,
  count(*) FILTER (WHERE any_prior_past_visit)::int                AS prior_past_visit,
  count(*) FILTER (WHERE any_prior_future_booking)::int            AS prior_future_booking,
  count(*) FILTER (WHERE any_in_window_deleted)::int               AS in_window_record_deleted,
  -- exact-answer subset: positives are always real; "none" is only exact for
  -- history-complete patients, because a creation-window outcome can be an
  -- appointment scheduled beyond the swept horizon.
  count(*) FILTER (WHERE history_complete AND any_in_window)::int   AS exact_positive,
  count(*) FILTER (WHERE history_complete)::int                     AS exact_denominator,
  count(*) FILTER (WHERE NOT history_complete AND NOT any_in_window)::int AS unresolved,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (first_in_window_created - entry_at)) / 86400.0)
    FILTER (WHERE any_in_window)                                    AS p50_days_to_record
FROM (
  SELECT p.*, e.entry_at,
         (e.entry_at + (($4::int * 24) || ' hours')::interval <= $3::timestamptz) AS entry_matured
    FROM per_patient p JOIN entries e ON e.patient_id = p.patient_id) q`;

/**
 * Attendance — DELIBERATELY NOT IMPLEMENTED AS A LIVE CALCULATION.
 *
 * The interface and tests exist so a later task can drop a definition in, but
 * this returns `blocked`. Three independent reasons, any one of which is
 * sufficient:
 *
 *  1. Transition retrieval is incomplete. Most appointments are in
 *     `transitions_not_retrieved`, where absence of transitions says nothing.
 *  2. No approved mapping from the clinic's status vocabulary to "arrived".
 *     The values are real but their meaning is unconfirmed.
 *  3. Procedure completion is not established by any field we hold.
 *
 * Computing this over the history-complete subset and generalising it would be
 * the specific mistake this file exists to prevent: that subset is 101 patients
 * chosen by retrieval order, not a sample of the cohort.
 */
export const ATTENDANCE_BLOCKED_REASON =
  "Attendance cannot be computed: transition retrieval is incomplete (most appointments " +
  "are in transitions_not_retrieved, where absent history is a retrieval artefact, not a " +
  "patient fact); the arrival-status mapping is unconfirmed by the clinic; and procedure " +
  "completion is not established by any stored field. Computing it over the history-complete " +
  "subset would generalise from a retrieval-ordered group, not a sample.";

/** Cohort-independent data-quality and coverage counts, for the report. */
export const COVERAGE_SUMMARY = `
SELECT
  (SELECT count(*) FROM drsnip_linked_patient_ids)                              AS linked_patients,
  (SELECT count(*) FROM submissions WHERE n8n_patient_id IS NULL)               AS unlinked_submissions,
  (SELECT count(*) FROM appointment_sync_windows
    WHERE strategy='patient_history' AND state='complete')                      AS history_complete,
  (SELECT count(*) FROM appointment_sync_windows
    WHERE strategy='patient_history' AND state<>'complete')                     AS history_not_complete,
  (SELECT count(DISTINCT patient_source_id) FROM appointment_snapshots)         AS patients_with_appointment,
  (SELECT count(*) FROM appointment_snapshots)                                  AS appointments,
  (SELECT count(*) FROM appointment_snapshots s
    WHERE EXISTS (SELECT 1 FROM appointment_status_transitions t
                   WHERE t.source_appointment_id = s.source_appointment_id))    AS appts_transitions_present,
  (SELECT count(*) FROM appointment_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM appointment_status_transitions t
                       WHERE t.source_appointment_id = s.source_appointment_id)
      AND s.patient_source_id IN (SELECT patient_source_id FROM appointment_sync_windows
                                   WHERE strategy='patient_history' AND state='complete'))
                                                                                AS appts_transitions_empty_confirmed,
  (SELECT count(*) FROM appointment_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM appointment_status_transitions t
                       WHERE t.source_appointment_id = s.source_appointment_id)
      AND s.patient_source_id NOT IN (SELECT patient_source_id FROM appointment_sync_windows
                                       WHERE strategy='patient_history' AND state='complete'))
                                                                                AS appts_transitions_not_retrieved,
  (SELECT max(n8n_response_at) FROM submissions WHERE n8n_patient_id IS NOT NULL) AS latest_linkage_at,
  (SELECT max(completed_at) FROM appointment_sync_windows
    WHERE strategy='scheduled_window' AND state='complete')                     AS sweep_last_window_at`;
