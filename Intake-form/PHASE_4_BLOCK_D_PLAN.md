# Phase 4, Block D — Admin console enhancements

Branch: `phase-4-admin-console` (from `main`) · PR target: `main` · **No deploy. Migration + seed WRITTEN but NOT run.**

Scope: admin console UI + its API routes, one DB migration file, one seed script. **Out:** forms, PDF, n8n, patientmail, deploy, and actually running the migration/seed.

> ★ This plan PAUSES for your sign-off on the **D.3 permission model** (below) before any code is written. A viewer wrongly getting delete/PHI access is a breach — eyes on it first.

---

## ⚠️ Three brief-vs-repo reconciliations (please confirm)

1. **Migration number → `0007`, not `0008`.** The repo's latest migration is `0006_n8n_bridge.sql`; the next sequential is **0007**. There is no 0007 yet, so naming this `0008` would leave a confusing gap. I propose **`0007_admin_role.sql`**. (Asking before I create the file — renaming later is churn.)
2. **Canonical runner is `api-server/migrate.ts`, not `scripts/run-pg-migration.mjs`.** That file doesn't exist in this repo. Migrations are SQL files in `lib/db/migrations/` registered in the `STEPS` array of `api-server/migrate.ts` (bundled to `dist/migrate.cjs`, run as the Fly release_command). I'll add 0007 to `STEPS` (so it's wired to run via the canonical runner) but **not run it**. Explicitly **not** `drizzle-kit push`.
3. **Role column lives on `users`, not `admins`.** The repo's account table is `users` (seeded by `seed-admin-users`); there is no `admins` table. The `role` column goes on **`users`**.

---

## D.3 — Permission model ★ SIGN-OFF REQUIRED ★

**Two roles only:** `admin` (full) and `viewer` (read-only). Column: `users.role text NOT NULL DEFAULT 'admin'`.

**`normalizeRole(v)` = `v === 'viewer' ? 'viewer' : 'admin'`** — anything that isn't exactly `'viewer'` resolves to `admin`. This honors the rollout rule ("existing users default to admin, nobody loses access") and matches the DB default. Privilege checks then key off `isAdmin(role) === (role === 'admin')`, so a destructive action requires an explicit admin.

**Permission matrix:**

| Action | Admin | Viewer | Server enforcement |
|---|:--:|:--:|---|
| View submissions list | ✓ | ✓ | `requireAuth` |
| View submission detail (incl. PHI text) | ✓ | ✓ | `requireAuth` |
| Download submission PDF | ✓ | ✓ | `requireAuth` |
| View link history | ✓ | ✓ | `requireAuth` |
| **Delete submission** | ✓ | ✗ **403** | `requireAdmin` on `DELETE /api/submissions/:id` |
| **CSV export** | ✓ | ✗ **403** | `requireAdmin` on `GET /api/submissions/export` |
| **Generate intake link** | ✓ | ✗ **403** | `requireAdmin` on `POST /api/admin/links` |
| **Raw PHI card-image base64** | ✓ | ✗ | N/A today — see note |

> **Card-image base64 note:** base64 bytes are **stripped at submit** (`sanitizeForPersistence` in `api/submit.ts`) and are never persisted to `raw_payload` nor served by any endpoint. So "viewer cannot view raw card base64" is **structurally satisfied** — there is no such data to leak. I'll document this and, if a card-bytes endpoint is ever added, it must use `requireAdmin`. (No new endpoint is added for this in Block D.)

**Enforcement design (server-side, not UI-only):**
- Pure logic in **`api/_lib/permissions.ts`**: `Role`, `normalizeRole`, `isAdmin`, and named predicates (`canDeleteSubmission`, `canExport`, `canGenerateLinks`). Unit-testable with no DB.
- **`api/_lib/auth.ts`**: `getSessionFromCookie` selects `users.role`; `AuthedSession.user` gains `role: Role`. New `enforceAdmin(auth, res)` (pure gate: null→401, non-admin→403, admin→pass) and `requireAdmin(req,res)` (= `getSessionFromCookie` + `enforceAdmin`). `enforceAdmin` is unit-tested with mock req/res (viewer→403, admin→pass, unauth→401) **without a live DB**.
- UI **hides/disables** what viewers can't do (Delete, Export, Generate Link) and shows a "Viewer · read-only" chip — but the server is the gate. A viewer hitting a destructive endpoint directly gets a 403.

---

## Steps & files

**D.1 — Delete submission (admin-only).** Extend `api/submissions/[id].ts` to handle `DELETE` behind `requireAdmin` (the route is already mounted `.all`). UI: a Delete button on the detail modal (admin-only) opens a confirmation modal that **explicitly warns this permanently deletes patient PHI**. On success, close + refetch the list.

**D.2 — CSV export (admin-only).** New `api/submissions/export.ts` (`GET`, `requireAdmin`), mounted in `api-server/index.ts` **before** the `:id` route. Flat CSV: dedicated columns + every `raw_payload` field, including each medical `mhX` Yes/No **and** a `mhX_explanation` column from `raw_payload.medicalDetails`. Honors the same optional filters as the list view. **Audit-logs every export** — `{ ts, actor_email, row_count, filters }` — with **no PHI values**. UI: an "Export CSV" button on the list (admin-only).

**D.3 — Viewer role.** Migration + permissions module + middleware (above). `POST /api/admin/links` → `requireAdmin`. `me.ts` returns `role`; `auth-context` `AuthUser` gains `role`; Submissions/Detail/Links/AdminLayout gate destructive UI and show the viewer chip. `LinkGenerator` generate action disabled for viewers (history still visible).

**D.4 — Highlight unanswered questions (detail view, read-only).** In `SubmissionDetailModal.tsx`, the `KeyValue` renderer flags any empty/blank value (rendered as `—`) with a subtle amber background + a small "Unanswered" tag. Pure display change.

**D.5 — Viewer seed script (written, NOT run).** New `scripts/src/seed-viewer-user.ts` mirroring `seed-admin-users.ts`: inserts `viewer@drsnip.com` with `role='viewer'`, password from **`VIEWER_PASSWORD` env** (never committed; ≥12 chars), idempotent (skip if exists, no overwrite). Add a `seed-viewer-user` entry to `scripts/package.json`. **Not executed against any DB this session.**

## Migration 0007 (idempotent, defaults to admin)
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','viewer')) ... (guarded so re-run is safe);
```
Registered in `api-server/migrate.ts` STEPS as `0007_admin_role`. Also add `role` to the Drizzle `users` table in `lib/db/src/index.ts` so the ORM/types stay in sync. **Not applied this session.**

## Tests
`api/_test/permissions.test.ts` (DB-free): predicates (`isAdmin`/`normalizeRole`/`canDelete…`) + `enforceAdmin` via mock req/res → viewer 403, admin pass, unauth 401. Wired into `test:api`.

## Acceptance / build
`pnpm install && pnpm build` green; permission predicate + middleware unit-tested without a live DB; migration 0007 + seed staged but **not run**. Logical commits per item. PR with the permission matrix, migration summary, and explicit confirmation migration + seed were NOT run.
