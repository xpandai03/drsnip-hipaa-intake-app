# PHASE 2 DEPLOY NOTES — Fly.io

**Date:** 2026-05-20
**Live URL:** **https://drsnip-intake-demo.fly.dev**

**Status:** ⚠️ **Deployed and live, but NOT yet fully functional.** The app is
running on Fly.io and both forms render, but the database has no tables yet —
the migration + admin-seed step is **blocked by an environment network issue**
(see §4). Two short commands remain for you to run from a normal terminal —
see §5.

---

## 1. What was completed

| Step | Result |
|---|---|
| Merge `phase-2-reskin` → `main` (`--no-ff`), pushed to origin | ✅ |
| `0000_core_tables.sql` — hand-written DDL for the core tables (RISK-3) | ✅ committed to main |
| Fly Postgres provisioned — `drsnip-intake-demo-db`, region `lax` | ✅ |
| Fly app created — `drsnip-intake-demo` | ✅ |
| Dockerfile fixed (2 latent Phase-1 bugs — see §3) | ✅ |
| `fly deploy` — image built, 2 machines running, healthy | ✅ |
| Secrets set (`SESSION_SECRET`, `DATABASE_URL`) | ✅ |
| Run migrations against the live DB | ❌ **blocked — see §4** |
| Seed admin user | ❌ **blocked — see §4** |

`git log main` (top): `fix(deploy): force a clean tsc build…` → `fix(deploy):
node:20-slim…` → `fix(db): add SQL migration for core tables…` → `merge:
phase-2-reskin into main` → Phase 2 commits.

## 2. Infrastructure

- **App:** `drsnip-intake-demo` · region `lax` · 2 `shared-cpu-1x` machines,
  both `started`, health check `1/1 passing`.
- **Postgres:** app `drsnip-intake-demo-db` · region `lax` · 1 node ·
  host `drsnip-intake-demo-db.flycast:5432` · database `postgres` · user
  `postgres`. (Password is held only in the `DATABASE_URL` Fly secret — not
  recorded here, not in git.)
- **Secrets** (set via `fly secrets set` — never in git):
  `DATABASE_URL`, `SESSION_SECRET`.
- **DATABASE_URL note:** normally `fly postgres attach` creates a dedicated
  database + user and sets `DATABASE_URL`. `attach` is tunnel-based and is
  blocked here (§4), so `DATABASE_URL` was set directly via the API to the
  cluster's default `postgres` database. Fine for a demo; migrations below
  therefore target the `postgres` database.

## 3. Dockerfile fixes (Phase 1 left it untested — see PHASE_1_NOTES.md §5)

The first `fly deploy` failed building the image. Two bugs, both fixed and
committed to `main`:

1. **`node:20-alpine` → `node:20-slim`.** The pnpm platform overrides in
   `pnpm-workspace.yaml` keep the `linux-x64-gnu` native binaries
   (lightningcss / rollup / @tailwindcss/oxide) but strip the `musl` variants —
   so an alpine/musl image has no usable native binaries.
2. **Forced `@workspace/db` build.** A plain `tsc --build` was exiting 0 in the
   container *without emitting* `lib/db/dist` (stale incremental state), so the
   api typecheck couldn't resolve `@workspace/db`. The Dockerfile now runs
   `tsc --build --force` for `lib/db` and verifies the `.d.ts` output.

After these fixes the image builds cleanly (deployed image: 61 MB).

## 4. ⚠️ BLOCKER — migrations + admin seed could not be run from here

Every Fly command that reaches the database — `fly postgres attach`,
`fly proxy`, `fly postgres connect`, `fly ssh console` — builds a WireGuard
tunnel to `*.gateway.6pn.dev`. From this environment that handshake fails:

```
Error: can't build tunnel for personal: websocket: failed to WebSocket dial:
… Get "https://lax1.gateway.6pn.dev:443/": tls: first record does not look
like a TLS handshake
```

