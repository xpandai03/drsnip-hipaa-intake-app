# Reporting clarity release: one appointment-data cutoff

**Released:** 23 September 2026, 21:28 UTC.
**Status: LIVE**, verified signed in, in production.

| | |
| --- | --- |
| Live URLs | https://drsnip-intake-demo.fly.dev/admin/outcomes (lead page) · https://drsnip-intake-demo.fly.dev/admin/journeys |
| Released commit | **`b74dc53`** on `feat/console-redesign-insurance-demo`, deployed from a pristine worktree with 0 local changes |
| Commits | `9506fa1` cutoff fix (migration 0022, routes, tests) · `d210308` UI · `b74dc53` audit and doc corrections |
| PR | **#55**, OPEN, not merged. Head `b74dc53`; its description has a "Reporting clarity" section (defect, UI, migration order, tests, rollback) |
| Fly release | **v89**, image `drsnip-intake-demo:deployment-01M382KAC4EE4B76CVFY5A06QV` |
| Rollback point | **v88**, image `drsnip-intake-demo:deployment-01M37M55X1HM7TBC7J0K0YBGN1`. Not used (§7) |
| Migration | `0022_one_evidence_cutoff.sql`, applied by hand **before** the deploy |

No patient identifiers, appointment identifiers, notes or payloads appear in
this report or its screenshots.

> **Read §6 before the Loom.** During verification the production **database
> VM (256 MB, one shared CPU) was starved under reporting load**, and the app
> crashed twice when dropped connections hit a Postgres pool that has no error
> handler. Both machines restarted within about 5 seconds. Neither cause was
> introduced by this release, and a rollback would not change either. Both are
> the main risk to a smooth live demo.

---

## 1. The cutoff correction

**Defect** (`DRSNIP_REPORTING_MEANING_AND_ACCURACY_AUDIT.md` §3). Booking,
attendance and monthly outcomes all took their cutoff as
`greatest(max(patient-history completed_at), watermark)`. That applied one
patient's catch-up read to everyone. In production it overstated completeness
by a median of 36 minutes, about a third of the time, and it would have hidden
a stalled hourly sync.

**Fix: migration 0022 adds `drsnip_evidence_cutoff()` → `(cutoff, basis)`.**

1. The `practice_incremental` **watermark** is used when present. It advances
   only on a complete, successful incremental run; catch-ups never move it.
2. If there is no watermark, the **earliest** completed history read is used.
   With no incremental sync, each covered patient is complete only to their own
   read, so the minimum is the one instant true for all of them.
3. Otherwise the cutoff is `unavailable`. Outcome rows report `unavailable`
   with no counts, booking reports `unavailable`, and attendance evidence is
   NULL. Nothing is invented.

**Where it applies.** Freshness (the badge), booking, attendance evidence, the
outcome classifier and the outcome metric all call it. Their bodies are the
production definitions with **only the cutoff lines replaced**. Signatures,
owners and grants are unchanged. Definitions, scope, status rules and approvals
were not touched.

**Known limitation, stated in the migration.** Snapshots hold each record's
*current* state, so a patient read after the watermark may already carry newer
changes that cannot be rewound. The page therefore says "complete to at least
this instant **for every patient counted**".

**One source per response.**

- The outcomes and freshness routes return the cutoff's `basis` from the same
  SQL statement as the figures.
- The Journeys page draws its figures from separate calls. They share the one
  cutoff source, so they can differ only if the hourly watermark advances
  between two calls on the same page load.

### 1.1 Verification

**Rehearsal on a schema-only copy of production**, applied twice:

- only the 5 intended functions changed;
- owners and grants are identical;
- the new function is owned by `drsnip_metrics_fn` and executable by the app
  and reporting roles, not PUBLIC;
- the classifier is still refused to the reporting role;
- the 9 other functions are byte-identical.

**Production, applied before the deploy.**

- The migration came from the pushed commit (SHA-256 `7b6057b1…`,
  identical on the DB machine). Result: `EXIT=0`, NOTICE *"one evidence cutoff
  installed: incremental_watermark 21:05:00Z"*.
- The same function-fingerprint comparison gave the same result as the
  rehearsal.
- The definitions are byte-identical before and after (rules `5fa71685…`, scope
  `00074018…` provisional, catalog `663453f4…`).
