-- 0018_activate_recurring_sync.sql — seed the schedule registry and set the
-- incremental cursor from evidence.
--
-- Apply by hand, after 0017. Not registered in migrate.ts.
--
-- ======================= WHERE THE WATERMARK COMES FROM ====================
-- The cursor for `practice_incremental` is a LAST-MODIFIED instant: "every
-- appointment modified before this was already read". The only defensible
-- value is the EARLIEST instant at which the backfill could still see the whole
-- world, which is the MINIMUM completed_at over the completed per-patient
-- history units — not the maximum, and certainly not "a few days ago".
--
--   * A patient whose unit completed at 23:37 has their history as at 23:37.
--   * A patient whose unit completed at 08:16 the next morning has theirs as at
--     08:16, but an edit at 23:40 to the FIRST patient's appointment would have
--     been missed by everything downstream of it.
--
-- So the first incremental window must start at min(completed_at). It re-reads
-- some hours that were already covered; every write is an upsert, so re-reading
-- is free and cheap insurance. Taking the maximum instead would silently skip
-- edits made during the backfill itself.
--
-- The value is COMPUTED here rather than pasted, so it cannot drift from what
-- the ledger actually records, and it is applied only when the cursor is still
-- NULL — re-running this file never rewinds a live cursor.
--
-- A two-hour overlap is subtracted as well, because `since` filters on the
-- source's clock, not ours, and clock skew at a boundary is the one way an
-- edit disappears for good.
--
-- ============================ NOT A BACKFILL ===============================
-- This schedules NOTHING historical. The per-patient history backfill is
-- finished (2,035 of 2,035 units complete) and must not be repeated. What this
-- enables is a forward-only incremental window plus a bounded catch-up for
-- patients who register from now on.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The cursor. Computed, guarded, and never rewound.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  floor_at timestamptz;
  units    integer;
BEGIN
  SELECT min(completed_at), count(*)
    INTO floor_at, units
    FROM public.appointment_sync_windows
   WHERE strategy = 'patient_history' AND state = 'complete';

  IF units = 0 OR floor_at IS NULL THEN
    RAISE EXCEPTION 'no completed patient-history units: there is no verified instant to start an incremental cursor from';
  END IF;

  UPDATE public.appointment_sync_state
     SET watermark = floor_at - interval '2 hours',
         watermark_meaning =
           'Incremental LAST-MODIFIED cursor. Initialised from min(completed_at) over '
           || units || ' completed patient_history units, less a 2-hour overlap. '
           || 'Advanced only by a run that finished its whole authorized window.',
         updated_at = now()
   WHERE scope_key = 'practice_incremental'
     AND watermark IS NULL;   -- never rewind a live cursor

  RAISE NOTICE 'practice_incremental cursor is now %',
    (SELECT watermark FROM public.appointment_sync_state WHERE scope_key = 'practice_incremental');
END $$;

-- The catch-up scope carries no timestamp cursor at all: its progress lives in
-- appointment_sync_windows, one row per patient. Say so, so a later reader
-- cannot mistake the NULL for "not started".
UPDATE public.appointment_sync_state
   SET watermark_meaning =
         'No timestamp cursor by design. Progress is one appointment_sync_windows '
         || 'row per patient (strategy = patient_history). A NULL here means the '
         || 'scope is not time-based, not that it never ran.',
       updated_at = now()
 WHERE scope_key = 'patient_catchup';

-- ---------------------------------------------------------------------------
-- 2. The schedules.
--
--    enabled stays FALSE here. Turning a schedule on is an operational act
--    performed after its first catch-up run has been watched end to end, not a
--    side effect of deploying a migration.
--
--    THE CADENCE. Hourly, conservatively: the clinic books days ahead, so an
--    appointment created at 10:04 being visible at 11:05 changes no decision,
--    and 24 runs/day against a 500/hour shared allowance leaves the live intake
--    workflows almost all of it. Reconciliation is folded into the same hourly
--    run rather than given its own schedule — see the workflow's Bounds node:
--    once a week the lookback widens to eight days, which re-reads anything an
--    edit-boundary or a brief outage could have dropped.
-- ---------------------------------------------------------------------------
INSERT INTO public.appointment_sync_schedules
  (schedule_key, scope_key, enabled, cadence, expected_interval_minutes,
   max_requests_per_run, n8n_workflow_id, note)
VALUES
  ('incremental_hourly', 'practice_incremental', false,
   'Hourly at :05, clinic time (America/Los_Angeles). Once a week, Sunday 03:05, the same run widens its lookback to 8 days as a reconciliation pass.',
   60, 12, NULL,
   'Forward-only last-modified window from appointment_sync_state.watermark. Advances the cursor only on a run that completed its whole window.'),
  ('patient_catchup_hourly', 'patient_catchup', false,
   'Hourly at :35, clinic time. Offset half an hour from the incremental run so the two never contend for the shared request budget.',
   60, 12, NULL,
   'Bounded: at most 10 newly linked patients per run, each read once with ?patient= since=1970. Patients who registered after the backfill get their history without another historical sweep.')
ON CONFLICT (schedule_key) DO UPDATE
  SET cadence                   = EXCLUDED.cadence,
      expected_interval_minutes = EXCLUDED.expected_interval_minutes,
      max_requests_per_run      = EXCLUDED.max_requests_per_run,
      note                      = EXCLUDED.note,
      updated_at                = now();
      -- `enabled` and `n8n_workflow_id` are deliberately NOT overwritten: a
      -- re-apply must never silently re-enable a schedule someone switched off.

COMMIT;
