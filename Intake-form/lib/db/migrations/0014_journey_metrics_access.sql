-- 0014_journey_metrics_access.sql — the aggregate reporting boundary.
--
-- PURPOSE: let the reporting role obtain journey metrics WITHOUT granting it
-- any privilege on `submissions`, `appointment_snapshots` or any other
-- PHI-bearing table. It calls one function; the function reads the tables as a
-- restricted owner and returns only suppressed aggregates.
--
-- NOT REGISTERED in api-server/migrate.ts: it creates roles, which needs
-- CREATEROLE/superuser, and that runner replays every registered step on every
-- deploy. Same reasoning as 0012a.
--
-- ============================ SECURITY NOTES ===============================
-- Each of these is deliberate; changing one silently weakens the boundary.
--
--  * OWNER IS drsnip_metrics_fn, NOT the application role. SECURITY DEFINER
--    runs as the owner, so owning this with a superuser would hand every
--    caller superuser reach through one function. drsnip_metrics_fn is NOLOGIN
--    and holds SELECT on exactly four objects.
--
--  * search_path = pg_catalog, pg_temp — and every object below is
--    schema-qualified. `public` is deliberately absent so nothing resolves
--    there implicitly. pg_temp is listed LAST and explicitly: if it were
--    omitted it would be searched FIRST, letting a caller shadow a table with
--    a temporary one of the same name.
--
--  * Metric names are matched against a FIXED ALLOW-LIST in a CASE. Nothing
--    from the caller is ever concatenated into SQL.
--
--  * Suppression happens HERE, inside the privileged boundary, so a small cell
--    never crosses it — not to the API, not to a log, not to an error message.
--
--  * statement_timeout / lock_timeout bound the cost of any single call.
--
--  * EXECUTE is revoked from PUBLIC and granted only to drsnip_reporting_ro.

-- ---------------------------------------------------------------------------
-- 1. The restricted owner.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_metrics_fn') THEN
    -- NOLOGIN: nothing ever connects as this role. It exists only to own the
    -- function and to hold the minimum read privileges it needs.
    EXECUTE 'CREATE ROLE drsnip_metrics_fn NOLOGIN';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO drsnip_metrics_fn;
REVOKE CREATE ON SCHEMA public FROM drsnip_metrics_fn;

-- Exactly what the metrics need to read. No UPDATE, INSERT or DELETE anywhere.
GRANT SELECT ON TABLE public.submissions                TO drsnip_metrics_fn;
GRANT SELECT ON TABLE public.appointment_snapshots      TO drsnip_metrics_fn;
GRANT SELECT ON TABLE public.appointment_sync_windows   TO drsnip_metrics_fn;
GRANT SELECT ON TABLE public.appointment_sync_state     TO drsnip_metrics_fn;

-- Explicitly NOT granted, so a later reader can see the intent:
REVOKE ALL ON TABLE public.users                  FROM drsnip_metrics_fn;
REVOKE ALL ON TABLE public.sessions               FROM drsnip_metrics_fn;
REVOKE ALL ON TABLE public.submission_files       FROM drsnip_metrics_fn;
REVOKE ALL ON TABLE public.registration_partials  FROM drsnip_metrics_fn;
-- appointment_status_transitions is NOT revoked here any more. Migration 0015
-- grants SELECT on it so the aggregate status-evidence summary can count which
-- status values actually occur — the input the clinic needs to decide what
-- "arrived" means. Revoking it here would fight 0015 on every replay.

