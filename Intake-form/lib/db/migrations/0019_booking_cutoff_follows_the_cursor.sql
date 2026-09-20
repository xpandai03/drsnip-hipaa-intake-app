-- 0019_booking_cutoff_follows_the_cursor.sql — the booking "as at" instant now
-- moves with recurring sync.
--
-- Apply by hand, after 0015. Not registered in migrate.ts.
--
-- THE BUG THIS FIXES, BEFORE IT COULD BE SEEN. drsnip_booking_metric matures
-- every cohort against the instant the appointment data was last observed,
-- which is right: maturing against the clock would count a patient whose
-- follow-up window ran past the last observation as someone who did not book.
--
-- That instant was max(completed_at) over the per-patient history units. The
-- backfill finished on 2026-09-20, so from the moment recurring sync went live
-- that value was FROZEN. Appointment data would have gone on being refreshed
-- hourly while every booking figure kept claiming to be as at Saturday morning,
-- and each day that passed would have excluded another day of patients from the
-- mature denominator for no reason.
--
-- The cutoff now follows the incremental cursor, which is the honest statement
-- of how far the data is complete to. Nothing else in the function changes: the
-- body below is 0015's, verbatim, with the one SELECT that computes `cutoff`
-- replaced. Definitions, suppression, privileges and the boundary assertion are
-- untouched.
--
-- Idempotent. Safe to re-run.

BEGIN;

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

  -- THE INSTANT THE APPOINTMENT DATA IS COMPLETE TO.
  --
  -- Two guarantees, and the answer is the later of them:
  --
  --   * max(completed_at) over completed per-patient history units — what the
  --     backfill established, one patient at a time.
  --   * appointment_sync_state.watermark for practice_incremental — how far
  --     the hourly incremental cursor has carried that forward. It advances
  --     only on a run that read its WHOLE window, and it was initialised (0018)
  --     from min(completed_at) less an overlap, so the chain from the backfill
  --     to now has no gap in it.
  --
  -- greatest() ignores NULLs, so this is correct before the first incremental
  -- run and correct if the schedule is ever switched off.
  SELECT greatest(
           (SELECT max(w.completed_at) FROM public.appointment_sync_windows w
             WHERE w.strategy = 'patient_history' AND w.state = 'complete'),
           (SELECT st.watermark FROM public.appointment_sync_state st
             WHERE st.scope_key = 'practice_incremental')
         )
    INTO cutoff;

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

ALTER FUNCTION public.drsnip_booking_metric(text, date, date, integer) OWNER TO drsnip_metrics_fn;
REVOKE ALL ON FUNCTION public.drsnip_booking_metric(text, date, date, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Status-evidence summary. An INTERNAL aid so the clinic can answer "which of
-- these mean the patient arrived" against what actually occurs. It asserts no
-- meaning, and groups under the threshold are withheld so a rare status cannot
-- identify the handful of people it belongs to.
-- ---------------------------------------------------------------------------

-- Ownership and privileges, restated so this file is safe on its own.
ALTER FUNCTION public.drsnip_booking_metric(text, date, date, integer) OWNER TO drsnip_metrics_fn;
REVOKE ALL ON FUNCTION public.drsnip_booking_metric(text, date, date, integer) FROM PUBLIC;
DO $ck$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['drsnip_reporting_ro', 'drsnip_intake_demo'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.drsnip_booking_metric(text, date, date, integer) TO %I', r);
    END IF;
  END LOOP;
  IF has_function_privilege('public', 'public.drsnip_booking_metric(text, date, date, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute drsnip_booking_metric';
  END IF;
  RAISE NOTICE 'booking cutoff now follows the incremental cursor';
END $ck$;

COMMIT;
