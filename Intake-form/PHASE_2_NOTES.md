# PHASE 2 NOTES — DrSnip reskin + forms

**Branch:** `phase-2-reskin` (forked from `main` @ `d09b7df`; `main` untouched).
**Scope:** Reskin to DrSnip, rebuild both intake forms, stub insurance-card
upload, clean up the admin console, add a `form_type` column. **Phase 3 (PDF /
DrChrono) not started.**

**Status:** ✅ Complete. `pnpm install && pnpm build` pass; the server boots and
serves both forms with DrSnip branding. One acceptance test could not be *fully*
executed here (live DB insert — no Postgres in this environment); see §6.

---

## 1. Jotform pull (Step 1)

The Jotform MCP worked. Two forms fetched and parsed into `DRSNIP_FORMS.md`:

| Form | Jotform ID | Questions | Built as |
|---|---|---|---|
| DrSnip Registration Form | `260987576842071` | **40** | `Home.tsx` — 5 screens |
| DrSnip Consultation Intake | `260987597803071` | **87** | `Consultation.tsx` — 6 screens |

⚠️ **Field-type fidelity.** The MCP's `fetch` / `display_form` return question
**labels and section grouping** cleanly, but **not** per-field type metadata,
exact select-option lists, required flags, or conditional-logic rules. Per the
decision rule, field **types / required / options / conditionals** were
**inferred** from the labels + medical-intake context. Real patient submissions
were deliberately **not** pulled (they are PHI).

**Needs the client's confirmation** (sensible defaults used, marked ⚠️ in
`DRSNIP_FORMS.md`): the option lists for *Office Location*, *Insurance
coverage*, *Job Demands*, *Education*, *Ethnicity*, *Relationship Status*,
*Marriage number*, *Child relation/gender*, *Birth-control methods*, and *How
did you hear about us*.

## 2. Brand assets (Step 2)

- **drsnip.com is a real site** — vasectomy clinic, locations Seattle / Portland
  / Plano, tagline *"Simply Vasectomy"* / *"No-Scalpel, No-Needle Vasectomy."*
- **Logo:** fetched `cropped-DrSnip_R_WHITE` → `public/images/drsnip-logo.png`.
  It is a **white** logo, so it is placed on the deep-blue form/admin headers.
- **Brand color:** ⚠️ **could not be reliably detected** — the homepage exposes
  no hex codes in markup the fetch tool could reach (two attempts). Per the
  instruction, the **default medical-tech palette** was used and is the
  realized brand:
  - Primary `#0F4C81` (deep clinical blue) · Accent `#06B6D4` (teal) ·
    Background white.
- The real DrSnip clinic locations are used as the Registration form's *Office
  Location* options.

## 3. Decisions & ambiguities (please review)

### D1 — Schema: also dropped the CJC attribution columns
Step 3 said to drop the `q_*` columns and listed the exact target columns.
Following that list literally, the migration also drops `source`,
`survey_detail`, `lead_source`, `campaign`, `event`, `utm_*`, and
`federal_agency` — they are not in Step 3's column list, and `federal_agency`
was `NOT NULL` and meaningless for DrSnip. Any `?source=` / `?patient_id=` the
forms read from the URL is still captured inside `raw_payload`.

### D2 — Insurance-card `size`: stored in raw_payload, not a column
Step 6 says "writes filename + size to the new DB columns," but Step 3 defines
only `insurance_card_{front,back}_filename` columns (no size column). Resolution:
the **filename** goes in the dedicated columns; the **size** is persisted inside
`raw_payload` (the full `{filename, size}` object is passed through). No data is
lost, and no schema column was invented beyond Step 3's list.

### D3 — `/` is ungated; `/consultation` is gated
Step 9's acceptance test 2 requires `GET /` to show the Registration form, so
`/` now renders it directly (sensible for a public patient-intake form). Step 5
explicitly requires `/consultation` to be gated by `?source=` or `?patient_id=`,
so it is. (Step 5's "gate it the same way Home is gated" predates `/` becoming
ungated — the explicit requirements were followed over the cross-reference.)

### D4 — Consultation "Child 1–8" rendered as a dynamic repeat
32 of the Consultation Jotform's 87 questions are a repeating Child 1–8 × {Age,
Relation, Gender, Dependent} block. Rendering 32 static fields would be poor UX,
so the form asks "how many children?" and renders that many child sub-forms
dynamically. This is a mild extension of the existing reveal pattern — flagged
per the iteration protocol.

