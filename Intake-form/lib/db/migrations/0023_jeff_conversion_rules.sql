-- 0023_jeff_conversion_rules.sql — the client's own definition of "converted".
--
-- Apply by hand, after 0022. NOT registered in migrate.ts: like 0014–0022 it
-- creates functions owned by drsnip_metrics_fn, which 0014 creates.
--
-- ============================ THE DEFINITION ===============================
-- Given by Jeffrey Cho on the 2026-09-21 call and restated, as the rule to
-- build, in the Train 4 brief (2026-10-19):
--
--   Converted:     Complete, Signed no review, Procedure not performed,
--                  Checked in, Ready in room N (any room number), In session,
--                  Scheduled, Confirmed, Rescheduled.
--   Not converted: Canceled (including "will call back"), Late canceled,
--                  No-show.
--   Anything else: Unclassified. Never counted as converted.
--
--   A patient is converted if ANY appointment on their chart is in the
--   converted set. One count per patient, attributed to the month (and ISO
--   week) of their earliest form submission of that type. The conversion date
--   is the created date of the earliest converted-set appointment.
--
-- This REPLACES the provisional v1 rules (0021) for every calculation the
-- console makes. v1's functions are left installed only so that a rollback to
-- release v96 keeps rendering; no code on main calls them.
--
-- ============================ TWO CLOCK FACTS ==============================
-- DrChrono returns zone-less timestamps, and the sync stores them as if they
-- were UTC. They are not:
--   * created_at / updated_at behave as US/Eastern wall-clock. Across 969
--     appointments first seen after 2026-09-21, the smallest gap between
--     created_at and our own first observation is 4.0 hours, and none is
--     negative (measured 2026-10-19).
--   * scheduled_time is Pacific wall-clock (stored hours cluster 08–17).
-- The conversion date below therefore reads source_created_at as Eastern
-- wall-clock before taking its clinic (Pacific) day. Not doing so would move a
-- conversion made after 8 pm Pacific into the next day, and sometimes into the
-- next week or month.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The rules, as data. Labels are matched case-insensitively after trimming
--    and collapsing whitespace; patterns are POSIX regexes on that same
--    normalised label. DrChrono's own labels ('Cancelled', 'Late Cancel within
--    48 hrs', 'No Show', 'Ready in 2') and the client's words ('Canceled',
--    'Late canceled', 'No-show', 'Ready in room 2') both match.
-- ---------------------------------------------------------------------------
INSERT INTO outcome_status_rules
  (version, state, rules, source_note,
   confirmed_by_name, confirmed_by_role, confirmed_via, confirmed_on)
VALUES ('2', 'approved', jsonb_build_object(
    'converted', jsonb_build_array(
      'complete', 'signed no review', 'procedure not performed', 'checked in',
      'in session', 'scheduled', 'confirmed', 'rescheduled'),
    'converted_patterns', jsonb_build_array(
      '^ready in (room )?[0-9]+$'),
    'not_converted', jsonb_build_array(
      'cancelled', 'canceled', 'late cancel within 48 hrs', 'late canceled',
      'late cancelled', 'no show', 'no-show'),
    'not_converted_patterns', jsonb_build_array(
      '^cancell?ed\M', '^late cancel', '^no[- ]?show$')),
  'Definition given by Jeffrey Cho on the 2026-09-21 call (jeff-meet-transcript.md) and '
  || 'restated as the rule to build in the Train 4 brief, 2026-10-19. Converted: Complete, '
  || 'Signed no review, Procedure not performed, Checked in, Ready in room N (any room), In '
  || 'session, Scheduled, Confirmed, Rescheduled. Not converted: Canceled (including will call '
  || 'back), Late canceled, No-show. Any other status is Unclassified and never counts as '
  || 'converted. A patient converts if ANY appointment on the chart is in the converted set.',
  'Jeffrey Cho', 'DrSnip client contact', 'video_call', DATE '2026-09-21')
ON CONFLICT (version) DO NOTHING;

