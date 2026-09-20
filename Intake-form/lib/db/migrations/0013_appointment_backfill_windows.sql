-- 0013_appointment_backfill_windows.sql — durable checkpoints for the backfill.
--
-- WHY THIS EXISTS: the backfill is a sequence of independent units of work
-- (scheduled-date windows, then per-patient history probes). "Resumable" means
-- each unit records its own outcome, so an interrupted sweep restarts at the
-- first unfinished unit instead of from the beginning — and so nothing can be
-- called complete unless every unit says it is.
--
-- appointment_sync_runs records one row per EXECUTION. That is not the same
-- thing: one execution covers one unit, and a failed execution must not erase
-- what earlier ones proved.
--
-- HISTORICAL CHECKPOINTS ARE NOT AN INCREMENTAL WATERMARK. Nothing here feeds
-- appointment_sync_state.watermark. A finished historical sweep says "these
-- date windows were read", not "everything modified before now was read".
--
-- PRIVACY: same class as the other sync tables — a patient id joined to
-- appointment coverage is health information. No grant to drsnip_reporting_ro.
-- The per-patient units store the patient id only, never a name or contact.
--
-- Idempotent; safe under the ledger-free migrate.ts replay.

CREATE TABLE IF NOT EXISTS appointment_sync_windows (
  -- e.g. 'sched:2022Q1' or 'patient:<id>'. Stable and deterministic, so the
  -- same plan regenerated later maps onto the same checkpoints.
  window_key        text PRIMARY KEY,

  -- scheduled_window | patient_history
  strategy          text        NOT NULL,

  -- Populated for scheduled_window units. NULL for patient_history units,
  -- which are unbounded by design (?patient= with since=1970 returns that
  -- patient's whole history in one page for almost every patient).
  range_start       date,
  range_end         date,
  patient_source_id text,

  -- pending | running | complete | partial | failed | blocked
  --
  -- 'partial' is load-bearing: a unit that hit its page cap read SOME of its
  -- window. It must never be counted as coverage, and it must be retried.
  state             text        NOT NULL DEFAULT 'pending',

  -- TRUE when the page cap cut the unit short. Recorded separately from state
  -- so "why is this not complete" is answerable without reading logs.
  truncated         boolean     NOT NULL DEFAULT false,

  attempts          integer     NOT NULL DEFAULT 0,
  last_run_id       uuid REFERENCES appointment_sync_runs (id),

  pages_fetched          integer NOT NULL DEFAULT 0,
  appointments_seen      integer NOT NULL DEFAULT 0,
  appointments_persisted integer NOT NULL DEFAULT 0,
  appointments_discarded integer NOT NULL DEFAULT 0,
  transitions_persisted  integer NOT NULL DEFAULT 0,

  first_attempt_at  timestamptz,
  completed_at      timestamptz,
  -- SANITIZED only. Never a payload, never an identifier.
  error_summary     text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_sync_windows_state_idx
  ON appointment_sync_windows (strategy, state, window_key);
CREATE INDEX IF NOT EXISTS appointment_sync_windows_patient_idx
  ON appointment_sync_windows (patient_source_id)
  WHERE patient_source_id IS NOT NULL;

-- The historical sweep gets its own scope so its lease never contends with,
-- and its progress is never mistaken for, the incremental cursor.
INSERT INTO appointment_sync_state (scope_key, watermark, watermark_meaning, history_complete)
VALUES
  ('historical_sweep', NULL,
   'Historical backfill by SCHEDULED-DATE window. Progress lives in '
   || 'appointment_sync_windows, not in this timestamp, which must stay NULL: '
   || 'a scheduled-date sweep says nothing about which records were MODIFIED '
   || 'before a given instant, so it can never seed an incremental cursor.',
   false),
  ('patient_history', NULL,
   'Per-patient history probes (?patient= with since=1970). Progress lives in '
   || 'appointment_sync_windows rows with strategy = patient_history.',
   false)
ON CONFLICT (scope_key) DO NOTHING;

-- Access boundary, stated explicitly so it survives a later blanket grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE appointment_sync_windows FROM drsnip_reporting_ro';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_sync_rw') THEN
    -- No DELETE: a checkpoint is evidence of what was read.
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE appointment_sync_windows TO drsnip_sync_rw';
  END IF;
END $$;