### D5 — New shared components added
To build two forms without ~300 lines of duplicated shell, four components were
added (decision rule permits new `components/ui/` additions, documented here):
`MultiStepForm` (the step shell), `form-fields` (labelled field kit),
`FileUploadStub`, and `DatePicker`. The CJC `Screen[]` array pattern, `RadioCard`,
shadcn components, and `framer-motion` reveals are all preserved/reused.

### D6 — DatePicker wraps the existing shadcn calendar
Per Step 4, `DatePicker.tsx` wraps the previously-unused `calendar.tsx`
(react-day-picker) in a popover, with `captionLayout="dropdown"` so date-of-birth
is selectable without clicking back hundreds of months.

### D7 — Admin "Links" / "Sources" pages reskinned, not reworked
`/admin/links` (LinkGenerator) and `/admin/sources` were reskinned to the DrSnip
palette, but their **content** is still the CJC-era marketing-campaign concept
(UTM link builder, marketing-source catalog). Reworking that content was out of
Phase 2's scope. Recommend deciding their fate (keep / repurpose / remove) in a
later phase.

## 4. What changed

- **Schema:** `submissions` restructured (`form_type`, `updated_at`,
  `date_of_birth`, insurance-card-stub columns; `q_*` + attribution columns
  dropped). Hand-written migration `lib/db/migrations/0003_drsnip_schema.sql`.
- **Forms:** `Home.tsx` rewritten as the 5-screen Registration form;
  `Consultation.tsx` added as the 6-screen Consultation form; `/consultation`
  route added.
- **Upload:** `FileUploadStub` wired into the Registration insurance screen for
  the card front + back — captures filename + size, **never** uploads bytes.
- **Reskin:** blue/teal design tokens, DrSnip logo, favicon, titles, copy; all
  CJC red hex literals removed from source.
- **Admin:** Submissions / SubmissionDetailModal / Activity rebuilt for the new
  schema (form_type pill + filter, raw_payload detail view, by-form-type
  activity).

## 5. Acceptance-test results

| # | Test | Result |
|---|---|---|
| 1 | `pnpm install && pnpm build` passes | ✅ Pass |
| 2 | Both forms render at `/` and `/consultation` with DrSnip branding | ✅ Server returns the SPA at both routes; title is "DrSnip Patient Intake". (Visual render is client-side — the components compile and build.) |
| 3 | Zero CJC artifacts (no red, no "CJC" text, no agency dropdown / SOFA) | ✅ No CJC red hex in source or the built bundle; federal-agency list and SOFA content removed. Remaining "CJC" strings are code comments (provenance notes), not UI. Error-state red (`text-red-500` etc.) is standard and retained. |
| 4 | `POST /api/submit` inserts the correct row per form | ⚠️ Partial — see §6. Both payloads pass validation and reach the DB insert; a live insert needs Postgres. |
| 5 | Admin renders cleanly — form_type filter, raw_payload detail | ✅ Builds clean; admin pages rewritten to the new schema with no references to removed fields. |
| 6 | File upload stub renders, captures filename, doesn't crash | ✅ Compiles + wired; captures `{filename, size}`, persists filename to the DB column. |
| 7 | `0003_drsnip_schema.sql` is valid Postgres DDL | ✅ Present; standard `ALTER TABLE` statements. |
| 8 | `DRSNIP_FORMS.md` + `PHASE_2_NOTES.md` exist | ✅ |
| 9 | Branch `phase-2-reskin`, clean history, `main` untouched | ✅ `main` @ `d09b7df`; one logical commit per step on the branch. |

## 6. Blockers / environment limitations

- **No PostgreSQL available** (no `docker`, `psql`, or local PG binaries).
  Acceptance test 4's live row insert could not be verified end-to-end. Verified
  instead: the server boots, both the Registration and Consultation payloads
  **pass validation and reach the DB insert** (bad body → 400; valid body with
  no DB → 500, gracefully handled, error *type* logged only — no PHI).
  **To verify:** point `DATABASE_URL` at a Postgres, apply migrations
  `0001`→`0003`, then `pnpm build && pnpm start` and POST each form — expect
  `{ success: true, id }` and a row with the matching `form_type`.

## 7. Carry-over

- Confirm the ⚠️ select-option lists (§1) against the real Jotforms.
- Decide the fate of the admin Links / Sources pages (D7).
- `attached_assets/` still holds CJC screenshots / `chris-form*.png` / `.txt`
  files (not `cj-*`, so untouched per Step 7's literal scope) — optional cleanup.
- HIPAA: insurance-card upload is intentionally a stub. Real BAA-backed object
  storage + a HIPAA-compliance pass remain for a later phase.
- The test suite refresh (Phase 1 D3) was out of scope and is still pending.
