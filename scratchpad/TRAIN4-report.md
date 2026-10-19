# Train 4: main parity, sync repair, the clinic's status rules, conversion by cohort

**Date:** 2026-10-19 (UTC). **Release:** **Fly v97** (2026-10-19 16:07 UTC, image `deployment-01M5AEJT53WTSPW9ES0EJAYRPH`), built from `main` `dbd2d24` (tag `train4`). **Rollback point:** v96.
No PHI appears in this report. It contains counts, short submission IDs and test-chart IDs only.

## Summary

| Step | Result | Evidence |
|---|---|---|
| 0 State report | Merged | PR #61 |
| 1 Main parity | `main` = production code | PRs #55 and #56 rebased and merged. A local build of `main` was **byte-identical** to live v96 (`index-DXFkCAk1.js`, sha256 `da6cb871…`) |
| 2 Hourly sync | Fixed, with an alarm | PR #62. Two consecutive scheduled non-zero runs (15:05, 16:05) |
| 2b PHI at rest in n8n | Success-data retention off on both sync workflows | Section below |
| 3 Status rules | The clinic's twelve statuses, approved v2 | PR #63. June/July/August converted all rose |
| 4 Cohort view | Live at `/admin/conversion` | PR #64. Cohort = Monthly outcomes (July: 383 = 383) |
| 5 Digest tweaks | Live, verified on the 17:00 digest | PR #65 (three commits in the PR, squash-merged per repo convention) |
| 6 Deploy | v97 live; all checks pass | 31/31 signed-in checks; the bundle is byte-identical to `main` |
| Incident | DB unavailable 15:06:37–15:36:35 UTC | Section below |

## Step 0: the state report, and the baseline drift

The Train 0 window now holds 2865 rows instead of 2870 because **5 submissions were deleted through the console after 2026-09-15**:
- four consultation `manual_review` rows from one 2026-09-09 repeat-submission chain;
- one insurance `success` row.

It is neither the drop-off purge (which only touches `registration_partials`) nor test-row exclusion (all six Appendix A rows are still present). The six August test insurance submissions share **one** chart, 135620405, not six.

## Step 1: main parity

- **#55** was rebased onto `main`. Only `package.json` conflicted (the `test:api` list, resolved as the union). The rebased branch differs from the original #55 by exactly `main`'s 16 files.
- **#56** was retargeted to `main` before #55 merged (CLAUDE.md stacked-PR rule), then rebased `--onto main 1c3bd99`. Its five duplicate copies of #57–#60 were dropped.
- **The resulting tree equals 335506a (the live code) plus the state report.**
- **Gate:** `assert-conversion-bundle.mjs` reports "compiled ON". The redesign strings, the `data-drsnip-conversion` marker and the `drsnip:ready` handshake are all present. The bundle is byte-identical to production v96.

## Step 2: hourly appointment sync

**Root cause, in one sentence:** the hourly workflow's *Fetch Appointments* `since` (`n8n-rollback/appointment_sync_incremental_hourly.json`, `queryParameters.parameters[0]`) rendered the UTC cursor as zone-less ISO with `toISOString().replace(…)`, but DrChrono does not read a zone-less `since` as UTC, so every hourly window sat about 4 hours in the future and returned an empty page.

- **Evidence.** DrChrono's `created_at`/`updated_at` behave as **US/Eastern** wall-clock time: across 969 recent appointments, the minimum lag between `created_at` and our first observation is 4.0 h, and none is negative. `scheduled_time` is Pacific. Execution 14562 returned `200 {"results": [], "next": null}`, so it was not a short-circuit.
- **What it was not.** The token is the same `DRSNIP-CHRONO` credential the working catch-up uses. The v75–v80 app secrets are irrelevant, because the sync runs in n8n.
- **Impact.** About 690 consecutive runs (2026-09-20 17:05 → 2026-10-19 14:05) saw 0 appointments while logging `success`. Only the Sunday 8-day reconcile and the per-patient catch-up kept data arriving. The evidence cutoff (the incremental watermark) kept advancing, so the console claimed fresh data.
- **Fix (n8n, live).**
  - `since` is rendered with Luxon in `America/Los_Angeles`. That is never later than intended whether DrChrono reads it as Eastern or Pacific; the worst case is 3 h of extra overlap.
  - Any run not started by the schedule is a 36-hour operator catch-up.
