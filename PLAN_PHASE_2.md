# PLAN_PHASE_2 — CJC Intake Console

> **Status:** Approved 2026-05-11. All 11 open questions resolved — see §8.
> **Author session:** 2026-05-11, agent handoff from Phase 1 ship.

---

## 1. Executive summary

Phase 2 transforms the existing public intake form into an **internal admin app — the CJC Intake Console** — with four authenticated tabs (Link Generator, Submissions, Settings, Scoring Rules) wrapping the same public form route at `/`. The intake form keeps working unchanged for end users, but its `/api/submit` handler now writes to a Vercel Postgres database, computes `Rank__c` and `Lead_Score__c` from a versioned RuleSet stored in DB, and POSTs the Lead directly to Salesforce (replacing the three staging Zaps). The Salesforce Flow that scores SurveyMonkey-sourced Leads keeps running unchanged — two engines coexist by design until Phase 3.

The goal is to give Chris, Mel, and Raunek a single place to (a) generate channel-tagged form links, (b) see every submission with its computed score and SF Lead Id, (c) flip operational toggles (kill switch, days-out gate, A-7 valve, per-channel overrides) with an audit log, and (d) edit + version + roll back the scoring rules without engineering involvement.

---

## 2. Architecture overview

### Architecture decisions (decided up front)

- **Server side lives in Vercel serverless functions under `Intake-form/api/`.** We considered the existing standalone Express `artifacts/api-server` package but rejected it for v1 to minimize ops surface (one deploy, one env, one log stream). The api-server scaffold is **deleted** as part of Sprint 0 — the empty `/healthz` route doesn't justify keeping a dormant package around. (Decision recorded in README under "Architecture decisions.")
- **DB**: Vercel Postgres + Drizzle ORM (already scaffolded in `lib/db`).
- **Auth**: Google OAuth via `arctic` + opaque session ids in the `sessions` table. Not NextAuth.js (not Next.js); not JWTs (server-stored sessions revoke instantly by row delete).
- **Contracts**: OpenAPI 3.1 in `lib/api-spec/openapi.yaml`; orval regenerates `lib/api-zod` (server-side Zod validators) + `lib/api-client-react` (client-side typed React Query hooks).

### File/directory layout (proposed)

The monorepo already has clean workspace boundaries. We extend them rather than reshape.

```
Intake-form/
├── api/                                        ← Vercel serverless functions (ALL server endpoints live here)
│   ├── submit.ts                               ← existing; refactored to: persist → score → push to SF (no Zapier)
│   ├── auth/
│   │   ├── google.ts                           ← OAuth init (redirect to Google)
│   │   ├── callback.ts                         ← OAuth callback (cookie + redirect)
│   │   ├── me.ts                               ← current user
│   │   └── logout.ts
│   ├── submissions/
│   │   ├── index.ts                            ← GET list (paginated, filterable)
│   │   └── [id].ts                             ← GET single submission detail
│   ├── settings/
│   │   ├── index.ts                            ← GET current; PATCH update (audit-logged)
│   │   └── history.ts                          ← GET audit log
│   ├── rules/
│   │   ├── index.ts                            ← GET list of versions; POST create draft from clone
│   │   ├── [id].ts                             ← GET single; PATCH (only if draft); POST publish
│   │   ├── [id]/diff.ts                        ← GET diff vs another version
│   │   └── [id]/test.ts                        ← POST a sample lead → returns simulated rank+score+trace
│   └── links/
│       ├── index.ts                            ← GET history (30-day); POST record a new link generation
│       └── events.ts                           ← GET event presets (for Tab 1 picker)
│
├── artifacts/
│   └── intake-form/
│       ├── index.html
│       └── src/
│           ├── App.tsx                         ← extend Router with /admin/* tree gated by auth
│           ├── pages/
│           │   ├── Home.tsx                    ← unchanged (public form)
│           │   ├── LinkGenerator.tsx           ← legacy /internal-tools-x9k2 — kept as redirect to /admin/links
│           │   ├── not-found.tsx
│           │   └── admin/
│           │       ├── AdminLayout.tsx         ← tab nav + auth guard + signed-in user chip
│           │       ├── SignIn.tsx              ← Google sign-in button
│           │       ├── Links.tsx               ← Tab 1
│           │       ├── Submissions.tsx         ← Tab 2 (with SubmissionDetailModal)
│           │       ├── Settings.tsx            ← Tab 3 (toggles + audit log)
│           │       └── Rules/
│           │           ├── RulesList.tsx       ← Tab 4 entry: version list + draft/publish/rollback
│           │           ├── RulesEditor.tsx     ← edit a draft (rule editor + condition builder)
│           │           ├── RulesDiff.tsx       ← side-by-side diff vs another version
│           │           └── RulesTester.tsx     ← simulate a lead → see rank+score+trace
│           ├── components/admin/               ← admin-only UI primitives (TabBar, AuditEntry, RuleRow, ...)
│           └── lib/
│               ├── auth-context.tsx            ← React context: current user, loading, refetch
│               └── api.ts                      ← typed wrapper over generated client
│
├── lib/
│   ├── db/
│   │   └── src/schema/
│   │       ├── index.ts                        ← re-exports
│   │       ├── submissions.ts                  ← NEW
│   │       ├── scoring.ts                      ← NEW (scoring_rule_sets, scoring_rule_changes)
│   │       ├── settings.ts                     ← NEW (settings, settings_audit)
│   │       ├── links.ts                        ← NEW (link_generations)
│   │       └── auth.ts                         ← NEW (sessions; users derived from email allowlist)
│   ├── api-spec/openapi.yaml                   ← extended with all Phase 2 operations
│   ├── api-zod/src/generated/                  ← regenerated from openapi.yaml
│   ├── api-client-react/src/generated/         ← regenerated from openapi.yaml
│   └── scoring/                                ← NEW workspace package: pure scoring engine
│       ├── package.json                        ← @workspace/scoring
│       ├── src/
│       │   ├── index.ts                        ← evaluate(ruleSet, lead) → { rank, score, trace }
│       │   ├── types.ts                        ← RuleSet, Rule, Condition, Outcome
│       │   ├── compiler.ts                     ← validate ruleSet against schema
│       │   └── evaluator.ts                    ← apply rules in order, return trace
│       └── test/
│           ├── seed-v1.test.ts                 ← seeded rules match SF Flow output
│           └── evaluator.test.ts
│
└── vercel.json                                  ← unchanged (rewrite already excludes /api)
```

