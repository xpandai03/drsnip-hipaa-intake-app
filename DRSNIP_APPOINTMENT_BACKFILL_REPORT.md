# Dr. Snip appointment history backfill — report

**Date:** 2026-09-19
**Linkage as-of:** 2026-09-19 16:07 Pacific (2,030 distinct linked DrChrono patient ids)
**Scope:** load the appointment history needed to trace existing intake patients,
measure coverage, and leave a resumable, verified historical dataset.
**Not in scope:** conversion metrics, dashboards, recurring sync.

> Counts only throughout. No patient identifiers, appointment identifiers,
> free-text reasons, clinical content or individual timelines appear in this
> document, in the workflow configuration, or in any log.

---

## 1. Retrieval strategy, and why

Three candidate strategies were measured before committing budget, because the
cost difference between them is more than an order of magnitude.

### What the API actually does (all measured, not assumed)

| Behaviour | Finding | Consequence |
|---|---|---|
| `count` field | **Absent.** DrChrono returns `next`/`previous` but no total. | A window's size is knowable only by paging through it. No cheap pre-sizing. |
| `date_range` length | **Max 190 days unless the entire range is in the past.** | Future coverage must be chunked; history need not be. |
| `?patient=` | **Honoured.** Filtered probe returned rows for one patient only; the unfiltered control returned 48 distinct patients on one page. | Per-patient retrieval is viable. |
| `since=1970` + `?patient=` | Returns that patient's **entire history**, no date bound. | This is what makes "no appointment found" a defensible claim. |
| `page_size=250` | Works — **without** `verbose`. | 250 rows/request. |
| `verbose=true` | **Silently caps `page_size` at 50**, whatever value is sent. | Transitions cost 5× more requests per appointment. |
| History depth | **Zero appointments before 2018**; 2 in total before 2022. | The historical floor is real, not assumed. |

The `verbose` page-size cap is the finding that decided the design. It was
measured directly: the same window returned 250 rows without `verbose` and 50
rows with it, at an identical requested `page_size`.

### Cost comparison

| Strategy | Requests | Yield | Coverage |
|---|---|---|---|
| Practice-wide sweep, `verbose=true` | ~800+ | very low — one window fetched 2,000 appointments and kept **0** | date-bounded |
| Per-patient, `verbose=true` | ~2,030 (1/patient) | 100% | complete per patient, no date bound |
| **Practice-wide sweep, non-verbose** | **~190** | low per request, but complete | **all appointments, all linked patients** |

### Chosen: two phases

**Phase A — practice-wide scheduled-date sweep, non-verbose, 250/page.**
Establishes which appointments exist for every linked patient across the whole
horizon, for roughly 190 requests instead of 2,030. It carries every field the
projection stores *except* status transitions.

**Phase B — per-patient `?patient=` with `verbose=true`.** Adds transition
history, and turns every patient into a definitively answered question. Seeded
for all 2,030 linked patients and resumable.

**Phase A cannot damage Phase B's data, by design.** A response with no
`status_transitions` field is recorded as *not present*, never as deletion, and
the flag-missing step is skipped entirely for such responses. This was verified
in production: running a non-verbose window over already-populated appointments
left transitions at 1,201 with **0 flagged missing**.

Phase B is seeded for **every** linked patient, including the ones already
holding appointments. Earlier runs only ever saw a short last-modified window,
which is a slice of a patient's history, not the whole of it; seeding only the
appointment-less patients would leave the rest permanently half-covered while
looking finished.

---

## 2. Boundaries recorded

| Boundary | Value |
|---|---|
| Historical start | 2000-01-01 (floor is empirical: zero appointments before 2018) |
| Future horizon | 2028-03-31 |
| Linkage as-of | 2026-09-19 16:07 Pacific, 2,030 distinct linked patient ids |
| Window size | one quarter (≤92 days, under the 190-day API ceiling) |
| Page cap per unit | 40 pages, enforced by `$pageCount` in the node's completion expression |
| Scope keys | `historical_sweep`, `patient_history` — both separate from `practice_incremental` |