- **Fix (repo).** `toDrChronoStamp` renders Pacific time, with tests.
- **Alarm.** The sweep counts consecutive successful incremental runs with 0 appointments. At **6** it ledgers one `notification_events` row (`channel='sync'`, `kind='sync_zero'`) per streak and shows an ALERT line in the digest. Read-only against production, the query reported the old streak at 200+ runs.

| Run | Seen | Persisted | Transitions |
|---|---:|---:|---:|
| Operator catch-up / backfill, 14:22 (36 h lookback) | 76 | 41 | 281 |
| Scheduled 15:05 | 24 | 21 | 82 |
| Scheduled 16:05 | 37 | 33 | 112 |

**No DrChrono writes.** The workflow's only HTTP node is a GET. The catch-up was triggered through a temporary webhook node on a random path, removed straight after (it now returns 404).

**n8n diff** (`n8n-rollback/jUNJrRWhZkogFhpX_2026-10-19_train4_{pre,post}.json`):
- Only *Sync Config* (catch-up detection, comments) and *Fetch Appointments* (the `since` expression and notes) changed.
- The only other difference is an empty, unused output branch dropped on `Enabled?`.
- versionId `b4cc5ba4…` → `3a873ea0…`.

## Step 2b: DrChrono responses at rest in n8n

The hourly sync requests `verbose=true` (needed for status transitions), which returns `clinical_note`, `vitals` and reminders. *Project Page* strips those before anything reaches Postgres, but **n8n stored every successful execution in full** (`saveDataSuccessExecution: all`), contrary to the design note.

**Change (live):** on both workflows, `saveDataSuccessExecution` `all` → **`none`**, `saveDataErrorExecution` stays **`all`**, and `saveManualExecutions` `true` → **`false`** (so a manual run cannot store them either). The diff is settings only (`n8n-rollback/*_2026-10-19_train4b_retention_{pre,post}.json`). Verified: the 15:40 catch-up ran (`success`) and was **not** stored.

