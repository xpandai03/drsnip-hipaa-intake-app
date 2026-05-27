-- Phase 3 (n8n bridge-link) — capture the n8n executionId + workflowId on
-- every bridge call so the admin console can deep-link from a submission
-- row directly to its n8n execution in the n8n UI:
--
--   {N8N_BASE_URL}/workflow/{n8n_workflow_id}/executions/{n8n_execution_id}
--
-- Populated on both success and failure paths (n8n's webhook node returns
-- the execution id in the `x-n8n-execution-id` response header).
-- `n8n_workflow_id` is set by the bridge based on which webhook was hit
-- (Registration vs Consultation v2).
--
-- Idempotent; safe to re-run via the Fly release_command.

BEGIN;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS n8n_execution_id text,
  ADD COLUMN IF NOT EXISTS n8n_workflow_id  text;

COMMIT;
