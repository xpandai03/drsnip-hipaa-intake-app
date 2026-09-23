# Monthly outcomes — release report

**Released:** 23 September 2026, 17:15 UTC.
**Status: LIVE and verified**, signed in, in production.

| | |
| --- | --- |
| Live URL | **https://drsnip-intake-demo.fly.dev/admin/outcomes** (Reports → Monthly outcomes) |
| Released commit | **`bdab3bf`**, on `feat/console-redesign-insurance-demo` |
| PR | **#55**, open and not merged. Its head is `bdab3bf`, and its description has a Monthly outcomes section (scope, migration order, tests, rollback) |
| Fly release | **v88**, image `drsnip-intake-demo:deployment-01M37M55X1HM7TBC7J0K0YBGN1`. Both machines are on v88, and the health check passes |
| Rollback point | **v87**, image `drsnip-intake-demo:deployment-01M32WDYQDKFCETEMB1C692D3V` (code `09119d6`). Not used |
| Migration | `0021_monthly_patient_outcomes.sql`, applied by hand before the deploy (§3) |

Commits released on top of `c2cc4c5`:

- `78b0dbd`: the calculation, the API, and the 400-not-500 fix;
- `ccb34ca`: the dashboard;
- `af03150`: the supporting docs;
- `332c5b9`: this report's first version;
- **`bdab3bf`: No Show left unclassified (§1).**

This report's own evidence update is a later, docs-only commit.

**Publication history.** The first push attempt was refused by the
environment's permission guard ("Out-of-Place Publication"). Nothing was
bypassed, and nothing reached production while the push was refused. The
release went ahead after explicit user authorisation for this repository and
branch. The push was a fast-forward, `c2cc4c5..bdab3bf`, and the remote was
verified to match the local commit.

No patient identifiers, appointment identifiers, notes or payloads appear in
this report or in its screenshots.

---

## 1. Definition change made before release: No Show

The v1 status rules had placed **No Show** in `ended_not_active`. That was an
engineering inference, and **it changed classification**. A patient whose only
included appointment was a past No Show was placed in *Neither established*
when the evidence supports only *Unknown*. Jeff named No Show without defining
it (T:66).

- **Change (`bdab3bf`):** No Show is removed from every status class. It
  establishes nothing, so such a patient is **Unknown** (status unresolved).
  0021 had not been applied anywhere, so the v1 seed itself was corrected.
- **It never erases positive evidence.** A regression test puts No Show beside
  a later completion (stays **Completed**) and beside a future booking (stays
  **Scheduled**). The March hand counts moved exactly as expected: the six
  no-show patients went from Neither to Unknown.
- **In production:** July registrations show Unknown 14 and Neither 209,
  against 5 and 218 under the inference. Nine patients are no longer counted as
  a negative on an undefined status.
- The page describes No Show as "not yet defined by the clinic". The scope stays
  **provisional**, and nothing is approved.

---

## 2. What was released

- **Reports → Monthly outcomes** (`/admin/outcomes`): first in the Reports
  group and first on the Reports index. Patient journeys is unchanged.
- **For each entry month** (Registration or Insurance inquiry, whole clinic
  months, URL-held state), newest first, the page shows:
  - patients counted;
  - **Completed** / **Currently scheduled** / **Unknown** / **Neither
    established**;
  - how long the cohort has been observed;
  - coverage notes.
- **Around the table:**
  - "Data complete to …";
  - the provisional-scope banner;
  - "What is included?" (appointment types by role, read from the API);
  - per-month details.
- **Deliberately absent:** a rate, a percentage, a combined total, or a
  follow-up window.
- **Suppression holds through the presentation.** A withheld value renders
  "Withheld", and a bar is drawn only when all four outcomes were published.
- **SQLSTATE 22023 now returns 400, not 500,** on booking, journey, attendance,
  the attendance preview and outcomes. This was verified live: a pre-2026
  booking period returns **400**.

---

## 3. Migration (production)

1. **Before.** v87 was live and confirmed, the rollback image recorded, and 0021
   absent (0 tables, 0 functions).
2. **Uploaded from the pushed commit.** The file was taken with `git show
   bdab3bf:…`, and its SHA-256 was identical locally and on the DB machine
   (`f4fc73d2…`).