**Appointments beyond the horizon exist.** A probe of 2027-04-01 → 2027-09-27
returned 26 appointments, all for a single patient — consistent with a recurring
placeholder rather than patient bookings, but it is recorded here rather than
ignored. Anything scheduled beyond 2028-03-31 is outside Phase A coverage;
Phase B has no horizon and will capture it for linked patients.

---

## 3. Verification performed before loading anything

Production state was confirmed rather than taken from the previous report:
5 sync tables plus the new window ledger, 3 seeded scopes (now 5), all
watermarks `NULL`, dedupe unique index present, FK from transitions to snapshots
present, lease columns present.

### The earlier privilege change

- **Revoked:** `CREATE` on schema `public` **from `PUBLIC`** (the pre-PG15
  default this database still carried).
- **Who legitimately depended on it:** only the application/migration role
  `drsnip_intake_demo`. It now holds `CREATE` by an **explicit named grant**
  (visible in the schema ACL as `drsnip_intake_demo=C/pg_database_owner`), so
  migrations no longer depend on a `PUBLIC` grant. The two other non-superuser
  roles hold `USAGE` only and never needed `CREATE`.
- **Application and migration operations still permitted:** yes — the app role
  owns all 17 public tables and holds explicit `CREATE`.
- **Sync writer:** cannot create objects, cannot delete appointment or
  transition evidence, cannot read `submissions`, `users`, `sessions`,
  `submission_files`, `registration_partials` or `notification_events`. Its only
  view of intake is the linked-id view.

*The application connecting to Postgres as a superuser remains a separate
concern. It was not changed here, as instructed.*

### Concurrency: a correction to the reported state

**The lease does not serialize a historical writer against an incremental one.**
It is keyed per scope, and those two run under different scopes, so they can
interleave on the shared evidence tables. What actually protects those tables is
row-level, not lease-level:

- the snapshot upsert refuses any revision older than what is stored, so an
  older historical read cannot roll back newer evidence;
- transitions are unique on `(appointment, dedupe_key)`, so concurrent writers
  converge rather than duplicate.

A test now asserts exactly this across two scopes, because it is the case the
lease does not cover.

### n8n hazards re-checked against the live configuration

| Hazard | Live state |
|---|---|
| Linked ids collected once, not one request per item | `executeOnce: true` on both the ids node and the fetch node |
| Page cap actually binds | In `completeExpression` via `$pageCount`; `maxRequestCount` is **absent** because this n8n version ignores it |
| Reaching a cap marks the run partial | Verified live: a deliberate cap of 3 produced `partial`, `complete=false`, cursor untouched |
| Raw payload retention | `saveDataSuccessExecution`, `saveDataErrorExecution` = `none`; `saveManualExecutions` = false |
| No identifiers in output or config | Workflow JSON contains no patient ids; the only long number in it is a millisecond constant |

---

## 4. Defects found and fixed during this task

**The sync writer had no privileges on the new window ledger.** Migration 0013
created and granted the table; re-running 0012a then revoked it again, because
that file begins with `REVOKE ALL ... FROM drsnip_sync_rw` and re-granted only a
hard-coded list of five tables. The backfill failed at its first write. Fixed by
making 0012a own the complete table list and, more importantly, **assert it** —
it now raises if any sync table is not writable, so the same class of mistake
cannot ship again. The unrelated legacy `appointment_sync_events` table remains
deliberately inaccessible.

**A truncated window would have retried itself forever.** A unit that hit the
page cap was marked `partial`, which is claimable — so it would be re-read from
the beginning, truncate again, and never progress. Fixed: a capped unit is now
marked `split`, a terminal state the claimer ignores, and its date range is
re-planned as two halves that *are* claimable. Coverage then comes from the
children. Verified live: 2023Q4 hit the 40-page cap under `verbose`, was marked
`split`, and produced two child windows.

