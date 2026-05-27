-- Phase 3 (n8n bridge) — track the n8n -> DrChrono outcome on every submission.
--
-- After the custom-app DB write commits, an async bridge call fires the
-- submission off to the v2 n8n webhook (Registration or Consultation). When
-- n8n responds (or the call fails / times out), the bridge UPDATEs the
-- submission row with the outcome so the admin console can show it.
--
-- States in `n8n_status`:
--   NULL              initial — before the bridge fires (or kill switch off)
--   'success'         n8n returned 200 with success: true
--   'manual_review'   n8n returned 200 with success: false, manual_review_required
--   'failed'          bridge errored, timed out, or returned a non-200
--
-- `n8n_response_body` keeps the full JSON response for debugging.
--
-- Idempotent; safe to re-run via the Fly release_command.

BEGIN;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS n8n_status        text,
  ADD COLUMN IF NOT EXISTS n8n_patient_id    bigint,
  ADD COLUMN IF NOT EXISTS n8n_response_at   timestamptz,
  ADD COLUMN IF NOT EXISTS n8n_response_body jsonb;

-- Partial index: find submissions stuck in pending or failed states quickly.
CREATE INDEX IF NOT EXISTS submissions_n8n_status_idx
  ON submissions(n8n_status)
  WHERE n8n_status IS NULL OR n8n_status NOT IN ('success', 'manual_review');

COMMIT;
