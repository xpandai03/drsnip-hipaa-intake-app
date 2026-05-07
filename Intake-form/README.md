# CJC Intake Form

Single Vite + React form that replaces the SOFA Evaluation SurveyMonkey form.
Submits to a Zapier Catch Hook via a Vercel serverless function, which routes
to Salesforce.

## Project layout

```
Intake-form/                    ← pnpm-workspace root + Vercel project root
├── api/
│   └── submit.ts               ← Vercel serverless function
├── artifacts/
│   └── intake-form/            ← Vite + React SPA
│       └── src/pages/
│           ├── Home.tsx        ← The form
│           └── LinkGenerator.tsx ← Internal admin tool
├── lib/                        ← Shared workspace packages
├── vercel.json
└── .env.local.example
```

## Local development

```sh
pnpm install
pnpm --filter @workspace/intake-form dev    # form on http://localhost:5173
```

For end-to-end testing of `/api/submit` locally, install the Vercel CLI and run:

```sh
vercel dev
```

This serves both the SPA and the `api/submit.ts` function, reading
`ZAPIER_WEBHOOK_URL` from `.env.local`.

## Environment variables

| Var | Where | Purpose |
|---|---|---|
| `ZAPIER_WEBHOOK_URL` | Vercel project + `.env.local` | Server-side webhook target. Required. |

Copy `.env.local.example` → `.env.local` and fill in the value before running
`vercel dev` or deploying.

## Deploy to Vercel

1. Set Vercel **Root Directory** to `Intake-form/` (this folder).
2. Add `ZAPIER_WEBHOOK_URL` as a Project Environment Variable.
3. Build settings auto-load from `vercel.json`:
   - Build command: `pnpm --filter @workspace/intake-form build`
   - Output directory: `artifacts/intake-form/dist/public`
   - Install command: `pnpm install --frozen-lockfile=false`
4. SPA fallback rewrite is configured so `/internal-tools-x9k2` and other
   client-side routes work after deployment.

## Routes

- `/` — public intake form
- `/internal-tools-x9k2` — link generator for the team (not linked from the form,
  not public-facing). Bookmark the URL or share manually.
- `POST /api/submit` — Vercel serverless function; forwards validated payload to
  `ZAPIER_WEBHOOK_URL`.

## Source attribution via URL params

The form reads `source`, `campaign`, `event`, and standard `utm_*` params on
mount and includes them in the submission payload. `source` is mapped to a
Lead Source string server-side:

| `?source=` | Lead Source |
|---|---|
| `fnn` | `FNN: Webinar` |
| `internal` | `Internal: Webinar` |
| `federal` | `SOFA: Webinar` |
| (none / unknown) | `SOFA: Webinar` (default) |

Use the `/internal-tools-x9k2` page to generate pre-tagged URLs.

## Feature flags

Edit `artifacts/intake-form/src/pages/Home.tsx`:

```ts
const SHOW_FEEDBACK_QUESTIONS = true;  // Q4, Q5, Q7
```

When `false`, the Presentation Feedback step is removed and the progress bar
adjusts. Q6 (pre-retirement review) is the qualifying question and is always
shown regardless of this flag.

## Replit dev (legacy)

The repo can still be opened in Replit. Replit-specific Vite plugins
(`runtime-error-modal`, `cartographer`, `dev-banner`) load only when `REPL_ID`
is present in the environment, so they don't run on Vercel builds.