**0012a could not run on a database without the app role.** It hard-failed on
`GRANT ... TO drsnip_intake_demo`, which is exactly the situation on the
disposable database where it most needs verifying first. Now guarded.

**A test teardown deleted runs before the window rows referencing them,** which
the foreign key rejected; the failure surfaced as a hung test run rather than a
clear error. Teardown now releases references first and purges strays from
interrupted runs on startup.

---

## 5. Request budget and accounting

DrChrono limits: **500/hour**, throttling above **10/second** and above **290 per
rolling 10 minutes**. Five live intake workflows share this credential, though
their measured draw is small (roughly 1.4 submissions/hour × a few requests).

Pacing actually used:

- Phase A: one window per 120 seconds, each window ~12 requests at 250/page —
  about **360 requests/hour** sustained and roughly **60 per rolling 10 minutes**,
  against caps of 500 and 290.
- Phase B: one patient per 12 seconds — **300 requests/hour**.
- Within a window, pagination requests are spaced 1.2s apart by the node's batch
  interval, so a single unit cannot approach the per-second throttle.

Budget is enforced by a **counter, not by spacing alone**: a 2-second delay alone
would yield 1,800 requests/hour, over the limit on its own.

---

## 6. Coverage achieved

**Phase A: COMPLETE.** All 26 planned scheduled-date windows finished, covering
**2000-01-01 → 2028-03-31** with no gaps. 260 requests, 58,678 appointments
scanned, **2,571 kept**, 56,107 discarded before persistence as belonging to
patients who never came through intake.

**Phase B: PARTIAL — 101 of 2,031 patients (5.0%).** Resumable; see §9.

### Per-patient coverage

Linked patients at the close of the backfill: **2,031**.

| Classification | Patients | What it means |
|---|---:|---|
| `has_appointment` | **1,412** | At least one appointment loaded. |
| no appointment in the covered horizon | **619** | Phase A completed over 2000-01-01 → 2028-03-31 and found nothing for them. |
| ├─ confirmed by per-patient probe | 24 | `?patient=` with `since=1970` returned nothing: **no appointment on record at all**. |
| └─ not yet probed | 595 | No appointment *within the horizon*. Only a Phase B probe can rule out one beyond it. |

**69.5% of linked patients have appointment history loaded. 70.7% (1,436) are
definitively answered** — they either have appointments, or a no-horizon probe
confirmed they have none. The remaining 595 are a narrower question than "not
yet queried": Phase A already covered 28 years for them.

**This is not "100% patient coverage."** Every *fetched* appointment linked to
intake, but that is a statement about the fetch, not about the patients.

### Appointments and transitions

| Measure | Value |
|---|---:|
| Appointments stored | 2,571 |
| Distinct patients with appointments | 1,412 |
| Earliest scheduled (Pacific) | 2023-12-15 |
| Latest scheduled (Pacific) | 2026-12-28 |
| Earliest created (Pacific) | 2023-11-20 |
| Transitions stored | 1,683 across 418 appointments |
| Distinct `to_status` values | 19 |

Intake began 2026-06-15, yet the earliest loaded appointment for a linked
patient is **2023-12-15** — the sweep did find genuine pre-existing bookings,
which a last-modified window starting at the first intake date would have missed.

Only **418 of 2,571** appointments carry transition history, because Phase A is
non-verbose. That gap is Phase B's job and is quantified in §7.

### Appointments per patient

| Appointments | Patients |
|---|---:|
| 1 | 557 |
| 2 | 632 |
| 3–5 | 218 |
| 6–10 | 5 |

No bucket falls under the small-cell threshold of 5, so nothing is suppressed
here. Dimensions represented: **7 doctors, 3 offices, 13 appointment profiles**
(2 appointments have no profile). Profile *names* remain unresolvable — see §8.

### Data quality

