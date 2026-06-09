# Phase 5 — Password Reset (Implementation Plan)

**Status:** PLAN ONLY — no code written, no migration applied, no deploy. Awaiting review.
**App:** DrSnip intake admin (`Intake-form/`), live in `it-snip` on `drsnip-intake-db`.
**Context:** HIPAA app for a medical practice. Account existence is itself sensitive
(reveals who has access to a urology practice's admin tooling), so anti-enumeration is a
hard requirement, not a nicety.

This plan is split into two independently-shippable phases. **Phase 1 (admin-initiated
reset) has no email dependency and can ship alone.** Phase 2 (self-service forgot-password)
adds the public email flow and couples us to n8n. Review and approve them separately.

---

## 0. What already exists (reuse, don't rebuild)

Grounding the plan in the current code so we lean on proven primitives:

| Primitive | Location | Reuse for |
|---|---|---|
| `BCRYPT_COST = 10`, `verifyPassword()` | `api/_lib/auth.ts` | Same cost for new hashes. **Add** `hashPassword()` — there is currently NO hashing helper, only verify. |
| `verifyDummyPassword()` (constant-time dummy bcrypt) | `api/_lib/auth.ts` | Timing-equalization pattern to copy for enumeration safety. |
| `generateSessionId()` = `randomBytes(32).toString("base64url")` (256-bit) | `api/_lib/auth.ts` | Exact pattern for reset-token generation. |
| `createSession` / `destroySession` / session rows | `api/_lib/auth.ts`, `sessions` table | **Add** `invalidateAllUserSessions(userId)` (delete every session for a user) for post-reset logout-everywhere. |
| `requireAdmin` / `enforceAdmin` (pure, unit-tested gate) | `api/_lib/auth.ts` | Phase 1 admin endpoint gate — no new auth machinery. |
| `isAdmin`, `canDeleteSubmission`, … permission predicates | `api/_lib/permissions.ts` | **Add** `canResetPasswords(role)` = `isAdmin`. Keep the matrix greppable. |
| Per-email rate limiter (`loginAttempts`, 5 / 15 min) | `api/_lib/rate-limit.ts` | Pattern to mirror for the public request-reset endpoint. |
| Enumeration-safe login (generic error, dummy bcrypt, per-email limit) | `api/auth/login.ts` | Template for the public request-reset handler's neutrality. |
| n8n trigger: `fetch(url, {POST, headers:{"X-DrSnip-Token": secret}, body})`, never throws, `N8N_BRIDGE_ENABLED` killswitch | `lib/n8n/bridge.ts` | Same transport + auth header for the reset-email webhook. |
| Migration runner: ordered `STEPS[]`, `pool.query(sql)` every deploy, **no tracking table → every migration must be idempotent** | `api-server/migrate.ts` | New migration 0008 follows `IF NOT EXISTS` / `DO`-block-guarded-constraint convention from `0007_admin_role.sql`. |
| DB-free unit tests (`node:test`, `makeRes` mock, pure-logic split) | `api/_test/`, `permissions.test.ts` | Same shape for token-logic and gate tests. |
| HIPAA logging discipline: IDs/event-types only, never body content | `submit.ts`, `bridge.ts` | Reset handlers log `user_id` + `token_id` + event only — never the token, never the password, never PHI. |

**Gap noted:** there is **no users-list endpoint** (`api/admin/` has only `links.ts`,
`marketing-sources.ts`). Phase 1's console UI needs a way to pick a target user — see Open
Question Q4.

---

## PHASE 1 — Admin-initiated reset (small, no email)

**Goal:** an admin resets any user's password directly from the console. Working reset
immediately, zero email dependency.

### Behavior
- Admin selects a user and sets a new password (server validates policy, hashes, stores).
- On success: **all of that user's sessions are invalidated** (forced re-login everywhere),
  and any outstanding Phase-2 reset tokens for that user are invalidated (no-op until
  Phase 2 ships).
- Admin conveys the new password to the user out-of-band (phone/in-person) — see Q3 for
  "admin types it" vs "system generates a one-time temp password shown once to the admin."

### Endpoints / files touched
| File | Change |
|---|---|
| `api/admin/reset-password.ts` | **NEW.** `POST` handler. `requireAdmin` gate first. Body `{ userId (uuid) , newPassword }` (or `{ email }` — see Q4). Validates policy, hashes via new `hashPassword`, updates `users.password_hash`, invalidates sessions. Returns neutral success `{ ok: true }`. |
| `api/_lib/auth.ts` | **ADD** `hashPassword(plaintext)` (bcrypt, `BCRYPT_COST`); `invalidateAllUserSessions(userId)` (delete all `sessions` rows for user); optional `setUserPassword(userId, hash)` wrapper. |
| `api/_lib/permissions.ts` | **ADD** `canResetPasswords(role)` = `isAdmin(role)`. |
| `api-server/index.ts` | **ADD** route `app.all("/api/admin/reset-password", adapt(handler))`. |
| `api/admin/users.ts` | **NEW (conditional, Q4).** `GET` list of users (id, email, role, is_active) behind `requireAdmin`, to populate the console picker. Read-only, no hashes ever returned. |
| `artifacts/intake-form/` (admin console UI) | **NEW** "Reset password" control in the admin area — user picker + new-password field, calls the endpoint. UI gating is convenience; the server `requireAdmin` is the real gate. |
| `api/_test/reset-password.test.ts` | **NEW.** DB-free: `enforceAdmin` returns 401/403 for unauth/viewer; password-policy validation is a pure function tested in isolation. |

### Migration
**None.** Phase 1 reuses `users.password_hash`. No schema change. (Keeps Phase 1 genuinely
small and low-risk.)

### Permission model
- Server-side `requireAdmin` on the endpoint — identical gate to delete/export/links.
- `canResetPasswords` predicate added so the matrix and tests read as a spec.
- An admin may reset any account including other admins (no self-lockout special-casing;
  an admin resetting their own password just re-logs-in). Viewers: 403.

### Security surface (Phase 1)
- **AuthZ:** admin-only, enforced server-side; viewer/unauth rejected before any DB work.
- **Password policy:** min length (propose **12**), max 1024 (matches login). No reuse of the
  current password check needed for an admin-set reset. See Q2.
- **Session invalidation:** mandatory on reset — prevents a compromised old session from
  surviving a forced reset. Uses `invalidateAllUserSessions`.
- **Logging:** `[admin-reset]` audit line = `{ actor_user_id, target_user_id, event }` only.
  Never the new password, never echoed back in the response.
- **No plaintext at rest in transit beyond the request body** over HTTPS; hash computed
  server-side; plaintext discarded after hashing.

### Test strategy (Phase 1, DB-free)
- `enforceAdmin` gate: unauth → 401, viewer → 403, admin → proceeds (mock `res`, no DB).
- Password-policy validator: pure function — boundary lengths, empty, too-long.
- (Session invalidation + DB write are integration concerns; covered by manual verification
  on the live new DB, mirroring how Phase 4 was verified.)

---

## PHASE 2 — Self-service forgot-password (email flow)

**Goal:** a user requests a reset by email, receives a time-limited link via the existing
n8n Gmail path, and sets a new password.

### Endpoints / files touched
| File | Change |
|---|---|
| `api/auth/request-reset.ts` | **NEW.** Public, unauthenticated `POST { email }`. **Always** returns `200 { ok: true }` with neutral message "If an account exists, a reset link has been sent." Rate-limited. Looks up active user; if found, generates token, stores hash, fires n8n email (async). If not found, does equivalent work/timing and sends nothing. |
| `api/auth/reset-password.ts` | **NEW.** Public `POST { token, newPassword }`. Validates token (exists/!expired/!used), enforces password policy, hashes, updates `users.password_hash`, marks token used, **invalidates all the user's sessions**, invalidates the user's other outstanding tokens. Generic `400 invalid-or-expired` for any bad-token state. |
| `api/_lib/reset-tokens.ts` | **NEW. PURE, DB-free.** `generateResetToken()` (256-bit base64url), `hashToken(token)` (SHA-256 hex), `isExpired(expiresAt, now)`, `classifyToken(row, now)` → `valid | expired | used | unknown`. Split from DB exactly like `permissions.ts` is split from `auth.ts`, so it's unit-testable with no live DB. |
| `api/_lib/reset-email.ts` | **NEW.** Builds the reset-link payload and POSTs to the n8n password-reset webhook reusing the bridge's transport/auth pattern (`X-DrSnip-Token`, AbortController timeout, never throws, killswitch). |
| `api/_lib/auth.ts` | Reuse `hashPassword` + `invalidateAllUserSessions` (added in Phase 1). |
| `lib/db/src/index.ts` | **ADD** `passwordResetTokens` drizzle table def + export in the re-export block. |
| `lib/db/migrations/0008_password_reset.sql` | **NEW** migration (next number after 0007). Idempotent. |
| `api-server/migrate.ts` | **ADD** import + `{ name: "0008_password_reset", sql: ... }` to `STEPS` (before `seed-admin`). |
| `api-server/index.ts` | **ADD** routes for `/api/auth/request-reset` and `/api/auth/reset-password`. |
| `artifacts/intake-form/` | **NEW** `/forgot-password` request page + `/reset-password?token=…` confirm page. Confirm page POSTs the token (does not auto-execute on GET). |
| n8n (infra, outside repo) | **NEW** "Password Reset Email" workflow/webhook on `n8n-drsnip` that sends the link via the existing Gmail (IT@drsnip.com, Workspace BAA-covered) node. **Coupling risk flagged below.** |
| `api/_test/reset-tokens.test.ts` | **NEW.** DB-free token-logic + enumeration-neutrality tests. |

### Migration 0008 — `password_reset_tokens` (shape, not final SQL)
Idempotent (`CREATE TABLE IF NOT EXISTS`, guarded indexes), wrapped in `BEGIN/COMMIT`, same
convention as `0007_admin_role.sql`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK `defaultRandom()` | |
| `user_id` | `uuid` NOT NULL → `users.id` `ON DELETE CASCADE` | |
| `token_hash` | `text` NOT NULL UNIQUE | **SHA-256 of the token**, never the token itself |
| `expires_at` | `timestamptz` NOT NULL | short expiry — see Q1 |
| `used_at` | `timestamptz` NULL | single-use marker; set on successful reset |
| `requested_ip` | `text` NULL | for abuse forensics (mirrors `login_attempts.ip_address`) |
| `created_at` | `timestamptz` NOT NULL default now() | also drives per-email rate-limit counting |

Indexes: unique on `token_hash` (lookup path); `user_id` (invalidate-all + rate counting).

### Why SHA-256 for the token, not bcrypt
The token is 256-bit cryptographically random (full entropy), so it needs no
salt/stretching — bcrypt would add nothing and caps at 72 bytes. SHA-256 of the token,
stored hex, looked up by exact match on the indexed `token_hash`, is the correct standard.
A DB breach leaks only hashes; the plaintext token lives only in the emailed URL and the
user's inbox.

### Email delivery (n8n only — no new mailer)
- The app **never sends email directly.** `reset-email.ts` POSTs to a new n8n webhook
  (`N8N_WEBHOOK_PASSWORD_RESET_URL`), authed with the existing `N8N_WEBHOOK_SECRET` via the
  `X-DrSnip-Token` header — identical to `lib/n8n/bridge.ts`.
- A new n8n workflow node sends the link through the **same Gmail (IT@drsnip.com,
  BAA-covered)** transport the submission notification already uses. No app-side SMTP, no
  new provider. (Consistent with `[[patientmail-dual-path]]`: n8n Gmail is the sanctioned path.)
- Payload to n8n: recipient email + absolute reset URL + expiry minutes. **No PHI**, no
  password. The app builds the URL; n8n only delivers.
- **Coupling risk (explicit):** password reset is now dependent on n8n availability and on
  that workflow staying healthy. If `n8n-drsnip` is down or the workflow is edited/broken,
  reset emails silently stop. Mitigations: (a) Phase 1 admin reset is always available as a
  fallback; (b) gate sending behind `N8N_BRIDGE_ENABLED` (or a dedicated flag, Q9) so the
  request endpoint still returns its neutral 200 even when sending is disabled; (c) the n8n
  call is fire-and-forget so reset *requests* never hang on n8n; (d) add the reset email to
  the n8n monitoring/verification done during the cutover.

### Security surface (Phase 2) — the core of this plan
1. **Token entropy:** 256-bit (`randomBytes(32)` base64url), same generator as session IDs.
2. **Hashed at rest:** only SHA-256(token) stored; plaintext token never persisted or logged.
3. **Single-use:** `used_at` set inside the same transaction as the password update; a
   second use of the same token classifies as `used` → generic invalid response.
4. **Short expiry:** propose **30 minutes** (Q1). `isExpired` checked server-side against
   `expires_at`.
5. **Invalidate on use AND on any password change:** successful reset (Phase 2) and admin
   reset (Phase 1) both delete the user's outstanding tokens, so an emailed link is dead the
   moment the password changes by any path.
6. **No user enumeration:** `request-reset` returns the **same status, body, and shape**
   whether or not the email matches. Do the user lookup unconditionally; branch only on
   whether to enqueue the email. Equalize timing (don't let "email exists" do visibly more
   synchronous work — the n8n call is async/fire-and-forget; token gen+insert is fast). The
   confirm endpoint returns a single generic `invalid-or-expired` for unknown/expired/used,
   so token *state* can't be probed either.
7. **Rate-limiting (abuse + enumeration-via-volume):** mirror `rate-limit.ts`.
   - Per-email: max **N** request-reset per email per window (propose 3 / 15 min) — counted
     from `password_reset_tokens.created_at` for that user.
   - Per-IP: a coarser cap (propose 10 / hour) to blunt mass-enumeration across emails.
   - Confirm endpoint: cap attempts per IP to stop token brute-force (though 256-bit entropy
     already makes guessing infeasible). See Q7 for thresholds.
8. **Session invalidation on reset:** all sessions for the user dropped on success — a reset
   logs out every device, killing any session an attacker may hold.
9. **Token-in-URL hygiene:** reset link is HTTPS-only; the confirm page loads **no
   third-party resources** (no referrer leak of the token) and sends `Referrer-Policy:
   no-referrer`; short expiry + single-use bound the blast radius if a URL leaks via history.
10. **No PHI / no secrets in logs:** handlers log `{ user_id, token_id, event }` only — never
    the token, the password, or the email body. Matches existing HIPAA logging discipline.
11. **Input validation:** zod on both endpoints (email format; token shape; password policy),
    mirroring `login.ts`.

### Test strategy (Phase 2, DB-free)
- `reset-tokens.ts` pure tests: token length/charset (entropy), `hashToken` determinism &
  that output ≠ input, `isExpired` boundaries, `classifyToken` → valid/expired/used/unknown.
- **Enumeration-neutrality test:** with the user-lookup mocked, assert `request-reset`
  returns identical status + body for existent vs non-existent email (the security-critical
  guarantee, proven without a DB — same approach as `permissions.test.ts`).
- Password-policy validator reused from Phase 1.
- Rate-limit decision function tested as pure logic (count + window → allow/deny) like
  `checkLoginRateLimit`'s shape.

---

## Reused vs new (summary)

**Reused:** bcrypt cost + verify, session model, `requireAdmin`/`enforceAdmin`, permission
matrix, rate-limit pattern, n8n transport + auth header + killswitch, migration runner +
idempotency convention, `node:test` + `makeRes` harness, HIPAA logging discipline,
enumeration-safe login template.

**New (Phase 1):** `hashPassword` + `invalidateAllUserSessions` helpers, `canResetPasswords`,
`api/admin/reset-password.ts`, admin-console UI control, (conditional) `api/admin/users.ts`,
one test file. **No migration.**

**New (Phase 2):** `password_reset_tokens` table + migration 0008 + schema export + runner
wiring, `api/_lib/reset-tokens.ts` (pure), `api/_lib/reset-email.ts`, `request-reset.ts`,
`reset-password.ts`, two UI pages, an n8n workflow/webhook (infra), `N8N_WEBHOOK_PASSWORD_RESET_URL`
secret, dedicated rate-limit logic, test files.

---

## Open questions (your decisions before any build)

1. **Token lifetime** — propose **30 minutes**. Acceptable, or prefer 60 min / 15 min?
2. **Password policy** — propose **min 12 chars**, max 1024, no forced complexity rules
   (length > composition). Want complexity/denylist requirements for a HIPAA admin app?
3. **Phase 1 conveyance** — (a) admin types the new password and tells the user out-of-band,
   or (b) system generates a random temp password shown **once** to the admin (and optionally
   forces change-on-next-login)? (a) is simplest; (b) avoids weak admin-chosen passwords.
4. **Phase 1 user selection** — add a small `GET /api/admin/users` list endpoint + picker, or
   keep Phase 1 minimal with the admin entering the target **email**? (List endpoint is more
   usable but is extra surface.)
5. **Reset email content constraints (HIPAA)** — propose minimal: subject "DrSnip admin
   password reset", body = no PHI, no name beyond the address, just "a reset was requested
   for your DrSnip admin account," the link, and the expiry; sender IT@drsnip.com. Any
   required branding, legal footer, or wording you want?
6. **Phase 2 timing** — ship Phase 2 now, or land Phase 1 first and defer Phase 2 until the
   n8n reset workflow is built and monitored?
7. **Rate-limit thresholds** — request-reset: propose 3 / email / 15 min and 10 / IP / hour;
   confirm: propose 10 / IP / 15 min. Adjust?
8. **Force-change-on-next-login flag** — add a `must_reset_password` capability (admin can
   force a user to change at next login)? Optional; adds a column + login-path check.
9. **n8n killswitch** — reuse `N8N_BRIDGE_ENABLED` to gate reset emails, or add a dedicated
   `PASSWORD_RESET_EMAIL_ENABLED` so the submission bridge and reset email can be toggled
   independently?

---

## Guardrails for the build (when approved)
- Phase 1 and Phase 2 reviewed and built **separately**.
- Migration 0008 is **idempotent** and only runs via the normal `release_command` (no manual
  apply); it adds a table only — no change to existing tables.
- No new email provider; n8n Gmail is the only transport.
- No plaintext passwords or tokens in logs, responses, or persistence.
- Nothing deployed without your go.
