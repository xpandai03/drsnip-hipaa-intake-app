# Monthly patient outcomes: the calculation

**Date:** 23 September 2026
**Scope:** local implementation and verification only.

- Nothing was committed, pushed or deployed.
- No production migration was applied.
- No definition was approved.
- No workflow was touched, and the attendance mapping was neither read nor
  changed.
- Production was read with `default_transaction_read_only=on`, for aggregate
  reconciliation only.

**Builds on:** `DRSNIP_POST_CALL_REPORTING_BRIEF.md`,
`DRSNIP_APPOINTMENT_TYPE_LOOKUP.md`, `DRSNIP_ATTENDANCE_REVIEW_RELEASE.md` (v87).

This report contains no patient identifiers, appointment identifiers, notes or
payloads. Appointment-profile IDs are practice configuration and appear
throughout. Production counts of 1–4 are shown as `<5` or withheld, exactly as
the new function would publish them.

---

## 1. What was built

| File | What it is |
| --- | --- |
| `Intake-form/lib/db/migrations/0021_monthly_patient_outcomes.sql` | The three definition tables (seeded), the classifier, the published monthly function, the definition read-out, grants and self-checks. Applied by hand like 0014–0020 |
| `Intake-form/lib/metrics/outcomes.ts` | The metric allow-list and every word shown to a person. It contains no profile ID |
| `Intake-form/api/reports/outcomes.ts` | `GET /api/reports/outcomes`. Auth-guarded, aggregate only |
| `Intake-form/api-server/index.ts` | The route is registered explicitly (two lines) |
| `Intake-form/api/_test/monthly-outcomes.test.ts` | 34 tests. The database cases run against a disposable Postgres |
| `Intake-form/package.json` | The new suite is added to `test:api` |

Nothing else changed. The existing booking, journey, attendance and freshness
functions are byte-identical to production (§7.3).

---

## 2. Profile mapping: coverage and corrected assumptions

### 2.1 Source

The 15 ID-to-name pairs were read by Raunek from DrChrono's **Custom Appointment
Profiles** settings page on **23 September 2026**. They are stored in
`appointment_profile_catalog` with:

- `name_source = 'drchrono_settings_ui'`;
- `source_detail = 'Custom Appointment Profiles page'`;
- `observed_on = 2026-09-23`;
- `recorded_by = 'Raunek Pratap'`.

This is **dated metadata from the settings UI**. It is not an API lookup, which
is still 403 (see the lookup report), and it is not an approved conversion
definition. Names are stored exactly as displayed, including **"Special
Accomodations"**.

### 2.2 Matching against stored IDs (production, 16:05 UTC cutoff)

| Profile ID | Exact name | Stored in production | Appointments |
| --- | --- | :--: | --: |
| 585137 | Consultation with Vasectomy | ✓ | 1,749 |
| 874151 | Auction Winner Consultation with Vasectomy | ✓ | <5 |
| 503309 | Consultation Only | ✓ | 103 |
| 585138 | Vasectomy Only | ✓ | 75 |
| 594436 | Repeat DrSnip | ✓ | <5 |
| 594437 | Repeat Outside Provider | ✓ | <5 |
| 594438 | Prior Reversal Vasectomy | ✓ | 5 |
| 886171 | Partial Vasectomy with Consultation | ✓ | <5 |
| 503310 | Follow Up Visit | ✓ | 5 |
| 665139 | Home Visit | **unused** | 0 |
| 866117 | Light Duty Slip Only | ✓ | 14 |
| 873325 | DrSnip Lab Only | ✓ | <5 |
| 874156 | Outside Lab Only | ✓ | 17 |
| 875741 | PVST Mail Order | ✓ | 600 |
| 989114 | Special Accomodations | **unused** | 0 |
| (no profile) | – | ✓ | <5 |

- **Matched:** all 13 distinct stored IDs.
- **Unused:** 2 mapped IDs, Home Visit and Special Accomodations.
- **Unresolved stored IDs:** none. Only a handful of appointments carry **no
  profile at all**, and those are classified `unknown_profile`, never excluded.
- The count is re-derived on every call by `drsnip_outcome_definition()`, so a
  new ID appearing later shows up as an unnamed `unknown_profile` row. It does
  not silently fall into an exclusion.

### 2.3 Earlier hypotheses, corrected

