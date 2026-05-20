-- Seed the initial DrSnip admin user.
--
-- password_hash is a bcryptjs hash, cost factor 10 (matches api/_lib/auth.ts).
-- The plaintext is a TEMPORARY demo credential recorded in
-- PHASE_2_DEPLOY_NOTES.md — rotate it immediately after first login.
--
-- Idempotent: ON CONFLICT DO NOTHING, safe to re-run.

INSERT INTO users (email, password_hash, name, is_active)
VALUES (
  'raunek@xpandai.com',
  '$2a$10$KVoVUyzUhnLVcpo1aDkL4.HQkl31n4FOsNyRiHrgCi7/1CicqzZjm',
  'Raunek Pratap',
  true
)
ON CONFLICT (email) DO NOTHING;
