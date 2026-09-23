# Monthly outcomes — release report

**Date:** 23 September 2026

**Status: NOT RELEASED.** The view is built, committed and verified end to end
locally, but **publication was blocked**:

- The environment's permission guard refused `git push origin
  feat/console-redesign-insurance-demo`, with the reason **"Out-of-Place
  Publication"**.
- The repository rule is that deployed code must be on a branch and in a PR
  before the deploy (`CLAUDE.md`). So the production migration and the Fly
  deploy were **deliberately not performed**, and nothing was bypassed.
- Production is unchanged: Fly **v87**, no 0021 objects, and
  `/api/reports/outcomes` returns 404 there. This was re-checked after the
  block.

§6 is the exact runbook to finish the release once the push is allowed. Every
step before the push is already done.

| | |
| --- | --- |
| Branch | `feat/console-redesign-insurance-demo` (PR #55, OPEN, base `main`, not merged) |
| Local commits, **not pushed** | `78b0dbd` calculation + API + 400 fix · `ccb34ca` dashboard · `af03150` docs (this report is committed after them) |
| Remote head (PR #55) | `c2cc4c5`, unchanged |
| Live release | **v87**, image `drsnip-intake-demo:deployment-01M32WDYQDKFCETEMB1C692D3V` (code `09119d6`) |
| Rollback point, recorded | the same v87 image, so no rollback is needed while nothing is deployed |
| Live URL, once released | `https://drsnip-intake-demo.fly.dev/admin/outcomes` (Reports → Monthly outcomes) |

---

## 1. What changed, and why

Jeff asked: *"For patients who registered or submitted an insurance inquiry in
a selected month, how many have completed an appointment or still have one
scheduled?"* The existing Patient journeys page answers a different question:
how fast an appointment record appeared within 7, 14 or 30 days.

### 1.1 The view: Reports → Monthly outcomes (`/admin/outcomes`)

- **Placement.** It is first in the Reports navigation group and first on the
  Reports index. Patient journeys keeps its route, second in the group.
- **Controls:**
  - Registration / Insurance inquiry.
  - An entry-month range, in whole clinic months, at most 13 per request.
  - **No follow-up window.**
- **URL state.** The state lives in the address (`?cohort=&from=&to=`). A first
  visit writes its defaults, so the link is shareable at once. Reload keeps the
  view, and Back steps through changes.
- **Table first.** One row per entry month, newest first, with these columns:
  - Patients counted;
  - Completed;
  - Currently scheduled;
  - Unknown;
  - Neither established;
  - Breakdown;
  - Observed.

  Under each "Patients counted" figure: how many are still awaiting their first
  history read, and how many submissions have no patient link.
- **Around the table:**
  - **"Data complete to …"** (Pacific), plus a stale-data warning after three
    hours.
  - The provisional-definition banner above everything it qualifies.
  - The plain-English column meanings, placed below the figures.
  - Month details: the Neither split, the Unknown reasons and the overlapping
    annotations.
  - **"What is included?"**, which lists every appointment type by role. The
    names come from the API.
- **Layout.** The table shows at 1024px and wider. Below that, each month is a
  card with the same values.
- **The page calculates nothing.** Every number, label, type name and
  explanation comes from `/api/reports/outcomes`.

### 1.2 Backend (built in the previous step, released together)

- **Migration 0021:**
  - the 15 appointment-type names, recorded as dated UI metadata;
  - status rules v1 (provisional);
  - scope "Selected procedure appointment types — provisional";
  - a patient-level classifier that nobody can execute, and a published
    monthly function that suppresses small groups inside the database.

  See `DRSNIP_MONTHLY_OUTCOMES_CALCULATION.md`.
- **`GET /api/reports/outcomes`.** The response now also carries plain-English
  bucket meanings, role labels and status explanations, so the page holds no
  definitions of its own.

### 1.3 Narrow fix, inside the release

A parameter the database refuses (SQLSTATE `22023`) now returns **400, not
500** on five routes:

- `/api/reports/booking`
- `/api/reports/journey`
- `/api/reports/attendance`
- the attendance preview
- `/api/reports/outcomes`

The cause was confirmed over real HTTP: Drizzle wraps the driver error, and the
routes read only `err.code`. The shared `sqlState()` also reads `cause.code`.
Only the error branch changed, and valid calculations are identical.