> **Deleted in Sprint 0**: `artifacts/api-server/` (dormant Express scaffold; see §2 "Architecture decisions" above).

### How the form continues to work

- Public route `/` renders `Home.tsx` unchanged. Form posts to `POST /api/submit`.
- `submit.ts` is refactored to: validate body → write `submissions` row → load active RuleSet → run `@workspace/scoring`.evaluate() → set `submission.rank` + `submission.lead_score` + `submission.scoring_trace` → POST to Salesforce REST `/sobjects/Lead` using the Connected App's Client Credentials token → update `submission.sf_lead_id` + `submission.sf_status` → respond.
- If SF push fails the row stays in DB with `sf_status='error'` and an admin retry endpoint can re-push later.
- The 3 staging Zaps are **disabled** at cutover (not deleted), via the Zapier UI by Raunek.

### Scoring engine plug-in

- Pure TS package `@workspace/scoring` with no DB or HTTP dependencies — just `evaluate(ruleSet, leadFields) → { rank, lead_score, trace }`.
- Used by `/api/submit` (write path) and `/api/rules/[id]/test` (read path).
- Trace is an array of `{ ruleName, matched: boolean, conditions: [{ field, op, target, actual, result }] }` so Tab 4's tester can show why a rank was assigned.

### Admin app routing

- `/admin` redirects to `/admin/links` if signed in, else `/admin/signin`.
- Sub-routes: `/admin/signin`, `/admin/links`, `/admin/submissions`, `/admin/submissions/:id`, `/admin/settings`, `/admin/rules`, `/admin/rules/:id`, `/admin/rules/:id/edit`, `/admin/rules/:id/test`, `/admin/rules/:id/diff/:otherId`.
- All `/admin/*` routes mount inside `AdminLayout.tsx` which checks `auth-context`; if no session → redirect to `/admin/signin` preserving `?next=`.
- Wouter handles routing client-side; SPA fallback rewrite in `vercel.json` already supports this.
- Legacy `/internal-tools-x9k2` route stays for one release as a 302-style client redirect to `/admin/links` so existing bookmarks don't break.

### DB schema overview

Postgres on Vercel Postgres. Drizzle ORM (already wired in `lib/db`). Six new tables:

- `submissions` — one row per form submission
- `scoring_rule_sets` — versioned RuleSets (draft / published / archived)
- `scoring_rule_changes` — append-only audit log of rule edits
- `settings` — singleton row of operational toggles (or key/value table; see §4)
- `settings_audit` — append-only audit of toggle changes
- `link_generations` — every URL generated from Tab 1 with `created_by` + payload
- `sessions` — Google-OAuth session cookies (small; only logged-in admins)

Full DDL in §4.

---

## 3. Dependencies to add

| Package | Workspace | Purpose | Recommendation |
|---|---|---|---|
| `@vercel/postgres` | root or `lib/db` | Vercel Postgres client | **Add.** Pairs with Drizzle via the existing `pg` adapter — Vercel Postgres exposes a pg-compatible URL, so `lib/db/src/index.ts` works as-is. We use `@vercel/postgres/kysely` style only if we want serverless connection pooling helpers, otherwise `pg` Pool is fine on Vercel functions (note: prefer Neon-style pooled URL). |
| `arctic` | new (used inside `api/auth/`) | Google OAuth 2.0 client (lightweight, framework-agnostic) | **Add.** ~3KB, no Next.js coupling, well-maintained. NextAuth.js doesn't apply (not Next.js). Alternative: `oslo` (same author, broader). Avoid `passport` (Express-coupled). |
| `oslo` | new | Crypto helpers for session cookies + CSRF | **Add** if we want hardened cookie handling; otherwise the Web Crypto API plus a thin wrapper suffices. |
| `jose` | new | JWT for short-lived signed session cookies | **Optional.** A simpler alternative is opaque session IDs stored in the `sessions` table — recommended for simplicity. Skip `jose` unless we want stateless sessions. |
| `qrcode` | `artifacts/intake-form` | QR code rendering for Tab 1 | **Add.** ~10KB, no React-specific quirks. Alternative `qrcode.react` is React-native but pulls more weight. |
| `react-diff-viewer-continued` | `artifacts/intake-form` | Side-by-side diff for Tab 4 | **Add.** Lightweight, actively maintained, works with React 19. Fallback: render diffs as plain `<pre>` with simple line markers (no dep). |
| (existing) `drizzle-orm`, `drizzle-zod`, `drizzle-kit`, `pg` | `lib/db` | already in catalog | reuse |
| (existing) `zod`, `react-hook-form`, `@radix-ui/*`, shadcn primitives | already in form | reuse |
| (existing) `orval` | `lib/api-spec` | OpenAPI → typed React Query client + Zod | reuse — extend `openapi.yaml` for every new endpoint |

