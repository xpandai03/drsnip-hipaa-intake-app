// Booking evidence, computed against the APPOINTMENT SNAPSHOT — not "now".
//
// THE CENTRAL CORRECTION IN THIS FILE. Appointment data is complete only up to
// a particular instant. Intake submissions keep arriving after that. So the two
// have different as-of times,
// and a cohort must be matured against the APPOINTMENT cutoff, never the clock:
// otherwise a patient who registered 20 days ago is counted in a 14-day
// booking denominator even though the last 6 of those days were never
// observed, which silently manufactures non-bookers.
//
// The snapshot cutoff is derived from the ledger, not hard-coded.
//
// WHAT THESE MEASURE, AND WHAT THEY DO NOT
//   * "Appointment recorded"      — a record exists whose SOURCE CREATION
//                                   timestamp falls after entry. It is the
//                                   timestamp on the record, not proof of when
//                                   a human booked.
//   * "Advance booking recorded"  — the subset created BEFORE its scheduled
//                                   time. Conservative, and the only one that
//                                   looks like a genuine forward booking.
//   * "Recorded at/after its time" — its own category. Not invalid data, and
//                                   deliberately excluded from advance-booking
//                                   timing.
//   * "Predating entry"           — split into a PAST visit and an appointment
//                                   already scheduled for a FUTURE date.
//   * "Currently scheduled"       — present position, not history. A patient
//                                   who ever booked is not necessarily booked now.
//
// None of these is attendance, and none is "a vasectomy booking": appointment
// profile names are unreadable (403), so type is not established.

export const BOOKING_DEFINITION_VERSION = "2.0.0";

/**
 * The instant the appointment data is COMPLETE TO.
 *
 * The later of two guarantees (migration 0019):
 *
 *   * max(completed_at) over completed per-patient history units — what the
 *     historical backfill established, one patient at a time.
 *   * appointment_sync_state.watermark for practice_incremental — how far the
 *     hourly incremental cursor has carried that forward. It moves only on a
 *     run that read its whole window, and it was initialised from
 *     min(completed_at) less an overlap, so there is no gap between the two.
 *
 * It was max(completed_at) alone until recurring sync went live, at which point
 * that value would have frozen on the day the backfill finished while the data
 * itself went on being refreshed hourly — every booking figure claiming an
 * as-at that got a day staler each day, excluding a day more of patients from
 * the mature denominator each time.
 *
 * Every appointment figure is "as at" this, and maturity is measured against
 * it, never against the clock.
 */
export const APPOINTMENT_SNAPSHOT_CUTOFF = `
  SELECT greatest(
           (SELECT max(completed_at) FROM appointment_sync_windows
             WHERE strategy='patient_history' AND state='complete'),
           (SELECT watermark FROM appointment_sync_state
             WHERE scope_key='practice_incremental')
         ) AS cutoff,
         count(*)::int      AS units_complete,
         (SELECT count(*)::int FROM appointment_sync_windows
           WHERE strategy='patient_history' AND state<>'complete') AS units_incomplete,
         (SELECT count(*)::int FROM drsnip_linked_patient_ids v
           WHERE NOT EXISTS (SELECT 1 FROM appointment_sync_windows w
                              WHERE w.strategy='patient_history'
                                AND w.patient_source_id = v.patient_source_id)) AS linked_without_unit
    FROM appointment_sync_windows
   WHERE strategy='patient_history' AND state='complete'`;

/**
 * Booking evidence for one entry cohort.
 *
 * $1 entry_from (Pacific day)  $2 entry_to exclusive  $3 window days
 * $4 entry form_type ('registration' | 'insurance')
 *
 * The snapshot cutoff is read inside the query so a caller cannot pass a later
 * instant and inflate maturity.
 */
