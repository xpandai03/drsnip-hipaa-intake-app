-- 0027_journey_window_60.sql — Patient journeys offers 7 / 30 / 60 days
-- (2026-10-27 call: no "14 days" anywhere in the console; default 30).
--
-- Apply by hand, after 0026. NOT registered in migrate.ts: it replaces
-- functions owned by drsnip_metrics_fn. Rollback: 0027_rollback.sql.
--
-- The three window-taking reporting functions accepted only 7, 14 or 30 days.
-- This widens that one check to 7, 14, 30 or 60 and changes nothing else: each
-- function's CURRENT definition is read from the catalog (pg_get_functiondef),
-- the single "NOT IN (7, 14, 30)" is replaced, and the definition is
-- re-created. CREATE OR REPLACE keeps the owner and every grant. 14 stays
-- accepted so an old link still answers; the console no longer offers it.
--
-- Idempotent: a function already widened is left alone.

DO $$
DECLARE
  f   text;
  def text;
  n   integer;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.drsnip_journey_metric(text,date,date,integer)',
    'public.drsnip_booking_metric(text,date,date,integer)',
    'public.drsnip_attendance_evidence(jsonb,text,date,date,integer)'
  ] LOOP
    def := pg_get_functiondef(f::regprocedure);
    IF position('NOT IN (7, 14, 30, 60)' IN def) > 0 THEN
      RAISE NOTICE '% already accepts 60', f;
      CONTINUE;
    END IF;
    n := (length(def) - length(replace(def, 'NOT IN (7, 14, 30)', ''))) / length('NOT IN (7, 14, 30)');
    IF n <> 1 THEN
      RAISE EXCEPTION '% has % window checks, expected exactly 1; nothing changed', f, n;
    END IF;
    EXECUTE replace(def, 'NOT IN (7, 14, 30)', 'NOT IN (7, 14, 30, 60)');
  END LOOP;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.drsnip_journey_metric(text,date,date,integer)',
    'public.drsnip_booking_metric(text,date,date,integer)',
    'public.drsnip_attendance_evidence(jsonb,text,date,date,integer)'
  ] LOOP
    IF position('NOT IN (7, 14, 30, 60)' IN pg_get_functiondef(f::regprocedure)) = 0 THEN
      RAISE EXCEPTION '% does not accept 60', f;
    END IF;
    IF (SELECT rolname FROM pg_roles r JOIN pg_proc p ON p.proowner = r.oid WHERE p.oid = f::regprocedure) <> 'drsnip_metrics_fn' THEN
      RAISE EXCEPTION '% changed owner', f;
    END IF;
  END LOOP;
  RAISE NOTICE 'journey, booking and attendance accept a 60-day window';
END $$;