| Earlier reading (brief §4.3) | Verified name | Correction |
| --- | --- | --- |
| 585138 "almost always follows another type's completion", possibly PVST follow-up | **Vasectomy Only** | It is a procedure type. It follows a consultation because that is the procedure, not a follow-up test |
| 875741 "after-the-fact, blank status" | **PVST Mail Order** | A mail-order test record. Its blank status says nothing about a missed in-person visit, and nothing about the patient's acquisition outcome |
| 874156, 866117 same pattern | **Outside Lab Only**, **Light Duty Slip Only** | Administrative or lab records, known by name. That they are administrative follows from their names, not from their timing |
| 585137 or 503309 is "probably" consultation-with-vasectomy | **585137 = Consultation with Vasectomy**, **503309 = Consultation Only** | Resolved |

A profile name still does not prove a procedure occurred. "Consultation with
Vasectomy" with status `Complete` means that appointment was completed.

---

## 3. The definition: three separate decisions

| Decision | Where it lives | Seeded state |
| --- | --- | --- |
| What a profile is called | `appointment_profile_catalog` | 15 rows, UI-derived, dated |
| What a status means | `outcome_status_rules` (versioned, provenance CHECK) | v1, **provisional** |
| Which profiles a report counts | `outcome_reporting_scopes` (versioned, one live version per key, provenance CHECK) | `selected_procedure_types` v1, **provisional** |

- An `approved` row in either rules table is refused by a CHECK unless it names
  a confirmer, their role, how they confirmed and when. This mirrors
  `attendance_mappings`.
- Nothing is approved, and no approval path was built.
- **The classifier contains no profile ID and no status label.** A test enforces
  this. Changing an inclusion decision means writing a new scope version, not
  editing SQL.

### 3.1 The provisional scope, "Selected procedure appointment types — provisional"

| Role | Profiles | Effect |
| --- | --- | --- |
| `qualifying` | Consultation with Vasectomy, Auction Winner Consultation with Vasectomy, Vasectomy Only | Counts toward Completed and Scheduled |
| `comparison` | Consultation Only | Reported beside the buckets. Never inside them |
| `excluded_known` | Follow Up Visit, DrSnip Lab Only, Outside Lab Only, PVST Mail Order, Light Duty Slip Only | Known non-acquisition. Can never create a positive, and its ambiguity is irrelevant |
| `inclusion_undecided` | Repeat DrSnip, Repeat Outside Provider, Prior Reversal Vasectomy, Partial Vasectomy with Consultation, Home Visit, Special Accomodations | An open clinic decision. A completed or active record makes the patient **Unknown**, not positive and not negative |
| (not listed) | Any other ID, or no profile | `unknown_profile`, with the same effect as undecided. Unknown meaning stays unknown |

This is an **engineering preview**. The API marks it `engineering_preview: true`
for as long as the scope is not `approved`.

### 3.2 Status rules v1 (provisional)

| Class | Labels | Source |
| --- | --- | --- |
| completion | `Complete`, `Signed No Review` | Jeff, T:55 and T:66–71. Completed the appointment, which is **not proof of a procedure** |
| (annotation) review withheld | `Signed No Review` | Jeff, T:66–71 |
| procedure not performed | `Procedure Not Performed` | Jeff, T:73. Its **own class, not counted as completion** |
| active if future | `Scheduled`, `Confirmed` | Jeff, T:57–59 |
| ended, not active | `Cancelled`, `Late Cancel within 48 hrs` | Jeff, T:60–62 and T:278–280. *(Corrected before release, `bdab3bf`: `No Show` was first placed here by engineering inference; Jeff named it without defining it (T:66), so it is now **unclassified** — it establishes nothing, and a patient whose only relevant record is a No Show is Unknown.)* |
| replaced | `Rescheduled` | Jeff, T:276–287. The remaining records are evaluated. A replacement is never assumed |
| unresolved | anything else: blank, NULL, `Checked In`, `Ready in N`, `In Room`, labels never seen before | Establishes neither a positive nor a negative |

---

## 4. Exact rules

### 4.1 Cohort and time

- **Unit:** one linked DrChrono chart (`submissions.n8n_patient_id`).
- **Entry:** the chart's **first-ever** submission of the form. This is the
  existing convention, unchanged.
  - A repeat submission is counted once, at the first, and flagged
    (`repeat_submitters`).
  - The entry month is the Pacific calendar month of that instant.
