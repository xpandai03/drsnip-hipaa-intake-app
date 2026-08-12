-- 0010_submission_files.sql — persist insurance/registration card image BYTES
-- inside BAA-covered Fly Postgres (the old Jotform stored images; the new form
-- regressed to filenames-only). One row per uploaded card; bytes live in a
-- bytea column and are served only through an authed endpoint — never in JSON,
-- raw_payload, logs, exports, the MCP, or the dashboard.
--
-- ON DELETE CASCADE: deleting a submission deletes its files. Additive +
-- idempotent (IF NOT EXISTS). Drop-off partials are intentionally excluded —
-- they never carry files.

CREATE TABLE IF NOT EXISTS submission_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  -- insurance_front | insurance_back | partner_front | partner_back
  kind           text NOT NULL,
  filename       text,
  mime           text,
  size_bytes     integer,
  -- stored | too_large | rejected | failed. Bytes are present only when 'stored'.
  status         text NOT NULL DEFAULT 'stored',
  bytes          bytea,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submission_files_submission_id_idx
  ON submission_files (submission_id);
