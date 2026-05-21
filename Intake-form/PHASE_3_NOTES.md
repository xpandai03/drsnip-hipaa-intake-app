# PHASE 3 NOTES — PDF generation for intake submissions

Implementation of `PHASE_3_PLAN.md`. On-demand, in-memory PDF generation for
both DrSnip intake forms, downloadable from the admin console. Deployed to Fly.

/ Branch `phase-3-pdf` → merged to `main` → deployed.

## What shipped

- **`lib/pdf/`** — a plain directory (not a workspace package):
  - `age.ts` — `calculateAge()` pure helper + `age.test.ts` (10 node:test cases).
  - `cursor.ts` — `PdfCursor` (top-down y cursor, word-wrap with hard-break,
    auto-pagination) + `stampFooters()`.
  - `layout/header.ts` — form-type-aware page-1 header.
  - `layout/sections.ts` — section/field renderers + template descriptor types.
  - `templates/registration.ts`, `templates/consultation.ts` — ordered
    sections with each field's key/label/kind.
  - `generator.ts` — `generateSubmissionPdf(submission) → Uint8Array`.
- **`api/submissions/[id]/pdf.ts`** — `GET` endpoint, `requireAuth`-guarded,
  streams `application/pdf`. Mounted in `api-server/index.ts`.
- **`api-server/vercel-adapter.ts`** — extended to pass binary
  (`Uint8Array`/`Buffer`) response bodies through untouched.
- **Admin UI** — "Download PDF" button in `SubmissionDetailModal.tsx`; a
  `FileDown` icon in a new "PDF" column in `Submissions.tsx`.
- `pdf-lib@^1.17.1` added to the root `package.json`.

## Library

`pdf-lib`, as decided in `PHASE_3_PLAN.md §3`. The de-risk gate (does it bundle
into `dist/server.cjs`?) **passed** — `pnpm build` bundles it cleanly into the
esbuild CJS server bundle; no wasm, no external font/asset files.

> Note: the Phase 3 task's literal Task-1 sanity command
> (`require('./dist/server.cjs')` to find `PDFDocument`) was inapplicable — the
> server bundle is the Hono app and never re-exports pdf-lib. Instead pdf-lib
> was verified functionally in Node (produced a valid `%PDF` document), and the
> bundling itself was confirmed by the full `pnpm build` once `generator.ts`
> was wired into the server via the endpoint.

## Deviations from the plan / task (iteration protocol)

All minor; none change behaviour the task specified.

1. **`calculateAge` signature** — the plan specced `calculateAge(dob)`. Shipped
   with an optional second arg `today: Date = new Date()`. Reason: the task's
   own test list requires leap-day behaviour checked "on Feb 28, Mar 1, and
   Feb 29" — only possible by injecting a reference date. Production callers
   still use `calculateAge(dob)`; the param defaults to now.

2. **Test runner** — the task said "vitest per the existing `pnpm test`
   scripts." There is no vitest in the repo; the existing runner is
   **`node --test` (node:test) + tsx**. Tests were written with `node:test` to
   match, and a `test:pdf` script was added (also folded into `pnpm test`).

3. **Footer rendering** — the plan suggested `addPage()` paints the footer +
   a later pass stamps page numbers. Shipped as a single final
   `stampFooters()` pass over all pages once the total is known — simpler,
   identical result (footer on every page, correct "Page X of Y").

4. **Template shape** — the task listed separate `*_SECTIONS` arrays and
   `*_LABELS` maps. Shipped with the label **co-located** in each section's
   field descriptor (`{ key, label, kind }`) — same data, and it lets the
   generator dispatch rendering generically. A `kind` discriminator was added
   (`text | medical | array | children | file`), including a `file` kind for
   the insurance-card stub refs (filename + "image not stored" note).

5. **PDF medical sub-grouping** — the Phase 3 task §6 specified the PDF's
   "Medical Background — …" sub-section field lists. Those differ slightly from
   the form's actual `MEDICAL_SCREENS` polish split (e.g. the PDF puts
   `mhKidney` under Urological & Reproductive). The task §6 spec is
   authoritative for the **PDF layout** and was followed verbatim; the form's
   screen grouping is unaffected.