| Check | Count | Reading |
|---|---:|---|
| Unlinked patients persisted | **0** | The linkage filter held across 58,678 scanned appointments. |
| `current_status` absent (NULL) | 0 | |
| `current_status` blank (`''`) | 627 | Preserved as blank, not coalesced. |
| Blank status *with* transition history | 59 | Blank current status does not mean nothing happened. |
| Deleted records retained | 98 | Evidence kept, not dropped. |
| Archived records retained | 0 | `show_archived=true` was used; none were archived. |
| Created at/after scheduled time | 635 (24.7%) | Recorded as-is, not repaired. |
| Transitions flagged missing | 0 | |

These are data-quality and coverage results. **No conversion metric, arrival
mapping or attendance claim is made anywhere.**

---

## 7. Replay, recovery and reconciliation

### Replay and recovery — verified in production

| Property | Result |
|---|---|
| Replaying a completed batch creates no duplicates | **Verified.** Re-ran the highest-yield window (18 pages, 4,449 scanned, 2,081 kept). Totals before and after: 2,571 appointments / 1,201 transitions — **identical**. `attempts` went to 2. |
| An interrupted batch resumes without skipping | **Verified.** The runner was interrupted three times. Each time the unit returned to `pending` and was re-claimed; the sweep still finished all 26 windows. |
| A page cap cannot mark history complete | **Verified.** A deliberate cap produced `partial`/`complete=false`; under `verbose` a real window hit the 40-page cap and was marked `split`, never `complete`. |
| Older responses cannot overwrite newer evidence | **Verified by test**, across scopes — the case the per-scope lease does not cover. |
| Failed batches do not advance checkpoints | **Verified.** Of 140 runs, 6 failed and 2 were partial: **0 advanced a cursor and 0 took a generation.** All five watermarks remain `NULL`. |
| Overlapping runs cannot corrupt shared state | **Verified by test.** Two genuinely overlapping claims: the loser blocks, re-evaluates, and matches nothing. Unit claiming uses `FOR UPDATE SKIP LOCKED`. |
| Non-verbose sweep cannot destroy transition history | **Verified in production.** A non-verbose window over already-populated appointments left transitions at 1,201 with 0 flagged missing. |

Synthetic failure cases are covered by 29 database tests that execute the
**actual** statements from `lib/sync/appointment-sync.sql`, plus 55 logic tests.
Full suite: **412 tests, 0 failures.**

### Reconciliation against the API

15 patients sampled deterministically, 26 appointments compared field by field.

| Field | Agreement |
|---|---|
| Appointment identity | 26 / 26 |
| Patient linkage | 26 / 26 |
| `created_at`, `scheduled_time`, `updated_at` | 26 / 26 each |
| Doctor, office, profile | 26 / 26 each |
| `current_status` (exact, `''` vs NULL) | 26 / 26 |
| `deleted_flag`, `archived` | 26 / 26 each |
| Transition count | **2 / 26** |

Stored rows absent from the API: **0**. API rows not stored: **0**.

**One discrepancy category, fully explained:** `transitions_missing_locally` for
24 of 26. These appointments were loaded by Phase A, which is non-verbose and
therefore carries no transitions. This is the known, deliberate Phase A
limitation — not corruption, and not silent loss: the schema records those
transitions as *absent*, never as *empty*.

**Consequently the transition scope is NOT called complete.** Appointment
coverage reconciles perfectly and Phase A is complete; transition coverage is
explicitly partial until Phase B finishes.

### Effect on existing operations

No rate-limit errors occurred: the final 90-unit batch ran **90/90 with zero
failures**. Intake stayed healthy throughout (`/healthz` 200), the five intake
workflows were untouched, and no row in `submissions` was modified.

### Live drift during the backfill

One new submission linked a patient *after* the linkage snapshot, so the
population grew 2,030 → 2,031 mid-run. This is the expected case, not an
anomaly: re-running the Phase B seed picked the new patient up automatically,
because it is a set difference against the linked-id view and never relies on
`submissions.updated_at` — which is never bumped and cannot detect anything.

