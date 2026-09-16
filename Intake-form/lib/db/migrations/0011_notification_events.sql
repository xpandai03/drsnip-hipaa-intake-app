-- 0011_notification_events.sql — Train 3. A durable record of every app-side
-- notification attempt, including the ones that deliberately send nothing.
--
-- WHY: before this table, "did anyone get told?" was unanswerable. The app has
-- no email log, Fly log retention is effectively zero, and n8n executions are
-- pruned at 14 days (FINDINGS-submission-health.md §0 and §4). Every alert in
-- this system fires once, synchronously, or never — so a send that silently
-- skipped left no trace at all. `notifyPatientSubmission` has been skipping
-- with `no_recipient` on EVERY registration and consultation success since
-- launch (PATIENTMAIL_TO is unset); that is by design, but nothing recorded it.
--
-- PRIVACY (locked): the column set below is the EXHAUSTIVE whitelist and it is
-- deliberately incapable of holding PHI. There is no name, DOB, phone, email,
-- message body or subject column, and `recipient_class` is a role
-- ('staff' | 'operator'), never a raw address. `detail` is a short machine
-- reason ('no_recipient', 'HTTP 500', 'no_url'), never a rendered message.
-- The submission_id is the join key; the PHI stays in `submissions`, behind
-- console auth.
--
-- NOT captured this train: the n8n-side Gmail sends. Those live inside the
-- workflows and need a write-back endpoint to reach this table — a separate
-- train. Rows here therefore describe app-side sends ONLY.
--
-- Idempotent (IF NOT EXISTS) — safe to re-run via the Fly release_command.

CREATE TABLE IF NOT EXISTS notification_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable: a digest covers many submissions and belongs to none.
  -- ON DELETE CASCADE so purging a submission purges its notification trail.
  submission_id   uuid REFERENCES submissions (id) ON DELETE CASCADE,

  -- insurance_notify | fallback_doorbell | patientmail | digest
  channel         text NOT NULL,

  -- Free text, e.g. chart_created | failed | sweep_digest | insurance_arrived
  kind            text NOT NULL,

  -- Role only. 'staff' = the clinic inbox, 'operator' = the engineering inbox.
  -- NEVER a raw address: an address is contact data and this table is meant to
  -- be safe to read in bulk.
  recipient_class text NOT NULL,

  -- sent | skipped | error
  outcome         text NOT NULL,

  -- Short machine-readable reason. Non-PHI by construction; see the note above.
  detail          text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_events_submission_id_idx
  ON notification_events (submission_id);
CREATE INDEX IF NOT EXISTS notification_events_created_at_idx
  ON notification_events (created_at);