- **Months only.** `from` and `to` are whole clinic months (`YYYY-MM`), from
  2026-01 onward, and at most 13 months per request. An arbitrary day range
  would let two requests one day apart be subtracted to read the outcomes of the
  few people who entered that day. The existing endpoints allow that; this one
  does not.
- **No maturity exclusion.** There is no 7/14/30-day window. Each month instead
  carries:
  - `entry_period_complete`, false while the month is still open at the cutoff;
  - `days_observed_min` and `days_observed_max`, how long the youngest and
    oldest possible entrant has been observed.

  A 20-day-old cohort and a 100-day-old cohort are therefore never presented as
  equally observed.
- **Evidence cutoff:** the same rule as booking (0019) and attendance (0020): the
  later of the last completed per-patient history read and the incremental
  cursor. **"Future" means after the cutoff, not after now.** A test moves the
  cutoff and watches scheduled patients turn into past-dated Unknowns.
- **Relevant appointments:** non-deleted, and scheduled **on or after the entry
  clinic day**. A visit earlier the same morning counts. One the previous day
  does not.
- **Coverage:**
  - `covered` means the chart's full history has been read. `not_covered` sits
    outside the buckets, never as a negative.
  - `unlinked_submissions` counts submissions no chart was linked to. The unit
    is **submissions, not people**, and nobody is deduplicated by assumption.
- **Insurance cohort:** every first-time inquirer, **including** patients
  already registered before inquiring. They are counted
  (`registered_before_inquiry`), not removed. The inquiry-to-registration
  metric's denominator, which excludes them, is **not** reused.

### 4.2 Precedence (one bucket per covered patient)

1. **Completed.** Any qualifying record in a completion status.
2. **Currently scheduled.** Otherwise, any qualifying `Scheduled`/`Confirmed`
   record dated after the cutoff.
3. **Unknown.** Otherwise, any **relevant** ambiguity:
   - `past_dated_open`: a qualifying record whose date has passed while it is
     still `Scheduled`/`Confirmed`.
   - `status_unresolved`: a qualifying record that is blank, NULL, in-clinic or
     unrecognised.
   - `rescheduled_no_replacement`: a qualifying `Rescheduled` record with no
     later-created, non-deleted record of a qualifying, undecided or unknown
     profile.
   - `conflicting_history`: a qualifying record whose status history reached a
     completion that its current status no longer shows.
   - `deleted_completion`: a qualifying completion recorded only on a record
     deleted at source.
   - `undecided_profile` / `unknown_profile`: such a record that is completed,
     due, or unresolved.
4. **Neither established.** Otherwise. It is split into
   `no_qualifying_record` and `had_qualifying_record`.

Why these particular rules:

- **A positive is never erased** by an unrelated ambiguity. A blank PVST record,
  or an undecided "Repeat DrSnip" booking, beside a completed consultation
  leaves the patient Completed. Ambiguity on `comparison` or `excluded_known`
  records is **never relevant**, because it could not make the answer positive.
- **Reschedule chains are never reconstructed.** The rule asks only whether *any*
  later record exists that could be the replacement. There is no pairing by time
  proximity.
- **Appointment count is never evidence.** Three cancelled records are Neither.
- **Neither** means every relevant record was read and none shows a counted
  completion or future booking. It is never labelled lost, failed or ready for
  outreach, and a test enforces that wording.

**Changes from the brief (§5):**

- `Procedure Not Performed` is now its own class, not completion.
- A completion on a deleted record is now **Unknown**, where the brief said
  Neither. Missing or ambiguous evidence must not become a negative.
- A rescheduled record's "replacement visible" test now also accepts undecided
  and unknown profiles.

### 4.3 Annotations (reported beside the buckets, and overlapping)

| Annotation | Of whom |
| --- | --- |
| `completed_with_future_booking` | Completed, and also holding a future qualifying booking |
| `completed_review_withheld_only` | Completed only via Signed No Review |
| `procedure_not_performed` | Not completed, with a qualifying record ending Procedure Not Performed |
| `comparison_completed` / `comparison_scheduled` | Not completed (or scheduled), with a Consultation Only completion or booking |
| `positive_booked_before_entry` | Completed or scheduled on a record created before the form |
| `prior_completion_before_entry` | A qualifying completion dated before entry (returning patients) |
| `registered_before_inquiry` | Insurance only |
| `repeat_submitters` | More than one submission of this form |

