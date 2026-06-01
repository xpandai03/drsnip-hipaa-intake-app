-- Phase 4 Block D (admin console) — add a role to admin accounts.
--
-- Two roles only:
--   'admin'   full access (delete, CSV export, generate intake links)
--   'viewer'  read-only — can see submissions/detail/PDF + link history, but
--             is blocked SERVER-SIDE from delete, export, and link generation.
--
-- Rollout safety (per Block D decision rule): the column DEFAULTs to 'admin'
-- and existing rows are backfilled to 'admin', so NOBODY loses access when
-- this ships. Read-only viewers are created explicitly (see
-- scripts/src/seed-viewer-user.ts).
--
-- Idempotent; safe to re-run via the Fly release_command (api-server/migrate.ts).

BEGIN;

-- The column: NOT NULL DEFAULT 'admin' backfills every existing user to admin.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';

-- Constrain to the two valid roles. ADD CONSTRAINT has no IF NOT EXISTS, so
-- guard it in a DO block to stay re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'viewer'));
  END IF;
END
$$;

COMMIT;
