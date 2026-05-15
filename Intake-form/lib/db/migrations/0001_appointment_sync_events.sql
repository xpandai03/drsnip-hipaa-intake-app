-- Workstream A (TimeTap ↔ Salesforce sync) — durable event log.
-- See cjc-sf-metadata/reports/timetap-sync-feasibility.md Area 3 / Workstream A.
--
-- drizzle-kit push is broken in this repo (see prior hold-valve session); this
-- migration is intended to be run manually with psql against $DATABASE_URL.

BEGIN;

CREATE TABLE IF NOT EXISTS appointment_sync_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    calendar_id text NOT NULL,
    raw_payload jsonb NOT NULL,
    direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    sf_status text NOT NULL DEFAULT 'pending',
    sf_appointment_id text,
    error text,
    attempts integer NOT NULL DEFAULT 0,
    last_attempt_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_sync_events_calendar_id_idx
    ON appointment_sync_events (calendar_id);

CREATE INDEX IF NOT EXISTS appointment_sync_events_created_at_idx
    ON appointment_sync_events (created_at);

CREATE INDEX IF NOT EXISTS appointment_sync_events_sf_status_idx
    ON appointment_sync_events (sf_status);

CREATE INDEX IF NOT EXISTS appointment_sync_events_direction_idx
    ON appointment_sync_events (direction);

COMMIT;
