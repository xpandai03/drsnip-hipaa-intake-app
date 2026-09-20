# Dr. Snip reporting — final release

**Date:** 20 September 2026 · **Branch:** `feat/console-redesign-insurance-demo` · **PR:** #55

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

---

## 2. What is deployed

### Committed and ready

| Commit | What |
| --- | --- |
| `0cf4b7c` | `perf(reporting)` — the page-load fix |
| `26ef5a5` | `feat(sync)` — recurring appointment sync, its budget, its monitoring |
| `1bd4c23` | `feat(reporting)` — booking and attendance views reach production |
| `4d354cd` | `feat(console)` — Reports index, findable journeys, honest loading |

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

### Still to do — one step, and it needs your hand

`git push origin feat/console-redesign-insurance-demo` was **refused by this
environment's permission policy**, so the four commits above are on the branch
locally and not yet on the remote or in PR #55. Because this repo's rule is that
deployed code must be in a PR *before* the deploy, not after, **the Fly deploy
has not been run.** See §6.

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

That last sequence is the catch-up doing its job on a real new patient, three
minutes after they arrived, without anybody touching it.

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

**Yes — against the build that is deployed right now**, signed in as the
application's own provisioned viewer account. No session was fabricated, no auth
bypassed, and no test patient was created.

| Check | Result |
| --- | --- |
| Sign-in with the real provisioned account | passed |
| `/admin/journeys` renders authenticated | passed, networkidle in 781 ms |
| `/api/reports/journey` × 3 metrics | `200` in 41–74 ms (was ~6,000 ms) |
| Appointment-evidence branch works | 1,117 of 1,845 |
| No patient identifier in any response body | passed |
| JavaScript errors on the page | none |

A 401 or a string found in a bundle is **not** authenticated verification, and
neither was accepted here.

Local verification, in addition:

- Full test suite: **537 passing, 0 failing** (15 skipped without their optional
  databases) across `pnpm run test`, including 26 new assertions that pin the
  loading and freshness rules and 6 that pin "real reporting is easy to find".
- Typecheck and production build clean.
- Screenshots at 1440 × 900, 820 × 1180 and 390 × 844: **no horizontal overflow
  anywhere, and the word "unknown" rendered nowhere.** The transient states —
  freshness in flight, freshness failed, a failed journey request, skeletons —
  were forced and captured, since they cannot be reached by clicking.

### Not yet verified, because it has not happened

The four commits are **not on the remote and not in PR #55**, and the Fly deploy
has **not** been run — see §6. So `/api/reports/booking` and
`/api/reports/freshness` still return `404` in production, which the check above
records honestly. The booking views and the new freshness badge are not live
yet. Everything else in §2 — the speed, the sync, the cursor — **is** live,
because it is in the database rather than in the bundle.

---

## 6. The one remaining step

```sh
git push origin feat/console-redesign-insurance-demo
# then, from Intake-form/:
fly deploy -a drsnip-intake-demo
```

`git push` was **refused by this environment's permission policy**, not by the
remote and not by a branch protection rule. Nothing was worked around. Because
this repo's hard-won rule is that deployed code must be on a branch and in a PR
*before* the deploy — Fly deploys from the working tree, so it is entirely
possible to ship something that exists nowhere in git — the deploy was not run
either.

**Rollback point:** Fly `v83`, image
`drsnip-intake-demo:deployment-01M2YAAW90CQFGMDFWZC29N2BJ`.

The database migrations are additive and are already live under v83, which is
running normally and faster than before, so a rollback to v83 needs no database
change. If recurring sync itself ever needs to stop, use either switch in §3;
neither requires a deploy or a rollback.

### After the deploy, check these four things

1. `/api/reports/freshness` returns `200` (not `404` — that is how v82 shipped a
   dead route, and the test suite now walks `api/reports/` to make it fail
   locally instead).
2. `/api/reports/booking?metric=booking_registration&…` returns `200` with
   `recorded: 989`.
3. `/admin/reports` renders and the sidebar shows Patient journeys without
   clicking into it.
4. The appointment badge reads **"complete to … · updates hourly"**, in green.