6. **Branch base** — `phase-3-pdf` was branched off `main` only **after**
   merging the un-merged `phase-2-polish` branch into `main` first (per the
   user's decision this session). Without that, deploying Phase 3 would have
   reverted the live polish work.

7. **Adapter cast** — the binary-response fix needed one extra
   `body as BodyInit | null` cast in `buildResponse()` (TS 5.9's generic
   `Uint8Array` is not assignable to `BodyInit` directly). Still ~10 lines
   total, runtime-safe (undici accepts a `Uint8Array` body).

8. **Admin row action** — the row download control was placed in a dedicated
   "PDF" table column rather than crammed into the Submission-ID cell.

## n8n / DrChrono seam (not built — confirmed only)

`generateSubmissionPdf(submission: Submission): Promise<Uint8Array>` is a pure
function — no HTTP, no auth, no disk. The admin endpoint calls it today; a
future `POST /api/submissions/:id/upload-to-drchrono` handler can call the
exact same function and pipe the bytes to the existing n8n webhook. No
refactor needed. (`PHASE_3_PLAN.md §8`.)

## HIPAA

- Generation is **in-memory only** — `pdf-lib` returns a `Uint8Array`; no temp
  files, no disk writes, no object storage.
- **On-demand** — no PDF is ever stored; nothing to leak at rest.
- Endpoint is `requireAuth`-guarded (admin session), same gate as all
  `/api/submissions/*` routes.
- `Cache-Control: no-store` on the response.
- Footer watermark `CONFIDENTIAL / PHI` on every page.
- Logs carry the submission id + outcome only — never PHI or PDF content.
- `phi_access_log` audit table — still recommended for a future phase
  (`PHASE_3_PLAN.md §9`); **not built here**, no schema change in Phase 3.

## Deploy

- Deployed to `drsnip-intake-demo` (Fly.io) on **2026-05-21** (UTC).
- `release_command` (`node dist/migrate.cjs`) completed successfully — no new
  Phase 3 migration; existing 0000–0004 + seed are idempotent.
- Image size 62 MB (unchanged — pdf-lib adds negligibly).
- Live: https://drsnip-intake-demo.fly.dev

## Verification

Local (pre-deploy), with mock submissions:
- `pnpm test:pdf` — 10/10 `calculateAge` cases pass.
- `pnpm build` — clean (typecheck + SPA + both esbuild bundles).
- Generated a Registration PDF (3 pages) and a Consultation PDF (4 pages,
  8 children) — both valid `%PDF`, layout inspected.

Live smoke test (deployed):
- Submitted a Registration and a Consultation form via the public API.
- Admin login → `GET /api/submissions/<id>/pdf` for each →
  **HTTP 200, `Content-Type: application/pdf`**, valid PDF v1.7.
- Registration PDF (3 pp): header shows name + age + DOB, **no spouse line,
  no Children tile**; medical "Yes" answers show the patient explanation;
  empty fields render "—"; footer on every page.
- Consultation PDF (4 pp): header shows name + spouse + age + Children + DOB;
  Children block renders every submitted child; sections in template order;
  footer on every page.
- `/api/submissions` (JSON) still returns correctly — no regression from the
  binary-adapter change.

### Acceptance tests

| # | Test | Result |
|---|------|--------|
| 1 | `pnpm build` clean on main after merge | ✅ |
| 2 | `fly deploy` succeeds | ✅ |
| 3 | `GET /api/submissions/<id>/pdf` → valid PDF | ✅ 200 application/pdf |
| 4 | Registration header: name + age + DOB, no spouse/children | ✅ |
| 5 | Consultation header: name + spouse + age + Children + DOB | ✅ |
| 6 | Section structure matches template order | ✅ |
| 7 | Medical Yes answers include explanations | ✅ |
| 8 | Children block renders only submitted children | ✅ |
| 9 | Footer on every page (CONFIDENTIAL/PHI + Page X of Y + id) | ✅ |
| 10 | Pagination works (Consultation spilled to 4 pages) | ✅ |
| 11 | `calculateAge` tests pass | ✅ 10/10 |
| 12 | Binary adapter — JSON endpoints still work | ✅ |
| 13 | PHASE_3_NOTES.md exists | ✅ (this file) |

## Follow-ups (not in scope)

- n8n → DrChrono upload endpoint (seam ready).
- `phi_access_log` audit table for PDF-download logging.
- Insurance-card image embedding (once bytes are actually stored, with a BAA).