export const BOOKING_EVIDENCE = `
WITH snap AS (
  -- See APPOINTMENT_SNAPSHOT_CUTOFF: the later of the backfill's completion and
  -- the incremental cursor. greatest() ignores NULLs, so this is right before
  -- the first incremental run and right if the schedule is switched off.
  SELECT greatest(
           (SELECT max(completed_at) FROM appointment_sync_windows
             WHERE strategy='patient_history' AND state='complete'),
           (SELECT watermark FROM appointment_sync_state
             WHERE scope_key='practice_incremental')
         ) AS cutoff
),
covered AS (
  -- Patients whose own history retrieval completed. After Phase B this is
  -- every linked patient, but it is COMPUTED, not assumed: a patient linked
  -- after the snapshot would not be in here.
  SELECT patient_source_id FROM appointment_sync_windows
   WHERE strategy='patient_history' AND state='complete' AND patient_source_id IS NOT NULL
),
first_entry AS (
  SELECT s.n8n_patient_id::text AS pid, min(s.created_at) AS entry_at
    FROM submissions s
   WHERE s.n8n_patient_id IS NOT NULL AND s.form_type = $4
   GROUP BY 1
),
e AS (
  SELECT fe.pid, fe.entry_at,
         (fe.pid IN (SELECT patient_source_id FROM covered))            AS covered,
         -- Matured against the SNAPSHOT, not now.
         (fe.entry_at + (($3::int * 24) || ' hours')::interval <= snap.cutoff) AS matured
    FROM first_entry fe, snap
   WHERE (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= $1::date
     AND (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  $2::date
),
a AS (
  SELECT e.pid, e.entry_at,
         s.source_appointment_id, s.source_created_at, s.scheduled_time,
         s.deleted_flag, s.current_status,
         (s.source_created_at >  e.entry_at
          AND s.source_created_at <= e.entry_at + (($3::int * 24) || ' hours')::interval) AS in_window,
         (s.source_created_at <  s.scheduled_time)  AS advance,
         (s.source_created_at >= s.scheduled_time)  AS at_or_after,
         (s.source_created_at <= e.entry_at)        AS predates,
         (s.scheduled_time    <  e.entry_at)        AS past_visit
    FROM e JOIN appointment_snapshots s ON s.patient_source_id = e.pid
   WHERE s.source_created_at IS NOT NULL
),
pp AS (
  SELECT e.pid, e.entry_at, e.covered, e.matured,
         -- A patient is counted ONCE per measure however many appointments
         -- they hold. Cancellation does not erase the booking evidence: a
         -- deleted or cancelled record still proves a record was created.
         coalesce(bool_or(a.in_window), false)                              AS any_recorded,
         coalesce(bool_or(a.in_window AND a.advance), false)                AS any_advance,
         coalesce(bool_or(a.in_window AND a.at_or_after), false)            AS any_at_or_after,
         coalesce(bool_or(a.predates AND a.past_visit), false)              AS prior_past,
         coalesce(bool_or(a.predates AND NOT a.past_visit), false)          AS prior_future,
         coalesce(bool_or(a.in_window AND a.deleted_flag), false)           AS recorded_then_deleted,
         coalesce(bool_or(a.in_window AND a.current_status = 'Cancelled'), false) AS recorded_then_cancelled,
         -- Earliest qualifying ADVANCE booking, for time-to-booking. Records
         -- created at/after their scheduled time are excluded from this timing
         -- deliberately; they are not forward bookings.
         min(a.source_created_at) FILTER (WHERE a.in_window AND a.advance)  AS first_advance_at
    FROM e LEFT JOIN a ON a.pid = e.pid
   GROUP BY 1,2,3,4
)
SELECT
  (SELECT cutoff FROM snap)                                        AS snapshot_cutoff,
  count(*)::int                                                    AS cohort_total,
  count(*) FILTER (WHERE covered)::int                             AS cohort_covered,
  count(*) FILTER (WHERE NOT covered)::int                         AS cohort_not_covered,
  count(*) FILTER (WHERE covered AND matured)::int                 AS eligible,
  count(*) FILTER (WHERE covered AND NOT matured)::int             AS immature,
  count(*) FILTER (WHERE covered AND matured AND any_recorded)::int      AS recorded,
  count(*) FILTER (WHERE covered AND matured AND any_advance)::int       AS advance_booking,
  count(*) FILTER (WHERE covered AND matured AND any_at_or_after)::int   AS at_or_after_scheduled,
  count(*) FILTER (WHERE covered AND matured AND prior_past)::int        AS prior_past_visit,
  count(*) FILTER (WHERE covered AND matured AND prior_future)::int      AS prior_future_booking,
  count(*) FILTER (WHERE covered AND matured AND recorded_then_deleted)::int   AS recorded_then_deleted,
  count(*) FILTER (WHERE covered AND matured AND recorded_then_cancelled)::int AS recorded_then_cancelled,
  count(*) FILTER (WHERE covered AND matured AND NOT any_recorded)::int  AS none_recorded,
  count(*) FILTER (WHERE NOT covered)::int                              AS unresolved,
  count(*) FILTER (WHERE covered AND matured AND any_advance)::int       AS matched_for_timing,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY extract(epoch FROM (first_advance_at - entry_at))/86400.0)
    FILTER (WHERE covered AND matured AND any_advance)              AS p50_days_to_advance
FROM pp`;