---

## 5. Synthetic worked examples

These are the test fixture's archetypes, six synthetic patients each. Entry is
2 March 2026, 09:00 Pacific, and the evidence cutoff is 15 April 2026.
"Q" = Consultation with Vasectomy.

| Records after entry | Bucket | Why |
| --- | --- | --- |
| Q Complete | Completed | |
| Q Complete + Q Scheduled 1 May | Completed (+ future booking) | Completion wins |
| Q Cancelled + Q Scheduled 1 May | Scheduled | The replacement is simply an active record |
| Q Rescheduled → Q Rescheduled → Q Cancelled | Neither (had record) | Every reschedule has a later record, and the last is cancelled |
| Q Rescheduled only | Unknown (no replacement) | A replacement was expected and none is visible |
| Q Rescheduled + Q Scheduled 1 May | Scheduled | |
| Q Rescheduled + Q Cancelled | Neither (had record) | |
| Q Confirmed for 1 April (before the cutoff) | Unknown (past-dated open) | |
| Q blank | Unknown (status unresolved) | |
| Q Checked In, past | Unknown (status unresolved) | An in-clinic status is not completion |
| PVST Mail Order blank, only | Neither (no record) | An excluded type cannot matter |
| Q Complete on a deleted record | Unknown (deleted completion) | |
| Q Scheduled 1 May on a deleted record | Neither (no record) | A deleted booking is not active |
| Q Cancelled, history shows Complete | Unknown (conflicting history) | |
| Vasectomy Only Complete | Completed | Recognised by its profile ID |
| Auction Winner Consultation Scheduled 1 May | Scheduled | |
| Consultation Only Complete | Neither (+ comparison completed) | |
| Consultation Only Scheduled 1 May | Neither (+ comparison scheduled) | |
| Q Procedure Not Performed | Neither (+ procedure not performed) | Not counted as completion |
| Q Signed No Review | Completed (+ review withheld only) | |
| Q Late Cancel | Neither (had record) | |
| Q No Show only | Unknown (status unresolved) | No Show is not yet defined by the clinic |
| Q Complete in January (before entry) | Neither (+ prior completion) | |
| Q Complete earlier the same clinic day | Completed | Relevance is by clinic day |
| Q Complete the previous clinic day | Neither (+ prior completion) | |
| Q Scheduled 1 May, record created before entry | Scheduled (+ booked before entry) | |
| Repeat DrSnip Complete | Unknown (undecided profile) | |
| Unknown ID 999999, or no profile, Scheduled 1 May | Unknown (unknown profile) | Unknown, not excluded |
| Q Complete + PVST blank + Repeat DrSnip Scheduled | Completed | Unrelated ambiguity does not erase a positive |
| DrSnip Lab Only Scheduled 1 May | Neither (no record) | Lab records never create a booking |
| Two registrations, Q Scheduled 1 May | Scheduled (+ repeat) | Counted once |
| Q Complete, history never retrieved | outside the buckets (`not_covered`) | |
| Submission with no linked chart | outside the cohort (`unlinked_submissions`) | |
| Entry at 23:30 Pacific on 31 March (1 April in UTC) | March cohort | Clinic calendar |

---

## 6. API contract

`GET /api/reports/outcomes?metric=outcome_registration|outcome_insurance&from=YYYY-MM&to=YYYY-MM[&scope=selected_procedure_types]`

- **Auth:** any signed-in user (viewer or admin), the same as `/booking` and
  `/journey`. Unauthenticated calls get 401 and non-GET calls get 405.
- **Parameters:**
  - `metric` comes from an allow-list.
  - `scope` must be a registered key. It is validated by format in the route and
    by existence in the database.
  - `from` and `to` are whole months: 2026-01 onward, `from ≤ to`, and at most
    13 months.
  - Any other query parameter is ignored. A test shows that adding
    `profile=875741` changes nothing.
  - Profile IDs, statuses and any other filter **cannot be supplied**.
