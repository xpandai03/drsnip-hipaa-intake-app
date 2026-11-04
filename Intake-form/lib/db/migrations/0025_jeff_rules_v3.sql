-- 0025_jeff_rules_v3.sql — the clinic's status list as restated on the
-- 2026-10-27 call, and "ignored" statuses.
--
-- Apply by hand, after 0024. NOT registered in migrate.ts: like 0014–0024 it
-- replaces functions owned by drsnip_metrics_fn. Rollback: 0025_rollback.sql.
--
-- ============================ THE DEFINITION ===============================
-- Jeffrey Cho, 2026-10-27:
--
--   Converted:     Complete, Signed no review, Procedure not performed,
--                  Checked in, Checked in online, Arrived, Ready / In room
--                  (all rooms), In session, Scheduled, Confirmed, Rescheduled.
--   Not converted: Canceled, Late canceled, No-show.
--   Ignored:       a blank status, and every other status (MD In, MD Out, …).
--                  Ignored is NOT "not converted".
--
-- What changes against v2 (0023):
--   * "checked in online" and "arrived" join the converted list.
--   * The room pattern also takes DrChrono's "In Room" (it has no number) and
--     "In room N", not only "Ready in N" / "Ready in room N". Labels it matches
--     in production on 2026-11-04 (current + transitions + label catalog):
--     Ready in 1, Ready in 2, Ready in 3, Ready in 4, In Room.
--   * An explicit "ignored" list documents the labels known to be ignored. Any
--     label in neither counted list is ignored too; drsnip_conversion_status_class()
--     still names that class 'unclassified', so the admin export (#68) and every
--     caller of the class function are unchanged.
--   * drsnip_conversion_classify(): an appointment with an ignored status is
--     dropped before a patient is classified, and a patient whose live
--     appointments are ALL ignored is left out entirely — out of the not-booked
--     list and out of every cohort denominator. A patient with no live
--     appointment at all is still counted (as "no appointment").
--     Same signature and columns, so every consumer (0023 monthly, 0024
--     cohorts, the not-booked report) picks this up without a change of its own.
--     `unclassified_only` from drsnip_conversion_monthly() is therefore always 0.
--
-- Idempotent. Safe to re-run.

BEGIN;

INSERT INTO outcome_status_rules
  (version, state, rules, source_note,
   confirmed_by_name, confirmed_by_role, confirmed_via, confirmed_on)
VALUES ('3', 'approved', jsonb_build_object(
    'converted', jsonb_build_array(
      'complete', 'signed no review', 'procedure not performed', 'checked in',
      'checked in online', 'arrived', 'in session', 'scheduled', 'confirmed', 'rescheduled'),
    'converted_patterns', jsonb_build_array(
      '^(ready in (room )?[0-9]+|in room( [0-9]+)?)$'),
    'not_converted', jsonb_build_array(
      'cancelled', 'canceled', 'late cancel within 48 hrs', 'late canceled',
      'late cancelled', 'no show', 'no-show'),
    'not_converted_patterns', jsonb_build_array(
      '^cancell?ed\M', '^late cancel', '^no[- ]?show$'),
    'ignored', jsonb_build_array(
      '', 'md in', 'md out')),
  'Definition restated by Jeffrey Cho on the 2026-10-27 call. Converted: Complete, Signed no '
  || 'review, Procedure not performed, Checked in, Checked in online, Arrived, Ready / In room '
  || '(all rooms), In session, Scheduled, Confirmed, Rescheduled. Not converted: Canceled, Late '
  || 'canceled, No-show. A blank or any other status is ignored, not counted as not converted; a '
  || 'patient whose appointments all have an ignored status is not counted.',
  'Jeffrey Cho', 'DrSnip client contact', 'video_call', DATE '2026-10-27')
ON CONFLICT (version) DO NOTHING;

UPDATE outcome_status_rules SET state = 'superseded' WHERE version = '2' AND state <> 'superseded';

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
-- See 0023: classify once per distinct label, rules read once, no JIT.
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
         -- created_at is Eastern wall-clock stored as UTC (see 0023 header).
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
         bool_or(a.cls = 'unclassified')                      AS has_unclassified,
         -- v3: only converted / not-converted appointments count. A chart whose
         -- live appointments are all ignored has nothing to classify.
         bool_or(a.cls IN ('converted', 'not_converted'))     AS has_counted
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
  LEFT JOIN covered cv ON cv.pid = fe.pid
 -- Left out: patients whose live appointments are all ignored. Kept: patients
 -- with no live appointment at all (pa.pid IS NULL), and everyone with at least
 -- one converted or not-converted appointment.
 WHERE pa.pid IS NULL OR pa.has_counted
-- <<< CONVERSION CLASSIFY BODY <<<
$classify$;

ALTER FUNCTION public.drsnip_conversion_classify(text) OWNER TO drsnip_metrics_fn;
REVOKE ALL ON FUNCTION public.drsnip_conversion_classify(text) FROM PUBLIC;

COMMIT;

-- Self-checks. A failure aborts here; the rules row and the function above are
-- already committed, so run 0025_rollback.sql if this ever fails.
DO $$
DECLARE
  rules jsonb;
  s text;
  f text;
  bad integer;
BEGIN
  IF has_function_privilege('public', 'public.drsnip_conversion_classify(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute the patient-level classifier';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro')
     AND has_function_privilege('drsnip_reporting_ro', 'public.drsnip_conversion_classify(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the reporting role can reach patient-level rows';
  END IF;

  SELECT r.rules INTO rules FROM public.drsnip_conversion_rules() r;
  IF (SELECT r.version FROM public.drsnip_conversion_rules() r) <> '3' THEN
    RAISE EXCEPTION 'rules v3 is not the rule set in force';
  END IF;
  FOREACH s IN ARRAY ARRAY['Complete', 'Signed No Review', 'Procedure Not Performed', 'Checked In',
                           'Checked In Online', 'Arrived', 'Ready in 1', 'Ready in 4', 'Ready in room 12',
                           'In Room', 'In room 3', 'In Session', 'Scheduled', 'Confirmed', 'Rescheduled'] LOOP
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
  FOREACH s IN ARRAY ARRAY['', 'MD In', 'MD Out', 'Ready in', 'In Room lobby', 'Something New'] LOOP
    IF public.drsnip_conversion_status_class(s, rules) <> 'unclassified' THEN
      RAISE EXCEPTION 'status % must be ignored', s;
    END IF;
  END LOOP;

  -- 0024's parity check, re-run: a month cohort's converted-as-of-today and
  -- forms are Monthly outcomes' converted and covered.
  FOREACH f IN ARRAY ARRAY['registration', 'insurance'] LOOP
    SELECT count(*) INTO bad
      FROM public.drsnip_conversion_cohorts(f, 'month') c
      JOIN public.drsnip_conversion_monthly(f, greatest(DATE '2026-01-01', (date_trunc('month', now())::date - interval '12 months')::date),
                                            (date_trunc('month', now())::date + interval '1 month')::date) m
        ON m.entry_month = c.period_start
     WHERE c.row_status = 'ok' AND m.row_status = 'ok'
       AND (c.converted_now IS DISTINCT FROM m.converted OR c.forms IS DISTINCT FROM m.covered)
       AND c.converted_now IS NOT NULL AND m.converted IS NOT NULL;
    IF bad > 0 THEN RAISE EXCEPTION 'cohort and monthly disagree for % (% months)', f, bad; END IF;
  END LOOP;
  RAISE NOTICE 'conversion rules v3 installed; cohort/monthly parity holds';
END $$;