-- v1 stays as a row (v96's functions read it by version, not by state), but it
-- no longer describes anything this console reports.
UPDATE outcome_status_rules SET state = 'superseded' WHERE version = '1' AND state <> 'superseded';

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------------
-- 2. One status -> 'converted' | 'not_converted' | 'unclassified'. Pure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_conversion_status_class(p_status text, p_rules jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN x.n = '' THEN 'unclassified'
           WHEN x.n IN (SELECT jsonb_array_elements_text(p_rules -> 'converted'))
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_rules -> 'converted_patterns') p
                         WHERE x.n ~ p)
             THEN 'converted'
           WHEN x.n IN (SELECT jsonb_array_elements_text(p_rules -> 'not_converted'))
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_rules -> 'not_converted_patterns') p
                         WHERE x.n ~ p)
             THEN 'not_converted'
           ELSE 'unclassified'
         END
    FROM (SELECT lower(regexp_replace(btrim(coalesce(p_status, '')), '\s+', ' ', 'g')) AS n) x;
$$;

-- ---------------------------------------------------------------------------
-- 3. The rules in force: the newest approved version. Exactly one row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_conversion_rules()
RETURNS TABLE (version text, state text, rules jsonb, source_note text,
               confirmed_by_name text, confirmed_via text, confirmed_on date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.version, r.state, r.rules, r.source_note, r.confirmed_by_name, r.confirmed_via, r.confirmed_on
    FROM public.outcome_status_rules r
   WHERE r.state = 'approved'
   ORDER BY r.created_at DESC, r.version DESC
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 4. PATIENT-LEVEL classification. Never granted to the reporting or the
--    application role: only the aggregate functions below may call it.
--
--    One row per linked chart, at its earliest submission of p_form.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_conversion_classify(p_form text)
RETURNS TABLE (
  pid                 text,
  entry_at            timestamptz,
  entry_day           date,
  entry_month         date,
  entry_week          date,
  n_subs              integer,
  is_covered          boolean,
  converted           boolean,
  conversion_at       timestamptz,
  conversion_day      date,
  has_not_converted   boolean,
  has_unclassified    boolean,
  has_appointment     boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $classify$
-- >>> CONVERSION CLASSIFY BODY >>>
WITH
rl AS (SELECT r.rules FROM public.drsnip_conversion_rules() r),
covered AS (
  SELECT DISTINCT w.patient_source_id AS pid
    FROM public.appointment_sync_windows w
   WHERE w.strategy = 'patient_history' AND w.state = 'complete' AND w.patient_source_id IS NOT NULL
),
fe AS (
  SELECT s.n8n_patient_id::text AS pid, min(s.created_at) AS entry_at, count(*)::int AS n_subs
    FROM public.submissions s
   WHERE s.n8n_patient_id IS NOT NULL AND s.form_type = p_form
   GROUP BY 1
),
-- Every live (not deleted) appointment on the chart, whatever its type or date.
a AS (
  SELECT s.patient_source_id AS pid,
         public.drsnip_conversion_status_class(s.current_status, rl.rules) AS cls,
         -- created_at is Eastern wall-clock stored as UTC (see header).
         (s.source_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS created_at
    FROM public.appointment_snapshots s CROSS JOIN rl
   WHERE s.deleted_flag IS NOT TRUE
),
pa AS (
  SELECT a.pid,
         bool_or(a.cls = 'converted')                         AS converted,
         min(a.created_at) FILTER (WHERE a.cls = 'converted') AS conversion_at,
         bool_or(a.cls = 'not_converted')                     AS has_not_converted,
         bool_or(a.cls = 'unclassified')                      AS has_unclassified
    FROM a GROUP BY a.pid
)
SELECT fe.pid,
       fe.entry_at,
       (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date,
       date_trunc('month', fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date,
       date_trunc('week',  fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date,
       fe.n_subs,
       EXISTS (SELECT 1 FROM covered c WHERE c.pid = fe.pid),
       coalesce(pa.converted, false),
       pa.conversion_at,
       (pa.conversion_at AT TIME ZONE 'America/Los_Angeles')::date,
       coalesce(pa.has_not_converted, false),
       coalesce(pa.has_unclassified, false),
       (pa.pid IS NOT NULL)
  FROM fe LEFT JOIN pa ON pa.pid = fe.pid
-- <<< CONVERSION CLASSIFY BODY <<<
$classify$;

-- ---------------------------------------------------------------------------
-- 5. Small-cell rule for a partition, shared by every aggregate here. Identical
--    algorithm to 0021: hide every count of 1..k-1; if anything is hidden,
--    hide at least two cells (the smallest visible ones) so no hidden cell can
--    be recovered by subtraction from the total.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_suppress_partition(v integer[], k integer DEFAULT 5)
RETURNS boolean[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  hide     boolean[] := array_fill(false, ARRAY[cardinality(v)]);
  n_hidden integer := 0;
  smallest integer;
  i        integer;
BEGIN
  FOR i IN 1..cardinality(v) LOOP
    IF v[i] BETWEEN 1 AND k - 1 THEN hide[i] := true; n_hidden := n_hidden + 1; END IF;
  END LOOP;
  IF n_hidden > 0 THEN
    WHILE n_hidden < 2 LOOP
      smallest := NULL;
      FOR i IN 1..cardinality(v) LOOP
        IF NOT hide[i] AND (smallest IS NULL OR v[i] < v[smallest]) THEN smallest := i; END IF;
      END LOOP;
      EXIT WHEN smallest IS NULL;
      hide[smallest] := true; n_hidden := n_hidden + 1;
    END LOOP;
    IF n_hidden < 2 THEN
      FOR i IN 1..cardinality(v) LOOP hide[i] := true; END LOOP;
    END IF;
  END IF;
  RETURN hide;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Monthly outcomes under the client's rules. Aggregate only.
--
--    Buckets partition the COVERED cohort (patients whose full appointment
--    history has been read):
--      converted          any live appointment in the converted set
--      not_converted      none converted; at least one in the not-converted set
--      unclassified_only  appointments exist, but every one is unclassified
--      no_appointment     no live appointment on the chart at all
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_conversion_monthly(
  p_form text, p_month_from date, p_month_to date
)
RETURNS TABLE (
  entry_month            date,
  row_status             text,
  entry_period_complete  boolean,
  cohort_total           integer,
  covered                integer,
  not_covered            integer,
  unlinked_submissions   integer,
  converted              integer,
  not_converted          integer,
  unclassified_only      integer,
  no_appointment         integer,
  converted_before_entry integer,
  repeat_submitters      integer,
  withheld               text[],
  status_rules_version   text,
  evidence_cutoff        timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  k    constant integer := 5;
  cut  timestamptz;
  rv   text;
  c    record;
  hide boolean[];
  m_end timestamptz;
BEGIN
  IF p_form IS NULL OR p_form NOT IN ('registration', 'insurance') THEN
    RAISE EXCEPTION 'unsupported form' USING ERRCODE = '22023';
  END IF;
  IF p_month_from IS NULL OR p_month_to IS NULL
     OR p_month_from <> date_trunc('month', p_month_from)::date
     OR p_month_to   <> date_trunc('month', p_month_to)::date
     OR p_month_to <= p_month_from
     OR p_month_from < DATE '2026-01-01'
     OR p_month_to > (p_month_from + interval '13 months')::date THEN
    RAISE EXCEPTION 'invalid entry period' USING ERRCODE = '22023';
  END IF;

  SELECT ec.cutoff INTO cut FROM public.drsnip_evidence_cutoff() ec;
  SELECT r.version INTO rv FROM public.drsnip_conversion_rules() r;
  IF rv IS NULL THEN
    RAISE EXCEPTION 'no approved status rules' USING ERRCODE = '22023';
  END IF;

  FOR c IN
    WITH cl AS (
      SELECT * FROM public.drsnip_conversion_classify(p_form) x
       WHERE x.entry_day >= p_month_from AND x.entry_day < p_month_to
    ),
    agg AS (
      SELECT cl.entry_month AS em,
        count(*)::int                                                               AS n_total,
        count(*) FILTER (WHERE cl.is_covered)::int                                  AS n_cov,
        count(*) FILTER (WHERE NOT cl.is_covered)::int                              AS n_notcov,
        count(*) FILTER (WHERE cl.is_covered AND cl.converted)::int                 AS n_conv,
        count(*) FILTER (WHERE cl.is_covered AND NOT cl.converted AND cl.has_not_converted)::int AS n_notconv,
        count(*) FILTER (WHERE cl.is_covered AND NOT cl.converted AND NOT cl.has_not_converted
                           AND cl.has_appointment)::int                             AS n_uncl,
        count(*) FILTER (WHERE cl.is_covered AND NOT cl.has_appointment)::int       AS n_none,
        count(*) FILTER (WHERE cl.is_covered AND cl.converted
                           AND cl.conversion_at < cl.entry_at)::int                 AS n_before,
        count(*) FILTER (WHERE cl.n_subs > 1)::int                                  AS n_repeat
        FROM cl GROUP BY 1
    ),
    unl AS (
      SELECT date_trunc('month', s.created_at AT TIME ZONE 'America/Los_Angeles')::date AS em,
             count(*)::int AS n
        FROM public.submissions s
       WHERE s.n8n_patient_id IS NULL AND s.form_type = p_form
         AND (s.created_at AT TIME ZONE 'America/Los_Angeles')::date >= p_month_from
         AND (s.created_at AT TIME ZONE 'America/Los_Angeles')::date <  p_month_to
       GROUP BY 1
    ),
    months AS (
      SELECT g::date AS em FROM generate_series(p_month_from, p_month_to - 1, interval '1 month') g
    )
    SELECT months.em, agg.*, coalesce(unl.n, 0) AS n_unl
      FROM months LEFT JOIN agg ON agg.em = months.em LEFT JOIN unl ON unl.em = months.em
     ORDER BY months.em
  LOOP
    entry_month := c.em;
    m_end := (c.em + interval '1 month')::timestamp AT TIME ZONE 'America/Los_Angeles';
    entry_period_complete := (cut IS NOT NULL AND m_end <= cut);
    status_rules_version := rv;
    evidence_cutoff := cut;
    withheld := ARRAY[]::text[];

    cohort_total := coalesce(c.n_total, 0); covered := coalesce(c.n_cov, 0);
    not_covered := coalesce(c.n_notcov, 0);
    converted := coalesce(c.n_conv, 0); not_converted := coalesce(c.n_notconv, 0);
    unclassified_only := coalesce(c.n_uncl, 0); no_appointment := coalesce(c.n_none, 0);
    converted_before_entry := coalesce(c.n_before, 0); repeat_submitters := coalesce(c.n_repeat, 0);
    unlinked_submissions := CASE WHEN c.n_unl BETWEEN 1 AND k - 1 THEN NULL ELSE c.n_unl END;
    IF unlinked_submissions IS NULL THEN withheld := array_append(withheld, 'unlinked_submissions_small'); END IF;

    IF cut IS NULL THEN
      row_status := 'unavailable';
      withheld := array_append(withheld, 'evidence_cutoff_unavailable');
      cohort_total := NULL; covered := NULL; not_covered := NULL; converted := NULL;
      not_converted := NULL; unclassified_only := NULL; no_appointment := NULL;
      converted_before_entry := NULL; repeat_submitters := NULL; entry_period_complete := NULL;
    ELSIF (c.em::timestamp AT TIME ZONE 'America/Los_Angeles') > cut THEN
      row_status := 'not_started';
    ELSIF cohort_total = 0 THEN
      row_status := 'empty';
    ELSIF covered BETWEEN 1 AND k - 1 THEN
      row_status := 'suppressed';
      withheld := array_append(withheld, 'covered_cohort_small');
      cohort_total := NULL; covered := NULL; not_covered := NULL; converted := NULL;
      not_converted := NULL; unclassified_only := NULL; no_appointment := NULL;
      converted_before_entry := NULL; repeat_submitters := NULL;
    ELSE
      row_status := 'ok';
      IF not_covered BETWEEN 1 AND k - 1 THEN
        not_covered := NULL; cohort_total := NULL;
        withheld := array_append(withheld, 'not_covered_small');
      END IF;
      hide := public.drsnip_suppress_partition(ARRAY[converted, not_converted, unclassified_only, no_appointment], k);
      IF hide[1] OR hide[2] OR hide[3] OR hide[4] THEN
        withheld := array_append(withheld, 'partition_small_cell');
        converted_before_entry := NULL;
      END IF;
      IF hide[1] THEN converted := NULL; END IF;
      IF hide[2] THEN not_converted := NULL; END IF;
      IF hide[3] THEN unclassified_only := NULL; END IF;
      IF hide[4] THEN no_appointment := NULL; END IF;
      IF converted_before_entry BETWEEN 1 AND k - 1 THEN converted_before_entry := NULL; END IF;
      IF repeat_submitters BETWEEN 1 AND k - 1 THEN repeat_submitters := NULL; END IF;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------------
-- 7. Privileges. Same boundary as 0014–0022.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.drsnip_conversion_status_class(text, jsonb)   OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_conversion_rules()                     OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_conversion_classify(text)              OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_suppress_partition(integer[], integer) OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_conversion_monthly(text, date, date)   OWNER TO drsnip_metrics_fn;

REVOKE ALL ON FUNCTION public.drsnip_conversion_status_class(text, jsonb)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_conversion_rules()                     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_conversion_classify(text)              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_suppress_partition(integer[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_conversion_monthly(text, date, date)   FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['drsnip_intake_demo', 'drsnip_reporting_ro'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.drsnip_conversion_monthly(text,date,date) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.drsnip_conversion_rules() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.drsnip_conversion_status_class(text,jsonb) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- Self-checks. A failure aborts the migration rather than shipping a leak or a
-- wrong rule.
DO $$
DECLARE
  rules jsonb;
  s text;
BEGIN
  IF has_function_privilege('public', 'public.drsnip_conversion_classify(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute the patient-level classifier';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro')
     AND has_function_privilege('drsnip_reporting_ro', 'public.drsnip_conversion_classify(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the reporting role can reach patient-level rows';
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'drsnip_metrics_fn') THEN
    RAISE EXCEPTION 'the function owner must not be a superuser';
  END IF;

  SELECT r.rules INTO rules FROM public.drsnip_conversion_rules() r;
  IF rules IS NULL THEN RAISE EXCEPTION 'no approved status rules'; END IF;
  FOREACH s IN ARRAY ARRAY['Complete', 'Signed No Review', 'Procedure Not Performed', 'Checked In',
                           'Ready in 1', 'Ready in 4', 'Ready in room 12', 'In Session', 'Scheduled',
                           'Confirmed', 'Rescheduled'] LOOP
    IF public.drsnip_conversion_status_class(s, rules) <> 'converted' THEN
      RAISE EXCEPTION 'status % must be converted', s;
    END IF;
  END LOOP;
  FOREACH s IN ARRAY ARRAY['Cancelled', 'Canceled', 'Cancelled - Will Call Back', 'Late Cancel within 48 hrs',
                           'Late canceled', 'No Show', 'No-show'] LOOP
    IF public.drsnip_conversion_status_class(s, rules) <> 'not_converted' THEN
      RAISE EXCEPTION 'status % must be not converted', s;
    END IF;
  END LOOP;
  FOREACH s IN ARRAY ARRAY['', 'Arrived', 'In Room', 'MD In', 'MD Out', 'Checked In Online'] LOOP
    IF public.drsnip_conversion_status_class(s, rules) <> 'unclassified' THEN
      RAISE EXCEPTION 'status % must be unclassified', s;
    END IF;
  END LOOP;
  RAISE NOTICE 'conversion rules v% installed', (SELECT r.version FROM public.drsnip_conversion_rules() r);
END $$;

COMMIT;