- **Response:**
  - `definition`: scope key, version, state, `engineering_preview`, label,
    description, status rules (version, state, rules, source), every profile
    (ID, exact name, name source and date, role, stored appointment count
    suppressed per cell), and `profile_coverage`.
  - `as_of.evidence_cutoff` (ISO-8601 UTC) and `evidence_age_minutes`.
  - `period` with its time zone.
  - The plain-English meanings of each bucket, Unknown reason and annotation.
  - `no_combined_measure`, which states why no rate is returned.
  - `months[]`, each with:
    - `status` ∈ `ok`, `empty`, `suppressed`, `not_started`, plus `withheld[]`
      naming what was withheld and why;
    - `observation`;
    - `cohort` (total, covered, not_covered, unlinked_submissions);
    - `outcomes` (completed, scheduled, unknown, neither);
    - `neither_breakdown`, `unknown_reasons` (overlapping) and `annotations`
      (overlapping).
- **Deliberately absent:** any rate, any completed-plus-scheduled total, and the
  word "conversion" as a measure.

**Suppression happens inside the database, per month:**

- Covered 1–4: the row's patient counts are all withheld.
- The four buckets are a **partition** of `covered`. A small bucket is withheld
  with the next-smallest, the same algorithm as `suppressPartition()` and 0020.
- **If any bucket is withheld, every outcome annotation in that month is withheld
  too.** A subset count bounds its parent, and a lower bound on the withheld
  partner narrows the small cell it protects.
- A small `not_covered` is withheld together with the cohort total.
- Neither's two sub-reasons are a partition of Neither.
- Everything else is per cell. Zero is publishable.

**Boundary:**

- The route calls `drsnip_outcome_metric()` and `drsnip_outcome_definition()`.
  Both are `SECURITY DEFINER`, owned by NOLOGIN `drsnip_metrics_fn`, and
  executable by the app role and `drsnip_reporting_ro`.
- The per-patient `drsnip_outcome_classify()` is executable by **nobody**, and
  the migration aborts if that ever stops being true.
- The route never reads a PHI table.

**Cross-scope and cross-endpoint disclosure:**

- There is exactly one scope. A second published scope would create a
  differencing pair: A − B = patients whose only positive is on the profiles
  that differ. It needs its own review before it is registered.
- The existing endpoints publish cohort totals for the same first-entry cohorts.
  Those totals match this endpoint's and carry no outcome.
- **Residual risk:** the open month grows daily, so two calls on consecutive
  days differ by that day's entrants. The same is true of every live dashboard
  here, and the console's users can already see submission rows.

### 6.1 Applying it (not done)

- Apply `0021` by hand after 0020, as the operator, the same way 0014–0020 were
  applied. It is idempotent. It was applied twice in a row locally.
- Deploy order: **migration first**. Without it only the new route fails (500),
  and nothing existing is affected.
- It must land on PR #55's branch, or a branch stacked on it, not `main`.

---

## 7. Verification

### 7.1 Tests

A disposable local Postgres 16 was built with **every migration 0000–0021**
applied in order, plus the app and reporting roles.

- **Baseline, before any change:** 607 tests, 582 pass, 0 fail, 25 skipped.
- **After:** **641 tests, 616 pass, 0 fail, 25 skipped.** That is exactly the
  baseline plus 34 new tests. Typecheck is clean, and the server bundle builds.
- **The 25 skips are pre-existing.** The attendance calculation suites expect a
  synthetic fixture that an earlier agent built by hand and never committed, so
  they cannot run on a fresh database. They were skipped before this change too.

The new suite has 34 tests, **all running live, none skipped**:

- **Definition:**
  - all 15 names present exactly, with source and date;
  - no profile ID and no status label inside the classifier;
  - one provisional scope, nothing approved, the attendance mapping untouched;
  - the four corrected hypotheses pinned;
  - No Show left unclassified (corrected before release);
  - no existing function redefined.
- **Wording:** no "conversion", "lost", "failed" or outreach language; Completed
  says it is not proof of a procedure; whole months only.
- **Route contract:**
  - registered explicitly;
  - auth-guarded and GET-only;
  - calls only the published functions;
  - accepts only four parameters;
  - returns no rate or total;
  - never echoes a driver error;
  - maps Drizzle's wrapped SQLSTATE to 400;
  - returns the month as text and the cutoff as ISO.
- **Calculation (hand-counted literals):** March cohort covered 210 → Completed
  48, Scheduled 30, Unknown 54, Neither 78 (48 no record, 30 had one).
  - Every Unknown reason, annotation, unlinked count and repeat count checks out.
  - Clinic-calendar month boundaries and observation days hold.
  - The partition small cell is withheld with its partner, and its annotations
    with it.
  - A three-patient cohort publishes nothing.
  - Insurance registered-first patients are kept and counted.
  - Moving the cutoff turns scheduled patients into past-dated Unknowns.