-- ---------------------------------------------------------------------------
-- 2. The function.
--
-- One row out. Every count is already suppressed; NULL means withheld, and the
-- `notes` column says why.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_journey_metric(
  p_metric      text,
  p_entry_from  date,
  p_entry_to    date,          -- exclusive
  p_window_days integer
)
RETURNS TABLE (
  metric              text,
  cohort              integer,
  numerator           integer,
  denominator         integer,
  observed_numerator  integer,
  observed_denominator integer,
  secondary_a         integer,   -- metric-specific; see `notes`
  secondary_b         integer,
  secondary_c         integer,
  unresolved          integer,
  coverage_denominator integer,
  matched             integer,
  p50_days            numeric,
  p75_days            numeric,
  p90_days            numeric,
  status              text,
  notes               text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '15s'
SET lock_timeout = '3s'
AS $fn$
DECLARE
  k        constant integer := 5;      -- small-cell threshold
  as_of    constant timestamptz := now();
  w_iv     interval;
  r        record;
  small_cohort boolean := false;
BEGIN
  -- ---- validation. Anything unexpected is rejected, never coerced. --------
  IF p_metric IS NULL OR p_metric NOT IN (
       'registration_to_consultation',
       'insurance_to_registration',
       'appointment_evidence_registration',
       'appointment_evidence_insurance') THEN
    RAISE EXCEPTION 'unsupported metric' USING ERRCODE = '22023';
  END IF;

  IF p_window_days IS NULL OR p_window_days NOT IN (7, 14, 30) THEN
    RAISE EXCEPTION 'unsupported window' USING ERRCODE = '22023';
  END IF;

  IF p_entry_from IS NULL OR p_entry_to IS NULL OR p_entry_to <= p_entry_from THEN
    RAISE EXCEPTION 'invalid entry period' USING ERRCODE = '22023';
  END IF;

  -- Bounds the scan. Intake begins 2026-06-15; anything before 2026-01-01 or
  -- more than 400 days wide is a mistake or an attempt to make this expensive.
  IF p_entry_from < DATE '2026-01-01' OR (p_entry_to - p_entry_from) > 400 THEN
    RAISE EXCEPTION 'entry period out of bounds' USING ERRCODE = '22023';
  END IF;

  -- A future end date is CLAMPED, not refused. Asking for "September" means
  -- p_entry_to = 2026-10-01, which is perfectly reasonable and returns exactly
  -- the same rows as clamping to tomorrow — entries cannot exist in the
  -- future. Refusing it turned an ordinary month filter into a 400.
  p_entry_to := least(p_entry_to, (as_of AT TIME ZONE 'America/Los_Angeles')::date + 2);

  -- Elapsed hours, NOT calendar days: `+ interval 'N days'` on a timestamptz
  -- is calendar arithmetic in the session time zone and spans 169 hours across
  -- a DST boundary, which would give two cohorts different amounts of time.
  w_iv := ((p_window_days * 24) || ' hours')::interval;

  IF p_metric = 'registration_to_consultation'
     OR p_metric = 'insurance_to_registration' THEN

    WITH first_entry AS (
      SELECT s.n8n_patient_id::text AS pid, min(s.created_at) AS entry_at
        FROM public.submissions s
       WHERE s.n8n_patient_id IS NOT NULL
         AND s.form_type = CASE WHEN p_metric = 'registration_to_consultation'
                                THEN 'registration' ELSE 'insurance' END
       GROUP BY 1
    ),
    e AS (
      SELECT fe.pid, fe.entry_at,
             (SELECT min(c.created_at) FROM public.submissions c
               WHERE c.n8n_patient_id::text = fe.pid
                 AND c.form_type = CASE WHEN p_metric = 'registration_to_consultation'
                                        THEN 'consultation' ELSE 'registration' END
                 AND c.created_at > fe.entry_at) AS outcome_at,
             (SELECT min(r2.created_at) FROM public.submissions r2
               WHERE r2.n8n_patient_id::text = fe.pid
                 AND r2.form_type = 'registration'
                 AND r2.created_at <= fe.entry_at) AS prior_reg_at
        FROM first_entry fe
       WHERE (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= p_entry_from
         AND (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  p_entry_to
    ),
    c AS (
      SELECT *,
             -- Only the insurance metric has an eligibility notion.
             (p_metric = 'insurance_to_registration' AND prior_reg_at IS NOT NULL) AS excluded
        FROM e
    )
    SELECT
      count(*)::int                                                       AS cohort,
      count(*) FILTER (WHERE NOT excluded)::int                           AS eligible,
      count(*) FILTER (WHERE excluded)::int                               AS excluded_n,
      count(*) FILTER (WHERE NOT excluded AND outcome_at IS NOT NULL)::int AS obs_num,
      count(*) FILTER (WHERE NOT excluded
                         AND entry_at + w_iv <= as_of)::int               AS mat_den,
      count(*) FILTER (WHERE NOT excluded
                         AND entry_at + w_iv <= as_of
                         AND outcome_at IS NOT NULL
                         AND outcome_at <= entry_at + w_iv)::int          AS mat_num,
      count(*) FILTER (WHERE NOT excluded AND outcome_at IS NOT NULL)::int AS matched_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (outcome_at - entry_at))/86400.0)
        FILTER (WHERE NOT excluded AND outcome_at IS NOT NULL)            AS p50,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY extract(epoch FROM (outcome_at - entry_at))/86400.0)
        FILTER (WHERE NOT excluded AND outcome_at IS NOT NULL)            AS p75,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (outcome_at - entry_at))/86400.0)
        FILTER (WHERE NOT excluded AND outcome_at IS NOT NULL)            AS p90
      INTO r
      FROM c;

    metric := p_metric;
    cohort := r.cohort;
    observed_numerator := r.obs_num;
    observed_denominator := r.eligible;
    numerator := r.mat_num;
    denominator := r.mat_den;
    secondary_a := r.excluded_n;            -- excluded: already registered
    secondary_b := NULL;
    secondary_c := NULL;
    unresolved := NULL;
    coverage_denominator := NULL;
    matched := r.matched_n;
    p50_days := r.p50; p75_days := r.p75; p90_days := r.p90;
    notes := 'secondary_a = excluded (already registered before entry)';

  ELSE
    -- ---- appointment-record evidence ------------------------------------
    WITH first_entry AS (
      SELECT s.n8n_patient_id::text AS pid, min(s.created_at) AS entry_at
        FROM public.submissions s
       WHERE s.n8n_patient_id IS NOT NULL
         AND s.form_type = CASE WHEN p_metric = 'appointment_evidence_registration'
                                THEN 'registration' ELSE 'insurance' END
       GROUP BY 1
    ),
    e AS (
      SELECT fe.pid, fe.entry_at FROM first_entry fe
       WHERE (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= p_entry_from
         AND (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  p_entry_to
    ),
    hc AS (
      SELECT w.patient_source_id FROM public.appointment_sync_windows w
       WHERE w.strategy = 'patient_history' AND w.state = 'complete'
         AND w.patient_source_id IS NOT NULL
    ),
    a AS (
      SELECT e.pid, e.entry_at,
             (s.source_created_at >  e.entry_at
              AND s.source_created_at <= e.entry_at + w_iv)   AS in_window,
             (s.source_created_at <  s.scheduled_time)        AS fwd,
             (s.source_created_at >= s.scheduled_time)        AS at_or_after,
             (s.source_created_at <= e.entry_at)              AS predates,
             (s.scheduled_time    <  e.entry_at)              AS past_visit,
             s.source_created_at
        FROM e JOIN public.appointment_snapshots s ON s.patient_source_id = e.pid
       WHERE s.source_created_at IS NOT NULL
    ),
    pp AS (
      SELECT e.pid, e.entry_at,
             (e.pid IN (SELECT patient_source_id FROM hc))              AS hist_complete,
             coalesce(bool_or(a.in_window), false)                      AS any_win,
             coalesce(bool_or(a.in_window AND a.fwd), false)            AS any_fwd,
             coalesce(bool_or(a.in_window AND a.at_or_after), false)    AS any_after,
             coalesce(bool_or(a.predates AND a.past_visit), false)      AS any_past,
             coalesce(bool_or(a.predates AND NOT a.past_visit), false)  AS any_prior_future,
             min(a.source_created_at) FILTER (WHERE a.in_window)        AS first_win
        FROM e LEFT JOIN a ON a.pid = e.pid
       GROUP BY 1, 2, 3
    )
    SELECT
      count(*)::int                                            AS cohort,
      count(*) FILTER (WHERE any_win)::int                      AS positives,
      count(*) FILTER (WHERE any_fwd)::int                      AS fwd_n,
      count(*) FILTER (WHERE any_after)::int                    AS after_n,
      count(*) FILTER (WHERE any_past OR any_prior_future)::int AS prior_n,
      count(*) FILTER (WHERE NOT hist_complete AND NOT any_win)::int AS unresolved_n,
      count(*) FILTER (WHERE hist_complete)::int                AS cov_den,
      count(*) FILTER (WHERE any_win)::int                      AS matched_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_win - entry_at))/86400.0)
        FILTER (WHERE any_win)                                  AS p50
      INTO r
      FROM pp;

    metric := p_metric;
    cohort := r.cohort;
    numerator := r.positives;
    denominator := r.cohort;
    observed_numerator := r.positives;
    observed_denominator := r.cohort;
    secondary_a := r.fwd_n;      -- forward-scheduled
    secondary_b := r.after_n;    -- created at/after scheduled time
    secondary_c := r.prior_n;    -- any appointment record predating entry
    unresolved := r.unresolved_n;
    coverage_denominator := r.cov_den;
    matched := r.matched_n;
    p50_days := r.p50; p75_days := NULL; p90_days := NULL;
    notes := 'observed minimum; secondary_a=forward-scheduled, '
          || 'secondary_b=created at/after scheduled, secondary_c=record predating entry';
  END IF;

  -- ---- suppression, INSIDE the boundary ---------------------------------
  -- The COHORT ITSELF is a small cell. A first version of this function
  -- withheld the rate for a 3-person insurance cohort but still returned
  -- `cohort = 3`, which is the disclosure the rate suppression was meant to
  -- prevent. Suppress the size of the group before anything else.
  IF cohort BETWEEN 1 AND k-1 THEN
    cohort := NULL;
    small_cohort := true;     -- the GROUP is tiny, not merely one of its parts
  END IF;

  -- Cell-by-cell.
  IF numerator            BETWEEN 1 AND k-1 THEN numerator := NULL; END IF;
  IF observed_numerator   BETWEEN 1 AND k-1 THEN observed_numerator := NULL; END IF;
  IF secondary_a          BETWEEN 1 AND k-1 THEN secondary_a := NULL; END IF;
  IF secondary_b          BETWEEN 1 AND k-1 THEN secondary_b := NULL; END IF;
  IF secondary_c          BETWEEN 1 AND k-1 THEN secondary_c := NULL; END IF;
  IF unresolved           BETWEEN 1 AND k-1 THEN unresolved := NULL; END IF;
  IF coverage_denominator BETWEEN 1 AND k-1 THEN coverage_denominator := NULL; END IF;

  -- A denominator under k makes the whole rate disclosive; withhold the pair.
  IF denominator BETWEEN 1 AND k-1 THEN
    denominator := NULL; numerator := NULL;
  END IF;
  IF observed_denominator BETWEEN 1 AND k-1 THEN
    observed_denominator := NULL; observed_numerator := NULL;
  END IF;

  -- Complement: n - x small is as disclosive as x small.
  IF denominator IS NOT NULL AND numerator IS NOT NULL
     AND (denominator - numerator) BETWEEN 1 AND k-1 THEN
    numerator := NULL; denominator := NULL;
  END IF;
  IF observed_denominator IS NOT NULL AND observed_numerator IS NOT NULL
     AND (observed_denominator - observed_numerator) BETWEEN 1 AND k-1 THEN
    observed_numerator := NULL; observed_denominator := NULL;
  END IF;

  -- Recovery by subtraction: cohort - eligible reveals the excluded group.
  --
  -- WITHHOLD THE TOTAL, NOT THE METRIC. A first version nulled `cohort` here
  -- and then, via the cohort-is-null rule below, withheld every other figure
  -- too — so a 69-patient cohort with a publishable 25/67 rate came back
  -- entirely blank because ONE sub-group of 2 was small. Dropping the total
  -- alone makes the small group unrecoverable while the rate survives.
  IF secondary_a IS NULL AND p_metric = 'insurance_to_registration'
     AND cohort IS NOT NULL AND observed_denominator IS NOT NULL
     AND small_cohort IS NOT TRUE THEN
    cohort := NULL;
  END IF;

  -- A percentile over a handful of people describes those people.
  IF matched BETWEEN 1 AND k-1 THEN
    matched := NULL; p50_days := NULL; p75_days := NULL; p90_days := NULL;
  END IF;

  -- Only when the COHORT ITSELF was tiny does every derived figure have to go:
  -- each one would still bound the size of that small group. A cohort withheld
  -- merely to protect a sub-group does not have that problem.
  IF small_cohort THEN
    numerator := NULL; denominator := NULL;
    observed_numerator := NULL; observed_denominator := NULL;
    secondary_a := NULL; secondary_b := NULL; secondary_c := NULL;
    unresolved := NULL; coverage_denominator := NULL;
    matched := NULL; p50_days := NULL; p75_days := NULL; p90_days := NULL;
  END IF;

  status := CASE
    WHEN denominator IS NULL AND numerator IS NULL THEN 'suppressed_or_undefined'
    WHEN denominator = 0 THEN 'zero_denominator'
    ELSE 'ok' END;

  RETURN NEXT;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Ownership and grants.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.drsnip_journey_metric(text, date, date, integer)
  OWNER TO drsnip_metrics_fn;