/**
 * Current appointment position — present state, not history.
 *
 * Implemented ONLY as a status distribution over the latest-scheduled
 * appointment per patient. It deliberately does NOT claim "currently booked":
 * that would need an approved reading of which statuses are live, which is the
 * same unapproved decision attendance is waiting on.
 *
 * $1 entry_from  $2 entry_to exclusive  $3 entry form_type
 */
export const CURRENT_POSITION = `
WITH first_entry AS (
  SELECT s.n8n_patient_id::text AS pid, min(s.created_at) AS entry_at
    FROM submissions s WHERE s.n8n_patient_id IS NOT NULL AND s.form_type = $3
   GROUP BY 1
),
e AS (SELECT * FROM first_entry
       WHERE (entry_at AT TIME ZONE 'America/Los_Angeles')::date >= $1::date
         AND (entry_at AT TIME ZONE 'America/Los_Angeles')::date <  $2::date),
latest AS (
  SELECT DISTINCT ON (s.patient_source_id)
         s.patient_source_id, s.current_status, s.scheduled_time, s.deleted_flag
    FROM appointment_snapshots s JOIN e ON e.pid = s.patient_source_id
   ORDER BY s.patient_source_id, s.scheduled_time DESC NULLS LAST
)
SELECT
  count(*)::int                                                        AS patients_with_any_appointment,
  count(*) FILTER (WHERE scheduled_time > (SELECT max(completed_at) FROM appointment_sync_windows
                                            WHERE strategy='patient_history' AND state='complete'))::int
                                                                       AS latest_is_in_the_future,
  count(*) FILTER (WHERE deleted_flag)::int                            AS latest_record_deleted,
  -- Exact source labels, never interpreted. Small groups are suppressed by the
  -- caller; this returns the raw distribution inside the trusted boundary.
  jsonb_object_agg(coalesce(nullif(current_status,''), '(blank)'), n)  AS status_distribution
FROM (SELECT l.*, count(*) OVER (PARTITION BY coalesce(nullif(l.current_status,''),'(blank)')) AS n
        FROM latest l) q`;

/**
 * Status-evidence summary — an INTERNAL aid for the clinic decision.
 *
 * Exact source labels with counts, so staff can answer "which of these mean
 * the patient arrived" against what actually occurs, rather than a guess. It
 * asserts no meaning and is not an attendance figure.
 */
export const STATUS_EVIDENCE = `
SELECT t.to_status AS status,
       count(*)::int                                    AS transitions,
       count(DISTINCT t.source_appointment_id)::int     AS appointments,
       count(DISTINCT s.patient_source_id)::int         AS patients
  FROM appointment_status_transitions t
  JOIN appointment_snapshots s ON s.source_appointment_id = t.source_appointment_id
 WHERE t.missing_since IS NULL
 GROUP BY 1
 ORDER BY 2 DESC`;