Regression tests cover the helper on wrapped and unwrapped errors, and each of
the five routes.

### 1.4 Wording (matched to the calculation)

- **Completed:** completion recorded for an included appointment type (Complete
  or Signed No Review). It is an appointment, not proof a procedure was
  performed.
- **Currently scheduled:** an included appointment is booked for after the data
  cutoff, and no qualifying completion is recorded.
- **Unknown:** missing or ambiguous evidence prevents classification.
- **Neither established:** neither a qualifying completion nor a current
  booking is established from the available evidence. The page states that
  this *does not mean the patient was lost, did not attend, or should be
  contacted*.
- **Signed No Review:** described as the clinic described it, "the appointment
  was completed and a review request was withheld". What remains open is only
  whether it qualifies for the business measure.

---

## 2. Suppression, through the whole presentation

- **The API response is the rendering contract.** A withheld value arrives as
  `null` and renders **"Withheld"**, with a reason for screen readers. It is
  never shown as 0 or left blank.
- **Bars.** A proportion bar is drawn **only** when all four outcomes were
  published *and* they add up to the published cohort. Otherwise the row shows
  **"Breakdown withheld"**. There is no renormalising, no remainder segment, and
  no bar tooltip; the bar is `aria-hidden` and the numbers are in the table.
- **Month details.** When a partition cell is withheld, the whole details
  section says it is withheld, mirroring the server rule.
- **Nothing derived.** There is no rate, percentage, combined
  completed-plus-scheduled total, export or client-side derivation. Tests pin
  this in the source, and a browser check scans the rendered text.
- **Unknown and withheld are visually distinct.** Unknown is a number (and amber
  in the bar); withheld is a dashed "Withheld" chip with no colour.

---

## 3. Verification

### 3.1 Tests, typecheck and build

**669 tests, 644 pass, 0 fail, 25 skipped.**

- This was run twice: in the working tree, and again from a **pristine
  worktree of the committed HEAD** (`af03150`), with a clean install, full
  build and every DB suite live against disposable Postgres databases.
- **The 25 skips are pre-existing and are not passes.** The attendance
  calculation suites need a synthetic fixture an earlier agent built by hand and
  never committed. They were skipped identically before this work.