3. **Applied** as the operator with `ON_ERROR_STOP=1`: `EXIT=0`, with NOTICE
   *"monthly outcome objects installed; no scope approved"*. The uploaded file
   was removed afterwards.
4. **Verified, read-only:**
   - **The 11 existing reporting and sync functions are byte-identical** before
     and after (md5 of `pg_get_functiondef`).
   - The three new tables are owned by `drsnip_intake_demo`.
   - The three new functions are owned by `drsnip_metrics_fn`, all `SECURITY
     DEFINER`.
   - PUBLIC can execute none of them.
   - `drsnip_reporting_ro` can execute the metric and definition functions;
     **calling the classifier as that role returns "permission denied"**.
   - The app role can execute the classifier only because it is a superuser in
     production, which the migration's self-check anticipates.
   - **1 scope (provisional), 0 approved scopes, 0 approved status rules,**
     15 names, attendance mappings still 0.
   - `ended_not_active` is `["Cancelled", "Late Cancel within 48 hrs"]`.
   - The published function, called as the reporting role, returned suppressed
     aggregates for both cohorts.

This had been rehearsed beforehand on a schema-only copy of production: applied
twice, same results.

---

## 4. Deploy

- The deploy was built from a **pristine worktree of `bdab3bf`** (0 local
  changes), with plain `fly deploy -a drsnip-intake-demo`.
- **No build arguments.** Conversion tracking stays off, as it is live (the v87
  bundle compiled it to `return !1`).
- The Fly build ran typecheck and the full build. Rolling deploy; both machines
  reached a good state.
- One health check failed at 17:15:45, one second after the new machine
  started, and then passed. The machine has reported healthy since.

---

## 5. Authenticated production verification

The check signed in as the application's own provisioned read-only account
(`viewer@drsnip.com`), through the real sign-in page. The password went from
the app's environment into a private 0600 file, was never printed, and was
deleted afterwards. **35 of 35 checks passed:**

| Check | Result |
| --- | --- |
| API without a session | 401 |
| Login | works |
| Reports → Monthly outcomes | opens; the sidebar entry is present; the URL carries `cohort=registration&from=2026-06&to=2026-09` |
| Provisional scope, data cutoff | shown ("Data complete to Sep 23, 2026, 10:10 AM", Pacific) |
| Registration | real aggregates; **every displayed cell equals the API** (4 months); 2 withheld cells render "Withheld" |
| Insurance | real aggregates; every cell equals the API (4 months); 3 withheld cells render "Withheld" |
| Chart geometry | **no bar on any month with a withheld outcome** (June registration and September insurance show "Breakdown withheld") |
| Back, month selection, reload | Back returns to the previous cohort; the selected range survives reload with an identical URL |
| What is included? | the three included types by name, from the API; No Show described as not yet defined |
| Forbidden content | no `%` anywhere, no "conversion" wording |
| Layout | no page overflow and nothing clipped at 1024, 820 and 390 |
| Network | 9 outcomes responses: **no patient or appointment identifier fields**, and the only 6+-digit numbers are appointment-type IDs; no `rate` field |
| Existing reporting | Journeys, Reports, Intake dashboard, Submissions and the insurance demo render; `/booking`, `/journey`, `/freshness` and `/attendance` return 200 |
| Regression fix | a pre-2026 booking period returns **400** (was 500) |
| Page errors | none |

### 5.1 Reconciliation at one instant

- The live API and an **independently written query** (not the shipped
  calculation) were read at the same evidence cutoff, **2026-09-23 17:10:38
  UTC**.
- **All 27 published cells match exactly**, across both cohorts and every
  month.
- The shipped classifier text and the independent query also agree on **23 of
  23 cells**, including the withheld ones, which were compared privately and
  never displayed.

### 5.2 What production shows (as at 17:10 UTC)

This is the provisional scope. It is **not** a conversion rate. Withheld cells
are shown as "—".

| Registration entry month | Patients counted | Completed | Currently scheduled | Unknown | Neither established |
| --- | --: | --: | --: | --: | --: |
| September (open) | 476 | 50 | 122 | 20 | 284 |
| August | 621 | 228 | 126 | 30 | 237 |
| July | 571 | 321 | 27 | 14 | 209 |
| June | 245 | 147 | — | — | 89 |

| Insurance entry month | Patients counted | Completed | Currently scheduled | Unknown | Neither established |
| --- | --: | --: | --: | --: | --: |
| September (open) | 53 | — | — | — | 46 |
| August | 29 | 5 | 5 | 0 | 19 |

