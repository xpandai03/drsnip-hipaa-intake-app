-- 0025_rollback.sql — undo 0025_jeff_rules_v3.sql. Apply by hand.
--
-- Puts rules v2 back in force and restores the v2 classifier body from 0023,
-- byte for byte. Safe with either app release: the classifier's signature never
-- changed. The v3 row stays (superseded) as a record.

BEGIN;
UPDATE outcome_status_rules SET state = 'superseded' WHERE version = '3' AND state <> 'superseded';
UPDATE outcome_status_rules SET state = 'approved'   WHERE version = '2';
COMMIT;

BEGIN;
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
-- 2026-10-19: the first version of this body was planned at 3.4 M rows (a
-- 1,000-row default for the rules function x every appointment), which made
-- PostgreSQL 17 JIT-compile it with LLVM. On the then-256 MB database machine
-- that exhausted memory and took the database down for 30 minutes. The status
-- is now classified once per DISTINCT label (about 14), the rules are read
-- once, and JIT is off for every reporting function.
SET jit = off
AS $classify$
-- >>> CONVERSION CLASSIFY BODY >>>
WITH
rl AS (SELECT (SELECT r.rules FROM public.drsnip_conversion_rules() r) AS rules),
-- One classification per distinct status label, not per appointment.
lc AS (
  SELECT l.st, public.drsnip_conversion_status_class(l.st, rl.rules) AS cls
    FROM (SELECT DISTINCT s.current_status AS st FROM public.appointment_snapshots s) l
    CROSS JOIN rl
),
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
         lc.cls,
         -- created_at is Eastern wall-clock stored as UTC (see header).
         (s.source_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS created_at
    FROM public.appointment_snapshots s
    JOIN lc ON lc.st IS NOT DISTINCT FROM s.current_status
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
       (cv.pid IS NOT NULL),
       coalesce(pa.converted, false),
       pa.conversion_at,
       (pa.conversion_at AT TIME ZONE 'America/Los_Angeles')::date,
       coalesce(pa.has_not_converted, false),
       coalesce(pa.has_unclassified, false),
       (pa.pid IS NOT NULL)
  FROM fe
  LEFT JOIN pa ON pa.pid = fe.pid
  -- A join, not a correlated EXISTS: the subplan form re-ran the covered set
  -- for every patient row.
  LEFT JOIN covered cv ON cv.pid = fe.pid
-- <<< CONVERSION CLASSIFY BODY <<<
$classify$;

ALTER FUNCTION public.drsnip_conversion_classify(text) OWNER TO drsnip_metrics_fn;
REVOKE ALL ON FUNCTION public.drsnip_conversion_classify(text) FROM PUBLIC;
COMMIT;

DO $$
BEGIN
  IF (SELECT r.version FROM public.drsnip_conversion_rules() r) <> '2' THEN
    RAISE EXCEPTION 'rollback did not restore rules v2';
  END IF;
  RAISE NOTICE 'rolled back to conversion rules v2';
END $$;
