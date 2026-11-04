-- 0027_rollback.sql — undo 0027_journey_window_60.sql. Apply by hand.
-- Narrows the three window checks back to 7, 14 or 30 days. Safe with either
-- app release; a release that offers 60 would then get a 400 for that option.

DO $$
DECLARE
  f   text;
  def text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.drsnip_journey_metric(text,date,date,integer)',
    'public.drsnip_booking_metric(text,date,date,integer)',
    'public.drsnip_attendance_evidence(jsonb,text,date,date,integer)'
  ] LOOP
    def := pg_get_functiondef(f::regprocedure);
    IF position('NOT IN (7, 14, 30, 60)' IN def) > 0 THEN
      EXECUTE replace(def, 'NOT IN (7, 14, 30, 60)', 'NOT IN (7, 14, 30)');
    END IF;
  END LOOP;
  RAISE NOTICE 'window checks back to 7, 14, 30';
END $$;
