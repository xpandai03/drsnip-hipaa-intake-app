# Dr. Snip reporting — final release

**Date:** 20 September 2026 · **Branch:** `feat/console-redesign-insurance-demo`
**Release commit:** `e0ded90` · **PR:** [#55](https://github.com/xpandai03/drsnip-hipaa-intake-app/pull/55)
**Deployed:** Fly **v84**, image `drsnip-intake-demo:deployment-01M2ZV72HZVW0410HWD4C9GWNZ`, 20 Sep 2026 09:45 PT

Written for: whoever picks this system up next, and for the Monday meeting.

No patient identifiers appear in this document. Every figure is an aggregate.

---

## 1. Where to click for the real reporting

**Reports → Patient journeys**, or straight to `/admin/reports`.

The Reports item in the sidebar used to land on the intake dashboard, and the
sidebar only unfolded a group once you were already inside it — so the only way
to find "Patient journeys" was to already be looking at it. That is the whole of
why real reporting was hard to find.

What changed:

| Before | Now |
| --- | --- |
| Reports → `/admin/dashboard` | Reports → `/admin/reports`, an index of every report |
| Children hidden until the group was active | Children always visible in the sidebar |
| Journeys second in an invisible list | **Patient journeys first**, on the index and in the nav |
| Demo listed as "Insurance follow-up", second | **"Demo: insurance follow-up"**, last, below a rule headed *Demonstration — not patient data* |
| One link for both journeys | `?journey=registration` and `?journey=insurance` are separate, shareable links |

`/admin/reports` **calculates nothing.** It is an index. The intake dashboard,
drop-offs and the activity log kept their routes and their links; nothing
operational was hidden to make room.

Direct links, all of which survive a reload and the Back button:

- `/admin/reports` — the index
- `/admin/journeys?journey=registration` — registration journey
- `/admin/journeys?journey=insurance` — insurance inquiry journey
- `/admin/journeys?journey=insurance&period=aug&window=30` — a specific question

On a phone: Reports is one of five bottom-bar slots and opens a sheet listing
Patient journeys first. Ten destinations, every one reachable in at most two
taps, no horizontal scrolling anywhere (checked at 390 × 844).

**The top-left is now the clinic's own wordmark**, in place of the typed
"DrSnip Console / Intake & Reporting". One thing to know if you touch it:
`drsnip-logo.png` is a *white* wordmark on transparency — the same asset the
public forms and the sign-in page place on the deep clinical blue — and the
sidebar is `#ffffff`. Dropped in unchanged it renders as nothing at all, which
is exactly what the old 7 × 7 copy beside the text was doing, and why the text
had to be there. So it sits on a brand-blue band: the clinic's artwork
unretouched, legible in light mode and dark, in the sidebar and in the 56px
mobile top bar alike.

---

## 2. What is deployed

### Committed and ready

| Commit | What |
| --- | --- |
| `0cf4b7c` | `perf(reporting)` — the page-load fix |
| `26ef5a5` | `feat(sync)` — recurring appointment sync, its budget, its monitoring |
| `1bd4c23` | `feat(reporting)` — booking and attendance views reach production |
| `4d354cd` | `feat(console)` — Reports index, findable journeys, honest loading |
| `e0ded90` | `fix(console)` — the clinic's logo, and a shell-blanking bug it exposed |

### Applied to the production database

| Migration | Effect | Status |
| --- | --- | --- |
| `0015` | booking + status-evidence functions | applied |
| `0016` | journey-metric index and cast fix | applied |
| `0017` | schedule registry, shared budget, sync health | applied |
| `0018` | incremental cursor initialised from evidence | applied |
| `0019` | booking "as at" follows the cursor | applied |

None are registered in `migrate.ts` — they create roles or depend on functions
another file creates — so they are applied by hand, **in numeric order.**
`0014` and `0017` both define `drsnip_journey_freshness`; replaying `0014` after
`0017` would silently drop the sync columns the console reads. Both files say so
at the point where it matters.

### Published and deployed

All six commits are pushed. The remote branch SHA is `e0ded90`, matching local `HEAD`
exactly, and PR #55 (OPEN, MERGEABLE, base `main`) carries them. The repository
has no required status checks and no required reviews configured, so there was
no release gate left to wait on; the PR was **not** merged, because nothing in
the documented process requires it.

The deploy was made from a **pristine `git worktree` checked out at `e0ded90`**,
not from the working tree, so no untracked or uncommitted file could reach the
image. The `Dockerfile` builds everything from source inside the image, so the
local `dist/` played no part.

`release_command` ran `migrate.cjs`, which replays only the *registered*
migrations. `0015`–`0019` are deliberately unregistered, so they were **not**
re-run — they were already applied and verified.

### The load-time fix, measured

The page was slow and nobody knew why, so the first thing was to find out rather
than guess. On production, before any change:

```
drsnip_journey_metric (registration→consultation)   6,340 ms   and 5,996 ms
drsnip_journey_metric (appointment evidence)           23 ms
drsnip_booking_metric                                  21 ms
drsnip_journey_freshness                                4 ms
```

The page issues three calls of the first kind — about eighteen seconds of
database time per load. `EXPLAIN ANALYZE` named it: the correlated subquery that
finds each patient's first later submission ran as `SubPlan 2 … loops=1845` over
a sequential scan. Two causes, and fixing either alone would have achieved
nothing:

1. `submissions` had **no index at all** on `n8n_patient_id`.
2. The function compared `c.n8n_patient_id::text = fe.pid` — casting the
   *column*, which makes any btree index on it unusable.

Both are fixed. After, same connection style, two runs each so neither number is
a warm-cache artefact: **57 ms and 38 ms.** Every metric value is byte-identical
before and after; the comparison is recorded in the migration header.

Measured end to end against production, signed in as the app's own viewer
account, **on the build that is deployed right now**:

```
/admin/journeys reached networkidle in       781 ms
/api/reports/journey  registration→consultation   200    74 ms
/api/reports/journey  appointment evidence        200    56 ms
/api/reports/journey  insurance→registration      200    41 ms
```

**One thing to own.** The first version of `0016` broke the appointment-evidence
branch of the function — removing the cast from the source column left one
comparison against a text column without one, and that branch returned an error
for the few minutes between applying it and catching it. It was caught by the
verification step that re-runs every metric and diffs the values, which is the
step that exists for exactly that. Fixed, re-applied, and the branch is verified
working above (1,117 of 1,845).

### Loading, and the sentence that was not true

The page got its freshness by reading it off the side of a six-second metric
call, so for six seconds it rendered:

> Appointment snapshot — last refreshed **unknown**

Three faults in one line: it called an in-flight request "unknown"; a reader
could not tell that apart from a genuinely missing timestamp; and it said
"snapshot" whether or not anything was keeping the data current.

Now there is `GET /api/reports/freshness`, which calls one cheap function and
nothing else, and the badge has five states that are never collapsed together:

| State | What it says |
| --- | --- |
| checking | *Appointment data — checking how current it is…* |
| current | *Appointment data complete to 20 Sep 2026, 9:05 AM · updates hourly* |
| behind | *…· hourly sync is behind* |
| paused | *…· scheduled sync is switched off* |
| check failed | *…freshness check failed; last known … (may be stale)* + **Retry** |
| never | *no sync has completed yet* |

On failure the last value we actually saw is kept and marked stale. It is never
replaced by a zero, and never by "unknown".

The shell, title, tabs and filters render immediately; figures arrive into
skeletons that occupy the same space and are announced `aria-busy`. A refresh
over existing figures says *"Updating these figures. The numbers below are the
previous ones until it finishes."* The freshness query stops retrying after one
attempt — an endless spinner is a way of never admitting something is broken.

The badge says **"complete to"**, not "last refreshed". A run that could not
finish its window does not advance the cursor, so the timestamp means coverage,
never activity.

### The booking views, recalculated against current data

Entry period: all intake history. Follow-up window: 14 days. As at the
appointment cursor.

**Registration journey**

| | |
| --- | --- |
| Entered | 1,845 |
| Eligible to measure | 1,554 |
| Still inside their window | 291 *(excluded, not counted as failures)* |
| Appointment record created after entry | **989** — 63.6% |
| Advance booking recorded | **975** — 62.7%, median 2.2 days |
| No appointment recorded | 565 — a real negative, not an unknown |
| Consultation form, observed to date | 674 of 1,845 — 36.5% |
| Consultation form, within 14 days (mature) | 368 of 1,554 — 23.7% |

**Insurance inquiry journey**

| | |
| --- | --- |
| Entered | 71 |
| Eligible to measure | 35 |
| Appointment record created after entry | 11 |
| Registration, within 14 days (mature) | 15 of 35 |

Several context cells in the insurance cohort are **withheld** — small groups
are not published, and neither is any total that would let them be recovered by
subtraction. "Withheld" never means zero.

---

## 3. Do appointments update automatically, and how often?

**Yes. Hourly, as of today.** Two schedules, both live and both verified running:

| Schedule | Cadence | What it does |
| --- | --- | --- |
| `incremental_hourly` | **hourly at :05**, clinic time | Reads everything modified in DrChrono since the cursor, with a two-hour overlap |
| `patient_catchup` | **every 10 minutes** | Reads the complete history of one newly linked patient |

Once a week, **Sunday 03:05**, the hourly run widens its lookback to eight days
as a reconciliation pass — the thing that recovers an edit lost to a window
boundary or a brief outage. First one: **Sunday 27 September.**

### It is working. Evidence, not configuration

```
16:05:00  incremental      success  1 request   20 appointments   132 transitions
          cursor advanced 2026-09-19 21:37 → 2026-09-20 16:05
16:10:38  patient_catchup  success  1 request
16:17:26  a patient registered      (linked patients 2,036 → 2,037)
16:20:38  patient_catchup  success  1 request — that patient's history read
          2,037 of 2,037 linked patients now have their history loaded
```

```
17:05:00  incremental      success  1 request  0 appointments  (nothing changed)
          cursor advanced 16:05 → 17:05, in 0.8 seconds
```

That middle sequence is the catch-up doing its job on a real new patient, three
minutes after they arrived, without anybody touching it. The 17:05 run is the
second unattended tick, watched from outside the system: it fired on the minute,
found nothing to do, said so, and still moved the cursor — which is what a quiet
hour is supposed to look like. Cursor lag at that point was **23 seconds**, and
the shared budget stood at 3 requests used of 150.

The console's "updates hourly" badge is **earned, not declared**:
`recurring_active` is true only when a run of that scope actually *succeeded*
inside twice its expected interval. A schedule row can say enabled while n8n is
down; the page will not repeat the claim.

### Where the cursor came from

Not "a few days ago". The only defensible starting instant is the earliest at
which the backfill could still see the whole world — `min(completed_at)` over
the 2,035 completed per-patient history units, **less a two-hour overlap**.

A patient whose unit finished at 23:37 has their history as at 23:37. An edit at
23:40 to that patient's appointment would have been missed by everything that
finished afterwards. Taking the *maximum* instead — the obvious-looking choice —
would have skipped every edit made during the backfill itself. Migration `0018`
computes the value rather than pasting it, refuses outright if no unit has
completed, and never rewinds a cursor that already exists.

The first run did the entire catch-up in one request, in two seconds.

### Bounds, and why they hold

DrChrono allows 500 requests/hour and 290 per rolling ten minutes for this
practice, and **five live intake workflows share that credential** with a patient
sitting in front of a form. So:

- `drsnip_sync_budget()` reads the one table every sync scope writes to. Two
  schedules cannot each obey a private cap and still exceed the practice's.
- Sustained (150/hour) and burst (60/10 min) are enforced **separately**. That
  distinction is how the backfill once reached ~840/hour.
- Both caps are a fraction of the real limits. Sync never gets to be the reason
  a patient's registration is rate-limited.
- A run still marked `running` reserves its full allowance, so a crashed or
  losing run cannot quietly shrink the budget for ever.
- Actual use so far: **3 requests in the hour**, against a cap of 150.

Concurrency is a **durable row-level lease** in `appointment_sync_state` — a
compare-and-set that works across processes and machines and expires, not a PID
file on one host. The loser of a race records itself `lock_contended` and closes
its own row.

A run that cannot finish its window reports **partial** and leaves the cursor
where it was, so the next run re-reads the same ground. Coverage is never
inferred from a budget limit.

### Monitoring

`drsnip_sync_health()` answers, per schedule: last attempt, last success, last
outcome, run state (`idle` / `running` / `stalled`), cursor lag, failed and
partial runs in 24 hours, and whether recurring sync is genuinely active. The
`/api/reports/freshness` endpoint returns all of it, plus how many newly linked
patients are still awaiting their first history read.

### How to switch it off — two independent ways, neither needs a deploy

```sql
-- 1. The database stop switch. Checked before any DrChrono request.
UPDATE appointment_sync_schedules SET enabled = false, updated_at = now()
 WHERE schedule_key = 'incremental_hourly';       -- or 'patient_catchup_hourly'
```

```
-- 2. Deactivate the workflow in n8n:
--    "Appointment Sync — DrChrono incremental (hourly, scheduled)"   jUNJrRWhZkogFhpX
--    "Appointment Sync — new-patient catch-up (every 10 min)"        9Wvd36XnnbDdypaf
```

Either alone is enough, and neither requires the application. Both workflows are
exported to `n8n-rollback/` with credential references stripped.

---

## 4. What needs the clinic's confirmation

**One thing, and it is the only thing standing between you and attendance
reporting.**

> **Which appointment status values mean the patient physically arrived?**

The appointment history is loaded in full — 2,571 appointments and 9,870 status
transitions for all 2,037 linked patients. What is missing is not data. It is a
decision.

Six of this practice's status values are genuinely ambiguous and **no agent
should guess at them**:

| Status | Why it is ambiguous |
| --- | --- |
| *(empty string)* | The majority of this practice's rows. Means nothing on its own |
| `Scheduled` | Booked. Says nothing about arrival |
| `Confirmed` | Confirmed by whom, and before or after the visit? |
| `Complete` | Could mean the visit happened, or the record was closed out |
| `Signed No Review` | A charting state, not an attendance state |
| `Procedure Not Performed` | The patient may well have arrived |

The mapping lives in `lib/metrics/attendance-mapping.ts` as a versioned object
whose approval state is `awaiting_clinic_confirmation` with provenance `null`,
and a single gate — `attendanceIsApproved()` — that will not let any figure be
published until a person with authority signs it off. A previous agent's
recommendation is not clinic approval, and the code treats it that way.

Until then the console says, in plain words:

> **Attendance — Not available yet.** Appointment history loaded; attendance
> definition awaiting clinic confirmation.

**Two smaller things worth a sentence at the meeting:**

- Appointment *type* is not established. `/api/appointment_profiles` returns 403
  for this credential, so profile names cannot be resolved and **none of these
  figures is a confirmed vasectomy booking** — they are all appointment types
  for all providers.
- "Appointment record created" is the timestamp on the record. It is not proof
  of when a human booked, and it is not attendance.

---

## 5. Did the authenticated production checks pass?

**Yes, against v84**, signed in as the application's own provisioned viewer
account. No session was fabricated, no auth bypassed, and no test patient was
created. A 401 or a string found in a bundle is not authenticated verification
and neither was accepted here.

### Release and health

| Check | Result |
| --- | --- |
| Fly release running | **v84**, image `deployment-01M2ZV72HZVW0410HWD4C9GWNZ` |
| Machines | 2, version 84, `lax`, health check passing |
| `release_command` | completed successfully |
| `/healthz`, `/`, `/admin/signin` | `200`, `200`, `200` |
| Unauthenticated `/api/reports/{journey,booking,freshness}` | `401`, `401`, `401` |
| JavaScript errors on any page visited | none |

### Navigation and the new views

| Check | Result |
| --- | --- |
| Sign-in with the real provisioned account | passed |
| Reports navigation opens the new overview | passed, 1,869 ms |
| Clinic logo in the top-left, desktop and mobile | passed |
| Patient journeys reachable without first entering the group | passed |
| Demo labelled and separated | passed |
| `?journey=insurance` selects the insurance tab | passed |
| …survives a reload | passed |
| `?journey=registration` selects the registration tab | passed |
| …and Back returns to `?journey=insurance` | passed |
| Figures resolve; no skeleton left behind | passed, 8 ms after networkidle |
| The word "unknown" rendered anywhere | **no** |
| Attendance unavailable, with the correct reason | passed |
| Mobile horizontal overflow at 390 × 844 | **0 px** |
| Mobile Reports sheet lists Patient journeys | passed |

The freshness badge in production reads, in green:

> **Appointment data complete to Sep 20, 2026, 9:05 AM · updates hourly**

### The endpoints, authenticated

```
/api/reports/freshness                        200    36 ms
/api/reports/booking  (registration)          200    45 ms
/api/reports/booking  (insurance)             200    56 ms
/api/reports/journey  (registration→cons)     200    70 ms
/api/reports/journey  (appointment evidence)  200    57 ms
```

No response body contained a patient identifier, an appointment identifier, an
email or a name.

### Values cross-checked independently

The figures the production API returned were re-derived directly from the
database with **identical filters and the same observation instant**. Every one
matches:

| Measure | Production API | Independent DB check |
| --- | --- | --- |
| Booking eligible / recorded / advance | 1,554 / 989 / 975 | 1,554 / 989 / 975 |
| Consultation observed to date | 674 / 1,845 | 674 / 1,845 |
| Consultation within 14 days (mature) | 368 / 1,554 | 368 / 1,554 |
| Appointment evidence observed | 1,117 / 1,845 | 1,117 / 1,845 |
| Freshness `complete_as_of` | 2026-09-20 16:05:00Z | cursor 2026-09-20 16:05:00Z |

Freshness reports `state: live`, `update_mode: scheduled`, last successful run
2026-09-20 16:05:02Z, **0 failed runs in 24 hours** — and it says so because a
run succeeded, not because a schedule row exists.

### The synthetic demo is still isolated

Renders with both waterfall charts, labelled synthetic, and **Approve / Edit /
Skip issued zero `/api/` requests** — they remain simulations with no sending
endpoint.

### Local verification

- **`pnpm run test`: 554 tests, 539 passing, 0 failing** (15 skipped without
  their optional databases).
- Typecheck and production build clean.
- Screenshots at 1440 × 900, 820 × 1180 and 390 × 844: no horizontal overflow,
  no "unknown". Transient states — freshness in flight, freshness failed, a
  failed journey request, skeletons — forced and captured, since they cannot be
  reached by clicking.

### A defect this release found in itself

Capturing the logo blanked the entire admin area — no nav, no sign-out, white
screen:

```
TypeError: Cannot read properties of undefined (reading 'schedules')
```

`freshness.data?.sync.schedules` — the optional chain stops after `data` and
then dereferences twice more, so any `200` whose body is not the expected shape
throws. The shell's error boundary could not catch it either: pages in this app
self-wrap in `<AdminLayout>`, so a page's own function body runs *before* the
boundary exists. TypeScript could not object; the response is `unknown` at the
network boundary and the annotation is taken on trust. Every hop is now
optional, in the index, the badge and the page, with two assertions pinning it.

---

## 6. Remaining limitations

1. **Attendance is not reported**, and will not be until the clinic answers
   which status values mean the patient physically arrived (§4).
2. **Appointment types are not confirmed as vasectomy-specific.**
   `/api/appointment_profiles` returns 403 for this credential, so every figure
   covers all appointment types and all providers.
3. **"Appointment record created" is a timestamp on a record** — not proof of
   when a human booked, and not attendance.
4. **The weekly reconciliation pass has not run yet.** First one is Sunday
   27 September, 03:05 PT.
5. **PR #55 is open, not merged.** Nothing in the documented release process
   requires merging it, and merging was deliberately not done.
6. The repository has **no CI status checks configured**, so "checks passed"
   means the local suite above, not a pipeline.

---

## 7. Rollback

```sh
fly deploy -a drsnip-intake-demo --image drsnip-intake-demo:deployment-01M2YAAW90CQFGMDFWZC29N2BJ
# or:  fly releases -a drsnip-intake-demo   →   fly deploy --image <v83 image>
```

**Previous release:** v83, image
`drsnip-intake-demo:deployment-01M2YAAW90CQFGMDFWZC29N2BJ`.

The database migrations are additive and were already live under v83, which ran
normally under them, so rolling the application back needs **no database
change** — and should not be given one. Do not roll back `0015`–`0019`.

If recurring sync itself needs to stop, use either switch in §3. Neither
requires a deploy, and neither is affected by a rollback.
