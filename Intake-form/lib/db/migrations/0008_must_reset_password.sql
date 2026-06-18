-- Phase 5 Block 1 (password reset) — force-change-on-next-login capability.
--
-- When an admin resets another user's password (api/admin/reset-password),
-- the system sets a one-time temporary password and flips this flag to true.
-- The login path surfaces the flag; the user must set a new password via
-- api/auth/change-password, which clears it. This is what makes the
-- "admin generates a temp password" flow safe — the temp credential cannot
-- become a long-lived password.
--
-- Rollout safety: NOT NULL DEFAULT false backfills every existing user to
-- "no reset required", so nobody is forced to reset on deploy.
--
-- Idempotent; safe to re-run via the Fly release_command (api-server/migrate.ts),
-- same convention as 0007_admin_role.sql.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_reset_password boolean NOT NULL DEFAULT false;

COMMIT;