- 0 approved scopes, 0 approved rules, 0 attendance mappings, 0 approvers.

**Four paths agreed**, called as the restricted reporting role: the shared
function, monthly outcomes, booking and the freshness badge all returned
**21:05:00.319 UTC**, which is the watermark.

**Regression tests** (`evidence-cutoff.test.ts`, 10 tests, all live):

- a new patient's catch-up after the watermark does **not** move the cutoff;
- the old rule would have taken the latest read, where the fallback takes the
  **earliest**;
- failed, partial, budget-exhausted and lock-contended runs do not move it;
- a stalled hourly sync with catch-ups continuing keeps the stalled instant,
  and the page's stale warning fires;
- a missing watermark and history gives `unavailable` on every path;
- outcomes, booking, attendance and freshness report the same instant;
- a booking between the watermark and a later catch-up is **Scheduled**, not
  past-dated.

**Live evidence of the fix.** At 22:30 a catch-up completed after the 22:05
watermark, and the reported cutoff correctly stayed at 22:05.

---

## 2. UI changes

**Monthly outcomes (`/admin/outcomes`)**

- **One appointment-data timestamp:** "Appointment data complete to … (Pacific)
  for every patient counted. Updated hourly." It comes from the same response
  as the figures. The separately fetched header badge was removed from this
  page.
- **Banner:** "**Provisional reporting scope** — counts include selected
  appointment types. Review what is included below."
- **One-line column key**, matching the calculation:
  - *Completed:* an included appointment is recorded as completed; this does
    not by itself establish that a procedure was performed.
  - *Currently scheduled:* an included future booking exists, without an
    established qualifying completion.
  - *Unknown:* relevant evidence is missing or ambiguous.
  - *Neither established:* no qualifying completion or current booking is
    established.

  The fuller definitions are under "More about each column".
- **An explicit `unavailable` state** if there is ever no valid cutoff.
- **Unchanged:** the table, cohort selector, whole-month range, URL behaviour,
  linkage coverage notes, Unknown reasons, withheld handling (text, bar
  geometry and screen-reader text), observation age, and "What is included?".

**Patient journeys (`/admin/journeys`)**

- **Removed:** the "Eligible cohort → Appointment record created → Advance
  booking recorded" waterfall. It was not replaced with another funnel.
- **Leads with form progression.** The headings are *Consultation form
  submitted after registration* and *Registration submitted after the insurance
  inquiry*. The period and window controls say they apply here, and the
  denominator, maturity and privacy explanations are kept.
- **Link at the top:** "See completed appointments and current bookings by
  entry month" → Monthly outcomes.
- **Collapsed "Appointment-record timing (diagnostic)"** section. It says that
  it "measures record creation, not a booked procedure, attendance, or a
  completed appointment". It contains:
  - "Appointment record created within N days";
  - "…of those, created before its scheduled date" ("not a further step");
  - "No appointment record within the window";
  - the median days to the first such record (all appointment types);
  - the overlapping record-detail cards.

  The calculations are unchanged.
- **Collapsed "Attendance status review"**, with review, draft and approval
  unchanged. A viewer is still refused preview.
- **One appointment timestamp** (the header badge, same source). The
  duplicate "As at" line was removed.

**Reports index**

- The journey cards are now "Registration form progression" and "Insurance
  inquiry progression".
- "Booked appointments" and "reach an appointment" wording is gone.
- Monthly outcomes stays first. Every existing URL is unchanged.

**Documentation corrected**

- `DRSNIP_ATTENDANCE_APPROVAL_SPEC.md`: No Show reliability is necessary but
  not sufficient for a rate.
- `DRSNIP_MONTHLY_OUTCOMES_CALCULATION.md`: No Show is unclassified, not "ended
  by inference".
- `DRSNIP_MONTHLY_OUTCOMES_RELEASE.md`: the "both timestamps are correct"
  claim is withdrawn.

---

## 3. Tests

- **Full suite: 688 tests, 663 pass, 0 fail, 25 skipped.** It was run in the
  working tree and again from a **pristine worktree of `b74dc53`** (clean
  install, full build, every DB suite live against disposable Postgres).
- **The 25 skips are pre-existing and are not passes.** The attendance
  calculation suites need a synthetic fixture that was never committed.