This is a network-level interception of the tunnel (it fails even with the
command sandbox disabled). API-based commands (`apps create`, `postgres
create`, `secrets set`, `deploy`) all worked — only the tunnel is blocked.

**Consequence:** the database has **no tables**, so `POST /api/submit` returns
500 and the admin console cannot load yet. This must be finished from a
terminal whose network can reach Fly's tunnel (a normal local shell almost
always can).

## 5. ▶️ REMAINING STEPS — run these to finish

From `Intake-form/` in a normal terminal:

```sh
# 1. Apply all migrations + seed the admin user (targets the `postgres` db).
for f in lib/db/migrations/0000_core_tables.sql \
         lib/db/migrations/0001_appointment_sync_events.sql \
         lib/db/migrations/0002_marketing_sources.sql \
         lib/db/migrations/0003_drsnip_schema.sql \
         scripts/seed-admin.sql; do
  echo "Applying $f"
  fly postgres connect -a drsnip-intake-demo-db -d postgres < "$f"
done
```

If `fly postgres connect` also fails on the tunnel from your shell, use a
proxy + any Postgres client instead:

```sh
fly proxy 15432:5432 -a drsnip-intake-demo-db &
# then connect a client to postgres://postgres:<pw>@localhost:15432/postgres
# (password: fly secrets list won't show it — get it from the DATABASE_URL
#  you set, or `fly pg ...`). Run the 4 migrations + scripts/seed-admin.sql.
```

```sh
# 2. Verify the live submission path:
curl -X POST https://drsnip-intake-demo.fly.dev/api/submit \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Test","lastName":"Patient","email":"test@example.com","phone":"5551234567","formType":"registration"}'
# expect: {"success":true,"id":"<uuid>"}
```

No app restart is needed after migrations — `DATABASE_URL` is already set and
the connection is pooled lazily.

## 6. Admin login

After `scripts/seed-admin.sql` is applied:

- **URL:** https://drsnip-intake-demo.fly.dev/admin/signin
- **Email:** `raunek@xpandai.com`
- **Password:** `DrSnipDemo2026!`  ← **TEMPORARY — rotate immediately after
  first login.** This is a demo credential. To change it, generate a new
  bcrypt hash (`node -e "console.log(require('bcryptjs').hashSync('NEW_PW',10))"`)
  and `UPDATE users SET password_hash='…' WHERE email='raunek@xpandai.com';`.

## 7. Smoke-test results

| # | Test | Result |
|---|---|---|
| 1 | `https://drsnip-intake-demo.fly.dev/healthz` | ✅ `200 {"status":"ok"}` |
| 2 | `GET /` | ✅ `200`, title `DrSnip Patient Intake`, SPA bundle served |
| 3 | `GET /consultation?patient_id=test123` | ✅ `200` |
| 4 | `fly status` | ✅ 2 machines `started`, checks `1/1 passing` |
| 5 | `POST /api/submit` | ⚠️ `500` — **expected until migrations run** (no `submissions` table) |
| 6 | Admin login | ⏳ pending the seed step (§5) |

Forms 1–4 confirm the deploy, branding, routing, and static serving all work.
5–6 complete once §5 is done.

## 8. Decisions

- **`fly apps create` instead of `fly launch`.** `fly.toml` already existed
  (Phase 1) and is complete; `fly apps create` + `fly deploy` is the
  deterministic, non-interactive path. Same result, no `fly launch` prompts.
- **`fly deploy --remote-only --no-cache`.** No local Docker; remote builder
  used. `--no-cache` was needed to clear a stale incremental-build layer.
- **Postgres is the unmanaged `fly postgres`** (per the task's command). Fly now
  recommends Managed Postgres (`fly mpg`); migrating is a future option.
- **HIPAA:** this is a demo. Do not put real patient data through the live URL.
  App logs carry IDs + error types only — no request bodies.
