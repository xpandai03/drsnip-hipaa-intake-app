# Phase 4, Block C (partial) — PDF template cleanup

Branch: `phase-4-pdf-cleanup` (from `main`) · PR target: `main` · **No deploy / DB / n8n / email. C.4 (patientmail) is out of scope.**

Scope: **PDF templates only — `lib/pdf/**`.** Rendered against the **current** submission payload shape (Block B's `howHeard` array / `partnerInsurance*` keys are NOT on this branch and are out of scope).

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
