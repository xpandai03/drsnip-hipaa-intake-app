# Phase 6 — Prompt 3 of 3: Downstream Wiring + PDF name-per-page (Plan)

Branch: `phase-6-downstream-wiring`, **cut from `phase-6-consultation-feedback` (PR #14)**,
NOT main — confirmed base tip `27e04e1` ("MOVE — place 3 relocated questions after
considerations"). It stacks on #13 + #14; all three deploy together. PR target: `main`.
No deploy. No form/admin edits. No n8n-workflow edits. Plan-first — **awaiting sign-off on
the storage decision before any code.**

---

## ⭐ STORAGE DECISION — needs your sign-off (the one real fork)

**Question:** where do `mhPainSensitive` / `mhFainting` (+ their details) live downstream?
`mh_mental_illness` already has a dedicated column; the other two do not.

**Key fact that reframes this:** the form body is persisted **verbatim** in
`raw_payload` (jsonb) for *every* submission (`api/submit.ts` → `sanitizeForPersistence`,
which only strips card bytes). So after #14, a Consultation submission **already persists**
`mhPainSensitive`, `mhFainting`, and `medicalDetails.{...}` in `raw_payload` today — no
migration required for the data to be saved. And the CSV export
([export.ts](Intake-form/api/submissions/export.ts) `buildSubmissionsCsv`) **already sweeps every `raw_payload` key** into
`rp_<key>` columns and explodes `medicalDetails` into `rp_<key>_explanation` columns — so
`rp_mhPainSensitive`, `rp_mhFainting`, and their `_explanation` columns **already export**.
(`mhMentalIllness` actually appears twice in the CSV today: dedicated `mh_mental_illness`
*and* `rp_mhMentalIllness`.)

### Option A — Dedicated columns `mh_pain_sensitive` + `mh_fainting` (migration 0008)
- **Pros:** parity with the `mh_mental_illness` column; clean fixed CSV columns side-by-side
  for the doctor; typed/queryable if ever needed.
- **Cons:** a migration on launch eve; **duplicates** data already in the CSV (each also
  appears as `rp_…`); requires edits to `submissions.ts`, `submit.ts`, and `export.ts` for
  zero new *captured* data (it's already captured). More surface, more risk, marginal gain.
- **Touches:** `lib/db/src/schema/submissions.ts`, `lib/db/migrations/0008_*.sql` (idempotent,
  nullable), `api/submit.ts` (extract+persist 2 more), `api/submissions/export.ts` (2 fixed
  columns) — **plus** the n8n + PDF wiring that both options need.

### Option B — No migration; rely on `raw_payload` (already persisted) + the `rp_` sweep ✅ RECOMMENDED
- **Pros:** **no migration**; the data already persists and already exports; smallest diff and
  lowest risk for the last build before launch; n8n + PDF (which read `raw_payload`/body, not
  columns) are the only real work.
- **Cons:** asymmetric with the lone `mh_mental_illness` column; pain/fainting surface in CSV
  as `rp_mhPainSensitive` / `rp_mhFainting` (+ `_explanation`) rather than clean `mh_*`
  columns. (The data is all there; only the column *name/placement* differs.)
- **Touches:** `lib/n8n/payload.ts` + `lib/pdf/templates/consultation.ts` only (the wiring
  both options need). No DB/submit/export change.

**My recommendation: Option B.** The mental-illness dedicated column predates the raw_payload
sweep and is now effectively redundant (it double-prints in the CSV). Replicating it for two
more fields buys a tidier column name at the cost of a launch-eve migration and three extra
file edits, for data that is *already* persisted and *already* exported. The genuine gap is
n8n + PDF rendering, which is identical under either option.

**The rest of this plan assumes Option B. If you choose Option A, I'll add the migration +
submit/export column edits on top — say the word.**

---

## WIRE-1 — the 3 moved questions flow end-to-end
Independent of the storage choice, these are required:

**1a. n8n — `buildConsultationPayload`** ([payload.ts](Intake-form/lib/n8n/payload.ts)): add a `medicalHistory`
record for the 3 keys, built exactly like `buildRegistrationPayload`
(`answer = str(body[key])`, `details = medicalDetail(medicalDetails, key)`). Add
`medicalHistory: Record<string, {answer, details}>` to `ConsultationN8nPayload`. Blank/absent
→ `{answer:"", details:""}` (graceful).

**1b. Consultation PDF** ([consultation.ts](Intake-form/lib/pdf/templates/consultation.ts)): append the 3 questions as
`kind: "medical"` fields at the END of the **"Medical & Personal Considerations"** section
(mirrors the form, where they were appended to that screen). The generator already renders
`kind:"medical"` from `raw[key]` + `medicalDetails[key]`, with grouped Yes + italic
explanation — no generator change. Verbatim labels (mental-illness **not** reworded).

**1c. Also wire `religionConflictDetails`** (new field from #14, currently flowing NOWHERE):
add it to the consultation PDF template (text row after `religionConflict`) and to
`medicalPersonal` in the n8n payload (next to sexual/genetic details). Without this, the
religion "Yes" detail a patient typed is silently dropped from PDF + n8n.

**1d. Storage / submit / export:** Option B → **no change** (raw_payload already persists;
`rp_` sweep already exports pain/fainting + all explanations, including
`rp_mhMentalIllness_explanation`). `mh_mental_illness` column keeps populating for
Consultation too (submit.ts reads `body.mhMentalIllness` regardless of form type — already works).

## WIRE-2 — child relation values (Ours/Mine/Hers/Adopted)
- Consultation PDF children block ([sections.ts](Intake-form/lib/pdf/layout/sections.ts) `renderChildrenBlock`) renders
  `Relation: ${c.relation}` **verbatim** — new values render correctly. **No change.**
- n8n payload `children.details[].relation = str(c.relation)` — **verbatim, no hardcoding.
  No change.**
- **Report:** code handles new values with no edits. The only place that could care is the
  **n8n WORKFLOW** if it maps `relation` to fixed values downstream (DrChrono/Sheets) — flagged
  as a separate n8n task (not edited here).

## WIRE-3 — howHeard values (Family/Friend merged + 3 new)
- n8n payload `emergencyReferral.howHeard = str(body.howHeard)`. `howHeard` is a `string[]`;
  `str()` serializes via `String(arr)` → comma-joined. The new labels contain **no commas**,
  so each passes through **intact** (e.g. `"Family / Friend,Radio"`). **No code change** (and
  changing the join risks breaking the existing n8n parse). Confirmed pass-through.
- ⚠️ **Consultation PDF bug found:** `howHeard` is declared `kind: "text"` in the template,
  but it's an array → `scalar(array)` returns `""`, so **howHeard renders BLANK on the
  consultation PDF today** (pre-existing, not caused by #14). **Fix:** change it to
  `kind: "array"` so the selected channels (incl. the new labels) actually render. Low-risk,
  in-scope (consultation PDF).
- **Report — n8n workflow follow-up NEEDED:** if the n8n→Google Sheets node maps `howHeard`
  by fixed value/column, it must learn `Family / Friend`, `TV Commercial`,
  `Insurance Directory`, `Magazine Ad` (and that standalone `Family`/`Friend` are gone).
  **Separate n8n-workflow task — flagged, not edited here.**

## PDF-D1 — patient name on EVERY page of BOTH PDFs
- Implement in [cursor.ts](Intake-form/lib/pdf/cursor.ts) `stampFooters`, which already paints a footer on every
  page (page 1 included) once page count is known. Thread `patientName` through and render it
  in the footer's left zone as `"<Name> · CONFIDENTIAL / PHI"` (fallback to just the
  confidential text when name is empty). `generateSubmissionPdf` already has the name — pass
  `submission.firstName + lastName`.
- **Does NOT touch the page-1 header** (`renderHeader`) — so the Phase 4 header (name centered,
  **no DOB**) is untouched; the per-page name is additive. Appears on page 1 + every page of
  both Registration and Consultation PDFs.

## Graceful-degradation guarantees (decision rules)
- 3 moved questions optional → blank everywhere: PDF shows "—", n8n `{answer:"",details:""}`,
  CSV blank cell. No errors.
- Registration (post-#13 sends none of the 3): `buildRegistrationPayload` `str(undefined)=""`;
  the registration PDF template still lists them → `renderMedicalAnswer` shows "—". No error;
  **historical** registrations keep their real answers. Registration template **unchanged**.
- New relation/howHeard values are rendered verbatim — no fixed-value hardcoding in our code.

## Files touched (Option B)
| File | Change |
|---|---|
| `lib/n8n/payload.ts` | `ConsultationN8nPayload.medicalHistory` + build it (3 keys); add `religionConflictDetails` to `medicalPersonal` |
| `lib/pdf/templates/consultation.ts` | append 3 `medical` fields to considerations; add `religionConflictDetails` row; fix `howHeard` → `kind:"array"` |
| `lib/pdf/cursor.ts` | `stampFooters` renders patient name per page |
| `lib/pdf/generator.ts` | pass `patientName` into `stampFooters` (both forms) |
| *(Option A only)* | `submissions.ts` + `migrations/0008` + `submit.ts` + `export.ts` |

## Commits (after sign-off)
1. WIRE-1 n8n (consultation medicalHistory + religionConflictDetails)
2. WIRE-1/3 consultation PDF (3 medical fields + religion details + howHeard array fix)
3. PDF-D1 name-per-page (cursor + generator, both PDFs)
4. *(Option A only)* migration + schema + submit + export

## Verification (local + PDF preview)
- `pnpm install && pnpm build` green; DB-free suites pass.
- Render a synthetic Consultation PDF (3 moved questions answered "Yes" + details) and a
  Registration PDF → confirm: moved questions + details render on Consultation; howHeard
  renders; **patient name on every page of both**; page-1 header still no DOB. Inspect the
  built PDFs (pdf→png) like #13/#14 screenshots.
- Unit-spec the n8n consultation `medicalHistory` mapping (answer+details, blank-safe) via the
  existing pure-function test seam if practical.

## Open question for sign-off
**Storage: Option A (dedicated columns + migration 0008) or Option B (no migration, rely on
raw_payload + rp_ export)? My recommendation is B.**
