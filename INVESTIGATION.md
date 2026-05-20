# INVESTIGATION — CJC Intake Form → DrSnip Adaptation Surface Map

**Date:** 2026-05-20
**Mode:** Read-only research. No code, configs, migrations, or deploys were modified.
**Repo root:** `/Users/raunekpratap/Desktop/DRSNIP-MAY2026-intake-dem0`
**App location:** `Intake-form/` (the git repo root contains planning docs + the `Intake-form/` app directory)

---

## 0. ⚠️ STOP-AND-FLAG: The codebase does not match the brief's description

The task brief calls this "a Next.js intake form app." **It is not Next.js.** The
iteration protocol asked me to pause and flag a meaningful framework mismatch. Here
it is — I completed the investigation anyway because the 10-step report structure
still maps cleanly onto what is actually here, but **please confirm you want to
proceed on these real facts before planning the adaptation:**

| Brief assumed | Actually is | Evidence |
|---|---|---|
| Next.js app | **Vite 7 + React 19 SPA** + **Vercel serverless functions** | `Intake-form/artifacts/intake-form/vite.config.ts`; `Intake-form/vercel.json`; no `next.config.*` exists anywhere |
| Single app | **pnpm monorepo, 9 workspace packages** | `Intake-form/pnpm-workspace.yaml:1-5`; `Intake-form/package.json` |
| "PDF generation logic" exists | **No PDF generation exists at all** | No `react-pdf`/`pdfkit`/`puppeteer`/`jsPDF`/`pdf-lib` in `pnpm-lock.yaml`; zero `pdf` references in any source file |
| JotForm replacement for a clinic | This is a **financial-advisor SOFA/TSP retirement-eval form** for **federal employees** | `Intake-form/artifacts/intake-form/src/pages/Home.tsx:16-61` (every field is TSP/federal-retirement specific) |