- **Independent classifier:** a separately written TypeScript classifier over the
  raw fixture rows produces the same buckets.
- **Boundary:**
  - the reporting role cannot run the classifier or read the PHI tables;
  - no fixture ID appears in any output;
  - off-list metric, scope, day-granular, pre-2026 and over-long periods are all
    refused;
  - the definition read-out lists all names, the unknown ID and the NULL profile;
  - approval without provenance is refused, and a second live scope version is
    refused.

### 7.2 Direct HTTP calls against the real server

The API server ran locally over a synthetic database. It connected as a
**non-superuser** app role, which is stricter than production, where that role
is a superuser. A synthetic viewer signed in through the real `/api/auth/login`.

| Call | Result |
| --- | --- |
| GET, unauthenticated | 401 |
| POST, viewer | 405 |
| GET, viewer | 200: provisional scope, `engineering_preview: true`, ISO cutoff, 15 profiles |
| June (30 covered: 12/8/3/7) | completed 12, scheduled 8, unknown and neither **withheld**, `partition_small_cell` |
| July (3 covered) | `suppressed`, everything withheld |
| August (after the cutoff) | `not_started` |
| Any `rate` key, any fixture ID in the body | none |
| Bad metric / day-granular / 14 months / pre-2026 / reversed / malformed scope | 400 each |
| Unregistered scope | 400 (**was 500** on first run; fixed, see §7.4) |
| An extra `profile=` parameter | ignored; identical output |
| `/booking`, `/journey`, `/freshness`, `/attendance` | 200 each |

### 7.3 Existing metrics unchanged

The fingerprint (md5 of `pg_get_functiondef`) of all **11 pre-existing reporting
and sync functions** was compared between the local database with 0021 applied
and production. **All 11 are identical.** The migration creates only new objects.

### 7.4 Found along the way

1. **Drizzle wraps driver errors.** The SQLSTATE is on `err.cause.code`, not
   `err.code`.
   - The new route handles this (and a test pins it).
   - **The existing `/booking` and `/journey` routes do not.** Verified locally:
     an entry period before 2026, which the database refuses with `22023`,
     returns **500** where the code intends 400.
   - This is pre-existing and was left unfixed, because this step preserves
     existing behaviour. It is a two-line fix per route.
2. **Fresh-database migration order.** `0012a` grants on a table that `0013`
   creates, so on an empty database it must run after 0013. `0018` refuses to
   run without real sync history. Production is unaffected; this matters only
   for anyone rebuilding a test database.
3. **The attendance calculation suites depend on an uncommitted fixture.** That
   accounts for the 25 skips.

### 7.5 Independent reconciliation against production (read-only)

Two independently structured queries were run under the read-only guard, at
evidence cutoff **2026-09-23 16:05 UTC**:

- **A** is the exact text between the classifier's markers in 0021, with the
  seeded scope and rules substituted as literals, so no production migration was
  needed.
- **B** is a separately written query with a different structure: `DISTINCT ON`
  entry, a per-appointment rank of 1 to 4, and the minimum per patient.

**24 cells compared, 0 disagreements** (registration and insurance, June to
September; completed, scheduled, unknown, neither, not covered).

What the endpoint **would publish** today, after the function's suppression
rules. This is the provisional scope, an engineering preview:

| Form | Entry month | Covered | Completed | Scheduled | Unknown | Neither | Withheld |
| --- | --- | --: | --: | --: | --: | --: | --- |
| Registration | Jun | 245 | 147 | — | — | 90 | partition small cell |
| Registration | Jul | 571 | 321 | 27 | 5 | 218 | – |
| Registration | Aug | 621 | 228 | 126 | 22 | 245 | – |
| Registration | Sep (open) | 474 | 50 | 122 | 19 | 283 | not-covered small (total withheld) |
| Insurance | Aug | 29 | 5 | 5 | 0 | 19 | – |
| Insurance | Sep (open) | 53 | — | — | — | 46 | partition small cell |

What it shows:

- **Consultation Only matters but is small.** Consultation Only completions among
  patients who are not otherwise completed: 16 in July, 15 in August, 7 in
  September (withheld in June). Counting consultation-only completion would move
  those patients from Neither to Completed.
