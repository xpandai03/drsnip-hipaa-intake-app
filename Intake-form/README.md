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

This serves both the SPA and the `api/submit.ts` function, reading the
`ZAPIER_WEBHOOK_*` vars below from `.env.local`.

## Environment variables

`/api/submit` dispatches to one of three Zapier Catch Hooks based on the
`?source=` URL param the form was loaded with. All three should be set in any
environment that handles real submissions.

| Var | `?source=` | Survey_Detail__c | Salesforce Campaign route |
|---|---|---|---|
| `ZAPIER_WEBHOOK_FEDERAL` | `federal` (default) | `DC SOFA` | Federal_Agency__c → agency-specific Campaign |
| `ZAPIER_WEBHOOK_INTERNAL` | `internal` | `DC SOFA 2` | "INTERNAL MARKETING" Campaign |
| `ZAPIER_WEBHOOK_FNN` | `fnn` | `DC SOFA 3` | FNN Campaign |

If `?source=` is missing or unrecognized, the request is treated as `federal`.
If the matching env var is unset for an incoming request, `/api/submit` returns
500 with `Webhook URL not configured for source: <source>`.

Copy `.env.local.example` → `.env.local` and fill in the values before running
`vercel dev` or deploying. The legacy single-webhook var `ZAPIER_WEBHOOK_URL`
is no longer read.

## Deploy to Vercel

1. Set Vercel **Root Directory** to `Intake-form/` (this folder).
2. Add `ZAPIER_WEBHOOK_FEDERAL`, `ZAPIER_WEBHOOK_INTERNAL`, and
   `ZAPIER_WEBHOOK_FNN` as Project Environment Variables.
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
- `POST /api/submit` — Vercel serverless function; routes the payload to one of
  the three `ZAPIER_WEBHOOK_*` URLs based on the `source` field in the body.

## Source attribution via URL params

The form reads `source`, `campaign`, `event`, and standard `utm_*` params on
mount and includes them in the submission payload. `source` drives both the
client-side `leadSource` label (preserved for downstream Zaps that still set
`Lead.LeadSource`) and the `surveyDetail` field that the Salesforce Apex
trigger `LeadHandler.addLeadInCampaign` reads to pick a Campaign:

| `?source=` | `leadSource` (in payload) | `surveyDetail` (in payload, drives Campaign routing) |
|---|---|---|
| `fnn` | `FNN: Webinar` | `DC SOFA 3` |
| `internal` | `Internal: Webinar` | `DC SOFA 2` |
| `federal` | `SOFA: Webinar` | `DC SOFA` |
| (none / unknown) | `SOFA: Webinar` (default) | `DC SOFA` (default) |

`leadSource` was the original channel signal but is unreliable for attribution
(Apex doesn't read it; the Zaps hardcode a value). `surveyDetail` is what Apex
actually routes on. See `CAMPAIGN_AUDIT_FINDINGS.md` for details.

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