**Tailwind + shadcn** are already fully installed (~30 Radix packages). No UI library to add.

**No NextAuth.js.** The handoff prompt mentioned it; this is not a Next.js project. Use `arctic` + `sessions` table + Vercel function handlers.

---

## 4. Database schema (DDL)

Drizzle definitions go in `lib/db/src/schema/*.ts`; this section shows the equivalent SQL for clarity. Tables are designed for `drizzle-kit push --force` workflow (no migrations checked in unless we add them later).

### `sessions`

```sql
CREATE TABLE sessions (
  id              text PRIMARY KEY,                  -- random 32-byte id (base64url)
  email           text NOT NULL,                     -- the admin's email
  name            text,
  picture_url     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL               -- 30-day rolling window
);
CREATE INDEX sessions_email_idx ON sessions (email);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
```

Cookie: `Set-Cookie: cjc_session=<id>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`.

### `submissions`

```sql
CREATE TABLE submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Channel attribution
  source          text NOT NULL,                     -- 'federal' | 'internal' | 'fnn'
  survey_detail   text NOT NULL,                     -- 'DC SOFA' | 'DC SOFA 2' | 'DC SOFA 3'
  lead_source     text NOT NULL,                     -- 'SOFA: Webinar' | 'Internal: Webinar' | 'FNN: Webinar'
  campaign        text,
  event           text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,

  -- Lead identity
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  email           text NOT NULL,
  phone           text NOT NULL,
  state_residence text NOT NULL,
  federal_agency  text NOT NULL,                     -- post-strip value sent to SF

  -- Survey answers (mirrors SF Sofa_Consultation_Survey_Q* fields)
  q_speaker_rating       text,
  q_workshop_content     text,
  q_pre_retirement       text NOT NULL,              -- "Yes" / "No"  (qualifying gate)
  q_eval_comments        text,
  q_years_to_retire      text,
  q_age                  text,
  q_separating           text,
  q_marital_status       text,
  q_maxing_tsp           text,
  q_tsp_contribution_pct text,
  q_external_investments text,
  q_tsp_balance          text,
  q_areas_of_concern     text,

  -- Scoring outputs
  scoring_rule_set_id    uuid REFERENCES scoring_rule_sets(id),
  rank                   text,                       -- 'A' | 'B+' | 'B' | 'C' | 'N/A' | null
  lead_score             text,                       -- e.g. '10  (over $1mm)' or null
  scoring_trace          jsonb,                      -- evaluator output: array of rule eval steps
  auto_schedule_hold     boolean NOT NULL DEFAULT false,  -- A-7 valve outcome; sent as Auto_Schedule_Hold__c to SF if field exists

  -- Salesforce push
  sf_lead_id      text,                              -- 18-char SF Id, populated on success
  sf_status       text NOT NULL DEFAULT 'pending',   -- 'pending' | 'sent' | 'error' | 'skipped'
  sf_error        text,                              -- last error message if status='error'
  sf_attempts     int NOT NULL DEFAULT 0,
  sf_last_attempt_at timestamptz,

  -- Raw payload for forensics
  raw_payload     jsonb NOT NULL
);
CREATE INDEX submissions_created_at_idx ON submissions (created_at DESC);
CREATE INDEX submissions_email_idx ON submissions (email);
CREATE INDEX submissions_source_idx ON submissions (source);
CREATE INDEX submissions_sf_status_idx ON submissions (sf_status);
```

### `scoring_rule_sets`

```sql
CREATE TYPE rule_set_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE scoring_rule_sets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version         int NOT NULL,                      -- monotonic per row creation order
  name            text NOT NULL,                     -- user-set label, e.g. "v3 — bumped age cutoff"
  status          rule_set_status NOT NULL DEFAULT 'draft',
  rules           jsonb NOT NULL,                    -- full RuleSet JSON (see §5)
  parent_id       uuid REFERENCES scoring_rule_sets(id),  -- cloned from
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,                     -- admin email
  published_at    timestamptz,
  published_by    text,
  archived_at     timestamptz
);

-- Exactly one published row at a time:
CREATE UNIQUE INDEX scoring_rule_sets_one_published
  ON scoring_rule_sets (status) WHERE status = 'published';

CREATE INDEX scoring_rule_sets_status_idx ON scoring_rule_sets (status);
CREATE INDEX scoring_rule_sets_created_at_idx ON scoring_rule_sets (created_at DESC);
```

### `scoring_rule_changes`

