# PHASE 3 — Jeff feedback session: pre-existing bugs found, not fixed

Surfaced during the `phase-3-jeff-feedback` work but **deliberately not
fixed in this session** (out of scope per the brief). Documenting here so a
future session can pick them up.

## 1. `marketing-sources` test fails to load on `main`

`pnpm test` fails on `api/_test/marketing-sources.test.ts` with a
`MODULE_NOT_FOUND` error during `require`-chain resolution. Reproduced with
the working tree stashed (so it pre-dates this session's edits).

- `pnpm test:pdf` still passes (10/10).
- The failure is at *test discovery / require* time, not an assertion —
  most likely a stale path or a missing fixture in `api/_test/`.
- No impact on production code or PDF generation.

Recommendation: bring the test runner config (currently `node:test` + tsx)
back in line with the rest of `api/_test/`, or remove the test if the
marketing-sources feature is no longer maintained.

## 2. Carry-over from Phase 2 / Phase 3 (still open)

These were flagged by earlier phases and remain out of scope:

- `phi_access_log` audit table for PDF downloads (PHASE_3_PLAN §9).
- Insurance-card image embedding once bytes are stored under a BAA.
- Admin `/admin/links` + `/admin/sources` content review.

## 3. Confirm with Jeff after this session

The patient-level **Education** and **Ethnicity** fields were removed from
the Consultation form per Jeff's spec. The **Partner / Spouse's Education**
field is retained — please confirm that was the intended scope. (The brief
only listed the patient-level fields under "remove".)