### 5.3 Health

- **Appointment sync is healthy.** Both schedules are enabled and recurring.
  The last runs succeeded at 17:05 (hourly incremental) and 17:10 (catch-up),
  and both are idle.
- **No new application errors.** The only log lines matching "error" or
  "failed" are the hourly sweep's routine info lines (`failed_24h:0`), plus the
  one boot-time health check above. No reporting route has logged a query
  failure since the deploy.

Screenshots of aggregate views only are in `prod-v88-screenshots/`. Screenshots
from the local synthetic-data run are in `outcomes-screenshots-local/`.

---

## 6. Tests

- **Full suite: 670 tests, 645 pass, 0 fail, 25 skipped.** The skips are
  pre-existing, not passes: the attendance calculation suites need a synthetic
  fixture that was never committed.
- **Focused suites after the No Show change:** `monthly-outcomes` and
  `outcomes-view`, 63 of 63 passed, all live.
- Typecheck and build are clean.
- The earlier local end-to-end run (59 of 59) and the clean-worktree build and
  test run are described in `DRSNIP_MONTHLY_OUTCOMES_CALCULATION.md` and the
  previous version of this report.

---

## 7. Privacy and coverage limitations

- **Aggregate only.** Small groups (1–4) are withheld inside the database with
  complementary suppression, and the page never derives a hidden value. Months
  are whole clinic months, so date ranges cannot be subtracted to isolate a day.
- **Residual risk:** the open month grows daily, so consecutive-day views differ
  by that day's entrants. The same is true of every live report, and console
  users can already see submission rows.
- **Unit and coverage:**
  - Counts are **linked patient charts**; one person with two charts counts
    twice.
  - Unlinked submissions are shown separately, as submissions.
  - Intake history starts 15 June 2026 (insurance 12 August 2026).
  - Recent months have been observed for less time, and each row says for how
    long.
- **Two "complete to" times on the page.** The header badge (the existing
  freshness component) reads the hourly cursor, 10:05. The table's cutoff also
  counts the 10-minute per-patient catch-up reads, 10:10. Both are correct. If
  it confuses anyone, the badge could adopt the table's rule; that was not done
  in this release.

---

## 8. Remaining clinic decisions (all provisional; nothing approved)

1. Does a completed **Consultation Only** appointment count? This is the
   biggest lever.
2. Does **Procedure Not Performed** count? It is not counted, and is shown
   separately.
3. Does **Signed No Review** qualify for the business measure? Its meaning,
   "completed", is settled.
4. **No Show:** what does the clinic mean by it? Until it is defined, it is
   **unclassified**, and those patients are Unknown.
5. The six undecided types: Repeat DrSnip, Repeat Outside Provider, Prior
   Reversal Vasectomy, Partial Vasectomy with Consultation, Home Visit, Special
   Accomodations.
6. Are past-dated Scheduled/Confirmed appointments reliably updated by staff?
7. Should returning patients, and already-registered insurance inquirers, stay
   in their month's cohort? Both are kept today, and counted.

---

## 9. Rollback

```sh
fly deploy -a drsnip-intake-demo --image drsnip-intake-demo:deployment-01M32WDYQDKFCETEMB1C692D3V
```

v87 does not reference any 0021 object, and 0021 altered nothing v87 uses.
**Leave 0021's tables and functions in place. Do not drop populated tables.**

---

## 10. Loom walkthrough (three minutes)

1. **(0:00)** Reports → **Monthly outcomes**: "your question, month by month".
2. **(0:20)** The banner: the definition is provisional, and Completed and
   Scheduled are never added together.
3. **(0:40)** **July**: 571 registrations counted, 321 completed, 27 still
   scheduled, 14 unknown, 209 neither. Each patient is counted once. Point out
   "observed 53–84 days" against September being "still open".
4. **(1:20)** Switch to **Insurance inquiry**, then back. Change the months.
   Copy the link: it opens the same view.
5. **(1:50)** **June**: two "Withheld" cells and no bar. Small groups are
   protected.
6. **(2:10)** **What is included?**: the three procedure types count.
   Consultation Only is shown for comparison. PVST and lab records never count.
   No Show is not yet defined.
7. **(2:40)** Ask Jeff: does Consultation Only count, and what does No Show
   mean to the clinic?