**Stored executions, not purged (Raunek's call):**

| Workflow | Stored | Success / error | Range | Holding DrChrono appointment records |
|---|---:|---|---|---|
| Hourly sync `jUNJrRWhZkogFhpX` (includes the Sunday reconcile) | 337 | 337 / 0 | 2026-10-05 → 2026-10-19 | about 4: reconciles 10-11 and 10-18, the 14:22 catch-up and 15:05 (about 2,550 verbose records) |
| Catch-up `9Wvd36XnnbDdypaf` | 2,014 | 2,008 / 6 | 2026-10-05 → 2026-10-19 | 20 with records (40 appointments); about 317 more with empty responses |

The range is the instance's 14-day execution pruning. The 6 catch-up errors are 3 during the outage (15:10–15:30), 2 on 2026-10-16 (20:50 and 21:00) and 1 on 2026-10-10.

**Other workflows that call DrChrono and store executions (not changed):**

| Workflow | Calls | Success retention | Stored |
|---|---|---|---:|
| Registration v2 `H2HihkGKntbfRNcK` | `/api/patients` (search, PATCH), `/api/documents` | all (CLAUDE.md audit rule) | 302 |
| Consultation v2 `4UicLLZRRMeENXhx` | `/api/patients` (search), `/api/documents` | all (audit rule) | 201 |
| Legacy Jotform `6warkNFZSSzuasMB` | `/api/patients`, `/api/documents` | all | 1 |
| Consultation Intake `xY1NOVVCflSyEme6` (old, active) | `/api/patients`, `/api/documents` | all | 0 |
| Insurance v1 `oLbn4ZWFXu8Lei3I` | `/api/patients`, `/api/documents` | none (errors: all) | 0 |
| Manual backfill / pilot / sizing probe | `/api/appointments` | none | 0 |

The intake workflows' stored executions hold patient-search responses (demographics) alongside the submitted form data. That is a deliberate audit-retention choice, but it is PHI at rest in n8n too.

## Incident: the database outage, 2026-10-19 15:06–15:36 UTC

- **What.** The first production call of `drsnip_conversion_monthly()` (0023 as first written) ran for more than 28 minutes on the **256 MB** DB machine. It held the backend in uninterruptible I/O wait (207 MB usable, 3 MB free, no swap). Fly's checks went critical at 15:06:37, the proxy marked every backend DOWN at 15:07:10, and new connections failed.
- **Postgres did not crash.** There was no "terminated by signal", no "out of memory" and no machine restart; the checkpointer kept PID 708. My session dropped because the machine starved.
- **Why.**
  - The planner assumed the rules function returns 1,000 rows and joined that to every appointment: an estimated 3.4 M rows at a cost of 3,645,896.
  - That is far above `jit_above_cost` (100,000), so PostgreSQL 17 **JIT-compiled 30 functions with LLVM**, which is memory-hungry.
  - The function's own `SET statement_timeout = '20s'` did not stop it, because that clause does not re-arm a statement already running.
  - Local tests could not show any of this: the local build has no JIT (`pg_jit_available() = false`).
- **Recovery.**
  - SIGTERM to the backend at 15:34:17 did not take effect (it was stuck on I/O).
  - **`fly machine restart` at 15:36:23 fixed it: healthy 15:36:44**, first `SELECT 1` at 15:36:52.
  - Memory was then raised to **1024 MB** (`free -m`: 207 → 962 MB). That restarted the DB once more (healthy 15:37:20) and moved the image from postgres-flex **17.2 → 17.7**.
- **Ledger (counts only).**
  - 0 submissions were recorded between 13:59:08 and 15:36:57.
  - Recent weekdays received 0–4 submissions (once 9) in the same 08:06–08:37 PT window, so **0–2 patient submissions may have been lost**. App logs for the window are gone (Fly keeps minutes), so this cannot be settled.
  - The first submission after recovery (`6333479a`) reached `success`.
  - No drop-off rows were written in the window.
  - Three catch-up runs (15:10–15:30) errored in n8n. There are no stuck sync runs or leases.
  - The **app process exited once** (exit code 1, not OOM) at 15:37:03 when the memory update restarted the DB under it. Fly restarted it within 3 s.
- **Fix, shipped in step 3.**
  - `ROWS 1`, rules read once, classification per distinct label, a hash join instead of a correlated `EXISTS`, and `jit = off` on every new function.
  - Production `EXPLAIN` cost: **5,544**. Full run: **727 ms**.
  - On a production-shaped local fixture (4,106 submissions, 3,580 appointments, 2,727 windows, 13,764 transitions): about 120 ms, peak 21 MB resident.
  - **Every console report query now runs with `SET LOCAL statement_timeout = '5s'` and `jit = off`** (`api/_lib/report-query.ts`). A test fails if any handler queries outside it.
  - Every production query I ran after the incident started with a 5 s timeout.

## Step 3: status rules

`outcome_status_rules` v2 is `approved`, with provenance (Jeffrey Cho, video call, 2026-09-21); v1 is `superseded`. The unit test asserts all twelve of the client's statuses, plus every DrChrono label variant.

**Before and after (production, registration, distinct patients of the covered cohort):**

| Entry month | Before (v1: completed + scheduled) | After (v2: converted) |
|---|---|---|
| June 2026 | 155 completed + scheduled withheld (≤4), of 245 | **166 (67.8%)** |
| July 2026 | 353 (340 + 13), of 571 (61.8%) | **383 (67.1%)** |
| August 2026 | 358 (309 + 49), of 621 (57.6%) | **392 (63.1%)** |

Insurance, August: 10 → 11 of 29.

**Unclassified statuses (never counted as converted):**

| Status | Appointments | Patients |
|---|---:|---:|
| (blank) | 891 | 859 |
| Arrived | 1 | 1 |
| In Room | 1 | 1 |
| Checked In Online, MD In, MD Out | seen only in transition history | n/a |

The blank status is the one that matters. It sits on 859 patients' appointments; a patient with only blank-status appointments is "Unclassified only" (0–2 patients per month at present).

## Step 4: conversion by cohort

`/admin/conversion`. Registration / Insurance and Month / Week toggles; Forms; Converted as of today (count and %); P+0, P+1, P+2, P+3, Later. Unended periods are blank. It is two taps on mobile (Reports, then Conversion by cohort).

- **Gate (production):** the July 2026 registration cohort is 571 patients. Converted as of today is **383 in both views**. Fill: P+0 325 (56.9%), P+1 368 (64.4%), P+2 379 (66.4%); P+3 is blank (October has not ended).
- **Speed:** every form × grain query takes 335–381 ms (the target was under 2 s), so no materialised view is needed.
- **Screenshots** (aggregate only, no names): `scratchpad/train4-screenshots/` (signed in as the read-only viewer on v97):
- `conversion-registration-month-1440.png`
- `conversion-registration-week-1440.png`
- `conversion-insurance-month-1440.png`
- `conversion-registration-month-390.png`
- `outcomes-registration-1440.png`

## Step 5: digest

The subject is `DrSnip intake sweep: …` (a colon). Test identities are excluded from every count. Patientmail is off (`PATIENTMAIL_ENABLED=false`, staged with the deploy) and its skips are not counted as problems. Read-only against production before the deploy: Stuck 1 (`8faf35fc`), Failed 0, manual review 255 (was 260), problems 0. **First digest after the deploy:** 17:00:25 UTC, sent (Digest Notify execution 14595):
- subject `DrSnip intake sweep: 1 stuck, 0 failed 24h`;
- Stuck 1 (`8faf35fc`), Failed 0;
- manual review 257 open (test rows excluded), 3 added in 24 h;
- **notification skips/errors: 0**;
- "Appointment sync: ok, 0 empty runs in a row, latest run saw 37".

**Gate passed.**

## Step 6: deploy and live checks

**One deploy**, `fly deploy --remote-only` from a pristine checkout of `main` `dbd2d24`, giving release **v97**.
- The image build ran `assert-conversion-bundle.mjs`: "compiled ON".
- The release command (migrate plus seed-viewer) succeeded.
- `PATIENTMAIL_ENABLED=false` went in with this deploy (staged beforehand, not a separate release).
- `fly config show`: `kill_timeout = "45s"`, `min_machines_running = 1`, `build.args.VITE_CONVERSION_TRACKING_ENABLED = "true"`.

**Form pages, by curl.** `/`, `/consultation` and `/insurance` all serve `index-C-GfiKRQ.js`. It is **byte-identical** to the local build of `main` (sha256 `24eea9d8…`). It contains the `drsnip-conversion-build:enabled` literal, guard `return!0`, `setAttribute("data-drsnip-conversion", …)`, and `drsnip:ready` ×3.

**Console, signed in as the app's read-only viewer** (the password went to a 0600 file, was never printed, and was deleted). All 31 checks passed:

| Check | Result |
|---|---|
| Login | 200 |
| `/api/reports/outcomes`, `/api/reports/conversion-cohorts` (month and week) | 200. Cohorts 358–376 ms; a bad grain gives 400 |
| Cohort "converted as of today" = Monthly outcomes "converted", every published month, both forms | ✓ (June 166 = 166, July 383 = 383, and so on) |
| No patient identifier fields in reporting responses | ✓ |
| Reports index lists Conversion by cohort | ✓ |
| Monthly outcomes, Patient journeys, the three cohort views, the redesign shell | render |
| A cohort table cell equals the API | ✓ |
| No horizontal overflow | 1440 / 820 / 390 |
| Phone: Reports → Conversion by cohort | two taps |
| Page errors | none |

**Data currency:** the cohort view reads "Appointment data complete to Oct 19, 2026, 9:05 AM" Pacific, which is the 16:05 UTC hourly sync.

**Rollback:** `fly deploy -a drsnip-intake-demo --image registry.fly.io/drsnip-intake-demo:deployment-01M3M8MPPYFS4YR0H3E53SCHB5` (v96). Its functions and the v1 rules row are still installed. Never roll back to v75–v92.

## Deferred (not touched)

- **Train 1b:** `Sheets: ManualReview` still runs before Respond, with bare `$json` refs, in both v2 workflows.
- **Train 1c:** Insurance v1 is still `saveDataSuccessExecution: none`.
- **The manual-review investigation:** the backlog is 255 non-test rows; the consultation rate is 18.5% since Sep 24.
- **The Journeys period bug:** the hard-coded periods end at "September 2026", which runs to today. The sync fix does not resolve it.
- **The legacy Jotform workflow:** an inline API key in `Download File`, and no `errorWorkflow`.
- **Test-data cleanup:** charts 135620405 and 135966665, 15 Qaignore rows, and the ManualReview tab rows.
- **`8faf35fc`:** stuck since 2026-09-14.
- **New, found this train:**
  - Stored DrChrono timestamps are Eastern/Pacific wall-clock values labelled UTC. The older Journeys/booking metrics compare them directly, so they are off by hours. The new conversion SQL corrects `created_at`.
  - The app process exits when its DB connection drops (unhandled pool error at 15:37:03).
  - The purge of the stored sync executions above awaits Raunek.