```sql
CREATE TABLE scoring_rule_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id     uuid NOT NULL REFERENCES scoring_rule_sets(id),
  action          text NOT NULL,                     -- 'create' | 'edit' | 'publish' | 'archive' | 'rollback'
  diff            jsonb,                             -- structural diff vs previous state, or null on create
  note            text,                              -- optional user-supplied note
  actor_email     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scoring_rule_changes_rule_set_idx ON scoring_rule_changes (rule_set_id, created_at DESC);
```

### `settings`

Key/value model — each toggle is one row. Lets us add new toggles later without migrations.

```sql
CREATE TABLE settings (
  key             text PRIMARY KEY,                  -- 'a7_valve', 'kill_switch', 'days_out_gate', 'channel_federal_paused', ...
  value           jsonb NOT NULL,                    -- boolean / number / object
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text NOT NULL
);
```

### `settings_audit`

```sql
CREATE TABLE settings_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL,
  old_value       jsonb,
  new_value       jsonb NOT NULL,
  actor_email     text NOT NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settings_audit_key_idx ON settings_audit (key, created_at DESC);
```

### `link_generations`

```sql
CREATE TABLE link_generations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,                     -- admin email
  source          text NOT NULL,                     -- 'federal' | 'internal' | 'fnn'
  campaign        text,
  event           text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  generated_url   text NOT NULL
);
CREATE INDEX link_generations_created_at_idx ON link_generations (created_at DESC);
CREATE INDEX link_generations_created_by_idx ON link_generations (created_by, created_at DESC);
```

---

## 5. Rule data model (TypeScript types)

Lives in `lib/scoring/src/types.ts`. Schema-validated with Zod (`scoringRuleSetSchema`) before `INSERT` and before `UPDATE`.

```ts
// All form field names the rule engine knows about.
// Mirrors the FormData type in Home.tsx (snake_case in DB; camelCase in the engine input).
export type LeadField =
  | "firstName" | "lastName" | "email" | "phone" | "stateResidence"
  | "federalAgency"
  | "speakerRating" | "workshopContent" | "preRetirementReview" | "evalComments"
  | "yearsToRetire" | "age" | "separating" | "maritalStatus"
  | "maxingTsp" | "tspContributionPct" | "externalInvestments" | "tspBalance"
  | "areasOfConcern"
  | "source" | "leadSource" | "surveyDetail" | "campaign" | "event";

export type LeadInput = Partial<Record<LeadField, string | null | undefined>>;

export type ConditionOp =
  | "equals" | "notEquals"
  | "in" | "notIn"
  | "isNull" | "notNull"
  | "contains" | "notContains"
  | "matchesRegex";

export type Condition = {
  field: LeadField;
  op: ConditionOp;
  value?: string | string[];   // required for all ops except isNull/notNull
};

export type ConditionGroup = {
  // Boolean tree. Mirrors the SF Flow's "1 OR (2 AND 3)" style with explicit nesting.
  // Either {all: [...]}, {any: [...]}, or {not: ...}.
  all?: Array<Condition | ConditionGroup>;
  any?: Array<Condition | ConditionGroup>;
  not?: Condition | ConditionGroup;
};

export type Outcome = {
  // Fields the rule writes when matched. Both optional — a rule can set just rank.
  rank?: "A" | "B+" | "B" | "C" | "N/A";
  leadScore?: string;          // exact picklist string, e.g. "10  (over $1mm)" — engine does NOT trim
  // Future extensibility: setStatus, setEvalType, etc. Kept narrow for v1.
};

export type Rule = {
  id: string;                  // stable uuid; preserved on edit/clone
  name: string;                // human label, e.g. "A Ranking — 59½+ or separating"
  description?: string;
  when: ConditionGroup;
  then: Outcome;
};

export type RuleSet = {
  // Stored in scoring_rule_sets.rules. Engine consumes this verbatim.
  schemaVersion: 1;            // bump if the RuleSet shape changes
  rules: Rule[];               // evaluated in order; first match wins for each output field
  default: Outcome;            // applied for any output field still unset after all rules run
};

// Trace produced by evaluator — stored in submissions.scoring_trace for forensics.
export type RuleTraceStep = {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  conditions: Array<{
    field: LeadField;
    op: ConditionOp;
    target?: string | string[];
    actual: string | null | undefined;
    result: boolean;
  }>;
};
export type ScoringTrace = {
  ruleSetId: string;
  ruleSetVersion: number;
  evaluatedAt: string;         // ISO timestamp
  steps: RuleTraceStep[];
  finalOutcome: Outcome;
};
```

