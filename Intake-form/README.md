# DrSnip Intake Form

Patient-intake web form for **DrSnip**, a HIPAA-regulated vasectomy clinic.
Adapted from a prior client's (CJC) intake codebase.

> **Phase status.** This repo is mid-adaptation. **Phase 1 (complete)** stripped
> the prior client's subsystems (lead scoring, Salesforce push, TimeTap sync,
> hold-valve) and migrated hosting from Vercel to Fly.io. **The form content is
> still the prior client's** — Phase 2 replaces it with DrSnip's questions and
> rebrands the UI; Phase 3 adds insurance-card upload and PDF generation. See
> `PHASE_1_NOTES.md` at the repo root.

## Stack

- **Frontend:** Vite + React 19 + TypeScript, Tailwind CSS v4, wouter (routing).
- **Backend:** a single [Hono](https://hono.dev) server (`api-server/`) that
  serves the built SPA and the `/api/*` routes in one process.
- **Database:** PostgreSQL via Drizzle ORM (`lib/db/`).
- **Repo:** pnpm workspace monorepo — packages: `artifacts/intake-form` (SPA),
  `lib/db` (database), `scripts` (seed scripts).
- **Hosting:** Fly.io (Docker image; `Dockerfile` + `fly.toml`).

## Project layout

```
Intake-form/                     ← pnpm-workspace root
├── api/                         ← API route handlers (one file per route)
├── api-server/                  ← Hono server: mounts api/* handlers + serves the SPA
├── artifacts/intake-form/       ← Vite + React SPA
├── lib/db/                      ← Drizzle ORM schema + Postgres client
├── scripts/                     ← seed scripts (admin users, settings)
├── Dockerfile, fly.toml         ← Fly.io deployment
└── .env.local.example
```

## Local development

```sh
pnpm install

# Frontend only (fast iteration on the form UI) — http://localhost:5173
pnpm --filter @workspace/intake-form dev

# Full server (SPA + /api/* on one port) — http://localhost:8080
# Requires DATABASE_URL for database-backed routes to work.
pnpm build      # typecheck + build SPA/libs + bundle the server
pnpm start      # runs dist/server.cjs
```

Copy `.env.local.example` → `.env.local` and set `DATABASE_URL` before running
the full server.

## Routes

- `/` — public intake form (renders when loaded with a `?source=` param).
- `/admin/*` — auth-gated admin console (submissions, activity, sources, links).
- `POST /api/submit` — accepts a form submission, persists it to `submissions`.
- `GET /healthz` — health check (used by Fly.io).

## Build & deploy (Fly.io)

```sh
fly apps create drsnip-intake-demo          # one time
fly secrets set DATABASE_URL=postgres://...  # one time
fly deploy                                   # builds the Dockerfile, ships it
```

The Docker build runs `pnpm build`, which compiles the SPA and bundles the Hono
server into `dist/server.cjs`. The runtime image is Node 20 + that bundle + the
static SPA.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string (`lib/db`). |
| `NODE_ENV` | no | `production` makes session cookies Secure-only. |
| `PORT` | no | api-server listen port (default `8080`). |

See `.env.local.example`.

## HIPAA note

This app will handle PHI in production. Application code logs **IDs and error
types only — never request-body content**. Keep it that way. A HIPAA-compliance
pass (PHI access auditing, BAAs, at-rest encryption review) is tracked for a
later phase.
