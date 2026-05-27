-- Seed the initial DrSnip admin users.
--
-- password_hash is a bcryptjs hash, cost factor 10 (matches api/_lib/auth.ts).
-- The plaintext is a TEMPORARY demo credential — rotate it after first
-- login. Plaintexts are NEVER committed; only the bcrypt hash.
--
-- Idempotent: ON CONFLICT DO NOTHING is safe to re-run on every deploy
-- (existing rows are preserved, including any in-place password changes).

INSERT INTO users (email, password_hash, name, is_active)
VALUES (
  'raunek@xpandai.com',
  '$2a$10$KVoVUyzUhnLVcpo1aDkL4.HQkl31n4FOsNyRiHrgCi7/1CicqzZjm',
  'Raunek Pratap',
  true
)
ON CONFLICT (email) DO NOTHING;

-- Jeffrey Cho (DrSnip CEO) — admin access for the n8n cutover demo.
-- Plaintext is held in the chat handoff; rotate via the same mechanism
-- after first login. Same DO-NOTHING idempotency so subsequent deploys
-- preserve any password rotation done in-DB.
INSERT INTO users (email, password_hash, name, is_active)
VALUES (
  'jeffrey.cho@drsnip.com',
  '$2a$10$osagqtBXI9keoIPxK8ImoeMObxagrDEv0HtO7Y3ldLx/5bE4lDahS',
  'Jeffrey Cho',
  true
)
ON CONFLICT (email) DO NOTHING;
