# Phase 4, Block C (partial) — PDF template cleanup

Branch: `phase-4-pdf-cleanup` (from `main`) · PR target: `main` · **No deploy / DB migration / n8n changes.**

Scope: **C.1–C.3 = PDF templates only (`lib/pdf/**`); C.4 = app-side patientmail notification (`lib/email/**` + `api/submit.ts`)** — appended at the bottom. Rendered against the **current** submission payload shape (Block B's `howHeard` array / `partnerInsurance*` keys are NOT on this branch and are out of scope).

## Files touched

- `lib/pdf/layout/header.ts` — **C.1**: drop the "Date of Birth" stat tile from the page-1 header (affects both PDFs). **C.3**: compress header band/name/tile vertical spacing.
- `lib/pdf/templates/registration.ts` — **C.2**: collapse the 5 `"Medical Background — …"` sections into one `"Medical History"` section (Jeff's Phase-3 order preserved).
- `lib/pdf/cursor.ts` — **C.3**: `TABLE` column widths + row padding tuning (shared by both PDFs; tuned conservatively so Consultation stays clean).
- *(verification only, not committed to `lib/pdf`)* a throwaway `scripts/` sample-PDF generator run from `/tmp` to measure page counts.

## C.1 — DOB out of the header
The header renders three stat tiles; the third is `{ label: "Date of Birth" }` ([header.ts](lib/pdf/layout/header.ts)), pushed for both form types. Remove that push only. DOB still renders in the body (Registration → Patient Information; Consultation → About You) and the underlying `submission.dateOfBirth` is untouched. Registration then shows one tile (Age); Consultation shows two (Age, Children) — the tile row is auto-centered, so both still look intentional.

## C.2 — One medical header (Registration)
Today the 14 medical questions are split across 5 separately-headed sub-sections, forcing the doctor to jump between headers. Merge them into a single section titled **"Medical History"** containing, in the **exact Phase-3 order**: PCP, then `mhMentalIllness → mhPainSensitive → mhFainting → mhBleeding → mhKidney → mhSTI → mhTesticleAbnormality → mhTesticleInjury → mhSurgeries → mhSurgeryComplications → mhMedications → mhAspirin → mhAllergies → mhChronic`. Every question + its Yes/No + explanation row is preserved verbatim — this is a grouping change, not content removal. Side benefit: removes 4 heading blocks (~150pt ≈ 7 rows of vertical space), the single biggest lever toward C.3.

## C.3 — 2-page fit for Registration (time-boxed ~45 min, readability first)

Ordered by leverage; measure page count after each, stop at a clean 2 pages or when the time-box is hit:

1. **C.2 heading removal** — frees ~150pt outright (structural, already required).
2. **Column re-balance** (`TABLE.labelWidth` ↑, `valueWidth` ↓): medical question labels are long and wrap to 2–3 lines in the current 196pt label column, while the value column (mostly "Yes"/"No") is over-wide. Widening the label column cuts label line-count — and since the label drives row height, this is the highest-leverage *readability-safe* win. Target ≈ `labelWidth 196→~252`, `valueWidth 296→~240`.
3. **Header compression**: band height 80→~64, patient-name 24→~20, trim the inter-block gaps and tile height 56→~48. ~40–60pt.
4. **Row density**: `rowPadV 4→3`, `rowMinHeight 20→18`. ~2pt/row over ~33 rows ≈ 66pt. Font sizes left unchanged (legibility).

**Stop rule (per the brief):** readability beats page count. If a clean 2 pages isn't reachable without cramping, stop and report the best clean result (e.g. "2.5 pages, no readability loss"). A heavy submission (many "Yes" + long explanations) may legitimately exceed 2 pages — that's the documented time-box case, reported not crammed. If any C.3 tuning ever fought C.2's grouping, C.2 wins.

## Verification
Standalone tsx script builds synthetic submissions (no real PHI) and reports page counts:
- Registration **typical** (a few "Yes" + short explanations) and **heavy** (many "Yes" + long explanations).
- Consultation sample (confirms C.1 + that the shared C.3 tuning didn't harm it).

`pnpm install && pnpm build` must be green before the PR. Logical commits per item (C.1, C.2, C.3).

---

## C.4 — Patientmail submission notification (app-side, appended)

**Architecture (fixed):** the email fires from the app's submission handler **after a successful n8n bridge call**, not from n8n. The DrChrono Patient ID is created downstream in n8n and is **not available at submit time** — it is intentionally omitted (a Patient-ID version is deferred to a future n8n block).

**Module:** `lib/email/patientmail.ts` — self-contained, best-effort, never throws.
- `patientmailEnabled()` → `process.env.PATIENTMAIL_ENABLED === "true"`.
- `shouldNotify(status)` → `status === "success"` only (so `failed` / `manual_review` send nothing). Pure predicate so the "failed bridge → 0 emails" path is unit-testable.
- `notifyPatientSubmission(notification, transport?)` → gated send. `transport` is an injectable seam (default = SMTP via `nodemailer`, lazily imported) so dev/tests stub it with no real send.

**Transport:** `nodemailer` over SMTP — provider-agnostic, all connection config from env (nothing hardcoded). Externalized in `build:server` so the node bundle stays clean.

**Hook point:** inside `runN8nBridge` in `api/submit.ts`, after the bridge `outcome` is persisted: `if (shouldNotify(outcome.status)) await notifyPatientSubmission({...})`. Already on the fire-and-forget path, so it never delays the user response; the call is best-effort and a failure is caught + logged without PHI, leaving the submission successful regardless.

**Email contents — EXACTLY four labelled fields, nothing else:**
```
Office: <officeLocation>
Name:   <firstName lastName>
DOB:    <dateOfBirth>
Phone:  <phone>
```
No medical/insurance data, no card images, no full submission dump, no Patient ID.

**Where "Office" comes from (confirmed):** `body.officeLocation`, a field on the **Registration** form only (`Home.tsx` → `.passthrough()` → `raw_payload.officeLocation`). The **Consultation** form has no office field, so a consultation notification renders `Office: —`. Surfaced here rather than guessed; not invented for consultation.

**Env vars (all documented in the PR):**
- `PATIENTMAIL_ENABLED` (bool killswitch — anything but `"true"` = no send, cleanly)
- `PATIENTMAIL_TO` (staff recipient; missing = skip cleanly)
- `PATIENTMAIL_FROM` (sender address)
- `PATIENTMAIL_SMTP_HOST`, `PATIENTMAIL_SMTP_PORT`, `PATIENTMAIL_SMTP_SECURE`, `PATIENTMAIL_SMTP_USER`, `PATIENTMAIL_SMTP_PASS` (SMTP transport)

**HIPAA / audit:** the four fields are PHI leaving the system, so: env-config only, killswitchable, send is best-effort and never blocks submission, and the audit log records only `{ ts, submission_id, recipient }` on send — **never** the Name/DOB/Phone values. Point `PATIENTMAIL_SMTP_*` at a BAA-covered relay (ops concern, outside code).