**v1 seed RuleSet** (derived from Investigation 6's decoded SF Flow). This is the initial `scoring_rule_sets` row inserted by Sprint 2's seed script. Pseudo-JSON:

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "<uuid>",
      "name": "A Ranking",
      "when": {
        "any": [
          {"field": "age", "op": "equals", "value": "59 1/2 or over"},
          {"all": [
            {"field": "age", "op": "equals", "value": "55 - 59"},
            {"field": "separating", "op": "equals", "value": "YES"}
          ]}
        ]
      },
      "then": {"rank": "A"}
    },
    {
      "id": "<uuid>",
      "name": "A Ranking → Lead Score 10 (over $1mm)",
      "when": {"all": [
        {"field": "tspBalance", "op": "equals", "value": "Over $1 million"},
        {"field": "age", "op": "in", "value": ["59 1/2 or over", "55 - 59"]}
      ]},
      "then": {"leadScore": "10  (over $1mm)"}
    },
    /* ... 9, 8, 7 brackets ... */
    {
      "id": "<uuid>",
      "name": "B+ Ranking",
      "when": {"all": [
        {"field": "maxingTsp", "op": "equals", "value": "YES"},
        {"field": "externalInvestments", "op": "equals", "value": "YES"}
      ]},
      "then": {"rank": "B+"}
    },
    /* NOTE: Plain "B" rank is UNREACHABLE in v1 by design.
       The SF Flow's B branch depended on a Q12 question with
       "YES, under $300k" / "YES, over $300k" brackets — that question
       does not exist in any of the 3 production SurveyMonkey surveys
       and is not collected by the intake form. The B branch in the SF
       Flow is dead code referencing a question that was removed years ago.
       Confirmed by Raunek 2026-05-11 (Resolved Q1 in §8). */
    {
      "id": "<uuid>",
      "name": "C Ranking (fallback when survey filled)",
      "when": {"all": [
        {"field": "age", "op": "notNull"},
        {"field": "maritalStatus", "op": "notNull"},
        {"field": "maxingTsp", "op": "notNull"}
        /* … notEquals "Not Answered" on each field … */
      ]},
      "then": {"rank": "C"}
    }
  ],
  "default": {"rank": "N/A"}
}
```

The exact picklist strings `"A"`, `"B+"`, `"B"`, `"C"`, `"N/A"` and `"10  (over $1mm)"` etc. are fixed by SF's restricted picklist and must be preserved verbatim (note the **two-space** prefix in `7` and `8` and the single-space in `9`/`10` — copied verbatim from Investigation 6's data probe).

---

## 6. Sprint-by-sprint implementation plan

Six sprints. Each sprint produces a shippable increment. Sprints are sized for ~half a day to a full day of focused work; total estimate ~6 days end-to-end.

### Sprint 0 — Foundation (≈0.5 day)

**Exit criteria**
- Vercel Postgres provisioned and `DATABASE_URL` set in Vercel Project Env (and locally in `.env.local`)
- `lib/db/src/schema/*.ts` defines all six tables (see §4)
- `drizzle-kit push` succeeds against the prod database
- Settings table seeded with default values (all toggles off / safe defaults)
- `lib/scoring` workspace package created with `types.ts` + an empty `evaluate()` stub

**Files**
- `Intake-form/.env.local.example` — add `DATABASE_URL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `ADMIN_EMAIL_ALLOWLIST`, `SF_INSTANCE_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SESSION_COOKIE_SECRET`
- `Intake-form/lib/db/src/schema/*.ts` (6 new files)
- `Intake-form/lib/scoring/package.json` (NEW workspace)
- `Intake-form/lib/scoring/src/{types,evaluator,index}.ts`
- `Intake-form/pnpm-workspace.yaml` (add `lib/scoring`)

**Tests**: `lib/scoring` package builds; `drizzle-kit push` clean.

**Depends on**: nothing.

### Sprint 1 — Auth (email/password + admin guard) (≈1 day) — ✅ DONE 2026-05-11

> **Auth approach changed mid-sprint.** Original plan called for Google OAuth via `arctic` + an email allowlist; Raunek chose **email/password** instead (faster to ship, no Workspace dependency, 3 pre-seeded admins, no public signup, password reset done manually via SQL for v1). The `arctic` / `oslo` / `jose` dependencies and the `/api/auth/google` + `/api/auth/callback` endpoints are **cut** from the plan. `lib/api-spec/openapi.yaml` extension is also deferred to Sprint 3 (the SPA uses plain `fetch` against the auth endpoints for now to keep Sprint 1 contained).

**Shipped exit criteria**
- Signed-in admin can hit `GET /api/auth/me` and get `{ email, name }`
- Unauthenticated request to any protected route returns 401
- `cjc_admin_session` cookie: HttpOnly + Secure-in-prod + SameSite=Lax, 30-day TTL, sliding renewal once >24h old
- `/admin/signin` renders email + password form; success redirects to `?next=` (same-origin /admin/* only — anti open-redirect)
- Per-email rate limit: 5 failed attempts in 15 min → 429
- Equal-timing dummy bcrypt on unknown email so login can't be used to enumerate registered accounts
- Inactive users (`is_active = false`) have their sessions auto-purged on next request

**Files shipped**
- Schema (`lib/db/src/schema/auth.ts`): `users`, refactored `sessions` (FK to users, cascade), `login_attempts`
- Server: `api/_lib/auth.ts`, `api/_lib/rate-limit.ts`, `api/auth/{login,logout,me}.ts`
- UI: `artifacts/intake-form/src/lib/auth-context.tsx`, `pages/admin/{SignIn,AdminLayout,Links}.tsx`, `App.tsx` routes
- Scripts: `scripts/src/seed-admin-users.ts` (idempotent; reads passwords from env vars only; 12-char minimum; never logs password values)
- Tests: `api/_test/{auth,login,logout}.test.ts` + harness + fixtures; 17 cases, all green against Neon, via `pnpm run test:api` (Node's built-in `node:test`, no new test framework dep)

**Files NOT shipped (cut from scope, per Raunek)**
- `api/auth/google.ts` + `api/auth/callback.ts` — Google OAuth path removed
- `lib/api-spec/openapi.yaml` `/auth/*` ops — deferred to Sprint 3 when other admin endpoints land
- Password reset / email verification / 2FA / password-change UI / account-lockout UI

**Pre-flight checklist (all green)**: no plaintext password logged or stored; identical 401 body for unknown-email vs wrong-password; equal-timing dummy bcrypt verified by test; per-email (not per-IP) rate limit; HttpOnly + Secure-in-prod + SameSite=Lax cookie; logout removes session row from DB; seed script never logs passwords; no register/reset endpoints exposed; /admin/* server-gated.

**Depends on**: Sprint 0. **Stacked PR** on `feature/phase-2-sprint-0`; GitHub auto-retargets to main on Sprint 0 merge.

### Sprint 2 — Scoring engine + cutover from Zapier (≈1.5 days)

**Exit criteria**
- `@workspace/scoring` evaluator passes its seeded test cases — produces identical rank+score outputs to the SF Flow for ≥20 sample leads we construct from Investigation 6
- `/api/submit` refactored to: validate → insert submissions row → load published RuleSet → evaluate → set rank+score+trace → push to SF directly via Connected App Client Credentials → update sf_lead_id+sf_status
- 3 staging Zaps disabled in Zapier UI (manual action by Raunek; not automated)
- A new test submission via the live form lands in DB AND lands in SF with rank+score populated AND has no Zapier hop

**Files**
- `lib/scoring/src/evaluator.ts` + tests
- `lib/scoring/src/compiler.ts` (zod-validate RuleSet)
- `Intake-form/api/_lib/sf.ts` — SF OAuth token caching (in-memory; tokens last ~2h) + `createLead(fields)` helper
- `Intake-form/api/_lib/scoring.ts` — load active RuleSet from DB + run evaluator
- `Intake-form/api/submit.ts` — refactor (preserve Path C strip)
- `Intake-form/scripts/src/seed-rule-set-v1.ts` — one-time seeder for the v1 RuleSet

**Tests**
- Unit: evaluator against 20+ synthetic leads
- Unit: SF helper handles 401 → re-auth → retry
- Integration: post a payload to a dev `/api/submit`; verify DB row + SF Lead Id

**Depends on**: Sprint 0 (DB tables + scoring package).

**Open work that doesn't block this sprint**: the 3 Zaps can stay enabled in parallel for one final E2E to compare results; Raunek disables them once we've seen 3 consecutive matches.

### Sprint 3 — Tab 1: Link Generator + Tab 2: Submissions (≈1 day)

**Exit criteria**
- Tab 1 lists same 3 quick-channel links + a custom builder (source, campaign, event) + QR code for any URL + 30-day history (paginated 20/page)
- Each link generation hits `POST /api/links` (records `created_by` + URL) — history is global, not per-user
- Tab 2 lists submissions with columns: created_at, name, email, source, rank, score, sf_status, sf_lead_id (link to SF)
- Filters: source, sf_status, rank, date range, free-text search across name/email
- Row click → `SubmissionDetailModal` with full payload + scoring trace + SF push details
- Legacy `/internal-tools-x9k2` redirects to `/admin/links`

**Files**
- `api/links/{index,events}.ts`
- `api/submissions/{index,[id]}.ts`
- `artifacts/intake-form/src/pages/admin/Links.tsx`
- `artifacts/intake-form/src/pages/admin/Submissions.tsx` + `SubmissionDetailModal.tsx`
- `artifacts/intake-form/src/pages/LinkGenerator.tsx` — convert to redirect-on-mount component
- OpenAPI extensions; regen client+zod

**Tests**
- Unit: filter combinations on submissions endpoint
- Manual: paginate through ≥50 seeded rows; click into detail; QR code scans

**Depends on**: Sprint 1 (auth), Sprint 2 (submissions table populated).

### Sprint 4 — Tab 3: Settings (toggles + audit) (≈0.5 day)

**Exit criteria**
- Tab 3 shows current values for: `a7_valve` (boolean, default ON), `kill_switch` (boolean, default OFF), `channel_federal_paused`, `channel_internal_paused`, `channel_fnn_paused` (all booleans, default OFF)
- Editing a toggle hits `PATCH /api/settings` → writes new row, appends to `settings_audit`, returns updated state
- Audit log shows last 50 changes with timestamp + actor + delta + optional note
- `/api/submit` reads `kill_switch` and the per-channel pause flags at runtime; if active → 503 with friendly error AND row in `submissions` with `sf_status='skipped'`
- **A-7 valve semantics**: when `a7_valve = false`, any Lead scored `Rank='A'` AND `Lead_Score='7  ($0-$350k)'` is flagged for hold. Implementation:
  - Add `auto_schedule_hold` column (boolean, default false) to `submissions` table — set during Sprint 2 scoring step
  - Attempt to send `Auto_Schedule_Hold__c = true` in the SF Lead payload. **This SF field doesn't exist yet.** If SF returns `INVALID_FIELD`, retry the request without the field, log a warning, and continue. The DB row keeps `auto_schedule_hold = true` either way (audit trail value even before SF wiring).
  - Raunek will arrange creation of `Auto_Schedule_Hold__c` (boolean) on the Lead object in SF before/during Sprint 4. TimeTap integration to actually halt auto-scheduling is Phase 3.
- **`days_out_gate` is CUT from v1** (Resolved Q4 in §8); no toggle, no plumbing, no settings row. Phase 3 candidate when TimeTap scope lands.

**Files**
- `api/settings/{index,history}.ts`
- `api/_lib/settings.ts` — read-with-cache helper (60s in-memory TTL per Vercel function instance)
- `artifacts/intake-form/src/pages/admin/Settings.tsx`
- `Intake-form/api/submit.ts` — gate logic on kill_switch + per-channel pauses

**Tests**
- Unit: kill switch blocks submit
- Manual: flip each toggle, confirm submit behavior change + audit row

**Depends on**: Sprint 1.

### Sprint 5 — Tab 4: Scoring Rules (editor + test + version history) (≈1.5 days)

**Exit criteria**
- Tab 4 lists all RuleSet versions: `version`, `name`, `status` chip (draft/published/archived), `created_by`, `published_at`, action buttons (`Edit` for drafts, `Clone & edit` for any, `Publish` for drafts, `Diff…` for any, `Rollback to this version` for archived/published)
- Editor (`RulesEditor.tsx`) shows the rule list, lets you reorder/add/remove rules, edit conditions in a tree builder, set the outcome
- Tester (`RulesTester.tsx`) takes a sample lead (manual input or "Load from existing submission") → calls `POST /api/rules/[id]/test` → shows the trace with matched/unmatched chips
- Diff (`RulesDiff.tsx`) shows side-by-side rule-by-rule comparison
- Publish flow: confirm modal → server transitions current `published` → `archived`, sets target → `published`, appends `scoring_rule_changes` row
- Rollback: clones an old version into a new draft (does NOT re-publish in-place — preserves audit chain)
- `POST /api/rules/[id]` validates ruleSet against Zod schema; rejects invalid shapes with field-level errors

**Files**
- `api/rules/{index,[id],[id]/diff,[id]/test}.ts`
- `artifacts/intake-form/src/pages/admin/Rules/{RulesList,RulesEditor,RulesDiff,RulesTester}.tsx`
- `artifacts/intake-form/src/components/admin/RuleConditionTree.tsx` — tree builder UI
- OpenAPI extensions; regen

**Tests**
- Unit: publish flow (exactly one published row invariant — enforced via partial unique index)
- Unit: rollback creates a new draft, doesn't mutate the source row
- Unit: tester output matches `/api/submit` output for the same lead
- Manual: edit → test → publish → submit a real form → confirm DB rank/score uses new RuleSet

**Depends on**: Sprint 2 (scoring package), Sprint 4 (settings page pattern can be reused for layout polish).

---

## 7. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **SF picklist values drift** — `Rank__c` or `Lead_Score__c` allowed values change in SF Setup; published RuleSet now writes invalid picklist strings → SF rejects every Lead | Medium | High | (a) Tab 4 editor surfaces a "known picklist values" reference panel populated from `Investigation 6` + the live SF describe (added to a periodic sync); (b) `/api/submit` validates the RuleSet's outcomes against the latest cached SF describe before pushing, falls back to no-score + `sf_status='error'` rather than failing the insert |
| **Two scoring engines diverge** — SF Flow keeps scoring SurveyMonkey Leads; our engine scores intake-form Leads; same lead via two channels → different scores | High | Medium | Document explicitly in Tab 4 banner. Phase 3 consolidates. For now, intake-form is the only channel using our engine (Survey_Detail__c=DC SOFA/DC SOFA 2/DC SOFA 3) — SF Flow is gated by `SurveyId__c != null` which we never set, so no overlap |
| **Vercel Postgres connection limits** — serverless functions create new connections per cold start; Vercel Postgres has tight pooling | Medium | Medium | Use Vercel Postgres' pooled connection URL (not direct); `lib/db/src/index.ts` already uses `pg.Pool` which is fine; consider `@vercel/postgres` driver if pool exhaustion shows up |
| **Bad publish breaks scoring on every new Lead** — admin publishes a RuleSet that throws in the evaluator | Medium | High | Server-side validation in `POST /api/rules/[id]/publish`: dry-run evaluator against a fixed corpus of ~10 reference leads; refuse to publish if any throws; **plus** publish flow requires the Tester to have been run at least once in the session (UX gate, not enforced server-side) |
| **OAuth session cookie compromise** — admin email allowlist is 3 people; one phishing → full access | Low | High | Short-ish session (30d), `Secure` + `HttpOnly`, no third-party JS on `/admin/*` (no analytics), audit log on every Settings/Rules change shows the actor, manual revoke by deleting from `sessions` table |
| **Zapier cutover regression** — direct SF push fails for a sub-agency that the Zaps used to handle | Medium | High | Cutover in stages: (a) write to DB but ALSO fire to Zap for 24-48h; compare DB vs Zap-created Lead daily; (b) once 0 regressions, disable Zaps. Cutover ETA: end of Sprint 2 |
| **Path C prefix strip is in `submit.ts` and must not be lost in the refactor** | Medium | Medium | Preserve the exact regex `/^[\s► ]+/` from current `submit.ts:84` in the refactored handler; add a unit test that fixes this string regression |
| **`Auto_Schedule_Hold__c` field not yet created in SF** — first Sprint 4 deploy attempts to write a field that doesn't exist; every Lead push 400s with `INVALID_FIELD` | Medium | High | Implementation strategy: try-then-retry pattern. First attempt includes `Auto_Schedule_Hold__c`; on `INVALID_FIELD` response, retry the request stripped of just that field (the SF helper caches the field's existence after the first 400). Local `submissions.auto_schedule_hold` is always written so audit value is preserved. Raunek arranges field creation in parallel; once it exists the retry path is never hit |
| **Drizzle `push --force` history loss** | Low | Medium | After Sprint 0 stabilizes the schema, switch to `drizzle-kit generate` + checked-in migrations |
| **/admin route accidentally exposed** | Low | High | Auth guard runs server-side on every `/api/*` (except `/api/submit` and `/api/auth/google` and `/api/auth/callback`); the SPA's `/admin/*` UI is just convenience — server is the gate. Add a `noindex` meta on the admin layout for good measure |