- New or changed suites:
  - `evidence-cutoff.test.ts`: 10 tests, new;
  - `monthly-outcomes.test.ts`: the "future" test now moves the practice-wide
    watermark, because a single catch-up no longer moves the cutoff;
  - `outcomes-view.test.ts`: the single timestamp, the short banner, the
    expandable detail, the unavailable state, and Journeys and Reports source
    contracts (no waterfall, the link, collapsed sections, no "booked
    appointments");
  - `booking-attendance.test.ts`: the single timestamp on Journeys.
- Typecheck and build are clean.
- **Local end-to-end** (real SPA → API → DB, synthetic data, a non-superuser
  app role): **73 of 73.** The page showed the 13:36 watermark rather than a
  later 14:01 catch-up. There is one timestamp per page, and the stalled-sync
  warning fires while catch-ups continue. Keyboard-expandable sections,
  attendance review opening and closing on Escape, and no overflow at 1440,
  1024, 820 and 390 were all verified.

---

## 4. Authenticated production verification

The check signed in as the application's own read-only viewer
(`viewer@drsnip.com`) through the real sign-in page. The password went into a
private 0600 file, was never printed, and was deleted afterwards.

| Check | Result |
| --- | --- |
| Login | works |
| Monthly outcomes, both cohorts | load; every displayed cell equals the API |
| API cutoff = freshness badge source = page time | ✓ (21:05:00.319 UTC, basis `incremental_watermark`) |
| One appointment timestamp on each page | ✓ Outcomes and Journeys; the Journeys badge equals the outcomes cutoff |
| Short provisional banner; column detail expands | ✓ |
| Patient journeys (registration and insurance) | form-progression measure loads; **no waterfall**; record timing collapsed by default, opens, labelled as record creation; attendance review opens, closes on Escape; link opens Monthly outcomes |
| Attendance preview for a viewer | still refused (405) |
| Reports | Monthly outcomes first; no "booked appointments" wording |
| Existing reporting | Reports, Intake dashboard and the insurance demo render; `/booking`, `/journey`, `/freshness` 200 |
| Refused period | 400 (not 500) |
| Layout | no overflow on Outcomes (1024/820/390) or Journeys (820/390) |
| Network | no patient or appointment identifier fields; no `rate` field |
| Page errors | none |
| Appointment sync | state **live**; incremental and catch-up both enabled, last runs successful, **0 failed, 0 partial in 24 h**; 2,122 of 2,122 linked patients' histories read |

The first attempt was interrupted by the database starvation in §6: a handful of
requests returned 502/500 while the app restarted. Every check was repeated
afterwards and passed. The one remaining failure, the insurance-demo render, was
a timeout during that recovery. Loaded on its own, the page renders fully with
no errors.

---

## 5. Reconciliation (July 2026 registrations)

| Source | Cutoff | Counted | Completed | Scheduled | Unknown | Neither |
| --- | --- | --: | --: | --: | --: | --: |
| Audit reference | 20:40 (old rule) | 571 | 321 | 27 | 14 | 209 |
| **Independent derivation C** (separately written SQL) | **20:05 watermark** | 571 | 321 | 27 | 14 | 209 |
| Production API (v89) | 21:05 watermark | 571 | 321 | 27 | 14 | 209 |
| Production API (v89) | 22:05 watermark | 571 | 321 | 27 | 14 | 209 |
| Rendered page (v89) | 21:05 watermark | 571 | 321 | 27 | 14 | 209 |

Unlinked July registration submissions: 9. Not covered: 0. Nothing withheld.

**Explained:**

- The July cohort is fully observed, and no included booking falls inside the
  one-hour window between the old and new cutoff rules. The correction
  therefore changed the *claimed time*, not the July counts, which is the
  expected result.
- Other months can differ slightly. For example, September's "patients counted"
  grows as registrations arrive (482 in the v89 screenshot, against 474 earlier).
  That is new intake, not a definition change.

**Not verified: a fresh independent derivation after the deploy.** Two attempts
to re-run a separately written query read-only on the database machine returned
no output, because `fly ssh` sessions to the DB were hanging during the §6
starvation. So the post-deploy check rests on:

- the pre-deploy independent derivation at the watermark (identical figures);
- the API matching it exactly at two later watermarks.

It is **not** a second post-deploy independent query.

---

## 6. Operational risk found during release (not caused by it)

**What happened, 21:29–21:46 UTC:**

- The `drsnip-intake-db` VM, **shared-cpu-1x with 256 MB RAM and no swap**,
  reported "Your instance has hit resource limits", with a load average of
  about 17, 1–6 MB free, and client connections timing out.
- The app then **crashed twice**, at 21:38:26 on `…d768` and at 21:45:49 on
  `…d378`. Each time a dropped database connection raised an `error` event on
  an idle Postgres client, and the pool (`lib/db/src/index.ts:158`, `new
  Pool(...)`) **has no `error` handler**, so Node exited with code 1. Fly
  restarted each machine within 3–5 seconds.

**Why this is not a v89 regression:**

- The same starvation (hanging SSH queries) occurred during the audit at about
  20:55, **before** 0022 or v89 existed.
- This release changed nothing in `lib/db` or the server wiring.
- Called one at a time, v89's endpoints are quick: freshness 0.1 s, outcomes
  0.9–2.4 s, journey, booking and attendance 0.1–0.2 s.
- A six-minute idle watch showed no further crash. The only exit, at 21:52:16,
  was code 0, a normal auto-stop.
- The only earlier OOM kill in the kernel log is 23 days old.

The trigger was concurrent heavy reporting load (my verification runs) on a very
small database. Rolling back to v88 would not change the database size or the
pool code, so **no rollback was done.**

**Recommended before the Loom** (not done here, because it is outside this
release's scope):

1. **Give the database more memory.** For example, `fly scale memory 1024 -a
   drsnip-intake-db`, planned, because it restarts Postgres.
2. **Add a pool error handler** (`pool.on("error", …)`) so a dropped connection
   is logged instead of crashing the app. That is about two lines, with a test.
3. Until then, record the Loom with one browser tab and let pages load before
   switching.

**Residual:** a 0-byte file `/tmp/recon_b.sql`, left on the DB machine by an
interrupted upload. It contains nothing, and can be removed when SSH is stable.

---

## 7. Rollback

```sh
fly deploy -a drsnip-intake-demo --image drsnip-intake-demo:deployment-01M37M55X1HM7TBC7J0K0YBGN1   # v88
```

- 0022 can stay: v88 calls the same functions with the same signatures. v88 would
  then show the watermark-based cutoff, which is the correct one.
- To restore the old cutoff *rule* as well, re-run the function definitions from
  0017, 0019, 0020 and 0021. That is not recommended, since they carry the
  defect.
- **Do not drop any table.**

---

## 8. Remaining provisional clinic decisions

These are unchanged by this release, and nothing is approved.

1. Does a completed **Consultation Only** appointment count? (July: up to 16
   patients.)
2. What does **No Show** mean? It is unclassified, and those patients are
   Unknown.
3. Do **Signed No Review** and **Procedure Not Performed** qualify for the
   business measure?
4. Are **past-dated Scheduled/Confirmed** appointments reliably updated?
5. The **six undecided appointment types**.
6. Should **returning patients and already-registered inquirers** stay in their
   month's cohort?

---

## Answers

1. **Is it live?** **Yes.** v89 (`b74dc53`) is deployed, migration 0022 is
   applied and verified, and PR #55 is updated and still open. The database
   capacity and app-crash risk in §6 predates this release but should be
   addressed before recording.
2. **Which page should Raunek lead with?** **Monthly outcomes**
   (`/admin/outcomes`).
3. **What does each page answer?**
   - **Monthly outcomes:** for patients who first registered, or sent an
     insurance inquiry, in each month, how many have completed an included
     appointment and how many still have one booked, as of one stated
     appointment-data time.
   - **Patient journeys:** whether people went on to submit the next form
     (registration → consultation form; inquiry → registration), with
     record-timing diagnostics and attendance review tucked away.
   - **Reports:** the index that points to both.
4. **Is anything still blocking an honest Loom walkthrough?** **Not in the
   figures.** The data freshness claim is now accurate, the misleading funnel
   is gone, and every number is provisional and labelled as such. **Practical
   blocker:** the undersized database and missing pool error handler (§6) can
   cause brief 502s or restarts under load. Scale the database and add the
   handler first, or record carefully.