- **Procedure Not Performed on a qualifying record:** 5 in August, and small or
  zero elsewhere.
- **Past-dated open qualifying records** drive Unknown: 14 in August and 14 in
  September.
- **Booked before entry:** 11–17 per month. This is visible in the annotation.
- **Scope matters only slightly for completions today.** June has 147 completions
  under the provisional scope, against 153 on any type in the brief. The
  difference is completions on other types.

These are **not conversion figures**. The scope is provisional, the month
cohorts are of different ages (see `days_observed_*`), and August and September
are still inside Jeff's 1–2-month window.

---

## 8. Questions only the clinic can answer

1. **Does a completed Consultation Only appointment count?** This is the biggest
   lever: 15–16 patients a month in July and August.
2. **Procedure Not Performed on a Consultation with Vasectomy:** is it
   completion (the appointment happened) or not (no procedure)? It is currently
   not counted, and flagged.
3. **Signed No Review** is counted as completion today. Jeff's own example
   includes cases where the procedure was not done. Is that right?
4. **The six undecided types:** Repeat DrSnip, Repeat Outside Provider, Prior
   Reversal Vasectomy, Partial Vasectomy with Consultation, Home Visit and
   Special Accomodations. For each, in or out? Rare today, so their effect is
   small.
5. **When an appointment date passes, do staff always update the status?** This
   decides whether past-dated Scheduled/Confirmed records stay Unknown.
6. **No Show:** what does the clinic mean by it? Until it is defined it is
   unclassified, and such patients are Unknown.
7. **Returning patients** with a completion before this registration: keep them
   in the month's cohort? They are kept today, and flagged.
8. **Insurance inquirers who were already registered:** keep them in the
   insurance cohort? They are kept today, and counted.

Each answer is recorded as a new version of `outcome_reporting_scopes` or
`outcome_status_rules`, with provenance, and needs no code change.

---

## 9. Implementation brief: the monthly dashboard

**Placement:** a new section at the top of the Journeys page, "Where each
month's patients stand now". The existing fixed-window cards stay below it,
unchanged.

**Controls:**

- Registration / Insurance inquiry toggle.
- Month presets from the earliest intake month to the current month, plus a
  from–to month picker (max 13).
- No window selector: this view has none.

**Header (always visible):**

- "As at {evidence_cutoff}, Pacific", with an age badge (reuse
  `AppointmentFreshnessBadge`).
- The scope label, verbatim ("Selected procedure appointment types —
  provisional"), with an **"Engineering preview — not the clinic's approved
  definition"** banner whenever `definition.engineering_preview` is true.
- A "What counts" disclosure listing the profiles by role, with exact names.

**One row per entry month:**

- The entry month, with an "open" tag when `entry_period_complete` is false and
  "observed {min}–{max} days".
- Four counts: Completed, Currently scheduled, Unknown, Neither established.
- A **100% stacked horizontal bar** of those four. It is a partition, not a
  funnel.
- A withheld cell renders as "—" with a tooltip taken from `withheld[]`. The bar
  then shows only the published segments, plus a hatched "withheld" remainder,
  and never redistributes.
- A `suppressed` row renders "Too few patients to show"; a `not_started` row
  renders nothing.

**Beside the row:**

- Coverage: "{not_covered} not yet retrieved · {unlinked_submissions}
  submissions not linked to a chart".

**Expandable per month:**

- Unknown reasons, marked as overlapping.
- Neither split: no counted appointment / had one.
- Annotations. Consultation Only completed and scheduled are shown as "for
  comparison".

**Must not:**

- show a rate, a percentage headline, or a completed-plus-scheduled total, until
  the scope is approved;
- use the words conversion, lost, failed or follow up;
- compute anything client-side from withheld cells;
- link to patients.

**Data:**

- One call per toggle: `/api/reports/outcomes?metric=…&from=…&to=…`.
- Every label and explanation comes from the response (`buckets`,
  `unknown_reasons`, `annotations`, `definition`), so the page carries no
  definitions of its own.

**Tests to add with it:**

- the banner appears when `engineering_preview` is true;
- no `%` or "conversion" text renders;
- a withheld cell renders "—";
- 390px width has no horizontal overflow (the existing Journeys checks).

**Before any production use:**

- apply 0021;
- re-run the §7.5 reconciliation against the deployed function itself, not the
  substituted text;
- screenshot the section at 1440 and 390.