Two stale planning docs are the likely source of the "Next.js" misconception:
`plan.md` (repo root) line 5 literally says *"single Next.js form"* — it is a
Phase-1 doc that no longer reflects the build. `Intake-form/replit.md` is **also
stale**: it describes an Express `api-server` package that has since been deleted
(`Intake-form/README.md` confirms `artifacts/api-server/` was "deleted in Phase 2
Sprint 0"). Treat `plan.md` and `replit.md` as historical, not current.

**Bottom line for adaptation:** this is still a standard multi-step intake form —
the adaptation work is real and the report below is accurate — but it is a
Vite SPA you will deploy to Vercel, *not* a Next.js app, and there is **no PDF
engine to rebrand; there is a PDF engine to build from scratch.**

---

## 1. Repo orientation

### Layout

```
DRSNIP-MAY2026-intake-dem0/        ← git root; INVESTIGATION.md saved here
├── CAMPAIGN_AUDIT_FINDINGS.md     ← planning doc (CJC Salesforce attribution audit)
├── PLAN_PHASE_2.md                ← planning doc (Phase 2 console)
├── plan.md                        ← STALE Phase-1 doc ("Next.js", "no database")
├── surveymonkey_questions.md      ← source survey content
└── Intake-form/                   ← THE APP (pnpm-workspace root + Vercel project root)
    ├── api/                       ← Vercel serverless functions (the backend)
    ├── artifacts/
    │   ├── intake-form/           ← Vite + React SPA (the frontend)
    │   └── mockup-sandbox/        ← unrelated UI-component sandbox (see §11)
    ├── lib/
    │   ├── db/                    ← Drizzle ORM schema + Postgres client
    │   ├── scoring/               ← lead-scoring rule engine
    │   ├── api-spec/              ← OpenAPI 3.1 spec + Orval codegen config
    │   ├── api-client-react/      ← generated React Query client
    │   └── api-zod/               ← generated Zod validators
    ├── scripts/                   ← seed scripts (admin users, rules, settings)
    ├── vercel.json
    └── .env.local.example
```

### Framework versions & key dependencies

- **Frontend:** React `19.1.0`, Vite `^7.3.0`, TypeScript `~5.9.2`, Tailwind CSS `v4`, wouter `^3.3.5` (routing), `@tanstack/react-query` `^5.90`, `framer-motion` `12.35`, `react-hook-form` `^7.55` *(installed but the main form does not use it — see §3)*, shadcn/ui component set (`Intake-form/artifacts/intake-form/src/components/ui/`, ~60 files). Source: `Intake-form/artifacts/intake-form/package.json`, `Intake-form/pnpm-workspace.yaml` catalog.
- **Backend:** `@vercel/node` `^5.3.27` serverless functions. No Express, no Next.js.
- **DB:** `drizzle-orm` `^0.45.1` + `pg` (node-postgres) → PostgreSQL. `lib/db/src/index.ts:1`, `:138`.
- **Validation:** `zod` `^3.25` (API handlers) + `zod/v4` + `drizzle-zod` (schema).
- **Auth:** `bcryptjs` `2.4.3` (password hashing) + custom server-side sessions.
- **Node:** `.replit` declares Node 24; local machine runs Node 20.20.2 (works for dev).
- **Package manager:** pnpm `10.33.4`. `Intake-form/package.json` `preinstall` hard-blocks npm/yarn.

### Build / run scripts

- `Intake-form/package.json` — `build` (`typecheck` + recursive package builds), `test`, `test:api`, `test:scoring`.
- `Intake-form/artifacts/intake-form/package.json` — `dev` (Vite dev server, port 5173), `build`, `serve`, `typecheck`.
- `Intake-form/vercel.json` — `buildCommand: pnpm run typecheck:libs && pnpm --filter @workspace/intake-form build`; `outputDirectory: artifacts/intake-form/dist/public`.
- **Local dev note:** `pnpm install` succeeds; `pnpm --filter @workspace/intake-form dev` serves the SPA. The serverless API (`api/*`) is *not* served by Vite — it needs `vercel dev` plus a populated `.env.local`.

---

## 2. Routing & pages map

There are **two routing layers**: client-side SPA routes (wouter) and file-based
Vercel serverless API routes.

### 2a. Frontend SPA routes — `Intake-form/artifacts/intake-form/src/App.tsx:45-92`

| Route | Component | Access | Notes |
|---|---|---|---|
| `/` | `RootIntakeGate` → `Home` | **Public IF `?source=` present**, else redirects to `/admin/signin` | Gate logic at `App.tsx:32-43`. The public intake form only renders when the URL carries a `?source=` param. |
| `/internal-tools-x9k2` | `LinkGenerator` | **Public, unguarded** (obscure URL only) | Legacy "security through obscurity" admin link tool. `App.tsx:48`. |
| `/admin` | redirect → `/admin/links` | — | `App.tsx:51-53` |
| `/admin/signin` | `SignIn` | Public | Email/password login form. |
| `/admin/links` | `AdminLinks` (wraps `LinkGenerator`) | **Protected** | Campaign-URL generator. |
| `/admin/submissions` | `AdminSubmissions` | **Protected** | Paginated lead list + detail modal. |
| `/admin/activity` | `AdminActivity` | **Protected** | Recharts heatmap/aggregates. |
| `/admin/scoring-rules` | `AdminScoringRules` | **Protected** | Read-only view of the published scoring rule set; "request a change" is a `mailto:` link (`ScoringRules.tsx:87`). |
| `/admin/held-leads` | `AdminHeldLeads` | **Protected** | "Hold valve" review queue + toggle. |
| `/admin/sources` | `AdminSources` | **Protected** | CRUD for marketing-source catalog. |
| `*` | `NotFound` | — | `not-found.tsx` |

Protection is enforced two ways: client-side `AuthProvider`/`AdminLayout` (UX
guard, `App.tsx:23-25`, `AdminLayout.tsx:8-16`) **and** server-side `requireAuth`
on every protected API handler. `AdminLayout.tsx:14-15` explicitly states the
server is the real gate.

### 2b. API routes — `Intake-form/api/` (Vercel file-based serverless functions)

| Route | File | Method | Auth |
|---|---|---|---|
| `/api/submit` | `api/submit.ts` | POST | **Public** (the form endpoint) |
| `/api/auth/login` | `api/auth/login.ts` | POST | Public; **rate-limited** (5 fails/15 min per email) |
| `/api/auth/logout` | `api/auth/logout.ts` | POST | Public (idempotent) |
| `/api/auth/me` | `api/auth/me.ts` | GET | `requireAuth` |
| `/api/submissions` | `api/submissions/index.ts` | GET | `requireAuth` |
| `/api/submissions/[id]` | `api/submissions/[id].ts` | GET | `requireAuth` |
| `/api/submissions/[id]/release` | `api/submissions/[id]/release.ts` | POST | `requireAuth` |
| `/api/submissions/[id]/discard` | `api/submissions/[id]/discard.ts` | POST | `requireAuth` |
| `/api/submissions/held` | `api/submissions/held.ts` | GET | `requireAuth` |
| `/api/submissions/activity` | `api/submissions/activity.ts` | GET | `requireAuth` |
| `/api/submissions/release-all` | `api/submissions/release-all.ts` | POST | `requireAuth` |
| `/api/rules/published` | `api/rules/published.ts` | GET | `requireAuth` |
| `/api/settings/[key]` | `api/settings/[key].ts` | GET/PUT | `requireAuth` |
| `/api/admin/marketing-sources` | `api/admin/marketing-sources.ts` | GET/POST | `requireAuth` |
| `/api/admin/marketing-sources/[id]` | `api/admin/marketing-sources/[id].ts` | GET/PUT/DELETE | `requireAuth` |
| `/api/timetap/webhook` | `api/timetap/webhook.ts` | POST | **NONE — unauthenticated** (see §11 RISK-1) |
| `/api/cron/timetap-poll` | `api/cron/timetap-poll.ts` | GET/POST | **NONE — unauthenticated** (see §11 RISK-1); runs every minute via `vercel.json` `crons` |

---

## 3. Form-rendering engine

### Code-defined, not data-defined

Form definitions are **100% code-defined hardcoded React** — there is **no JSON
schema, no DB-driven form definition, no schema type**. The entire intake form
lives in one file: `Intake-form/artifacts/intake-form/src/pages/Home.tsx` (914 lines).

- The form is an array of **`Screen` objects** (`Home.tsx:300-649`, variable `allScreens`).
- The `Screen` type (`Home.tsx:245-252`) has: `id`, optional `category`, `title`,
  optional `description`, a `render: () => React.ReactNode` function returning raw JSX,
  and an `isValid: () => boolean`.
- Form state is a single flat `FormData` object — type at `Home.tsx:16-61`, initial
  value at `Home.tsx:63-96` — held in one `useState` (`Home.tsx:259`). Note: the form
  does **not** use `react-hook-form` despite it being an installed dependency.

There are 7 screens (about-you, contact, feedback, pre-retirement, demographics,
financials, status) covering ~15 questions. Every question is CJC-specific: TSP
balances, federal-agency dropdown, years-to-retirement, SOFA presentation feedback.

### Field types that exist

All field types are rendered inline as JSX inside each screen's `render()`. There
is **no field-type registry or dispatcher**. Existing types:

| Type | Implementation | Example |
|---|---|---|
| Text / email / tel | `<Input>` (`components/ui/Input.tsx`) | `Home.tsx:309`, `:327`, `:349` |
| Number | `<Input type="number">` | `Home.tsx:513`, `:576` |
| Native dropdown | raw `<select>` | `Home.tsx:369-378` (the agency picker) |
| Multi-line text | raw `<textarea>` | `Home.tsx:449`, `:638` |
| Single-select card grid | `<RadioCard>` (`components/ui/RadioCard.tsx`) | `Home.tsx:421`, `:467`, `:487` |

**No file-upload field type exists. No date-picker field is used** (a shadcn
`calendar.tsx` component is present in `components/ui/` but unused by the form).
No multi-select, no checkbox group, no signature field.

### Conditional logic / branching

There is **no general branching/skip-logic engine.** Conditionals are hardcoded:

1. **Inline field reveals** via `framer-motion`'s `AnimatePresence`:
   - "Specify your agency" text field appears when `agency === "Other"` (`Home.tsx:383-399`).
   - "What percentage are you contributing" appears when `maxingTsp === "NO"` (`Home.tsx:563-586`).
2. **Early-exit branch:** `isPreRetirementNo` (`Home.tsx:658-660`) — answering "No"
   to the pre-retirement-review question makes that screen the final step (Submit
   instead of Continue).
3. **Feature flag:** `SHOW_FEEDBACK_QUESTIONS` (`Home.tsx:12`) filters the feedback
   screen out of `allScreens` (`Home.tsx:651-653`) and the progress bar adjusts.

### Validation — client-first, server type-guard

- **Client:** each screen's `isValid()` (e.g. `Home.tsx:336-339`) gates the
  Continue button. This is the real UX validation; it is presence/non-empty checks only.
- **Server:** `api/submit.ts:29-65` — a Zod `bodySchema` validates types, required
  fields, max lengths, and email format. It is a shape/type guard, **not** business
  validation. So: validation is "both," but neither side does domain-rule validation.

### Where to add a new field type (e.g., insurance-card upload)

Because the form is code-defined with no registry, adding a field touches **~5
files** minimum:

1. `Home.tsx` — add the field to `FormData` (`:16`), `initialData` (`:63`), and JSX inside a screen's `render()`.
2. `api/submit.ts` — add it to `bodySchema` (`:29`) and the DB-insert object (`:151`).
3. `lib/db/src/schema/submissions.ts` — add a column.
4. `lib/scoring/src/types.ts:7-32` — add to `LEAD_FIELDS` if it should be scoreable.
5. `api/_lib/lead-fields.ts` — add to the Salesforce field mapping if it should sync out.

A **file-upload field is substantially more than "a new field type"** — see §11
GAP-1: the form posts a single JSON body (`Home.tsx:665-669`), there is no
multipart handling, and there is no object storage configured anywhere.

---

## 4. PDF generation

**There is no PDF generation in this codebase. None.**

- No PDF library in `Intake-form/pnpm-lock.yaml`: searched `react-pdf`, `@react-pdf`,
  `pdfkit`, `puppeteer`, `playwright`, `jspdf`, `pdf-lib`, `html-pdf` — zero matches.
- No source file references `pdf` (case-insensitive) anywhere under `api/`, `lib/`,
  or `artifacts/intake-form/src/`.
- There is no DrChrono integration, no DrChrono dependency, and no DrChrono
  reference of any kind.

**Consequence for DrSnip:** the brief's questions 4 ("what library is used", "is
the template code- or data-driven", "could I produce a DrSnip-branded PDF by
editing one file") **have no answer because the feature does not exist.** A
DrChrono-compatible patient-intake PDF must be **built from scratch** — this is
net-new work, not a reskin. See §11 GAP-2 and the adaptation sequence (§13).

---

## 5. Submission flow & storage

### What happens on submit — `api/submit.ts` (391 lines)

The form `POST`s its `FormData` as JSON to `/api/submit` (`Home.tsx:662-689`). The
handler then:

1. **Validates** the body with Zod (`submit.ts:94-100`).
2. **Persists a row to Postgres first**, `sf_status='pending'` (`submit.ts:151-185`)
   — deliberate audit-trail-before-side-effects ordering. The full request body is
   also stored verbatim in a `raw_payload` jsonb column (`submit.ts:182`).
3. **Scores the lead** using the published rule set from the DB (`submit.ts:192-251`),
   falling back to the in-code `V1_RULE_SET`. Writes `rank`, `lead_score`, and a
   full `scoring_trace` jsonb back to the row.
4. **Hold-valve gate** (`submit.ts:272-288`) — if an admin toggle is on and the
   score byte-matches `"7  ($0-$350k)"`, the row is marked `held` and the
   Salesforce push is skipped.
5. **Pushes a Lead to Salesforce** via REST (`submit.ts:300`, `createLead`).
6. **Optionally returns a TimeTap self-scheduling redirect URL** for qualifying
   leads (`submit.ts:318-368`); also optimistically PATCHes the SF Lead's
   `Meeting_stage__c`.

> **Note:** `README.md` and `plan.md` describe submissions going to a **Zapier
> Catch Hook** (`ZAPIER_WEBHOOK_*`). **This is stale.** The current code pushes
> **directly to Salesforce** via OAuth REST (`api/_lib/sf.ts`). `ZAPIER_WEBHOOK_*`
> env vars are referenced in docs but **read by no code** (verified — see §8).

### Where data lands

| Sink | Detail |
|---|---|
| **PostgreSQL** | Primary store. Every submission → `submissions` table. Drizzle ORM. `lib/db/src/index.ts:138` creates a `pg.Pool` from `DATABASE_URL`. |
| **Salesforce** | Outbound. `api/_lib/sf.ts` — OAuth 2.0 Client Credentials flow (`sf.ts:59-87`), `POST /services/data/v59.0/sobjects/Lead` (`sf.ts:153-192`). Targets CJC's org (`cjcwealth.my.salesforce.com`). |
| **TimeTap** | Outbound (scheduling redirect) + inbound (webhook) + a cron poller. `api/_lib/timetap*.ts`, `api/timetap/webhook.ts`, `api/cron/timetap-poll.ts`. |
| **File storage** | **None.** No S3, R2, Vercel Blob, or Fly volume anywhere. No file uploads are handled. |

### Database schema — PostgreSQL via Drizzle ORM

Schema source: `Intake-form/lib/db/src/schema/*.ts` + inlined auth tables in
`lib/db/src/index.ts:43-96`. Tables:

| Table | File | Purpose |
|---|---|---|
| `submissions` | `schema/submissions.ts` | Every intake submission + scoring + SF-push status. Stores PII columns (`first_name`, `last_name`, `email`, `phone`, `state_residence`) **and** a full `raw_payload` jsonb. |
| `users` | `index.ts:43-54` | Admin accounts (`email`, bcrypt `password_hash`, `name`, `is_active`). |
| `sessions` | `index.ts:58-74` | Opaque server-side session IDs. |
| `login_attempts` | `index.ts:79-96` | Rate-limit ledger. |
| `scoring_rule_sets` / `scoring_rule_changes` | `schema/scoring.ts` | Versioned scoring rules + audit. |
| `settings` / `settings_audit` | `schema/settings.ts` | KV toggles + audit. |
| `marketing_sources` | `schema/marketing-sources.ts` | Admin-editable campaign-source catalog. |
| `link_generations` | `schema/links.ts` | History of generated campaign URLs. |
| `appointment_sync_events` | `schema/appointments.ts` | TimeTap↔SF sync event log. |

**Migrations:** only `lib/db/migrations/0001_*.sql` and `0002_*.sql` exist, covering
*only* `appointment_sync_events` and `marketing_sources`. **The core tables
(`submissions`, `users`, `sessions`, etc.) have no migration file.** Both migration
files carry the comment *"drizzle-kit push is broken in this repo … run manually
with psql"* — see §11 RISK-3.

### Outbound integrations summary

- **Salesforce** (CJC's org) — leads + appointment objects. `api/_lib/sf.ts`.
- **TimeTap** (CJC's scheduling tenant, `businessId 371415`) — `api/_lib/timetap.ts`,
  API-key + MD5-signature auth. Inbound webhook + outbound cron poller.
- **No Zapier** in active code (despite docs).

---

## 6. Auth & access control

- **Mechanism:** classic email + password, custom-built. **No third-party auth
  library** (no NextAuth, Auth0, Clerk, Supabase Auth). Core logic in
  `api/_lib/auth.ts` (256 lines).
- **Passwords:** `bcryptjs`, cost factor 10 (`auth.ts:32`). Hashes stored in
  `users.password_hash`. **No public signup** — accounts are created only by the
  seed script `scripts/src/seed-admin-users.ts` (`index.ts:42` comment).
- **Sessions:** opaque 32-byte random token (`auth.ts:53-55`), stored server-side
  in the `sessions` table; cookie holds only the ID. Cookie name `cjc_admin_session`
  (`auth.ts:17`), `HttpOnly`, `Secure` in prod, `SameSite=Lax`, 30-day TTL with
  sliding renewal (`auth.ts:195-207`). This design is **sound** — the cookie is not
  signed, but it doesn't need to be (the token is opaque + server-dereferenced).
- **Login hardening:** per-email rate limiting (`api/_lib/rate-limit.ts`,
  5 fails/15 min → 429), constant-time dummy-bcrypt against unknown emails to
  prevent user enumeration (`auth.ts:42-50`, `login.ts:61-68`), generic error
  strings (`login.ts:25`).
- **Authorization:** `requireAuth` (`auth.ts:227-237`) on every protected handler.
  There are **no roles** — any active user in the `users` table has full admin
  access to all submissions and settings.
- **Credentials storage:** admin credentials in the DB; integration secrets
  (`SF_*`, `TIMETAP_*`, `DATABASE_URL`) in environment variables.

> **Doc divergence:** `.env.local.example` describes **Google OAuth sign-in**
> (`GOOGLE_OAUTH_CLIENT_ID/SECRET`, `ADMIN_EMAIL_ALLOWLIST`, `SESSION_COOKIE_SECRET`).
> **None of those four variables are read by any code** (verified by grep). The
> actual auth is the email/password system above. The `.env.local.example` auth
> section is aspirational/stale.

---

## 7. Branding / styling surface area — the reskin checklist

Every CJC-specific branding touchpoint, as a checklist. **All paths are relative
to `Intake-form/`.**

### Logos & image assets
- [ ] `attached_assets/cj-ss_1773942560897.png` — **the logo actually used.** Imported via the `@assets` alias by `Home.tsx:8`, `pages/admin/SignIn.tsx:13`, `pages/LinkGenerator.tsx:21`.
- [ ] `artifacts/intake-form/public/images/cj-logo.png` — a second CJC logo (appears unused by current code — `[AMBIGUOUS]`, see §11).
- [ ] `artifacts/intake-form/public/favicon.svg` — favicon (currently a plain `#FF3C00` orange rounded square — generic, but not DrSnip).
- [ ] `artifacts/intake-form/public/opengraph.jpg` — social-share preview image.
- [ ] `artifacts/intake-form/public/images/bg-abstract.png` — background image asset.

### Page titles & meta
- [ ] `artifacts/intake-form/index.html:6` — `<title>Financial Advisor Intake Form</title>`.
- [ ] `artifacts/intake-form/index.html:9` — hardcoded **Inter** Google Font import.

### Brand colors (Tailwind v4 design tokens)
- [ ] `artifacts/intake-form/src/index.css:69-154` — light-mode tokens. Comment line 69 reads *"CJ Wealth Red/White Brand"*. `--primary: 0 73% 37%` (crimson `#A71B1B`), `--background: 0 70% 30%` (deep red), plus chart/sidebar reds.
- [ ] `artifacts/intake-form/src/index.css:156-206` — dark-mode token overrides (also all-red).

### Hardcoded colors (NOT using the tokens — easy to miss)
- [ ] `Home.tsx:733` — form background literal `#CD1C3A`.
- [ ] `Home.tsx:791` — footer background literal `rgba(120, 20, 20, 0.85)`.
- [ ] `Home.tsx:820` — submit-button text color `#A82020`.
- [ ] `Home.tsx:886` — success-screen gradient (`#8B1A1A → #A82020 → #C0282B`).
- [ ] `Home.tsx:901` — success-icon color `#A82020`.
- [ ] `pages/admin/AdminLayout.tsx:73, 85` — admin-shell red literals.

### Copy / text strings
- [ ] `Home.tsx:741-743` — logo `alt="CJ Wealth Management"`.
- [ ] `Home.tsx:874-881` — success-screen headlines + *"A member of the **CJC** team will reach out within 24 hours"*.
- [ ] `pages/admin/SignIn.tsx:96, 99` — logo alt + heading **"CJC Intake Console"**.
- [ ] `pages/LinkGenerator.tsx:150` — logo `alt="CJC Wealth Management"`.
- [ ] `pages/admin/ScoringRules.tsx:87` — `mailto:` subject *"CJC Intake — scoring rule change request"*.
- [ ] The **entire form content** of `Home.tsx` (all ~15 questions, the 80-entry
  federal-agency list `AGENCIES` at `Home.tsx:117-201`, TSP/retirement wording) is
  CJC-specific. This is not a reskin — it is a content rewrite (see §13).

### Domain references
- [ ] `pages/admin/Submissions.tsx:134` — hardcoded `https://cjcwealth.lightning.force.com/lightning/r/Lead/${id}/view` (the "open in Salesforce" deep link).
- [ ] `.env.local.example` — `SF_INSTANCE_URL=https://cjcwealth.my.salesforce.com`, `ADMIN_EMAIL_ALLOWLIST=chris@cjcwealth.com,mel@cjcwealth.com,raunek@xpandai.com`.

### Email templates
- [ ] **None found.** The app sends no email itself; the only email touchpoint is the `mailto:` link above. Welcome/confirmation emails (referenced in code comments) are handled Salesforce-side, outside this repo.

---

## 8. Environment & secrets

`.env.local.example` lists more variables than the code reads. **Verified by grep
of all `process.env.*` references across `api/`, `lib/`, `artifacts/`, `scripts/`:**

### Variables actually read by code

| Var | Used by | CJC-specific? → DrSnip action |
|---|---|---|
| `DATABASE_URL` | `lib/db/src/index.ts:132` | Provision a **new** DB for DrSnip. |
| `SF_INSTANCE_URL` | `api/_lib/sf.ts:31` | CJC's Salesforce org — **DrSnip likely has no Salesforce** (brief says DrChrono). Replace or remove. |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | `api/_lib/sf.ts:32-33` | CJC Connected App creds. Replace or remove. |
| `SF_API_VERSION` | `api/_lib/sf.ts:34` | Generic; keep if SF kept. |
| `TIMETAP_BASE_URL` | `api/_lib/timetap.ts` | CJC's TimeTap tenant. Replace or remove. |
| `TIMETAP_API_KEY` / `TIMETAP_API_SECRET` | `api/_lib/timetap.ts` | CJC creds. Replace or remove. |
| `TIMETAP_WEBHOOK_SECRET` | `api/timetap/webhook.ts:64` | Read but **not enforced** (`void`'d — see §11 RISK-1). |
| `PORT` / `BASE_PATH` | `vite.config.ts` | Build/runtime; generic. |
| `NODE_ENV` / `VERCEL_ENV` | `api/_lib/auth.ts:175` | Platform; generic. |
| `REPL_ID` | `vite.config.ts:19` | Replit detection; harmless. |

### Variables in `.env.local.example` that NO code reads (stale)

`ZAPIER_WEBHOOK_FEDERAL`, `ZAPIER_WEBHOOK_INTERNAL`, `ZAPIER_WEBHOOK_FNN`,
`ZAPIER_WEBHOOK_URL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`ADMIN_EMAIL_ALLOWLIST`, `SESSION_COOKIE_SECRET`. Safe to ignore for DrSnip; the
example file should be rewritten.

**Secret hygiene:** `.gitignore:51-55` correctly excludes `.env`, `.env.local`,
`.env.*.local`, `.vercel`. `git ls-files` confirms only `.env.local.example`
(no real secrets) is tracked. ✅ Good.

---

## 9. Deployment posture

- **Host:** Vercel. `Intake-form/vercel.json` is the deploy config.
  - `buildCommand`: `pnpm run typecheck:libs && pnpm --filter @workspace/intake-form build`
  - `outputDirectory`: `artifacts/intake-form/dist/public`
  - `installCommand`: `pnpm install --frozen-lockfile=false`
  - SPA fallback rewrite (`vercel.json:7`): all non-`/api/` paths → `/index.html` (so client routes like `/admin/*` work).
  - **Cron:** `vercel.json:9-11` schedules `/api/cron/timetap-poll` **every minute** (`* * * * *`).
  - Vercel **Root Directory must be set to `Intake-form/`** (per `README.md`).
- **No Dockerfile.** **No `fly.toml`.** No Fly.io, no containers, no persistent volumes.
- **No healthcheck endpoint** in the active app (the OpenAPI spec defines a
  `healthStatus` type, a leftover from the deleted Express `api-server`).
- **Replit:** `.replit` + `artifacts/intake-form/.replit-artifact/artifact.toml`
  exist — the repo can still open in Replit (legacy). Vite loads Replit-only
  plugins solely when `REPL_ID` is set (`vite.config.ts:19`), so they don't affect
  Vercel builds.
- **Ports:** Vite dev server default `5173` (`vite.config.ts:5`).

---

## 10. The scoring engine (context for adaptation)

`lib/scoring/` is a standalone rule engine — worth understanding because it sits
in the submission path and is heavily CJC-specific.

- **Data-defined rules:** a `RuleSet` is JSON (`lib/scoring/src/types.ts:92-96`) —
  ordered `Rule`s with boolean condition trees (`all`/`any`/`not`) → `Outcome`
  (`rank` + `leadScore`). Rule sets are versioned in the `scoring_rule_sets` DB
  table; admins **view** but cannot edit them in-app (`/admin/scoring-rules` is
  read-only; changes go via `mailto:`).
- **CJC-specific:** `LEAD_FIELDS` (`types.ts:7-32`) and `v1-rule-set.ts` are built
  around TSP balance, federal agency, years-to-retire, etc. The `Lead_Score__c`
  values are whitespace-sensitive Salesforce picklist strings (`types.ts:75-81`).
- **DrSnip relevance:** a vasectomy clinic almost certainly does **not** need
  financial-advisor lead scoring. This whole subsystem (`lib/scoring/`, the
  hold-valve, `/admin/scoring-rules`, `/admin/held-leads`) is a candidate for
  **removal** rather than adaptation — confirm with the client.

---

## 11. Risk & gap analysis

### RISK-1 — Unauthenticated webhook + cron endpoints
`api/timetap/webhook.ts` accepts `POST`s with **no authentication**. The
`TIMETAP_WEBHOOK_SECRET` check is explicitly stubbed out — `webhook.ts:64` does
`void process.env.TIMETAP_WEBHOOK_SECRET;` and the comment (`webhook.ts:17`) says
auth is "deferred." Anyone who knows the URL can inject appointment-sync events
that write to Salesforce. Similarly `api/cron/timetap-poll.ts:114` notes the
`CRON_SECRET` validation is "out of scope" — the cron endpoint is callable by
anyone. **For a HIPAA app handling patient appointment data, an open webhook is a
hard blocker.** Must be fixed before DrSnip ships.

### RISK-2 — `/api/submit` has no rate limiting or CAPTCHA
The public submission endpoint (`api/submit.ts`) imports no rate limiter (only
`/api/auth/login` is rate-limited). `plan.md` explicitly deferred CAPTCHA
("federal employees, low spam risk"). A public clinic intake form is a **far
higher spam/abuse target**, and every spam submission writes a DB row + a
Salesforce record. Needs rate limiting and/or CAPTCHA for DrSnip.

### RISK-3 — `drizzle-kit push` is broken; core tables have no migration
Both migration files (`lib/db/migrations/0001`, `0002`) state *"drizzle-kit push
is broken in this repo … run manually with psql."* The core tables
(`submissions`, `users`, `sessions`, `login_attempts`, `scoring_rule_sets`,
`settings`, `link_generations`) have **no migration file at all** — their DDL
exists only as Drizzle TypeScript definitions. Standing up a fresh DrSnip database
will require either fixing `drizzle-kit` or hand-writing the full DDL. There is a
`lib/db/src/index.ts:35` `TODO` confirming the Vercel module-resolution issue
behind the inlined-auth-schema workaround.

### RISK-4 — Pervasive documentation drift
`plan.md`, `replit.md`, `README.md`, and `.env.local.example` all describe a
materially different app than what exists (Next.js, Express api-server, Zapier
webhooks, Google OAuth — all wrong or deleted). **Anyone planning the adaptation
from the docs instead of the code will be misled.** This investigation reads the
code; trust it over the docs.

### GAP-1 — No file upload anywhere (DrSnip needs insurance-card upload)
There is no file-upload field type (§3), no multipart request handling
(`submit.ts` consumes a JSON body only), and no object storage configured (no S3,
R2, Vercel Blob, Fly volume). HIPAA-grade insurance-card upload is **net-new**:
needs a field component, a storage backend with a BAA, multipart/upload handling,
and encryption-at-rest. Estimate **L**.

### GAP-2 — No PDF generation (DrSnip needs DrChrono-compatible PDF)
Covered in §4. No PDF library, no template, no DrChrono integration. Net-new
build, not a reskin. Estimate **L**.

### GAP-3 — No multi-tenancy / no config layer
Branding, copy, the form questions, colors, and the agency list are all hardcoded
across `Home.tsx`, `index.css`, and the admin pages. There is no theme config, no
content config, no env-driven branding. "Cloning for a new client" currently means
forking and editing source — there is no clean adaptation seam. Estimate to add
one: **M** (optional but recommended if more clients follow).

### GAP-4 — No PHI access audit logging
The app audits `settings` changes (`settings_audit`), scoring-rule changes, and
login attempts — but there is **no log of which admin viewed which submission**.
HIPAA expects access logging for PHI. The submission-list and detail endpoints
(`api/submissions/*`) record nothing. Estimate **M**.

### GAP-5 — PII/PHI stored in plaintext
`submissions` stores `first_name`, `last_name`, `email`, `phone`, `state_residence`
as plain `text` columns, plus the entire submission again in `raw_payload` jsonb.
There is no field-level/application-level encryption. For CJC (financial leads)
this was acceptable; for DrSnip this data becomes **PHI** and relies entirely on
the database provider's at-rest encryption + a signed BAA. See §12.

### Half-built / dormant code (lower severity — flag, don't fix)
- **`artifacts/mockup-sandbox/`** — `[AMBIGUOUS]` a second Vite app, a UI-component
  sandbox unrelated to the intake form. It is a workspace package and gets
  type-checked, but it is not part of the deployed product. Likely safe to delete
  for DrSnip; confirm before removing.
- **`lib/api-spec` / `lib/api-client-react` / `lib/api-zod`** — `[AMBIGUOUS]` an
  OpenAPI + Orval codegen pipeline. The generated client only contains a
  `healthCheck`/`healthStatus` endpoint — a leftover from the **deleted** Express
  `api-server`. The current `api/*` handlers do **not** use this generated client;
  the SPA calls `fetch("/api/...")` directly. These three packages appear to be
  **dead weight** kept only so `pnpm run typecheck` passes. Candidate for removal.
- **`api/_lib/release.ts`, `valve.ts`, hold-valve UI** — fully built and wired,
  but tightly coupled to CJC's lead-scoring concept. Not broken; just irrelevant
  to DrSnip (see §10).
- **`scripts/src/hello.ts`** — placeholder script, harmless.
- No `TODO`/`FIXME` markers of concern beyond the `index.ts:35` one already noted;
  `custom-fetch.ts:69` has a benign "not implemented" comment about a browser API.

---

## 12. HIPAA-specific concerns (this app will handle PHI)

The brief states DrSnip is HIPAA-regulated and this app will handle PHI (patient
data, insurance cards). Findings ranked by concern:

| # | Concern | Detail |
|---|---|---|
| H1 | **Open webhook/cron endpoints** | `api/timetap/webhook.ts` & `api/cron/timetap-poll.ts` are unauthenticated (RISK-1). Unacceptable for PHI-adjacent data. |
| H2 | **Third-party data processors need BAAs** | Current outbound flow sends PII to **Salesforce** and **TimeTap**. Storage is **Vercel Postgres**; hosting/logs are **Vercel**. Each of these is a Business Associate — every one needs a signed BAA, which generally requires their enterprise/HIPAA tier. None of this is verifiable from the repo; **must be confirmed contractually.** |
| H3 | **DrChrono replaces Salesforce, presumably under a BAA** | The brief implies the outbound target becomes DrChrono (an EHR). DrChrono offers BAAs. The existing `api/_lib/sf.ts` push path would be **replaced**, not adapted. |
| H4 | **PHI at rest is plaintext** | GAP-5 — relies solely on provider disk encryption. Consider application-level encryption for the most sensitive fields, especially insurance-card images. |
| H5 | **No PHI access audit log** | GAP-4 — HIPAA expects access logging for PHI reads. |
| H6 | **Logging** | `console.*` calls in `api/*` were reviewed: they log IDs (`submissionId`, `leadId`, `calendarId`), error messages, and `lead_score` — **not** raw names/emails/phone directly. However, raw `err` objects are passed to `console.*` (e.g. `submit.ts:134`, `webhook.ts:84`) and could contain payload fragments on certain failures. Vercel's log stream is itself a processor (ties back to H2). Tighten before handling PHI. |
| H7 | **No data-retention / deletion mechanism** | `raw_payload` keeps a full copy of every submission "for forensics" (`submit.ts:182`) indefinitely. HIPAA minimum-necessary + retention policies should drive a retention/purge story. |
| ✅ | **Good** | `.env` secrets are gitignored and not committed; sessions are HttpOnly/Secure; passwords are bcrypt-hashed; SF secrets are deliberately kept out of error messages (`sf.ts:38-39`, `:73-77`). |

---

## 13. Recommended adaptation sequence

Ordered. Effort: **S** ≈ <½ day · **M** ≈ ½–2 days · **L** ≈ 3+ days. Assumes a
**clone-and-adapt** of `Intake-form/` into a new DrSnip repo/Vercel project.

| # | Step | Effort | Notes |
|---|---|---|---|
| 1 | **Confirm the stack mismatch with the client/stakeholder** | S | It is Vite SPA + Vercel functions, not Next.js. Confirm Vercel is an acceptable host with a BAA, or pick a HIPAA-capable host. Blocks everything. |
| 2 | **Decide the outbound integration** — DrChrono vs. Salesforce vs. none | S | Drives how much of `api/_lib/sf.ts` + `api/timetap/*` survives. Brief implies DrChrono. This is a decision, not code. |
| 3 | **Strip CJC-specific subsystems** | M | Remove (pending step 2): `lib/scoring/`, hold-valve (`valve.ts`, `release.ts`, `/admin/held-leads`, `/admin/scoring-rules`), `api/timetap/*`, `api/cron/*`, `api/_lib/sf.ts`. Also delete dead weight: `artifacts/mockup-sandbox/`, `lib/api-spec` + `lib/api-client-react` + `lib/api-zod` (RISK/§11). |
| 4 | **Rewrite the form content** in `Home.tsx` | M | Replace all ~15 SOFA/TSP questions + the 80-entry `AGENCIES` list (`Home.tsx:117-201`) with DrSnip's patient-intake questions (port from their JotForm). The screen/`Screen[]` mechanism is reusable as-is. |
| 5 | **Rebrand** — work the §7 checklist | M | Logos, favicon, OG image, `<title>`, `index.css` color tokens, **and the hardcoded color literals in `Home.tsx`/`AdminLayout.tsx`** (easy to miss). Optionally do GAP-3 (config layer) now if more clients are coming. |
| 6 | **Build the insurance-card file-upload field** (GAP-1) | L | New field component; pick a HIPAA-BAA object store (e.g. AWS S3 w/ BAA); add multipart handling — `api/submit.ts` currently takes JSON only; store a reference, not the blob, in `submissions`. |
| 7 | **Build DrChrono-compatible PDF generation** (GAP-2) | L | Net-new. Choose a library (e.g. `pdf-lib` or `@react-pdf/renderer`); confirm DrChrono's exact ingest format (uploaded PDF? API? specific layout?); build the template. |
| 8 | **Re-point persistence + provision the DB** | M | New `DATABASE_URL`; resolve the broken-migrations problem (RISK-3) — fix `drizzle-kit` or hand-write full DDL for all core tables. |
| 9 | **HIPAA hardening** | L | Authenticate any retained webhook/cron (RISK-1); add rate limiting/CAPTCHA to `/api/submit` (RISK-2); add PHI access audit logging (GAP-4); review logging (H6); decide on field-level encryption (H4) + retention (H7); execute BAAs (H2/H3). |
| 10 | **Rewrite the docs & `.env.local.example`** | S | Current docs are actively misleading (RISK-4). Replace `plan.md`/`replit.md`/`README.md`/`.env.local.example` with DrSnip-accurate content. |

**Critical-path callout:** steps 6, 7, and 9 are each **L** and are the real
project. Steps 4–5 (the "reskin") are the easy part. Do **not** let the
clone-and-rebrand framing hide that DrSnip needs two net-new subsystems
(file upload, PDF) and a HIPAA-compliance pass that CJC never required.

---

## 14. Acceptance-test answers (per the brief)

1. **Files to touch to rebrand CJC → DrSnip?** Yes — see the §7 checklist
   (logos/assets, `index.html`, `index.css` tokens, hardcoded color literals in
   `Home.tsx`/`AdminLayout.tsx`, copy strings, the Salesforce deep-link in
   `Submissions.tsx:134`). Note rebranding ≠ adapting: the form *content* is a
   rewrite, not a reskin.
2. **Does the form schema support a file-upload field?** No. The form is
   code-defined React with no field-type registry and no file-upload type;
   `/api/submit` accepts JSON only; no object storage exists. File upload must be
   built (GAP-1, **L**).
3. **Can the PDF generator make a DrSnip PDF by editing config?** No — **there is
   no PDF generator** (§4). It must be built from scratch (GAP-2, **L**).
4. **Where does submission data land; is the storage HIPAA-appropriate?** Postgres
   (`submissions` table) + outbound to Salesforce + TimeTap. PII is stored
   plaintext; HIPAA-appropriateness depends entirely on signed BAAs with Vercel /
   the DB provider / the EHR — unverifiable from code and currently a gap (§12).
5. **Are CJC-specific strings, env vars, and branding enumerated as a checklist?**
   Yes — §7 (branding) and §8 (env vars, including the stale ones to drop).

---

*End of investigation. Read-only — no files in the repository were modified.*
