-- 0022_one_evidence_cutoff.sql — one appointment-data cutoff, and it must be true for everyone.
--
-- Apply by hand, after 0021. NOT registered in migrate.ts: like 0014–0021 it
-- replaces functions owned by drsnip_metrics_fn.
--
-- ============================ THE DEFECT ===================================
-- 0019 (booking), 0020 (attendance) and 0021 (monthly outcomes) took their
-- "appointment data is complete to" instant as
--
--     greatest(max(patient_history completed_at), practice_incremental watermark)
--
-- A patient_history completed_at is ONE patient's full-history read. Taking the
-- MAXIMUM over them applies one patient's guarantee to everyone: every
-- 10-minute new-patient catch-up pushed the claimed cutoff past what the
-- practice-wide incremental sync had actually read (production, 7 days: every
-- catch-up, median 36 minutes, about a third of the time). Worse, if the hourly
-- incremental sync stalled, catch-ups would keep advancing the cutoff and the
-- stale warning — driven by the cutoff's age — would never fire.
-- (DRSNIP_REPORTING_MEANING_AND_ACCURACY_AUDIT.md §3.)
--
-- ============================ THE RULE =====================================
-- drsnip_evidence_cutoff() is now the ONLY source, for every calculation and
-- for the freshness badge:
--
--   1. practice_incremental watermark. It is the run_cutoff of the last
--      incremental run that read its WHOLE window with outcome 'success'
--      (lib/sync/appointment-sync.sql); failed, partial, budget-exhausted and
--      lock-contended runs cannot move it. Every covered patient is complete to
--      at least this instant: backfilled patients are carried forward by the
--      cursor, and a patient caught up since is complete to their own later
--      read. Catch-up reads never move it.
--   2. Only if there is no watermark: the EARLIEST completed patient_history
--      read. With no incremental sync ever completed, each covered patient is
--      complete to their own read and to nothing later, so the minimum is the
--      one instant true for all of them. (0018 seeded the cursor the same way.)
--   3. Otherwise NULL — 'unavailable'. Nothing is invented.
--
-- KNOWN LIMITATION, stated rather than hidden: appointment_snapshots holds each
-- record's CURRENT state. A patient read after the watermark may already carry
-- changes newer than it; those cannot be rewound. The cutoff is therefore a
-- guaranteed lower bound — "complete to at least" — and "future" is judged
-- against it.
--
-- ============================ WHAT IT DOES NOT CHANGE ======================
-- No signature, owner or grant of an existing function; no appointment-type
-- inclusion, status rule, cohort rule, scope or approval. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.drsnip_evidence_cutoff()
RETURNS TABLE (cutoff timestamptz, basis text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(w.watermark, b.baseline),
         CASE WHEN w.watermark IS NOT NULL THEN 'incremental_watermark'
              WHEN b.baseline  IS NOT NULL THEN 'history_baseline'
              ELSE 'unavailable' END
    FROM (SELECT (SELECT st.watermark FROM public.appointment_sync_state st
                   WHERE st.scope_key = 'practice_incremental') AS watermark) w,
         (SELECT (SELECT min(x.completed_at) FROM public.appointment_sync_windows x
                   WHERE x.strategy = 'patient_history' AND x.state = 'complete') AS baseline) b;
$$;

ALTER FUNCTION public.drsnip_evidence_cutoff() OWNER TO drsnip_metrics_fn;
REVOKE ALL ON FUNCTION public.drsnip_evidence_cutoff() FROM PUBLIC;
DO $$
BEGIN
  -- Two timestamps and a label: nothing about any patient.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_evidence_cutoff() TO drsnip_intake_demo';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_evidence_cutoff() TO drsnip_reporting_ro';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The five callers. Each body is its current definition (0017 / 0019 / 0020 /
-- 0021, identical to production) with ONLY the cutoff lines replaced, plus an
-- explicit 'unavailable' path where the cutoff is NULL. CREATE OR REPLACE keeps
-- each function's owner and grants.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drsnip_journey_freshness()
RETURNS TABLE (
  intake_latest_at          timestamptz,
  appointments_synced_at    timestamptz,
  appointment_sync_active   boolean,
  history_complete_patients integer,
  linked_patients           integer,
  awaiting_catchup          integer,
  sync_last_success_at      timestamptz,
  sync_last_attempt_at      timestamptz,
  sync_run_state            text,
  sync_cursor_lag_seconds   integer,
  sync_expected_interval_minutes integer,
  sync_schedule_enabled     boolean,
  sync_failed_runs_24h      integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'
AS $$
  WITH inc AS (
    SELECT * FROM public.drsnip_sync_health() WHERE scope_key = 'practice_incremental'
  )
  SELECT
    (SELECT max(s.created_at) FROM public.submissions s),
    -- The instant appointment data is complete to: the ONE shared cutoff (0022).
    (SELECT ec.cutoff FROM public.drsnip_evidence_cutoff() ec),
    coalesce((SELECT i.recurring_active FROM inc i), false),
    (SELECT count(*)::int FROM public.appointment_sync_windows w
      WHERE w.strategy = 'patient_history' AND w.state = 'complete'),
    (SELECT count(DISTINCT s.n8n_patient_id)::int FROM public.submissions s
      WHERE s.n8n_patient_id IS NOT NULL),
    (SELECT count(*)::int FROM (
        SELECT DISTINCT s.n8n_patient_id::text AS pid FROM public.submissions s
         WHERE s.n8n_patient_id IS NOT NULL
      ) l
      WHERE NOT EXISTS (
        SELECT 1 FROM public.appointment_sync_windows w
         WHERE w.strategy = 'patient_history' AND w.state = 'complete'
           AND w.patient_source_id = l.pid)),
    (SELECT i.last_success_at FROM inc i),
    (SELECT i.last_attempt_at FROM inc i),
    coalesce((SELECT i.run_state FROM inc i), 'not_scheduled'),
    (SELECT i.cursor_lag_seconds FROM inc i),
    (SELECT i.expected_interval_minutes FROM inc i),
    coalesce((SELECT i.enabled FROM inc i), false),
    coalesce((SELECT i.runs_failed_24h FROM inc i), 0);
$$;


CREATE OR REPLACE FUNCTION public.drsnip_booking_metric(
  p_metric      text,
  p_entry_from  date,
  p_entry_to    date,          -- exclusive
  p_window_days integer
)
RETURNS TABLE (
  metric                 text,
  snapshot_cutoff        timestamptz,
  cohort_total           integer,
  cohort_covered         integer,
  cohort_not_covered     integer,
  eligible               integer,   -- covered AND matured against the snapshot
  immature               integer,
  recorded               integer,
  advance_booking        integer,
  at_or_after_scheduled  integer,
  prior_past_visit       integer,
  prior_future_booking   integer,
  recorded_then_deleted  integer,
  recorded_then_cancelled integer,
  none_recorded          integer,
  matched                integer,
  p50_days_to_advance    numeric,
  status                 text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '15s'
SET lock_timeout = '3s'
AS $fn$
DECLARE
  k        constant integer := 5;
  form     text;
  w_iv     interval;
  cutoff   timestamptz;
  r        record;
  small    boolean := false;
BEGIN
  IF p_metric IS NULL OR p_metric NOT IN ('booking_registration', 'booking_insurance') THEN
    RAISE EXCEPTION 'unsupported metric' USING ERRCODE = '22023';
  END IF;
  IF p_window_days IS NULL OR p_window_days NOT IN (7, 14, 30) THEN
    RAISE EXCEPTION 'unsupported window' USING ERRCODE = '22023';
  END IF;
  IF p_entry_from IS NULL OR p_entry_to IS NULL OR p_entry_to <= p_entry_from THEN
    RAISE EXCEPTION 'invalid entry period' USING ERRCODE = '22023';
  END IF;
  IF p_entry_from < DATE '2026-01-01' OR (p_entry_to - p_entry_from) > 400 THEN
    RAISE EXCEPTION 'entry period out of bounds' USING ERRCODE = '22023';
  END IF;
  p_entry_to := least(p_entry_to, (now() AT TIME ZONE 'America/Los_Angeles')::date + 2);

  form := CASE WHEN p_metric = 'booking_registration' THEN 'registration' ELSE 'insurance' END;
  -- Elapsed hours, never calendar days: `+ interval 'N days'` on a timestamptz
  -- is calendar arithmetic in the session time zone and spans 169 hours across
  -- a DST boundary.
  w_iv := ((p_window_days * 24) || ' hours')::interval;

  -- THE INSTANT THE APPOINTMENT DATA IS COMPLETE TO: the one shared cutoff
  -- (0022, drsnip_evidence_cutoff). NULL means no valid cutoff exists, and the
  -- metric says so rather than maturing anyone against nothing.
  SELECT ec.cutoff INTO cutoff FROM public.drsnip_evidence_cutoff() ec;
  IF cutoff IS NULL THEN
    metric := p_metric; snapshot_cutoff := NULL; status := 'unavailable';
    RETURN NEXT; RETURN;
  END IF;

  WITH covered AS (
    SELECT w.patient_source_id FROM public.appointment_sync_windows w
     WHERE w.strategy='patient_history' AND w.state='complete' AND w.patient_source_id IS NOT NULL
  ),
  first_entry AS (
    SELECT s.n8n_patient_id::text AS pid, min(s.created_at) AS entry_at
      FROM public.submissions s
     WHERE s.n8n_patient_id IS NOT NULL AND s.form_type = form
     GROUP BY 1
  ),
  e AS (
    SELECT fe.pid, fe.entry_at,
           (fe.pid IN (SELECT patient_source_id FROM covered)) AS is_covered,
           -- MATURED AGAINST THE SNAPSHOT, NOT now(). Using the clock would
           -- count a patient whose window ran past the last observation as
           -- someone who did not book.
           (fe.entry_at + w_iv <= cutoff) AS matured
      FROM first_entry fe
     WHERE (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= p_entry_from
       AND (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  p_entry_to
  ),
  a AS (
    SELECT e.pid, e.entry_at, s.source_created_at, s.scheduled_time,
           s.deleted_flag, s.current_status,
           (s.source_created_at >  e.entry_at AND s.source_created_at <= e.entry_at + w_iv) AS in_window,
           (s.source_created_at <  s.scheduled_time) AS advance,
           (s.source_created_at >= s.scheduled_time) AS at_or_after,
           (s.source_created_at <= e.entry_at)       AS predates,
           (s.scheduled_time    <  e.entry_at)       AS past_visit
      FROM e JOIN public.appointment_snapshots s ON s.patient_source_id = e.pid
     WHERE s.source_created_at IS NOT NULL
  ),
  pp AS (
    SELECT e.pid, e.entry_at, e.is_covered, e.matured,
           coalesce(bool_or(a.in_window), false)                     AS any_recorded,
           coalesce(bool_or(a.in_window AND a.advance), false)       AS any_advance,
           coalesce(bool_or(a.in_window AND a.at_or_after), false)   AS any_after,
           coalesce(bool_or(a.predates AND a.past_visit), false)     AS prior_past,
           coalesce(bool_or(a.predates AND NOT a.past_visit), false) AS prior_future,
           coalesce(bool_or(a.in_window AND a.deleted_flag), false)  AS then_deleted,
           coalesce(bool_or(a.in_window AND a.current_status='Cancelled'), false) AS then_cancelled,
           min(a.source_created_at) FILTER (WHERE a.in_window AND a.advance) AS first_advance
      FROM e LEFT JOIN a ON a.pid = e.pid
     GROUP BY 1,2,3,4
  )
  SELECT count(*)::int                                                  AS c_total,
         count(*) FILTER (WHERE is_covered)::int                        AS c_cov,
         count(*) FILTER (WHERE NOT is_covered)::int                    AS c_notcov,
         count(*) FILTER (WHERE is_covered AND matured)::int            AS elig,
         count(*) FILTER (WHERE is_covered AND NOT matured)::int        AS imm,
         count(*) FILTER (WHERE is_covered AND matured AND any_recorded)::int AS rec,
         count(*) FILTER (WHERE is_covered AND matured AND any_advance)::int  AS adv,
         count(*) FILTER (WHERE is_covered AND matured AND any_after)::int    AS aft,
         count(*) FILTER (WHERE is_covered AND matured AND prior_past)::int   AS ppast,
         count(*) FILTER (WHERE is_covered AND matured AND prior_future)::int AS pfut,
         count(*) FILTER (WHERE is_covered AND matured AND then_deleted)::int AS tdel,
         count(*) FILTER (WHERE is_covered AND matured AND then_cancelled)::int AS tcan,
         count(*) FILTER (WHERE is_covered AND matured AND NOT any_recorded)::int AS nonerec,
         count(*) FILTER (WHERE is_covered AND matured AND any_advance)::int  AS matched_n,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY extract(epoch FROM (first_advance - entry_at))/86400.0)
           FILTER (WHERE is_covered AND matured AND any_advance)        AS p50
    INTO r FROM pp;

  metric := p_metric; snapshot_cutoff := cutoff;
  cohort_total := r.c_total; cohort_covered := r.c_cov; cohort_not_covered := r.c_notcov;
  eligible := r.elig; immature := r.imm; recorded := r.rec;
  advance_booking := r.adv; at_or_after_scheduled := r.aft;
  prior_past_visit := r.ppast; prior_future_booking := r.pfut;
  recorded_then_deleted := r.tdel; recorded_then_cancelled := r.tcan;
  none_recorded := r.nonerec; matched := r.matched_n; p50_days_to_advance := r.p50;

  -- ---- suppression, inside the boundary --------------------------------
  IF cohort_total BETWEEN 1 AND k-1 THEN small := true; END IF;
  IF eligible     BETWEEN 1 AND k-1 THEN small := true; END IF;
  -- A small complement is as disclosive as a small cell.
  IF eligible IS NOT NULL AND recorded IS NOT NULL
     AND (eligible - recorded) BETWEEN 1 AND k-1 THEN small := true; END IF;

  IF small THEN
    cohort_total := NULL; cohort_covered := NULL; cohort_not_covered := NULL;
    eligible := NULL; immature := NULL; recorded := NULL; advance_booking := NULL;
    at_or_after_scheduled := NULL; prior_past_visit := NULL; prior_future_booking := NULL;
    recorded_then_deleted := NULL; recorded_then_cancelled := NULL; none_recorded := NULL;
    matched := NULL; p50_days_to_advance := NULL;
    status := 'suppressed';
  ELSE
    IF recorded                BETWEEN 1 AND k-1 THEN recorded := NULL; END IF;
    IF advance_booking         BETWEEN 1 AND k-1 THEN advance_booking := NULL; END IF;
    IF at_or_after_scheduled   BETWEEN 1 AND k-1 THEN at_or_after_scheduled := NULL; END IF;
    IF prior_past_visit        BETWEEN 1 AND k-1 THEN prior_past_visit := NULL; END IF;
    IF prior_future_booking    BETWEEN 1 AND k-1 THEN prior_future_booking := NULL; END IF;
    IF recorded_then_deleted   BETWEEN 1 AND k-1 THEN recorded_then_deleted := NULL; END IF;
    IF recorded_then_cancelled BETWEEN 1 AND k-1 THEN recorded_then_cancelled := NULL; END IF;
    IF none_recorded           BETWEEN 1 AND k-1 THEN none_recorded := NULL; END IF;
    IF cohort_not_covered      BETWEEN 1 AND k-1 THEN cohort_not_covered := NULL; END IF;
    IF immature                BETWEEN 1 AND k-1 THEN immature := NULL; END IF;
    -- A percentile over a handful of people describes those people.
    IF matched BETWEEN 1 AND k-1 THEN matched := NULL; p50_days_to_advance := NULL; END IF;
    status := CASE WHEN eligible = 0 THEN 'zero_denominator' ELSE 'ok' END;
  END IF;

  RETURN NEXT;
END;
$fn$;


CREATE OR REPLACE FUNCTION public.drsnip_attendance_evidence(
  p_labels     jsonb,
  p_metric     text,
  p_entry_from date,
  p_entry_to   date,
  p_window_days integer
)
RETURNS TABLE (
  cohort_total        integer,
  cohort_covered      integer,
  eligible            integer,
  immature            integer,
  arrived_in_window   integer,
  arrived_untimed     integer,
  arrived_outside     integer,
  not_established     integer,
  remote_only         integer,
  in_window_deleted_only integer,
  evidence_as_of      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  form   text;
  w_iv   interval;
  cutoff timestamptz;
BEGIN
  IF p_metric IS NULL OR p_metric NOT IN ('attendance_registration', 'attendance_insurance') THEN
    RAISE EXCEPTION 'unsupported metric' USING ERRCODE = '22023';
  END IF;
  IF p_window_days IS NULL OR p_window_days NOT IN (7, 14, 30) THEN
    RAISE EXCEPTION 'unsupported window' USING ERRCODE = '22023';
  END IF;
  IF p_entry_from IS NULL OR p_entry_to IS NULL OR p_entry_to <= p_entry_from
     OR p_entry_from < DATE '2026-01-01' OR (p_entry_to - p_entry_from) > 400 THEN
    RAISE EXCEPTION 'invalid entry period' USING ERRCODE = '22023';
  END IF;

  form := CASE WHEN p_metric = 'attendance_registration' THEN 'registration' ELSE 'insurance' END;
  -- Elapsed hours, never calendar days: a DST boundary makes `interval 'N days'`
  -- 169 hours and silently gives one cohort extra time.
  w_iv := ((p_window_days * 24) || ' hours')::interval;

  -- The instant appointment data is COMPLETE to: the one shared cutoff (0022).
  -- Maturity is measured against this, never against now(). With no valid
  -- cutoff there is no evidence to report: every column NULL.
  SELECT ec.cutoff INTO cutoff FROM public.drsnip_evidence_cutoff() ec;
  IF cutoff IS NULL THEN
    RETURN QUERY SELECT NULL::integer, NULL::integer, NULL::integer, NULL::integer, NULL::integer,
                        NULL::integer, NULL::integer, NULL::integer, NULL::integer, NULL::integer,
                        NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY
  WITH lbl AS (
    SELECT x.source_column, x.raw_label, x.classification
      FROM jsonb_to_recordset(coalesce(p_labels, '[]'::jsonb))
        AS x(source_column text, raw_label text, classification text)
     WHERE x.classification IN ('physically_present', 'remote_presence')
  ),
  covered AS (
    SELECT w.patient_source_id FROM public.appointment_sync_windows w
     WHERE w.strategy = 'patient_history' AND w.state = 'complete'
       AND w.patient_source_id IS NOT NULL
  ),
  first_entry AS (
    SELECT s.n8n_patient_id::text AS pid, min(s.created_at) AS entry_at
      FROM public.submissions s
     WHERE s.n8n_patient_id IS NOT NULL AND s.form_type = form
     GROUP BY 1
  ),
  e AS (
    SELECT fe.pid, fe.entry_at,
           (fe.pid IN (SELECT patient_source_id FROM covered)) AS is_covered,
           (fe.entry_at + w_iv <= cutoff)                      AS matured
      FROM first_entry fe
     WHERE (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= p_entry_from
       AND (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  p_entry_to
  ),
  -- Per appointment: the earliest TIMED physical arrival, whether any physical
  -- evidence exists at all, and whether any of it is remote.
  appt AS (
    SELECT a.source_appointment_id AS aid,
           a.patient_source_id     AS pid,
           a.deleted_flag,
           -- Timed: a transition to a physically-present label with a usable
           -- timestamp. This is the ONLY thing that can be placed in a window.
           min(t.transition_at) FILTER (
             WHERE t.transition_at IS NOT NULL
               AND EXISTS (SELECT 1 FROM lbl l
                            WHERE l.source_column = 'transition'
                              AND l.classification = 'physically_present'
                              AND l.raw_label IS NOT DISTINCT FROM t.to_status)
           ) AS timed_arrival_at,
           -- Untimed: a physically-present transition with no timestamp.
           coalesce(bool_or(
             t.transition_at IS NULL
             AND EXISTS (SELECT 1 FROM lbl l
                          WHERE l.source_column = 'transition'
                            AND l.classification = 'physically_present'
                            AND l.raw_label IS NOT DISTINCT FROM t.to_status)
           ), false) AS untimed_transition,
           -- Current status is evidence of the same vocabulary, but it carries
           -- no arrival time. source_updated_at is the row's last touch, not an
           -- arrival, and must never be used as one.
           EXISTS (SELECT 1 FROM lbl l
                    WHERE l.source_column = 'current_status'
                      AND l.classification = 'physically_present'
                      AND l.raw_label IS NOT DISTINCT FROM a.current_status) AS current_physical,
           (EXISTS (SELECT 1 FROM lbl l
                     WHERE l.source_column = 'current_status'
                       AND l.classification = 'remote_presence'
                       AND l.raw_label IS NOT DISTINCT FROM a.current_status)
            OR coalesce(bool_or(
                 EXISTS (SELECT 1 FROM lbl l
                          WHERE l.source_column = 'transition'
                            AND l.classification = 'remote_presence'
                            AND l.raw_label IS NOT DISTINCT FROM t.to_status)
               ), false)) AS remote_evidence
      FROM public.appointment_snapshots a
      LEFT JOIN public.appointment_status_transitions t
        ON t.source_appointment_id = a.source_appointment_id AND t.missing_since IS NULL
     GROUP BY 1, 2, 3, a.current_status
  ),
  -- Per patient, against their own entry instant and window.
  pp AS (
    SELECT e.pid, e.entry_at, e.is_covered, e.matured,
           -- Deletion at source does not erase the observation that was made.
           -- Booking excludes deleted records from its counts; attendance keeps
           -- their evidence and reports separately how much rests on one.
           coalesce(bool_or(ap.timed_arrival_at >  e.entry_at
                        AND ap.timed_arrival_at <= e.entry_at + w_iv), false) AS in_window,
           coalesce(bool_or(ap.timed_arrival_at >  e.entry_at
                        AND ap.timed_arrival_at <= e.entry_at + w_iv
                        AND ap.deleted_flag), false)                          AS in_window_deleted,
           coalesce(bool_or(ap.timed_arrival_at >  e.entry_at
                        AND ap.timed_arrival_at <= e.entry_at + w_iv
                        AND NOT ap.deleted_flag), false)                      AS in_window_live,
           coalesce(bool_or(ap.untimed_transition OR ap.current_physical), false) AS untimed,
           coalesce(bool_or(ap.timed_arrival_at IS NOT NULL), false)          AS any_timed,
           coalesce(bool_or(ap.remote_evidence), false)                       AS remote
      FROM e LEFT JOIN appt ap ON ap.pid = e.pid
     GROUP BY 1, 2, 3, 4
  ),
  -- Mutually exclusive, in this order. A patient counts ONCE however many
  -- appointments they have: "did they come" is a question about the person.
  cls AS (
    SELECT pp.*,
           CASE
             WHEN in_window                THEN 'in_window'
             -- Untimed evidence MIGHT be inside the window; we cannot say. It
             -- gets its own bucket rather than being guessed either way.
             WHEN untimed                  THEN 'untimed'
             WHEN any_timed                THEN 'outside'
             ELSE 'none'
           END AS bucket
      FROM pp
  )
  SELECT
    count(*)::int                                                        AS cohort_total,
    count(*) FILTER (WHERE is_covered)::int                              AS cohort_covered,
    count(*) FILTER (WHERE is_covered AND matured)::int                  AS eligible,
    count(*) FILTER (WHERE is_covered AND NOT matured)::int              AS immature,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'in_window')::int AS arrived_in_window,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'untimed')::int   AS arrived_untimed,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'outside')::int   AS arrived_outside,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'none')::int      AS not_established,
    count(*) FILTER (WHERE is_covered AND matured AND bucket <> 'in_window'
                       AND bucket <> 'untimed' AND remote)::int          AS remote_only,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'in_window'
                       AND in_window_deleted AND NOT in_window_live)::int AS in_window_deleted_only,
    cutoff
  FROM cls;
END;
$fn$;


CREATE OR REPLACE FUNCTION public.drsnip_outcome_classify(
  p_roles jsonb, p_rules jsonb, p_form text, p_month_from date, p_month_to date
)
RETURNS TABLE (
  entry_month                     date,
  pid                             text,
  is_covered                      boolean,
  bucket                          text,
  neither_reason                  text,
  r_past_dated_open               boolean,
  r_status_unresolved             boolean,
  r_rescheduled_no_replacement    boolean,
  r_conflicting_history           boolean,
  r_deleted_completion            boolean,
  r_undecided_profile             boolean,
  r_unknown_profile               boolean,
  a_completed_with_future_booking boolean,
  a_completed_review_withheld_only boolean,
  a_procedure_not_performed       boolean,
  a_comparison_completed          boolean,
  a_comparison_scheduled          boolean,
  a_positive_booked_before_entry  boolean,
  a_prior_completion_before_entry boolean,
  a_registered_before_inquiry     boolean,
  a_repeat_submitter              boolean,
  evidence_cutoff                 timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $classify$
-- >>> OUTCOME CLASSIFY BODY >>>
WITH
rules AS (
  SELECT
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'completion'))                 AS completion,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'completion_review_withheld')) AS review_withheld,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'procedure_not_performed'))    AS pnp,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'active_if_future'))           AS active,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'ended_not_active'))           AS ended,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'replaced'))                   AS replaced
),
roles AS (
  SELECT x.profile_source_id, x.role
    FROM jsonb_to_recordset(p_roles) AS x(profile_source_id text, role text)
),
-- The instant appointment data is complete to: the one shared cutoff (0022).
-- "Future" is judged against THIS, never against now().
cutoff AS (
  SELECT ec.cutoff AS c FROM public.drsnip_evidence_cutoff() ec
),
covered AS (
  SELECT DISTINCT w.patient_source_id AS pid
    FROM public.appointment_sync_windows w
   WHERE w.strategy = 'patient_history' AND w.state = 'complete' AND w.patient_source_id IS NOT NULL
),
-- One row per linked chart at its FIRST submission of this form ever. A repeat
-- submission never creates a second entry; it is flagged.
fe AS (
  SELECT s.n8n_patient_id AS pid_n, min(s.created_at) AS entry_at, count(*) AS n_subs
    FROM public.submissions s
   WHERE s.n8n_patient_id IS NOT NULL AND s.form_type = p_form
   GROUP BY 1
),
e AS (
  SELECT fe.pid_n::text AS pid, fe.entry_at, fe.n_subs,
         (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date                    AS entry_day,
         date_trunc('month', fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date AS entry_month,
         EXISTS (SELECT 1 FROM covered c WHERE c.pid = fe.pid_n::text)              AS is_covered,
         -- Insurance only: a registration already on file BEFORE the inquiry.
         (p_form = 'insurance' AND EXISTS (
            SELECT 1 FROM public.submissions r
             WHERE r.n8n_patient_id = fe.pid_n AND r.form_type = 'registration'
               AND r.created_at < fe.entry_at))                                    AS registered_before
    FROM fe
   WHERE (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= p_month_from
     AND (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  p_month_to
),
a AS (
  SELECT e.pid, s.source_appointment_id AS aid, s.source_created_at, s.current_status,
         s.deleted_flag,
         coalesce(ro.role, 'unknown_profile') AS role,
         CASE
           WHEN s.current_status = ANY (rl.completion) THEN 'completion'
           WHEN s.current_status = ANY (rl.pnp)        THEN 'pnp'
           WHEN s.current_status = ANY (rl.active)
                AND s.scheduled_time > (SELECT c FROM cutoff) THEN 'active'
           WHEN s.current_status = ANY (rl.active)     THEN 'past_open'
           WHEN s.current_status = ANY (rl.ended)      THEN 'ended'
           WHEN s.current_status = ANY (rl.replaced)   THEN 'replaced'
           ELSE 'unresolved_status'   -- blank, NULL, in-clinic, or never seen before
         END AS sclass,
         coalesce(s.current_status = ANY (rl.review_withheld), false) AS review_withheld,
         -- Relevant from the entry CLINIC day. An undated record cannot be
         -- placed before entry, so it is not discarded as pre-entry.
         coalesce((s.scheduled_time AT TIME ZONE 'America/Los_Angeles')::date >= e.entry_day, true) AS after_entry,
         coalesce(s.source_created_at < e.entry_at, false) AS created_before_entry,
         EXISTS (SELECT 1 FROM public.appointment_status_transitions t
                  WHERE t.source_appointment_id = s.source_appointment_id
                    AND t.missing_since IS NULL
                    AND t.to_status = ANY (rl.completion)) AS history_completion
    FROM e
    JOIN public.appointment_snapshots s ON s.patient_source_id = e.pid
    CROSS JOIN rules rl
    LEFT JOIN roles ro ON ro.profile_source_id = s.profile_source_id
),
ax AS (
  SELECT a.*,
         (NOT a.deleted_flag AND a.after_entry)      AS live,
         (a.role = 'qualifying')                     AS q,
         -- A later-created record that COULD be a replacement. Existence only:
         -- no pairing by time proximity, no claim that it IS the replacement.
         EXISTS (SELECT 1 FROM a b
                  WHERE b.pid = a.pid AND b.aid <> a.aid AND NOT b.deleted_flag
                    AND b.role IN ('qualifying', 'inclusion_undecided', 'unknown_profile')
                    AND b.source_created_at > a.source_created_at) AS has_later_record
    FROM a
),
pp AS (
  SELECT e.entry_month, e.pid, e.is_covered, e.n_subs, e.registered_before,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'completion'), false) AS q_completed,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'active'), false)     AS q_active,
    coalesce(bool_or(ax.live AND ax.q), false)                              AS q_any,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'completion' AND NOT ax.review_withheld), false) AS q_completed_with_review,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'past_open'), false)          AS r_past_dated_open,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'unresolved_status'), false)  AS r_status_unresolved,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'replaced' AND NOT ax.has_later_record), false) AS r_rescheduled_no_replacement,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass <> 'completion' AND ax.history_completion), false) AS r_conflicting_history,
    coalesce(bool_or(ax.deleted_flag AND ax.after_entry AND ax.q AND ax.sclass = 'completion'), false) AS r_deleted_completion,
    coalesce(bool_or(ax.live AND ax.role = 'inclusion_undecided'
                     AND ax.sclass IN ('completion', 'active', 'past_open', 'unresolved_status')), false) AS r_undecided_profile,
    coalesce(bool_or(ax.live AND ax.role = 'unknown_profile'
                     AND ax.sclass IN ('completion', 'active', 'past_open', 'unresolved_status')), false) AS r_unknown_profile,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'pnp'), false)                AS a_pnp,
    coalesce(bool_or(ax.live AND ax.role = 'comparison' AND ax.sclass IN ('completion', 'pnp')), false) AS a_cmp_completed,
    coalesce(bool_or(ax.live AND ax.role = 'comparison' AND ax.sclass = 'active'), false) AS a_cmp_active,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass IN ('completion', 'active') AND ax.created_before_entry), false) AS a_booked_before,
    coalesce(bool_or(NOT ax.deleted_flag AND NOT ax.after_entry AND ax.q AND ax.sclass = 'completion'), false) AS a_prior_completion
    FROM e LEFT JOIN ax ON ax.pid = e.pid
   GROUP BY e.entry_month, e.pid, e.is_covered, e.n_subs, e.registered_before
),
cls AS (
  SELECT pp.*,
         CASE
           WHEN NOT pp.is_covered THEN 'not_covered'
           WHEN pp.q_completed    THEN 'completed'
           WHEN pp.q_active       THEN 'scheduled'
           WHEN pp.r_past_dated_open OR pp.r_status_unresolved OR pp.r_rescheduled_no_replacement
             OR pp.r_conflicting_history OR pp.r_deleted_completion
             OR pp.r_undecided_profile OR pp.r_unknown_profile THEN 'unknown'
           ELSE 'neither'
         END AS bucket
    FROM pp
)
SELECT cls.entry_month, cls.pid, cls.is_covered, cls.bucket,
       CASE WHEN cls.bucket <> 'neither' THEN NULL
            WHEN cls.q_any THEN 'had_qualifying_record'
            ELSE 'no_qualifying_record' END,
       cls.r_past_dated_open, cls.r_status_unresolved, cls.r_rescheduled_no_replacement,
       cls.r_conflicting_history, cls.r_deleted_completion, cls.r_undecided_profile, cls.r_unknown_profile,
       (cls.q_completed AND cls.q_active),
       (cls.q_completed AND NOT cls.q_completed_with_review),
       cls.a_pnp, cls.a_cmp_completed, cls.a_cmp_active, cls.a_booked_before, cls.a_prior_completion,
       cls.registered_before, (cls.n_subs > 1),
       (SELECT c FROM cutoff)
  FROM cls