- The new and changed tests are:
  - `monthly-outcomes.test.ts`, 40 tests, including the 22023 regression tests;
  - `outcomes-view.test.ts`, 22 tests (URL state, month limits, withheld cells,
    bar rule, notices, grouping, staleness, and the page's source contract);
  - `admin-nav.test.ts`, updated on purpose: 11 destinations, with Monthly
    outcomes first and Patient journeys second.
- `pnpm run typecheck` and `pnpm run build` are clean. The server bundle
  contains the route.

### 3.2 The real frontend → authenticated API → database, locally

The Vite build was served by the real API server, which connected as a
**non-superuser** app role (stricter than production), over a synthetic fixture
built to hit every display state. A synthetic viewer signed in through the real
`/api/auth/login`, and headless Chromium drove it. **59 of 59 checks passed:**

| Area | Checked |
| --- | --- |
| Access | API 401 without a session; the page redirects to sign-in; a viewer signs in and reads |
| Findability | first card on Reports; sidebar link; the card opens the view; defaults written to the URL |
| Content | provisional banner; "Data complete to…"; newest month first; values equal the API |
| Suppression | withheld cells read "Withheld"; no bar and "Breakdown withheld" on a withheld month; withheld unlinked count stated in words; month details withheld; reasons explained; `null` in the network response too |
| Coverage | "a few awaiting their first history read" on partial coverage; "No entries this month" distinct from "begins after the data cutoff" and "Too few patients" |
| Scope | the three included types by name; Consultation Only as comparison; PVST/lab as not counted; Signed No Review explained as completed |
| Forbidden | no `%`, no "conversion", no lost/outreach wording, no follow-up window control |
| State | cohort switch; Back; reload keeps the range; `to` before `from` repairs the range; empty range explained |
| States | loading skeleton; error with retry that recovers; stale warning |
| Keyboard | Tab reaches the cohort control with a visible focus ring; Enter activates it |
| Layout | no page overflow and **nothing clipped** at 1440, 1024, 820 and 390 |
| Privacy | no patient or appointment ID in any outcomes response; no `rate` field |
| Regressions | Patient journeys, Reports, the insurance demo and the Intake dashboard all render; no page errors |

The browser run caught three real defects, all fixed before commit:

- the URL did not carry the default state on first visit;
- the observation label read "54 days–84 days";
- **at 820px the table was clipped beside the sidebar.** The table now appears
  only from 1024px, and a clipping check was added.

Screenshots of the synthetic run are in `outcomes-screenshots-local/`.

### 3.3 Migration rehearsal on production's real schema

- A **schema-only** `pg_dump` of production was taken (2,427 lines, 22 tables,
  **zero data statements**) and restored locally with production's four roles.
  The restored functions matched production's fingerprints exactly.
- 0021 was then applied **twice**. Both runs succeeded, with the self-check
  reporting "no scope approved".
- The 11 existing functions were **byte-identical** before and after.
- New tables are owned by `drsnip_intake_demo`.
- The three new functions are owned by `drsnip_metrics_fn` and are `SECURITY
  DEFINER`.
- The classifier is executable by PUBLIC: no, and by `drsnip_reporting_ro`: no.
  The metric and definition functions are executable by `drsnip_reporting_ro`:
  yes.
- 1 scope, 0 approved scopes, 0 approved rules, 15 names.
- **Compatibility:**
  - v87 references none of 0021's objects, and 0021 alters nothing v87 uses.
  - The new build needs 0021 only for `/api/reports/outcomes`; without it, that
    one route fails and nothing else does.
  - **Order: migration first, then deploy.**
- **It cannot seed an approval:**
  - both seeds are `provisional` and insert-if-absent;
  - an `approved` row is refused by a CHECK without full provenance;
  - one live scope version per key is enforced by an index.
- Postgres is 16 locally and 17 in production; only the 17-only `SET
  transaction_timeout` line was dropped from the dump.

### 3.4 Reconciliation

- The calculation was reconciled read-only against production in the previous
  step, at a fixed cutoff (2026-09-23 16:05 UTC). The shipped classifier text
  and an independently written query agreed on **24 of 24 cells**.
- In this step the page was checked to show exactly the API's values (§3.2).
- **Still to do after deploy:** compare the live page with that independent
  query at one instant (§6, step 7). July's earlier figures are an example only,
  not an expected value; production data moves.

---

## 4. Privacy and coverage limitations

- **Aggregate only.** No patient identifiers, drill-downs or outreach actions.
  Small groups (1–4) are withheld inside the database, with complementary
  suppression.
- **Residual risk, stated once:** the current month grows daily, so views taken
  on consecutive days differ by that day's entrants. The same is true of every
  live report here, and console users can already see submission rows. Whole
  months only removes the day-range differencing lever.
- **Unit and coverage:**
  - Counts are **linked patient charts**. One person with two charts counts
    twice.
  - Submissions with no patient link cannot be followed and are shown as a
    separate **submissions** count.
  - Intake history starts **15 June 2026** (insurance **12 August 2026**), so
    there is no year-over-year comparison yet.
  - Recent months have been observed for less time, and each row says for how
    long.
- **As-of:** "Currently scheduled" is judged against the evidence cutoff, not
  the clock. The page shows that instant.

---

## 5. Remaining clinic decisions

The definition is provisional. None of these was approved or assumed.

1. Does a completed **Consultation Only** appointment count? This is the
   biggest lever, about 15 patients a month in July and August.
2. Does **Procedure Not Performed** count? It is not counted today, and is
   shown separately.
3. Does **Signed No Review** qualify for the business measure? Its meaning,
   "completed", is settled.
4. The six undecided types: Repeat DrSnip, Repeat Outside Provider, Prior
   Reversal Vasectomy, Partial Vasectomy with Consultation, Home Visit, Special
   Accomodations.
5. Are past-dated Scheduled/Confirmed appointments reliably updated by staff?
6. Does **No Show** mean "did not come"? It is treated that way by inference.
7. Keep returning patients, and already-registered insurance inquirers, in
   their month's cohort? Both are kept today, and counted.

---

## 6. Runbook to finish the release (after the push is permitted)

```sh
# 1. Publish the reviewed commits to the existing PR (no new PR)
git push origin feat/console-redesign-insurance-demo          # the step the guard refused
gh pr edit 55 --body-file <updated body>                      # add the Monthly outcomes section

# 2. Rollback point (already recorded): v87, image
#    drsnip-intake-demo:deployment-01M32WDYQDKFCETEMB1C692D3V

# 3. Migration, as the operator, BEFORE the deploy (additive, idempotent, rehearsed)
fly ssh console -a drsnip-intake-db -C "sh -c 'cat > /tmp/0021.sql'" < Intake-form/lib/db/migrations/0021_monthly_patient_outcomes.sql
fly ssh console -a drsnip-intake-db -C "sh -c 'PGPASSWORD=\$OPERATOR_PASSWORD psql -h 127.0.0.1 -U postgres -d drsnip_intake_demo -v ON_ERROR_STOP=1 -f /tmp/0021.sql'"
#    expect NOTICE "monthly outcome objects installed; no scope approved";
#    then re-run the §3.3 ownership/grant/approval queries read-only.

# 4. Deploy the PUSHED commit from a pristine worktree (no conversion-tracking build arg: live has it off)
git worktree add /tmp/rel <pushed sha> && cd /tmp/rel/Intake-form && fly deploy -a drsnip-intake-demo

# 5. Verify, signed in with an existing account: Reports -> Monthly outcomes; both cohorts;
#    provisional banner and data cutoff; withheld cells null in the network response and
#    "Withheld" on screen; /booking /journey /freshness /attendance 200; login; no new errors;
#    appointment sync healthy (fly logs, drsnip_sync_health()).

# 6. Rollback if a critical regression appears: redeploy the v87 image. Leave 0021's tables in place
#    (v87 ignores them; do NOT drop populated tables).
fly deploy -a drsnip-intake-demo --image drsnip-intake-demo:deployment-01M32WDYQDKFCETEMB1C692D3V

# 7. Reconcile the live page against the independent query at one instant (recon.py, read-only).
```

---

## 7. Loom walkthrough (three minutes, once live)

1. **(0:00)** Reports → **Monthly outcomes**: "This answers your question, month
   by month."
2. **(0:20)** The banner: the definition is provisional, and Completed and
   Scheduled are never added together.
3. **(0:40)** June's row: completed, still scheduled, unknown, neither. Each
   patient is counted once. Point at "observed 84–114 days" against September
   being "still open".
4. **(1:20)** Switch to **Insurance inquiry**, then back. Change the months.
   Copy the link: it opens the same view.
5. **(1:50)** A **Withheld** cell: small groups are protected, so there is no
   bar for that month.
6. **(2:10)** **What is included?**: Consultation with Vasectomy, Auction Winner
   and Vasectomy Only count. Consultation Only is shown for comparison, and PVST
   and lab records never count.
7. **(2:40)** Ask Jeff the two questions that move the numbers: does
   Consultation Only count, and do Procedure Not Performed or Signed No Review
   count?

---

## 8. Answers

1. **Is it live, and where do I click?** **No.** The push to PR #55 was refused
   by the environment's permission guard ("Out-of-Place Publication"). Under the
   PR-before-deploy rule, that means no migration and no deploy were performed,
   and production is still v87. Once the push is permitted, the §6 runbook
   finishes the release. The view will then be at **Reports → Monthly outcomes**,
   `https://drsnip-intake-demo.fly.dev/admin/outcomes`.
2. **What question does it answer?** For patients who first registered, or sent
   an insurance inquiry, in each month: how many have **completed** an included
   appointment, and how many **still have one scheduled**, as at the latest
   appointment data. Unknown and Neither established are shown alongside, never
   hidden, and never called lost.
3. **What remains provisional?** The whole reporting definition: which
   appointment types count, and whether Consultation Only, Procedure Not
   Performed and Signed No Review qualify. No Show is treated as ended by
   inference, and there is the returning-patient rule. Nothing is approved, and
   there is deliberately no combined figure or rate until it is.
4. **What to show Jeff in a three-minute Loom?** §7: the June row and what each
   column means, the cohort switch and a shareable link, one Withheld cell,
   "What is included?", and then the Consultation Only and Signed No Review
   questions. Record it after the release, or on a local run if he needs it
   sooner, clearly labelled as synthetic data.