---

## 8. Resolved questions

All 11 questions resolved by Raunek on 2026-05-11. The decisions below are applied to the rest of the plan; this section is the canonical record.

1. **Q12 in the v1 RuleSet — RESOLVED: omit.** Raunek verified all three production SurveyMonkey surveys (Federal Direct, Internal Marketing, FNN). None of them include a question with `"YES, under $300k"` / `"YES, over $300k"` answer brackets. The SF Flow's B-Ranking branch is dead code referencing a question that was removed from the surveys at some point. v1 RuleSet has no Q12-dependent rule, plain `B` rank is unreachable, B-Ranking exists only via the B+ path. (Documented as a comment in §5's seed.)

2. **C-Ranking when `preRetirementReview = "No"` — RESOLVED: default to N/A.** Someone who says they don't want a pre-retirement review isn't qualified. No special handling.

3. **Lead Score on non-A Leads — RESOLVED: match SF.** `Lead_Score__c` is set only when `Rank__c = 'A'`. Don't apply 7/8/9/10 brackets to B+/B/C ranks.

4. **`days_out_gate` — RESOLVED: cut from v1.** Placeholder without a concrete definition; depends on a TimeTap integration that isn't scoped yet. Phase 3 candidate. Removed from Sprint 4 settings + DDL.