-- <<< OUTCOME CLASSIFY BODY <<<
$classify$;


CREATE OR REPLACE FUNCTION public.drsnip_outcome_metric(
  p_metric text, p_scope text, p_month_from date, p_month_to date
)
RETURNS TABLE (
  entry_month                      date,
  row_status                       text,
  entry_period_complete            boolean,
  days_observed_min                numeric,
  days_observed_max                numeric,
  cohort_total                     integer,
  covered                          integer,
  not_covered                      integer,
  unlinked_submissions             integer,
  completed                        integer,
  scheduled                        integer,
  unknown                          integer,
  neither                          integer,
  neither_no_qualifying_record     integer,
  neither_had_qualifying_record    integer,
  unknown_past_dated_open          integer,
  unknown_status_unresolved        integer,
  unknown_rescheduled_no_replacement integer,
  unknown_conflicting_history      integer,
  unknown_deleted_completion       integer,
  unknown_undecided_profile        integer,
  unknown_unknown_profile          integer,
  completed_with_future_booking    integer,
  completed_review_withheld_only   integer,
  procedure_not_performed          integer,
  comparison_completed             integer,
  comparison_scheduled             integer,
  positive_booked_before_entry     integer,
  prior_completion_before_entry    integer,
  registered_before_inquiry        integer,
  repeat_submitters                integer,
  withheld                         text[],
  scope_key                        text,
  scope_version                    integer,
  scope_state                      text,
  status_rules_version             text,
  evidence_cutoff                  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  k        constant integer := 5;
  form     text;
  sc       record;
  rl       record;
  cut      timestamptz;
  m        date;
  m_start  timestamptz;
  m_end    timestamptz;
  c        record;
  v        integer[];
  hide     boolean[];
  n_hidden integer;
  smallest integer;
  i        integer;
  part_hidden boolean;
  cell     integer;
BEGIN
  IF p_metric IS NULL OR p_metric NOT IN ('outcome_registration', 'outcome_insurance') THEN
    RAISE EXCEPTION 'unsupported metric' USING ERRCODE = '22023';
  END IF;
  IF p_month_from IS NULL OR p_month_to IS NULL
     OR p_month_from <> date_trunc('month', p_month_from)::date
     OR p_month_to   <> date_trunc('month', p_month_to)::date
     OR p_month_to <= p_month_from
     OR p_month_from < DATE '2026-01-01'
     OR p_month_to > (p_month_from + interval '13 months')::date THEN
    RAISE EXCEPTION 'invalid entry period' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO sc FROM public.outcome_reporting_scopes s
   WHERE s.scope_key = p_scope AND s.state <> 'superseded';
  IF sc IS NULL THEN
    RAISE EXCEPTION 'unsupported scope' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO rl FROM public.outcome_status_rules r WHERE r.version = sc.status_rules_version;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(sc.profile_roles) AS x(profile_source_id text, role text)
              WHERE x.role NOT IN ('qualifying', 'comparison', 'excluded_known', 'inclusion_undecided')
                 OR x.profile_source_id IS NULL) THEN
    RAISE EXCEPTION 'malformed scope' USING ERRCODE = '22023';
  END IF;

  form := CASE WHEN p_metric = 'outcome_registration' THEN 'registration' ELSE 'insurance' END;

  -- The one shared cutoff (0022). NULL = no valid cutoff: every month is
  -- reported 'unavailable' with no counts, rather than classified against NULL.
  SELECT ec.cutoff INTO cut FROM public.drsnip_evidence_cutoff() ec;

  FOR c IN
    WITH cl AS (
      SELECT * FROM public.drsnip_outcome_classify(
        sc.profile_roles, rl.rules, form, p_month_from, p_month_to)
    ),
    agg AS (
      SELECT cl.entry_month AS em,
        count(*)::int                                                         AS n_total,
        count(*) FILTER (WHERE cl.is_covered)::int                            AS n_cov,
        count(*) FILTER (WHERE NOT cl.is_covered)::int                        AS n_notcov,
        count(*) FILTER (WHERE cl.bucket = 'completed')::int                  AS n_comp,
        count(*) FILTER (WHERE cl.bucket = 'scheduled')::int                  AS n_sched,
        count(*) FILTER (WHERE cl.bucket = 'unknown')::int                    AS n_unk,
        count(*) FILTER (WHERE cl.bucket = 'neither')::int                    AS n_nei,
        count(*) FILTER (WHERE cl.neither_reason = 'no_qualifying_record')::int  AS n_nei_none,
        count(*) FILTER (WHERE cl.neither_reason = 'had_qualifying_record')::int AS n_nei_had,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_past_dated_open)::int            AS u1,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_status_unresolved)::int          AS u2,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_rescheduled_no_replacement)::int AS u3,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_conflicting_history)::int        AS u4,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_deleted_completion)::int         AS u5,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_undecided_profile)::int          AS u6,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_unknown_profile)::int            AS u7,
        count(*) FILTER (WHERE cl.bucket = 'completed' AND cl.a_completed_with_future_booking)::int  AS a1,
        count(*) FILTER (WHERE cl.bucket = 'completed' AND cl.a_completed_review_withheld_only)::int AS a2,
        count(*) FILTER (WHERE cl.is_covered AND cl.bucket <> 'completed' AND cl.a_procedure_not_performed)::int AS a3,
        count(*) FILTER (WHERE cl.is_covered AND cl.bucket <> 'completed' AND cl.a_comparison_completed)::int    AS a4,
        count(*) FILTER (WHERE cl.is_covered AND cl.bucket NOT IN ('completed', 'scheduled') AND cl.a_comparison_scheduled)::int AS a5,
        count(*) FILTER (WHERE cl.bucket IN ('completed', 'scheduled') AND cl.a_positive_booked_before_entry)::int AS a6,
        count(*) FILTER (WHERE cl.is_covered AND cl.a_prior_completion_before_entry)::int AS a7,
        count(*) FILTER (WHERE cl.a_registered_before_inquiry)::int           AS a8,
        count(*) FILTER (WHERE cl.a_repeat_submitter)::int                    AS a9
        FROM cl GROUP BY 1
    ),
    -- Submissions no chart was ever linked to. SUBMISSIONS, not people: two of
    -- them may be the same person, and nobody is deduplicated by assumption.
    unl AS (
      SELECT date_trunc('month', s.created_at AT TIME ZONE 'America/Los_Angeles')::date AS em,
             count(*)::int AS n
        FROM public.submissions s
       WHERE s.n8n_patient_id IS NULL AND s.form_type = form
         AND (s.created_at AT TIME ZONE 'America/Los_Angeles')::date >= p_month_from
         AND (s.created_at AT TIME ZONE 'America/Los_Angeles')::date <  p_month_to
       GROUP BY 1
    ),
    months AS (
      SELECT g::date AS em FROM generate_series(p_month_from, p_month_to - 1, interval '1 month') g
    )
    SELECT months.em, agg.*, coalesce(unl.n, 0) AS n_unl
      FROM months
      LEFT JOIN agg ON agg.em = months.em
      LEFT JOIN unl ON unl.em = months.em
     ORDER BY months.em
  LOOP
    m := c.em;
    -- Month boundaries as instants on the clinic calendar (DST-correct).
    m_start := m::timestamp AT TIME ZONE 'America/Los_Angeles';
    m_end   := (m + interval '1 month')::timestamp AT TIME ZONE 'America/Los_Angeles';

    entry_month := m;
    entry_period_complete := (m_end <= cut);
    -- How long the YOUNGEST and OLDEST possible entrant has been observed. A
    -- month still open has a youngest entrant observed for no time at all.
    days_observed_min := round(greatest(0, extract(epoch FROM (cut - least(m_end, cut))) / 86400.0)::numeric, 1);
    days_observed_max := round(greatest(0, extract(epoch FROM (cut - m_start)) / 86400.0)::numeric, 1);
    scope_key := sc.scope_key; scope_version := sc.version; scope_state := sc.state;
    status_rules_version := sc.status_rules_version; evidence_cutoff := cut;
    withheld := ARRAY[]::text[];

    unlinked_submissions := CASE WHEN c.n_unl BETWEEN 1 AND k - 1 THEN NULL ELSE c.n_unl END;
    IF unlinked_submissions IS NULL THEN withheld := array_append(withheld, 'unlinked_submissions_small'); END IF;

    cohort_total := coalesce(c.n_total, 0); covered := coalesce(c.n_cov, 0); not_covered := coalesce(c.n_notcov, 0);
    completed := coalesce(c.n_comp, 0); scheduled := coalesce(c.n_sched, 0);
    unknown := coalesce(c.n_unk, 0); neither := coalesce(c.n_nei, 0);
    neither_no_qualifying_record := coalesce(c.n_nei_none, 0);
    neither_had_qualifying_record := coalesce(c.n_nei_had, 0);
    unknown_past_dated_open := coalesce(c.u1, 0); unknown_status_unresolved := coalesce(c.u2, 0);
    unknown_rescheduled_no_replacement := coalesce(c.u3, 0); unknown_conflicting_history := coalesce(c.u4, 0);
    unknown_deleted_completion := coalesce(c.u5, 0); unknown_undecided_profile := coalesce(c.u6, 0);
    unknown_unknown_profile := coalesce(c.u7, 0);
    completed_with_future_booking := coalesce(c.a1, 0); completed_review_withheld_only := coalesce(c.a2, 0);
    procedure_not_performed := coalesce(c.a3, 0); comparison_completed := coalesce(c.a4, 0);
    comparison_scheduled := coalesce(c.a5, 0); positive_booked_before_entry := coalesce(c.a6, 0);
    prior_completion_before_entry := coalesce(c.a7, 0);
    registered_before_inquiry := coalesce(c.a8, 0); repeat_submitters := coalesce(c.a9, 0);

    IF cut IS NULL THEN
      row_status := 'unavailable';
      withheld := array_append(withheld, 'evidence_cutoff_unavailable');
      cohort_total := NULL; covered := NULL; not_covered := NULL;
      completed := NULL; scheduled := NULL; unknown := NULL; neither := NULL;
      neither_no_qualifying_record := NULL; neither_had_qualifying_record := NULL;
      unknown_past_dated_open := NULL; unknown_status_unresolved := NULL;
      unknown_rescheduled_no_replacement := NULL; unknown_conflicting_history := NULL;
      unknown_deleted_completion := NULL; unknown_undecided_profile := NULL; unknown_unknown_profile := NULL;
      completed_with_future_booking := NULL; completed_review_withheld_only := NULL;
      procedure_not_performed := NULL; comparison_completed := NULL; comparison_scheduled := NULL;
      positive_booked_before_entry := NULL; prior_completion_before_entry := NULL;
      registered_before_inquiry := NULL; repeat_submitters := NULL;
      entry_period_complete := NULL; days_observed_min := NULL; days_observed_max := NULL;
    ELSIF m_start > cut THEN
      row_status := 'not_started';
    ELSIF cohort_total = 0 THEN
      row_status := 'empty';
    ELSIF covered BETWEEN 1 AND k - 1 THEN
      -- Too few people to say anything about outcomes at all.
      row_status := 'suppressed';
      withheld := array_append(withheld, 'covered_cohort_small');
      cohort_total := NULL; covered := NULL; not_covered := NULL;
      completed := NULL; scheduled := NULL; unknown := NULL; neither := NULL;
      neither_no_qualifying_record := NULL; neither_had_qualifying_record := NULL;
      unknown_past_dated_open := NULL; unknown_status_unresolved := NULL;
      unknown_rescheduled_no_replacement := NULL; unknown_conflicting_history := NULL;
      unknown_deleted_completion := NULL; unknown_undecided_profile := NULL; unknown_unknown_profile := NULL;
      completed_with_future_booking := NULL; completed_review_withheld_only := NULL;
      procedure_not_performed := NULL; comparison_completed := NULL; comparison_scheduled := NULL;
      positive_booked_before_entry := NULL; prior_completion_before_entry := NULL;
      registered_before_inquiry := NULL; repeat_submitters := NULL;
    ELSE
      row_status := 'ok';

      -- Coverage. A small uncovered count is withheld with the total it would
      -- be recovered from; `covered` — the bucket denominator — stays.
      IF not_covered BETWEEN 1 AND k - 1 THEN
        not_covered := NULL; cohort_total := NULL;
        withheld := array_append(withheld, 'not_covered_small');
      END IF;

      -- The partition. Identical algorithm to suppressPartition() and to 0020.
      v := ARRAY[completed, scheduled, unknown, neither];
      hide := ARRAY[false, false, false, false];
      FOR i IN 1..4 LOOP IF v[i] BETWEEN 1 AND k - 1 THEN hide[i] := true; END IF; END LOOP;
      n_hidden := 0;
      FOR i IN 1..4 LOOP IF hide[i] THEN n_hidden := n_hidden + 1; END IF; END LOOP;
      IF n_hidden > 0 THEN
        WHILE n_hidden < 2 LOOP
          smallest := NULL;
          FOR i IN 1..4 LOOP
            IF NOT hide[i] AND (smallest IS NULL OR v[i] < v[smallest]) THEN smallest := i; END IF;
          END LOOP;
          EXIT WHEN smallest IS NULL;
          hide[smallest] := true; n_hidden := n_hidden + 1;
        END LOOP;
        IF n_hidden < 2 THEN hide := ARRAY[true, true, true, true]; END IF;
      END IF;
      part_hidden := hide[1] OR hide[2] OR hide[3] OR hide[4];
      IF hide[1] THEN completed := NULL; END IF;
      IF hide[2] THEN scheduled := NULL; END IF;
      IF hide[3] THEN unknown   := NULL; END IF;
      IF hide[4] THEN neither   := NULL; END IF;

      IF part_hidden THEN
        -- Every outcome annotation bounds some bucket; withhold them all.
        withheld := array_append(withheld, 'partition_small_cell');
        neither_no_qualifying_record := NULL; neither_had_qualifying_record := NULL;
        unknown_past_dated_open := NULL; unknown_status_unresolved := NULL;
        unknown_rescheduled_no_replacement := NULL; unknown_conflicting_history := NULL;
        unknown_deleted_completion := NULL; unknown_undecided_profile := NULL; unknown_unknown_profile := NULL;
        completed_with_future_booking := NULL; completed_review_withheld_only := NULL;
        procedure_not_performed := NULL; comparison_completed := NULL; comparison_scheduled := NULL;
        positive_booked_before_entry := NULL; prior_completion_before_entry := NULL;
      ELSE
        -- Neither's two sub-reasons partition it: one small one hides both.
        IF neither_no_qualifying_record BETWEEN 1 AND k - 1
           OR neither_had_qualifying_record BETWEEN 1 AND k - 1 THEN
          neither_no_qualifying_record := NULL; neither_had_qualifying_record := NULL;
          withheld := array_append(withheld, 'neither_breakdown_small');
        END IF;
        -- Overlapping annotations: plain per-cell suppression.
        IF unknown_past_dated_open BETWEEN 1 AND k - 1 THEN unknown_past_dated_open := NULL; END IF;
        IF unknown_status_unresolved BETWEEN 1 AND k - 1 THEN unknown_status_unresolved := NULL; END IF;
        IF unknown_rescheduled_no_replacement BETWEEN 1 AND k - 1 THEN unknown_rescheduled_no_replacement := NULL; END IF;
        IF unknown_conflicting_history BETWEEN 1 AND k - 1 THEN unknown_conflicting_history := NULL; END IF;
        IF unknown_deleted_completion BETWEEN 1 AND k - 1 THEN unknown_deleted_completion := NULL; END IF;
        IF unknown_undecided_profile BETWEEN 1 AND k - 1 THEN unknown_undecided_profile := NULL; END IF;
        IF unknown_unknown_profile BETWEEN 1 AND k - 1 THEN unknown_unknown_profile := NULL; END IF;
        IF completed_with_future_booking BETWEEN 1 AND k - 1 THEN completed_with_future_booking := NULL; END IF;
        IF completed_review_withheld_only BETWEEN 1 AND k - 1 THEN completed_review_withheld_only := NULL; END IF;
        IF procedure_not_performed BETWEEN 1 AND k - 1 THEN procedure_not_performed := NULL; END IF;
        IF comparison_completed BETWEEN 1 AND k - 1 THEN comparison_completed := NULL; END IF;
        IF comparison_scheduled BETWEEN 1 AND k - 1 THEN comparison_scheduled := NULL; END IF;
        IF positive_booked_before_entry BETWEEN 1 AND k - 1 THEN positive_booked_before_entry := NULL; END IF;
        IF prior_completion_before_entry BETWEEN 1 AND k - 1 THEN prior_completion_before_entry := NULL; END IF;
      END IF;

      -- Cohort facts, not outcomes: they bound no bucket.
      IF registered_before_inquiry BETWEEN 1 AND k - 1 THEN registered_before_inquiry := NULL; END IF;
      IF repeat_submitters BETWEEN 1 AND k - 1 THEN repeat_submitters := NULL; END IF;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$fn$;


-- Self-checks: the old rule must be gone, and ownership must not have moved.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['drsnip_journey_freshness', 'drsnip_booking_metric', 'drsnip_attendance_evidence',
                           'drsnip_outcome_classify', 'drsnip_outcome_metric'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = f
                AND pg_get_functiondef(p.oid) ~ 'max\(w\.completed_at\)') THEN
      RAISE EXCEPTION '% still derives its cutoff from max(completed_at)', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = f
                    AND pg_get_functiondef(p.oid) LIKE '%drsnip_evidence_cutoff()%') THEN
      RAISE EXCEPTION '% does not use drsnip_evidence_cutoff()', f;
    END IF;
    IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.proname = f) <> 'drsnip_metrics_fn' THEN
      RAISE EXCEPTION '% is no longer owned by drsnip_metrics_fn', f;
    END IF;
  END LOOP;
  IF has_function_privilege('public', 'public.drsnip_evidence_cutoff()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute drsnip_evidence_cutoff';
  END IF;
  RAISE NOTICE 'one evidence cutoff installed: %',
    (SELECT basis || ' ' || coalesce(cutoff::text, 'NULL') FROM public.drsnip_evidence_cutoff());
END $$;

COMMIT;
