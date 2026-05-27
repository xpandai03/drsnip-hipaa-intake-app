-- Phase 3 (Jeff feedback) — dedicated column for the new Mental Illness
-- screening question on the Registration form.
--
-- Per-question explanations (when the patient answers "Yes") continue to
-- live inside raw_payload.medicalDetails — no schema change needed there.
--
-- Idempotent; safe to re-run via the Fly release_command.

BEGIN;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS mh_mental_illness text;

COMMIT;