5. **A-7 valve — RESOLVED: defined.** When the toggle is OFF, any Lead scored `Rank='A'` AND `Lead_Score='7  ($0-$350k)'` is flagged in the local DB (`submissions.auto_schedule_hold = true`) and sent to SF with `Auto_Schedule_Hold__c = true`. The SF field doesn't exist yet — Raunek will arrange its creation. Until it exists, the SF helper retries without the field on `INVALID_FIELD` and logs a warning; local audit trail is preserved either way. Actually halting auto-scheduling (TimeTap integration) is Phase 3. (Implementation details in Sprint 4 §6 and risk row in §7.)

6. **Per-channel overrides — RESOLVED: paused booleans only.** Three settings keys: `channel_federal_paused`, `channel_internal_paused`, `channel_fnn_paused`. Paused channel → 503 to user + `submissions.sf_status = 'skipped'`. Richer overrides (per-channel RuleSet, etc.) deferred.

7. **Submission detail PII — RESOLVED: full visibility.** All three admins see the full payload in Tab 2 detail modal — they already see this in Salesforce. No UI redaction. Server logs sanitize: don't write full email + phone + name in the same log line.

8. **Tab 4 rollback — RESOLVED: clone-as-draft.** Rolling back creates a new draft from the target version's snapshot; admin must explicitly Publish that draft to make it live. Preserves linear audit chain. (Already the §6 Sprint 5 default — no change.)

