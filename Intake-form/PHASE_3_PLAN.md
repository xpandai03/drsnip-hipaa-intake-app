# PHASE 3 PLAN — PDF generation for DrSnip intake submissions

**Type:** Research + implementation plan. **No code written.** Read-only audit.
**Date:** 2026-05-20
**Author goal:** a plan an implementation agent can execute end-to-end without
further research.

---

## 0. Executive summary

Each submitted intake form should generate a **doctor-friendly PDF**: a
prominent page-1 header (patient name, spouse, # children, calculated age, DOB)
plus the full submission as a structured medical record on the following pages.
For this phase the PDF is **downloadable from the admin console only**; a clean
function seam is left for the future n8n → DrChrono upload.

**Headline decisions:**
- **Library:** `pdf-lib` — pure JS, zero esbuild-bundling risk in the existing
  `dist/server.cjs` pipeline (§3).
- **Shape:** option **(B)** — multi-page full medical record with the header
  prominent on page 1 (§4).
- **Generation:** **on-demand**, in-memory, via `GET /api/submissions/:id/pdf`
  — no stored PDFs, no object storage (§6).
- **Effort:** **L** — ~4–6 hours, one ordered task list, no research unknowns
  left (§10).

**⚠️ One item needs Jeff's decision before/at implementation — see §11:**
spouse name and number-of-children **only exist on Consultation submissions**.
Registration submissions capture neither. The PDF header must be
**form-type-aware**; Jeff should confirm what the Registration header shows for
those two rows (recommendation: omit them). This is **not a code blocker** —
implementation can proceed with a form-type-aware header — but it is Jeff's
call on presentation.

---

## 1. Submission data audit

### 1.1 The `submissions` table

Source: `lib/db/src/schema/submissions.ts:19-56`. Columns:

| Column | Type | Null? | Line | Notes |
|---|---|---|---|---|
| `id` | uuid PK | no | :22 | submission id (used as the DrChrono/n8n reference) |
| `created_at` | timestamptz | no | :23-25 | submission timestamp |
| `updated_at` | timestamptz | no | :26-28 | unused today |
| `form_type` | text | no | :31 | `'registration'` \| `'consultation'` |
| `first_name` | text | no | :34 | patient first name |
| `last_name` | text | no | :35 | patient last name |
| `email` | text | no | :36 | |
| `phone` | text | no | :37 | |
| `date_of_birth` | text | **yes** | :38 | ISO `YYYY-MM-DD` string (see §1.4) |
| `state_residence` | text | yes | :39 | |
| `insurance_card_front_filename` | text | yes | :44 | stub — filename only |
| `insurance_card_back_filename` | text | yes | :45 | stub — filename only |
| `has_insurance_cards` | boolean | no | :46 | |
| `raw_payload` | jsonb | no | :49 | **the full POSTed form object** |

`Submission` row type: `lib/db/src/schema/submissions.ts:60`
(`typeof submissions.$inferSelect`).

### 1.2 How `raw_payload` is populated

`api/submit.ts` validates the POST body with a `.passthrough()` Zod schema
(`api/submit.ts:26-39`) and stores the **entire parsed body** verbatim:
`rawPayload: body` (`api/submit.ts:79`). `.passthrough()` (`:39`) means every
form-specific answer key survives into `raw_payload` even though only identity
+ insurance fields are explicitly typed (`:28-36`).

So `raw_payload` = the exact object the form's `onSubmit` POSTed. The dedicated
columns (`first_name`, `date_of_birth`, …) are a **subset** also copied out for
querying; the PDF should treat the **columns as authoritative** for identity
and read everything else from `raw_payload`.

### 1.3 `raw_payload` shape — Registration (`form_type='registration'`)

Built by `Home.tsx` `onSubmit` (`...data` spread + identity overrides). Keys
present in `raw_payload`:

- Identity / contact: `officeLocation`, `legalFirstName`, `preferredFirstName`,
  `middleInitial`, `legalLastName`, `dateOfBirth`, `streetAddress`, `state`,
  `mobileNumber`, `email`, `consentVoicemail`, `consentText`
  (`Home.tsx` `RegistrationData`, lines ~105-117).
- Medical: `primaryCarePhysician`, the **13 `mh*` keys**
  (`mhTesticleAbnormality`, `mhTesticleInjury`, `mhSTI`, `mhKidney`,
  `mhMedications`, `mhSurgeries`, `mhFainting`, `mhAllergies`, `mhChronic`,
  `mhBleeding`, `mhSurgeryComplications`, `mhPainSensitive`, `mhAspirin` —
  each `"Yes"` / `"No"` / `""`), and `medicalDetails` — a
  `Partial<Record<MedicalKey,string>>` of per-question "Yes" explanations
  (`Home.tsx:120`, the per-question explain box shipped earlier).
- Insurance: `insuranceCoverage`, `insuranceCompany`, `insuranceIdNo`,
  `insuranceGroupNo`, `insuredFirstName`, `insuredLastName`, `insuredDob`,
  `insuredEmployer`, `insuranceCardFront`/`insuranceCardBack`
  (`{filename,size}|null`).
- Override keys (also in raw_payload): `formType`, `firstName`, `lastName`,
  `phone`, `stateResidence`.

Medical-question labels live in `Home.tsx` `MEDICAL_QUESTIONS` (the 13
`{key,label}` entries) — the PDF should use those labels, not the raw keys.

### 1.4 `raw_payload` shape — Consultation (`form_type='consultation'`)

Built by `Consultation.tsx` `onSubmit` (`Consultation.tsx:645-657`). Keys
(`ConsultationData`, `Consultation.tsx:97-148`):

- About You: `firstName`, `lastName`, `email`, `phone`, `dateOfBirth`,
  `occupation`, `employer`, `jobTitle`, `jobDemands`, `education`,
  `educationOther`, `ethnicity`.
- Relationship: `relationshipStatus`, `relationshipStatusOther`,
  **`partnerFirstName`**, **`partnerLastName`**, `partnerPhone`,
  `partnerShareConsent`, `partnerAge`, `partnerOccupation`,
  `partnerEducation`, `yearsInRelationship`, `marriageNumberSelf`,
  `marriageNumberSpouse`.
- Children: **`childCount`** (string `"0"`–`"8"`), **`children`** — an array
  of `ChildRow` `{age,relation,gender,dependent}` (`Consultation.tsx:82-87`),
  sliced to `childCount` at submit time (`Consultation.tsx:649`).
- Family planning / birth control: `wantMoreChildren`, `considerAdoption`,
  `vasectomyConsideredDuration`, `consideredTubal`, `consideredTemporaryBC`,
  `currentBC` (string[]), `currentBCOther`, `priorBC` (string[]).
- Medical / personal: `religionConflict`, `sexualConcerns`,
  `sexualConcernsDetails`, `geneticCondition`, `geneticConditionDetails`.
- Emergency / referral: `emergencyName`, `emergencyPhone`,
  `emergencyRelationship`, `howHeard`, `howHeardOther`,
  `referringProfessional`, `additionalNotes`.
- Override keys: `formType`, `patientId` (the `?patient_id=` URL param, for
  downstream linkage).

### 1.5 `date_of_birth` format

Both forms collect DOB through `components/ui/DatePicker.tsx`, which emits an
ISO `YYYY-MM-DD` string (`DatePicker.tsx:31-34`, `dateToIso`). The
`submissions.date_of_birth` column stores that string. The column is
**nullable** (`submissions.ts:38`) — the age helper must tolerate `null`/`""`.

---

## 2. Jeff's four header fields — mapped to real data

| Field | Source | Both form types? |
|---|---|---|
| **Patient name** | `submissions.first_name` + `submissions.last_name` columns (`submissions.ts:34-35`) | ✅ **Yes** — populated for both (Registration copies `legalFirstName/legalLastName`; Consultation copies `firstName/lastName`). |
| **Spouse name** | `raw_payload.partnerFirstName` + `raw_payload.partnerLastName` (`ConsultationData`, `Consultation.tsx:113-114`) | ⚠️ **Consultation only.** Registration's `RegistrationData` has no partner/spouse field. Even on Consultation, populated only when `relationshipStatus` ∈ {Married, Partnered}. |
| **Number of children** | `raw_payload.children.length` (== `Number(raw_payload.childCount)` after the submit-time slice, `Consultation.tsx:649`) | ⚠️ **Consultation only.** Registration has no children field. |
| **Date of birth** | `submissions.date_of_birth` column (`submissions.ts:38`), ISO `YYYY-MM-DD` | ✅ **Yes** — both forms (column nullable; handle missing). |
| **Calculated age** | *derived* from `date_of_birth` (§5) | ✅ wherever DOB exists. |

### 2.1 The form-type divergence (see §11)

**Patient name, DOB, and age exist for every submission.** **Spouse name and
number-of-children exist only for Consultation submissions.** This is expected
— per `DRSNIP_FORMS.md`, partner and children sections belong to the
Consultation Intake form; the Registration form is identity + medical-screening
+ insurance only.

Implementation consequence: the page-1 header is **form-type-aware**.
- **Consultation PDF header:** name · spouse · children · age · DOB (all 5).
- **Registration PDF header:** name · age · DOB. Spouse and children rows
  **omitted** (recommended) — see §11 for Jeff's confirmation.

No data is "missing" in a way that blocks code — every header field that
*can* exist for a given form type *does* exist. The only open item is the
**presentation choice** for Registration (§11).

---

## 3. PDF library selection

### 3.1 Hard constraints (from the brief + the deploy reality)

- Server-side Node, inside the Hono server (`api-server/`).
- Produces a real PDF binary (not a print stylesheet).
- Must **bundle cleanly into `dist/server.cjs`** — the server is a single
  esbuild CJS bundle (`package.json` `build:server`), deployed in a 62 MB
  Fly image. A library that fights esbuild bundling jeopardises the whole
  deploy pipeline (already twice-bitten in Phase 2 — see PHASE_2_DEPLOY_NOTES
  §3).
- No third-party API calls (HIPAA — generation stays in-process).
- Free / open-source.

### 3.2 Comparison

| Lib | Bundle/esbuild risk | Layout flexibility | Auto-pagination | Dev ergonomics | Image embed | Verdict |
|---|---|---|---|---|---|---|
| **`pdf-lib`** | **None** — pure JS, standard fonts embedded with no external files, no wasm/asset deps | Programmatic (draw text at x/y) | No — manual (small helper, §4.4) | Imperative but simple | `embedPng` / `embedJpg` ✅ | ✅ **Recommended** |
| `@react-pdf/renderer` | **Real risk** — pulls `yoga-layout` + `fontkit`; wasm/asset handling under esbuild-CJS is unverified in this pipeline | Flexbox engine — excellent | Yes (built-in) | JSX (team knows React) — excellent | `<Image>` ✅ | Strong on ergonomics, **loses on the no-research-unknowns requirement** |
| `pdfkit` | **Real risk** — ships `.afm` font-metric + brotli data files that esbuild does not bundle without manual asset wiring | Flowing text API — good | Yes (flowing) | Imperative | ✅ | Rejected — worst bundling story of the three |
| `puppeteer` | N/A | Full HTML/CSS | Yes | HTML | ✅ | **Rejected** — ~200 MB Chromium; ~4× the entire current image. Non-starter. |

### 3.3 Decision — `pdf-lib`

**Recommend `pdf-lib`.** The deciding factor is the success criterion of this
plan: *an agent can ship without further research.* `pdf-lib` is pure
JavaScript with **zero esbuild-bundling unknowns** — it embeds the 14 PDF
standard fonts (Helvetica family) without external files, has no wasm and no
runtime asset directory, and bundles into `dist/server.cjs` the same way
`pg`/`drizzle`/`hono` already do. It also supports `embedPng`/`embedJpg`,
covering the eventual insurance-card images. Footprint added to the image:
small (single-digit MB).

`@react-pdf/renderer` would give nicer JSX layout + free pagination, but its
`yoga-layout`/`fontkit` dependencies introduce an **unverified bundling
question** in exactly the esbuild→CJS→Fly path that already cost two extra
deploy iterations in Phase 2. Trading a ~40-line pagination helper (fully
spec'd in §4.4 — so it is *not* an unknown) for a bundling unknown is the wrong
trade for a "no research left" plan.

> If, during task 1 (§10), `pdf-lib` were somehow unsuitable, the documented
> fallback is `@react-pdf/renderer`. It is **not** expected to be needed.

Install: add `pdf-lib` to **`Intake-form/package.json` `dependencies`** (the
root package — that is what `build:server` bundles).

---

## 4. PDF layout design

### 4.1 Decision — option (B): full multi-page medical record

**Recommend (B)** — a multi-page record with the 4-field header prominent on
page 1, the entire submission structured on pages 2+. Reasoning:
- One artifact serves both jobs Jeff described — the **30-second chart scan**
  (page-1 header) *and* a **complete medical record** (the rest).
- It is what gets uploaded to DrChrono later — DrChrono expects a real chart
  document, not a summary card.
- A summary-only card (option A) would force a *second* document later for the
  full record; (B) avoids that rework.

Page count is naturally variable (a Consultation with 8 children + many "Yes"
medical explanations runs longer) — hence the pagination helper in §4.4.

### 4.2 Page 1 — Header & summary

```
┌─────────────────────────────────────────────────────────────┐
│ [DrSnip logo]                          Registration Intake   │  ← form-type badge, top-right
│                                                               │
│                     JAMES  CARTER                            │  ← patient name, ~24pt bold, centred
│                  Spouse: Maria Carter                        │  ← Consultation only; omitted on Registration
│                                                               │
│     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│     │  Age          │  │  Children     │  │  Date of      │     │  ← stat tiles; "Children" tile
│     │   38          │  │   3           │  │  birth        │     │     omitted on Registration
│     │               │  │               │  │  1987-04-12   │     │
│     └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                               │
│  Submitted: 2026-05-20 14:02 UTC                              │
│  Submission ID: d9e4ea0f-3eaf-4a03-902f-5ca0ff0409d6          │  ← small, mono — n8n/DrChrono ref
│  ───────────────────────────────────────────────────────     │
│  (full submission begins below / on page 2)                   │
└─────────────────────────────────────────────────────────────┘
```

Header elements: DrSnip logo top-left (the existing
`artifacts/intake-form/public/images/drsnip-logo.png` — note it is **white**;
draw it on a clinical-blue `#0F4C81` band so it is visible); form-type label
top-right; patient name large/bold/centred; spouse line below
(**Consultation only**); a row of stat tiles — **Age**, **Children**
(Consultation only), **Date of birth**; submission timestamp; submission id
(small monospace).

### 4.3 Pages 2+ — full submission

Render the submission as **sections that mirror the form's screen titles** so a
doctor reads it in the same order the patient filled it:

- **Registration sections:** Patient Information · Contact & Consent ·
  Medical Background — Urological & Reproductive · — General Health ·
  — Surgical & Procedure History · — Bleeding & Anesthesia · — Aspirin & Pain ·
  Insurance. (Screen titles from `Home.tsx` `MEDICAL_SCREENS` + the static
  screens; the "Review & Submit" screen is not a data section.)
- **Consultation sections:** About You · Relationship · Children ·
  Family Planning · Birth Control · Medical & Personal Considerations ·
  Emergency Contact & Referral.

Within each section, a clean **key-value list**: question label (left,
muted) + answer (right/bold). Rendering rules:
- **Question labels:** use the form's own labels, not raw camelCase keys.
  Implement a curated `key → {section, label}` map per form type in the
  templates (§6) — the medical-question labels come straight from
  `Home.tsx` `MEDICAL_QUESTIONS`.
- **Medical "Yes" answers:** under the `Yes`, render the patient's explanation
  from `raw_payload.medicalDetails[key]` (indented, italic). If `Yes` with no
  explanation → just `Yes`.
- **Multi-select / arrays** (`currentBC`, `priorBC`) → comma-joined, or a
  short bulleted list.
- **Empty / skipped fields** → render `—` (or omit the row — recommend `—` so
  the doctor sees the question *was* asked).
- **Children block** → a "Children" subsection: one compact row per element of
  `raw_payload.children` (Age · Relation · Gender · Dependent). Render only the
  children actually submitted (the array is already sliced to `childCount`).
- **Insurance cards** → for now print the stored filenames + a
  "Demo mode — image not stored" note (bytes are not persisted, per
  PHASE_2_NOTES). The layout leaves room to `embedJpg`/`embedPng` later.

### 4.4 Pagination helper (the only "manual" piece)

A ~40-line shared helper removes all pagination guesswork:

```
class PdfCursor {
  // tracks { page, y }, the page size, and margins
  ensureSpace(heightNeeded): void   // if y - heightNeeded < bottomMargin → addPage(); y = topMargin
  text(label, value, opts): void    // measures with font.widthOfTextAtSize, wraps, advances y
  sectionHeading(title): void       // ensureSpace + heading + advance
  addPage(): void                   // new page + repaint the footer
}
```

`pdf-lib` provides `font.widthOfTextAtSize()` and `font.heightAtSize()` for
measurement; wrapping long answers is a simple word-accumulation loop. This is
standard, deterministic code — **not** a research item.

### 4.5 Footer (every page)

Drawn by `PdfCursor.addPage()` on each page:
`DrSnip Patient Intake — CONFIDENTIAL / PHI`  ·  `Page X of Y`  ·
`Submission <id>`. (Page X-of-Y: pdf-lib needs the total, so stamp footers in a
final pass over `pdfDoc.getPages()` once the page count is known.)

### 4.6 Fonts

Use pdf-lib's built-in `StandardFonts.Helvetica` / `Helvetica-Bold` /
`Helvetica-Oblique` only. **No custom font files** — keeps the bundle clean and
avoids asset-loading. Sizes: name ~24pt bold, section headings ~13pt bold,
labels ~9pt, answers ~10pt, footer ~7pt.

---

## 5. Calculated-age logic

A small pure function, **`lib/pdf/age.ts`**:

```ts
/**
 * Whole-years age from an ISO 'YYYY-MM-DD' date_of_birth (or a Date).
 * Returns null when the DOB is missing or unparseable so callers can
 * render "—". Returns 0 (not negative) for a future DOB (data error).
 */
export function calculateAge(dob: string | Date | null | undefined): number | null {
  if (dob == null || dob === "") return null;
  const birth = typeof dob === "string" ? new Date(`${dob}T00:00:00`) : dob;
  if (Number.isNaN(birth.getTime())) return null;          // invalid → caller shows "—"
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;  // birthday not yet reached
  return age < 0 ? 0 : age;                                 // future DOB → 0 (flag as data error)
}
```

Edge cases (all handled above):
- **Birthday is today** → `m === 0 && today.getDate() === birth.getDate()` → no
  decrement → full year diff. ✅
- **Birthday not yet this year** → `m < 0`, or `m === 0` and day not reached →
  `age--`. ✅
- **Future DOB** → negative → clamped to `0`. The template should additionally
  render age `0` from a future DOB with a subtle "(check DOB)" marker.
- **Missing / invalid DOB** → `null` → template renders `—`.

Parsing note: `new Date("YYYY-MM-DD")` alone parses as **UTC midnight**, which
can shift the day in negative-offset timezones; appending `T00:00:00` forces
**local** midnight so the day component is stable. Unit-test this helper
(birthday today / yesterday / tomorrow / leap-day 02-29 / null / garbage /
future).

---

## 6. Architecture & file structure

### 6.1 `lib/pdf/` — a plain directory, NOT a workspace package

Recommend a plain `lib/pdf/` directory (sibling of `lib/db/`), **not** a
`@workspace/pdf` package. Reasoning: a workspace package needs its own
`package.json`, `tsconfig.json`, project-reference wiring, and a built `dist/`
(Phase 1 D-notes flagged the `@workspace/db` build friction). A plain directory
imported by relative path from the API handler is typechecked transitively by
`tsc -p api/tsconfig.json` (tsc follows imports) and bundled transitively by
esbuild — zero new build wiring.

### 6.2 Files

```
lib/pdf/
  age.ts                     calculateAge() — §5 (pure, unit-tested)
  cursor.ts                  PdfCursor pagination/footer helper — §4.4
  generator.ts               generateSubmissionPdf(submission) → Uint8Array  ← the seam (§8)
  layout/header.ts           page-1 header band + name + stat tiles
  layout/sections.ts         generic section + key-value + array + children renderers
  templates/registration.ts  Registration field→{section,label} map + section order
  templates/consultation.ts  Consultation field→{section,label} map + section order
api/submissions/[id]/pdf.ts  new endpoint: requireAuth → generateSubmissionPdf → stream
```

`api/submissions/[id]/` does not currently exist (Phase 1 deleted the old
`[id]/release.ts` etc.); creating `[id]/pdf.ts` re-introduces the directory
alongside the existing `api/submissions/[id].ts` file — both are fine
(`[id].ts` and `[id]/pdf.ts` are distinct routes).

### 6.3 Generation strategy — on-demand, in-memory

**Recommend generate-on-demand**, not on-submit-and-store. Reasoning:
- No object storage is configured (PHASE_2_NOTES / INVESTIGATION §11) — storing
  PDFs would require provisioning S3/R2 + a BAA. Out of scope.
- HIPAA: a PDF that is never persisted cannot leak from storage. Generation is
  in-memory only (`pdf-lib` returns a `Uint8Array`; no temp files).
- Simpler: no lifecycle, no invalidation, no cleanup.
- Trivially extends to n8n later — the same `generateSubmissionPdf()` is called
  by a future webhook handler (§8).
- Cost is negligible: a `pdf-lib` render of a few pages is single-digit
  milliseconds.

### 6.4 The endpoint — and a real adapter finding

New handler `api/submissions/[id]/pdf.ts` (Vercel-style, mirrors the auth +
UUID-validation pattern of `api/submissions/[id].ts`):
1. `requireAuth(req, res)` — admin-only.
2. Validate `:id` is a UUID; `SELECT` the submission row; 404 if absent.
3. `const bytes = await generateSubmissionPdf(row)`.
4. `res.setHeader("Content-Type", "application/pdf")`,
   `res.setHeader("Content-Disposition", 'attachment; filename="drsnip-<lastname>-<id8>.pdf"')`,
   `res.send(bytes)`.

Mount in `api-server/index.ts` next to the other submissions routes
(near `:44`): `app.all("/api/submissions/:id/pdf", adapt(pdfHandler));`
— register it **before** or independently of `/api/submissions/:id`; the deeper
static `/pdf` segment is unambiguous, but keep it adjacent for clarity.

> **⚠️ Adapter finding — binary responses.** `api-server/vercel-adapter.ts`
> buffers the response body as a **string**: `responseBody` is typed
> `string | null` (`vercel-adapter.ts:84`) and `send()` does
> `typeof payload === "string" ? payload : JSON.stringify(payload)`
> (`vercel-adapter.ts:107-109`). A PDF `Uint8Array`/`Buffer` passed to
> `res.send()` today would be **`JSON.stringify`-ed and corrupted.**
> **Required small change (≈5 lines):** widen `responseBody` to
> `string | Uint8Array | null` and make `send()`/`end()` pass a
> `Uint8Array`/`Buffer` through untouched — `buildResponse`'s `new Response()`
> (`vercel-adapter.ts:40`) already accepts a `Uint8Array` body. This keeps the
> PDF endpoint a normal Vercel-style handler, consistent with every other
> route. (Alternative: implement `/api/submissions/:id/pdf` as a native Hono
> route — rejected: it would duplicate the `requireAuth` plumbing.)

---

## 7. Admin UI plan

Two download affordances (no new pages, no batch/zip for the demo):

1. **Submission detail modal** — `SubmissionDetailModal.tsx`: a prominent
   primary **"Download PDF"** button in the modal header/footer. On click,
   `window.open('/api/submissions/<id>/pdf')` (or an anchor with `download`) —
   the browser streams the file. This is the main path.
2. **Submission list row** — `Submissions.tsx`: a small icon button (e.g.
   `FileDown` from lucide) in each row, next to the existing copy-ID button,
   that downloads that row's PDF without opening the modal. `stopPropagation`
   so it does not also open the detail modal.

Both just hit `GET /api/submissions/:id/pdf`; the browser handles the download
via `Content-Disposition: attachment`. No client-side PDF code.

**Out of scope for the demo:** a "Download all / selected (zip)" button —
note it as a future nicety, do not build it.

---

## 8. n8n / DrChrono future hook — the seam

The architecture leaves a clean seam **without building the integration**:

- `generateSubmissionPdf(submission: Submission): Promise<Uint8Array>`
  (`lib/pdf/generator.ts`) is a **pure function** — input is a `submissions`
  row, output is PDF bytes. It has **no dependency on HTTP, `req`/`res`, or
  auth**.
- Today it is called only by `api/submissions/[id]/pdf.ts`.
- The future n8n→DrChrono path is a second caller of the *same function*:
  a suggested `POST /api/submissions/:id/upload-to-drchrono` handler would
  `generateSubmissionPdf(row)` and POST the bytes to the existing n8n webhook
  (n8n then uploads to DrChrono). The submission `id` is the cross-system
  reference (already printed on the PDF, §4.2).
- Because the function returns a plain `Uint8Array`, it is equally usable from
  an HTTP stream, an n8n webhook body, or a (future) batch job.

**Do not build the upload endpoint now** — only confirm, as above, that the
function signature already supports it. It does.

---

## 9. HIPAA & security considerations

The PDF *is* PHI (name, DOB, full medical history). Controls:

| Concern | Plan |
|---|---|
| **Generation** | In-memory only. `pdf-lib` returns a `Uint8Array`; **no temp files, no disk writes.** |
| **Storage** | **None.** On-demand generation (§6.3) — no PDF ever sits in storage waiting to leak. |
| **Access control** | The endpoint calls `requireAuth` (`api/_lib/auth.ts`) — admin session required, same gate as every `/api/submissions/*` route. Confirmed. |
| **Transport** | Already HTTPS-only — `fly.toml` `force_https = true`. |
| **Audit logging** | **Recommended (plan only, do not build):** log each PDF download to a future `phi_access_log` table — `{ submission_id, actor_email, action:'pdf_download', at }`. HIPAA expects access logging for PHI reads. Surfaced here as a follow-up; not built this phase. |
| **Caching** | **No caching** of generated PDFs — regenerate each request. Less attack surface, always current, negligible cost. |
| **Watermark** | **Yes** — every page footer reads `CONFIDENTIAL / PHI` (§4.5). |
| **Logging hygiene** | The endpoint + generator log **IDs and error types only** — never raw payload / PHI — consistent with `api/submit.ts:13,85-88`. |
| **Filename** | `Content-Disposition` filename uses last name + a short id (`drsnip-carter-d9e4ea0f.pdf`) — avoid putting full DOB/identifiers in the filename. |

---

## 10. Implementation sequence & effort estimates

Effort: **S** = <1 hr · **M** = 1–3 hr · **L** = 3+ hr.

| # | Task | Effort |
|---|---|---|
| 1 | Add `pdf-lib` to root `package.json`; `pnpm install`; confirm it bundles into `dist/server.cjs` (`pnpm build`). De-risk gate. | **S** |
| 2 | `lib/pdf/age.ts` — `calculateAge()` (§5) + unit tests (today/未reached/leap/null/future). | **S** |
| 3 | `lib/pdf/cursor.ts` — `PdfCursor` pagination + per-page footer helper (§4.4). | **M** |
| 4 | `lib/pdf/layout/header.ts` — page-1 header band, logo, name, form-type-aware stat tiles (§4.2). | **M** |
| 5 | `lib/pdf/layout/sections.ts` — section heading + key-value + array + medical-"Yes"-with-explanation + children-block renderers (§4.3). | **M** |
| 6 | `lib/pdf/templates/registration.ts` + `consultation.ts` — field→{section,label} maps + section order. | **M** |
| 7 | `lib/pdf/generator.ts` — `generateSubmissionPdf(submission)` tying header + templates + sections + footer pass. | **S** |
| 8 | Extend `api-server/vercel-adapter.ts` for binary responses (§6.4, ~5 lines). | **S** |
| 9 | `api/submissions/[id]/pdf.ts` endpoint + mount in `api-server/index.ts`. | **S** |
| 10 | Admin UI — "Download PDF" button in `SubmissionDetailModal.tsx` + row icon in `Submissions.tsx` (§7). | **S** |
| 11 | `pnpm build`; deploy to Fly; smoke-test — download a Registration PDF and a Consultation PDF from the live admin, eyeball the header + sections. | **S** |

**Total: L — ~4–6 hours.** No research unknowns remain: the library is chosen
and bundling-safe, the pagination approach is spec'd, the data shapes are
mapped, and the one architectural gotcha (binary responses) is identified with
a fix.

---

## 11. Blockers & decisions needed

### [DECISION NEEDED] Registration-PDF header — spouse & children rows

**Not a code blocker.** Spouse name and number-of-children are captured **only
by the Consultation form** (§2). Registration submissions have neither.
Implementation will proceed with a **form-type-aware header** regardless;
Jeff just needs to confirm the *presentation* for Registration PDFs:

- **Option A (recommended):** On a Registration PDF, **omit** the spouse line
  and the Children tile entirely — show name · age · DOB. Cleanest; the doctor
  isn't shown empty fields.
- **Option B:** Keep all rows and render `—` for spouse/children on
  Registration. Consistent layout across form types, but shows blanks.

Recommendation: **Option A.** No implementation is held up by this — the
template can ship with Option A and be flipped trivially if Jeff prefers B.

### Non-blocking notes (no decision required)

- **Nullable DOB** — `date_of_birth` is a nullable column. Both forms *require*
  DOB so in practice it is always set, but the age helper + header handle
  `null` → `—` defensively.
- **Spouse on a single Consultation patient** — partner fields only populate
  when `relationshipStatus` ∈ {Married, Partnered}; a single patient yields an
  empty spouse name. The header omits the spouse line when empty.
- **Insurance card images** — bytes are not stored (stub, PHASE_2_NOTES). The
  PDF prints the filenames + a "not stored" note now; `embedJpg`/`embedPng`
  slots in later when real upload + a BAA-backed store exist.
- **`phi_access_log`** — recommended future audit table (§9); explicitly *not*
  built this phase. No schema change is required for Phase 3 itself.

---

## Acceptance-test answers

1. **Which PDF library, and why?** `pdf-lib` — pure JS, **zero esbuild
   bundling risk** in the established `dist/server.cjs` pipeline, standard
   fonts need no external files, supports image embedding for future insurance
   cards (§3).
2. **Where does each of the 4 header fields live?** Name → `first_name` +
   `last_name` columns; DOB → `date_of_birth` column; spouse →
   `raw_payload.partnerFirstName/partnerLastName` (Consultation only);
   children → `raw_payload.children`/`childCount` (Consultation only); age →
   derived from DOB (§2).
3. **`calculateAge` signature + edge cases?** `calculateAge(dob: string | Date
   | null | undefined): number | null` — handles birthday-today, not-yet-this-
   year, future DOB (→0), and missing/invalid (→null) (§5).
4. **One page or multi-page?** Multi-page — option (B), full medical record
   with the header prominent on page 1 (§4.1).
5. **Where do new files go?** `lib/pdf/` (plain directory) +
   `api/submissions/[id]/pdf.ts` (§6).
6. **Where does the download button live?** "Download PDF" in
   `SubmissionDetailModal.tsx`; a row icon in `Submissions.tsx` (§7).
7. **How does the function signature support admin + future n8n?**
   `generateSubmissionPdf(submission): Promise<Uint8Array>` is pure (no
   HTTP/auth) — called by the admin endpoint now, by a future
   `upload-to-drchrono` handler later (§8).
8. **Ordered task list with estimates?** 11 tasks, total **L / 4–6 hrs** (§10).
9. **Blockers?** None that block code. One **[DECISION NEEDED]** for Jeff:
   the Registration-PDF header presentation for the spouse/children rows that
   Registration does not capture (§11).
