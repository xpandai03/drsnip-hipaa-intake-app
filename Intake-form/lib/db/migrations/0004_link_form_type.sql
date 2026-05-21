-- Phase 2 polish — DrSnip link generator.
--
-- Adds form_type (registration | consultation) and a free-text notes column
-- to link_generations, so the reworked /admin/links page can record which
-- form a generated link targets plus an optional team note.
--
-- Idempotent. Applied automatically by the Fly release_command
-- (api-server/migrate.ts); to apply manually: psql "$DATABASE_URL" -f this.

BEGIN;

ALTER TABLE link_generations ADD COLUMN IF NOT EXISTS form_type text;
ALTER TABLE link_generations ADD COLUMN IF NOT EXISTS notes text;

COMMIT;