REVOKE ALL ON FUNCTION public.drsnip_journey_metric(text, date, date, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_journey_metric(text, date, date, integer) TO drsnip_reporting_ro';
  END IF;
  -- The application role reads through the same boundary rather than querying
  -- the PHI tables directly for metrics.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_journey_metric(text, date, date, integer) TO drsnip_intake_demo';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Freshness, so a caller can label a stale snapshot without table access.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_journey_freshness()
RETURNS TABLE (
  intake_latest_at        timestamptz,
  appointments_synced_at  timestamptz,
  appointment_sync_active boolean,
  history_complete_patients integer,
  linked_patients           integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'
AS $$
  SELECT
    (SELECT max(s.created_at) FROM public.submissions s),
    (SELECT max(w.completed_at) FROM public.appointment_sync_windows w WHERE w.state = 'complete'),
    -- SUPERSEDED BY 0017, which replaces this function so the flag is earned
    -- from a completed scheduled run rather than hard-coded. This literal was
    -- correct when written — no schedule existed — and is kept so re-reading
    -- 0014 alone is not misleading. Apply these files in numeric order.
    false,
    (SELECT count(*)::int FROM public.appointment_sync_windows w
      WHERE w.strategy = 'patient_history' AND w.state = 'complete'),
    (SELECT count(DISTINCT s.n8n_patient_id)::int FROM public.submissions s
      WHERE s.n8n_patient_id IS NOT NULL);
$$;

ALTER FUNCTION public.drsnip_journey_freshness() OWNER TO drsnip_metrics_fn;
REVOKE ALL ON FUNCTION public.drsnip_journey_freshness() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_journey_freshness() TO drsnip_reporting_ro';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_journey_freshness() TO drsnip_intake_demo';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Assert the boundary, loudly.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- appointment_status_transitions is deliberately absent from this list: 0015
  -- grants it for the aggregate status-evidence summary. users and
  -- submission_files remain off limits.
  IF has_table_privilege('drsnip_metrics_fn', 'public.users', 'SELECT')
     OR has_table_privilege('drsnip_metrics_fn', 'public.submission_files', 'SELECT') THEN
    RAISE EXCEPTION 'drsnip_metrics_fn reads more than it needs';
  END IF;
  IF has_schema_privilege('drsnip_metrics_fn', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'drsnip_metrics_fn can create objects';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro')
     AND has_table_privilege('drsnip_reporting_ro', 'public.submissions', 'SELECT') THEN
    RAISE EXCEPTION 'the reporting role gained direct access to submissions';
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'drsnip_metrics_fn') THEN
    RAISE EXCEPTION 'the function owner must not be a superuser';
  END IF;
  RAISE NOTICE 'journey metric boundary verified';
END $$;