9. **Event picker source — RESOLVED: free-text + autocomplete.** Tab 1's `event` input is free-text with an autocomplete dropdown pulled from `link_generations.event` distinct values, sorted most-recent-first. No preset table.

10. **`api-server` scaffold — RESOLVED: delete.** Sprint 0 deletes `artifacts/api-server/`. README gains an "Architecture decisions" section noting we considered a standalone Express server and chose Vercel functions for v1.

11. **OAuth client ownership — RESOLVED: Raunek's Google Cloud project (`xpandai.com` org).** Consent screen will show "Xpand AI" branding when Chris/Mel sign in — acceptable for an internal tool. Migrate to a CJC-owned project in Phase 3 if this becomes long-term. Raunek will create the OAuth client and populate `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` in Vercel env + `.env.local` before Sprint 1. Authorized redirect URIs: `https://<vercel-prod-url>/api/auth/callback` and `http://localhost:3000/api/auth/callback` (local Vercel dev port).

---

## 9. Acceptance & rollout

- **Local dev**: `pnpm install && vercel dev` with `.env.local` populated runs the whole thing including admin app.
- **Staging**: a separate Vercel preview env with a separate Postgres branch and a sandbox SF org would be ideal but is not on the critical path — for Phase 2 we ship to prod once Sprint 2's parallel-run period (Zap + direct push) shows 3 consecutive clean matches.
- **Cutover day**: Raunek disables the 3 Zaps in Zapier UI; first 24h closely monitored from Tab 2.
- **Documentation deliverables alongside code**: update `Intake-form/README.md` to cover the new admin tabs, env vars, and DB provisioning; add a one-page "How to edit scoring rules" runbook for Chris/Mel.

---

**End of plan. Next step:** Raunek reviews + answers Open Questions §8. Then Sprint 0 starts.