---

## 8. Known historical limitations

Stated plainly, because each one bounds what a later cohort calculation may claim.

1. **"No prior appointment found within available history" is not "never
   booked."** Only a completed Phase B probe for a given patient licenses even
   that weaker statement. Patients not yet probed are `not_yet_queried`, and the
   coverage query keeps them in a separate bucket for exactly this reason.
2. **Phase A is bounded by a horizon** (2000-01-01 → 2028-03-31). Appointments
   scheduled beyond it are not in Phase A. A probe found 26 such appointments
   for a single patient. Phase B has no horizon and resolves this per patient.
3. **Phase A carries no status transitions.** Appointments loaded by Phase A
   alone have accurate identity, timing, provider, office, profile, status and
   deletion/archive flags, but their transition history is *absent, not empty*.
   The schema records that distinction; a metric must not read "no transitions"
   as "never progressed."
4. **`current_status` is a point-in-time observation**, not an outcome. It is
   stored verbatim, including blanks and the clinic's custom vocabulary. No
   arrival, attendance or completion meaning has been assigned anywhere in this
   pipeline.
5. **Appointment profile names remain unresolvable** — `/api/appointment_profiles`
   still returns 403 — so `profile_source_id` is a raw id. Any grouping by
   appointment type needs that endpoint, or a clinic-supplied mapping.
6. **No `count` field means no independent total.** Completeness is asserted from
   the window ledger (every planned unit `complete`), not from matching a number
   the API reports.
7. **The source can change while a sweep runs.** Appointments created, updated,
   cancelled or rescheduled mid-sweep are handled by the staleness guard and by
   the reconciliation pass, but a sweep is not a consistent snapshot and is not
   presented as one.

---

## 9. Resume instructions

Everything below is idempotent. Re-running a completed unit is a no-op.

**Workflow:** `tv3pTtAiyc18LyPz` — "Appointment Backfill — DrChrono historical".
It is **inactive** and has **no schedule**; it must be triggered manually.

**Resume Phase A (appointment coverage)** — only if units remain unfinished:

1. Open the workflow, set `Backfill Config` → `strategy: "scheduled_window"`,
   `verbose: false`, `page_size: 250`.
2. Execute once per remaining unit. Each execution claims the lowest-keyed
   unfinished unit automatically, so repeated execution walks the plan in
   chronological order.
3. Pace at roughly one execution per 75–120 seconds.

**Run Phase B (transition history + definitive per-patient answers):**

1. Set `Backfill Config` → `strategy: "patient_history"`, `coverage:
   "patient_history"`, `verbose` is irrelevant (the per-patient branch always
   uses it).
2. Execute repeatedly; each execution handles one patient, roughly one API
   request. Pace at about one per 12 seconds (~300 requests/hour).
3. Remaining work at any moment:
   ```sql
   SELECT state, count(*) FROM appointment_sync_windows
    WHERE strategy = 'patient_history' GROUP BY 1;
   ```

**If a run is interrupted**, nothing is lost: the unit stays claimable and the
scope lease expires on its own. To release it immediately:

```sql
UPDATE appointment_sync_state SET active_run_id = NULL, lease_expires_at = NULL
 WHERE scope_key = 'historical_sweep';
UPDATE appointment_sync_windows SET state = 'pending', last_run_id = NULL
 WHERE state = 'running' AND updated_at < now() - interval '10 minutes';
```

**A unit marked `split`** hit the page cap and was replaced by two halves, which
are already planned. No action needed.

---

## 10. Recommended incremental starting watermark

**Do not seed the incremental cursor from this backfill.**

All watermarks are still `NULL`, deliberately. A scheduled-date sweep establishes
which appointment *dates* were read; it says nothing about which records were
*modified* before a given instant. Seeding `practice_incremental` from a
historical run would make the first incremental run skip every edit made before
it — silently.

The correct procedure when incremental sync is switched on:

1. Capture `T = now()` **before** the first incremental run, not after.
2. Run the incremental workflow with scope `practice_incremental` and
   `coverage: "incremental_window"`. With `watermark = NULL`, it has no cursor
   to rewind from, so bound that first run explicitly — a `since` of a few days
   before `T` is enough to overlap anything the backfill was reading.
3. Let it advance the cursor **only on a complete, successful run**; the release
   statement already enforces that.
4. Thereafter, `sinceWithOverlap()` rewinds 120 minutes on every run so a record
   modified at a window boundary cannot slip through.

**Catch-up for newly linked patients.** Intake keeps adding patients, and
`submissions.updated_at` is never bumped, so it cannot detect them. Use the set
difference instead — this is what blocks [9] and [15] do — and re-seed
`patient_history` units periodically:

```sql
-- queues a probe for every linked patient not yet probed; already-complete
-- units are untouched
INSERT INTO appointment_sync_windows (window_key, strategy, patient_source_id)
SELECT 'patient:' || v.patient_source_id, 'patient_history', v.patient_source_id
  FROM drsnip_linked_patient_ids v
ON CONFLICT (window_key) DO NOTHING;
```

---

## 11. Readiness for journey progression

**Ready, for the appointment-level cohort; not yet for transition-level timing.**

What the dataset supports **now**:

- Which linked intake patients have appointments, over a complete 2000→2028-03
  horizon — 1,412 of 2,031, with 619 having none in that horizon.
- Booking timing: `source_created_at` versus `scheduled_time`, per patient and
  per appointment, in UTC and derivable to the clinic's Pacific day.
- Multiple appointments per patient (632 patients have exactly 2), and
  provider/office/profile breakdowns.
- Cancelled and deleted evidence retained (98 deleted records).

What it does **not** support yet:

- **Transition-based timing for most appointments.** Only 418 of 2,571 carry
  history. Finish Phase B before any metric reads appointment progression.
- **Any arrival/attendance/completion claim.** Statuses are stored verbatim and
  deliberately unclassified. The clinic still has to confirm what its custom
  values mean — the open question in `DRSNIP_PATIENT_JOURNEY_DEFINITIONS.md` §10.
  In particular, **635 appointments (24.7%) were created at or after their
  scheduled time**, which any naive "booked → attended" interval would
  misinterpret.
- **A denominator of 595 patients** whose status outside the horizon is
  unresolved. Cohort percentages should either exclude them explicitly or report
  them as unknown, not fold them into "no appointment".

---

## 12. Final state

| Item | State |
|---|---|
| Backfill workflow `tv3pTtAiyc18LyPz` | **inactive**, manual trigger only, no schedule node |
| Incremental workflow `zrLGSNqdm6lPatDa` | **inactive**, unchanged in behaviour |
| Probe workflow `1tiPE7fxBnuBeWDD` | **inactive**, read-only, counts-only output |
| Temporary triggers | removed |
| Temporary credentials | deleted |
| Pinned data | none |
| Execution payload retention | `none` for success and error; manual saves off |
| Patient identifiers in workflow config | none |
| Historical vs incremental cursors | separate scopes; **all five watermarks `NULL`** |
| DrChrono credential / scopes | untouched |
| Intake workflows | untouched |
| Git | nothing committed, pushed, or deployed |

### A secret was exposed during this task, and rotated

While diagnosing a stalled runner I listed the process table with `pgrep -fl`,
and the output included a `curl` command carrying the temporary webhook's header
secret and path. That printed the secret into the session transcript.

Remediation, performed immediately rather than deferred to end-of-task cleanup:
the credential was **deleted**, and a **new secret and new random path** were
issued. The old path was then confirmed to return **HTTP 404**. The replacement
credential has since been deleted as part of normal cleanup. No DrChrono or
database credential was involved, and the endpoint could only trigger a
read-only sync into our own tables.

The general lesson: never inspect the process table for a command that carries a
secret in its arguments.
