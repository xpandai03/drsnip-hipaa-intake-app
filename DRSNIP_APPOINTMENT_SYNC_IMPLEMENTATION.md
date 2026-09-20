# Dr. Snip appointment data sync — implementation record

**Date:** 2026-09-19
**Scope:** the minimum reliable sync connecting DrChrono appointments and status
history to the intake reporting database.
**Explicitly not in scope:** conversion metrics, dashboard changes, historical
backfill, scheduled execution.

Everything below was executed and verified. Where something did not work as
designed, the failure and the correction are recorded rather than smoothed over.

---

## 1. What exists now

| Thing | Identifier | State |
|---|---|---|
| Migration (tables) | `Intake-form/lib/db/migrations/0012_appointment_sync.sql` | applied to production, registered in `migrate.ts` |
| Migration (role/grants) | `Intake-form/lib/db/migrations/0012a_appointment_sync_grants.sql` | applied to production, **deliberately not** registered |
| Sync logic | `Intake-form/lib/sync/n8n-appointment-sync.code.js` | 55 unit tests |
| Write-path SQL | `Intake-form/lib/sync/appointment-sync.sql` | 23 tests execute these exact statements |
| Code-node build | `Intake-form/lib/sync/build-code-node.mjs` (+ `.glue.js`, `.generated.js`) | staleness enforced by test |
| n8n workflow | `zrLGSNqdm6lPatDa` — "Appointment Sync — DrChrono → intake DB (MANUAL, no schedule)" | **inactive**, manual trigger only |
| DB credential | n8n `tMxuwymCiFRtg1QW` → role `drsnip_sync_rw` | least privilege, password only in n8n |
| DrChrono credential | n8n `vCwf0HNhIwA3cFV1` (`DRSNIP-CHRONO`) | referenced only; **not modified** |

Test totals: **407 tests, 368 pass, 0 fail**, 17 cancelled (pre-existing
`DATABASE_URL` gap in the auth tests) and 22 skipped (the database tests, which
need a disposable database). Baseline before this work was 329 tests / 0 fail /
17 cancelled.

---

## 2. Architecture, and why

n8n writes to Postgres directly as a restricted role. No console release is
involved, which is what the brief asked for; n8n already holds the DrChrono
credential; and the role confines writes to five tables.

```
Manual Trigger → Pilot Bounds → Open Run → Claim Scope → Claimed?
  → Linked Patient IDs → Fetch Appointments (GET, paginated, OAuth)
  → Project Page (strips clinical fields, discards unlinked patients)
  → Upsert Snapshot → Build Transitions → Upsert Transition
  → Appointments With History → Flag Missing Transitions
  → Run Summary → Finish Run → Release Lease
```

A strictly linear chain is not an accident: it is what guarantees a snapshot row
exists before the transitions whose foreign key points at it.

### Tables

- `appointment_snapshots` — current known state of one appointment.
- `appointment_status_transitions` — the history, verbatim.
- `appointment_sync_runs` — one row per execution: bounds, counters, outcome.
- `appointment_sync_state` — per-scope watermark and concurrency lease.
- `appointment_sync_patient_queue` — patients whose linkage appeared later.

---

## 3. The constraints, and how each is enforced

**These tables are not PHI-free.** A patient identifier joined to an appointment
history is health information about an identifiable person. They are treated
exactly like `submissions`: the reporting role `drsnip_reporting_ro` is
explicitly revoked on all five, and that was verified from its own connection.

**Nothing clinical is stored.** `verbose=true` is required to get
`status_transitions` and it also returns `clinical_note`, `vitals`,
`custom_vitals` and `reminders`. The projector whitelists columns rather than
blacklisting them, and the glue throws if a forbidden field ever survives. There
is no raw-payload column, and **n8n execution saving is off** (see §6).

**No arrival set, no attendance claim.** Statuses are stored as the source sent
them. There is no `attended` column and no procedure-completion column. A test
greps the logic module to assert no classification constant was ever added.

**"Latest", not "terminal".** The schema and comments say latest observed
transition throughout.

**Evidence is preserved.** Cancelled, deleted and archived rows are kept
(`show_archived=true`). A transition missing from a later response is flagged
with `missing_since`, never deleted — an omission is not proof of a correction,
and re-observing it clears the flag. The writer role has **no DELETE** on either
evidence table, which is enforced in Postgres, not by convention.

**`''` and `NULL` stay different.** Blank status is the majority case; absent and
empty mean different things. The column is text, nothing coalesces it, and the
n8n Postgres option `replaceEmptyStrings` is explicitly false.

**No provider or profile filtering.** Every appointment in the window is read.
Appointment-type names are still unresolvable (`/api/appointment_profiles`
returns 403), so `profile` is stored as a raw id and classified later.

**`submissions.updated_at` is not used.** It is never bumped, so it cannot detect
anything. Catch-up is a set difference against the linked-id view.

**DrChrono access is read-only.** Every HTTP node in the workflow is GET; a check
of the stored workflow confirms `http verbs: ['GET']`.

---

## 4. Least-privilege database access

Role `drsnip_sync_rw`, created without a password in SQL; the password was
generated out-of-band and exists only in the n8n credential store. It is not in
this repository, in workflow JSON, or in any log.

The only intake data it can reach is the view `drsnip_linked_patient_ids`
(`SELECT DISTINCT n8n_patient_id` — no name, email, phone, DOB, form content or
submission id). Verified from the role's own connection in production:

| Probe | Result |
|---|---|
| `SELECT` on `submissions`, `users`, `notification_events` | **denied** |
| `DELETE` on `appointment_snapshots`, `appointment_status_transitions` | **denied** |
| `CREATE TABLE` in `public` | **denied** (after the fix in §5) |
| `SELECT` on `drsnip_linked_patient_ids` | allowed — 2,030 linked ids |
| `INSERT`/`UPDATE` on the five sync tables | allowed |

`0012a` ends with a DO block that raises rather than returning a false success,
so the boundary is asserted every time it runs.

---

## 5. What went wrong, and what was changed

These are the corrections that matter for anyone maintaining this.

**The writer could create tables in production.** `REVOKE CREATE ON SCHEMA public
FROM drsnip_sync_rw` was a no-op, because the privilege is held by `PUBLIC`.
PostgreSQL 15 made "no CREATE for PUBLIC" the default; this database predates
that and never had it applied — which is exactly why a freshly `initdb`'d test
cluster did **not** reproduce it, and why the first assertion block missed it.
Fixed by revoking from `PUBLIC` and granting CREATE back to the application role
`drsnip_intake_demo` **by name**, so its migrations no longer depend on an
accident. Net effect: strictly fewer privileges for every role except the app,
which keeps what it needs explicitly. An assertion now covers it. A probe table
created during this check was dropped; none remain.

**The request budget did not bind — twice.** The first pilot fetched 8 pages
against a declared cap of 3. The first hypothesis (that pagination expressions
cannot see other nodes) was wrong: setting a literal did not bind either. The
actual cause is that **this n8n version's HTTP node pagination has no
`maxRequestCount` or `limitPagesFetched` option at all** — the keys are accepted
and silently ignored. The budget now lives in `completeExpression` via
`$pageCount`, which the node itself evaluates, and a deliberate test run at a cap
of 3 confirmed it: 3 pages, `outcome: partial`, `complete: false`, cursor
untouched. Harmless at 8 pages, but a cap that can evaporate is not a budget.

**The pilot would have fired ~2,030 DrChrono requests.** `Linked Patient IDs`
emits one item per linked patient and an HTTP node runs once per input item.
Caught before any live run; `executeOnce` on the fetch node is load-bearing and
is documented as such in the node's notes.

**An empty page would have stranded the run.** n8n skips every downstream node
when a node emits zero items, so a window with no appointments would never reach
"Finish Run" or "Release Lease" and would hold the scope lease until it expired.
The projector now always emits at least one item, and the write statements are
`INSERT ... SELECT ... WHERE $1 IS NOT NULL`, which makes a sentinel a genuine
no-op.

**The concurrency guard could not have worked as first written.** It used a
multi-statement advisory-lock batch. node-postgres uses the extended protocol
whenever parameters are passed, and that protocol forbids multiple statements —
so it would have failed at runtime inside n8n. Replaced with a compare-and-set
lease on the state row, which is correct under READ COMMITTED (a colliding
UPDATE blocks, then re-evaluates its WHERE against the committed row) and is a
single parameterized statement. A test issues two genuinely overlapping claims
and asserts the loser blocks and then matches nothing.

**A pilot must not move a cursor.** The pilot originally ran under
`practice_incremental`. A pilot reads a short last-modified window, so advancing
that cursor to its cutoff would make a later incremental or backfill skip
everything older than the pilot window — the exact trap `backfillStartFloor()`
refuses. The pilot now runs under its own `pilot_bounded` scope and
`watermark_after` is always null for `coverage = 'bounded_pilot'`. All three
scope watermarks are still `NULL`.

**The split of `0012a` was justified with a wrong reason.** The original comment
claimed `CREATE ROLE` would fail because the app's DB user lacks the privilege.
It does not: `drsnip_intake_demo` is a **superuser**. The comments now say so.
The split stands on the real reason — `migrate.ts` has no ledger and replays
every registered step on every deploy, so nothing in that path should depend on
the app holding superuser. That the application connects to Postgres as a
superuser is worth a separate look; it was not changed here.

---

## 6. A deliberate deviation from the repo's n8n rule

`CLAUDE.md` states: *any workflow whose runs matter for audit must set
`saveDataSuccessExecution: "all"`.*

This workflow sets **`none`**, for success and error alike, with
`saveManualExecutions: false`. Saving executions would persist raw `verbose=true`
DrChrono responses — including `clinical_note` and `vitals` — into n8n's
execution store, which the brief forbids.

The audit record is `appointment_sync_runs` instead: one row per execution with
bounds, counters, outcome, coverage and a sanitized error summary. It is
queryable, retained indefinitely, and PHI-free — a better audit trail than n8n
execution blobs. **Consequence to accept:** debugging a failure means reading
that row and re-running, not opening an execution. Error text is sanitized
(emails and 4+ digit runs stripped, 300-char cap).

---

## 7. Live pilot results

Four manual runs against production, bounded to a 2-day **last-modified** window.

| Run | Pages | Seen | Persisted | Discarded | Transitions | Outcome | Cursor |
|---|---|---|---|---|---|---|---|
| 1 | 8 | 375 | 257 | 118 | 1,125 | success | unchanged |
| 2 (replay) | 8 | 375 | 257 | 118 | 1,125 | success | unchanged |
| 3 (cap = 3) | 3 | 150 | — | — | — | **partial** | unchanged |
| 4 (final) | 8 | 375 | 257 | 118 | 1,126 | success | unchanged |

**Idempotent replay proven in production:** run 2 reported identical counts and
the tables did not grow — 257 snapshots and 1,125 transitions before and after.
Run 4's 1,126 is one genuinely new transition from clinic activity between runs,
not a duplicate.

Data written (counts only):

- 257 appointments, **0 belonging to patients not linked to intake**
- 118 discarded as unlinked, before anything was persisted
- 1,126 transitions across 257 appointments, 18 distinct `to_status` values
  including the clinic's custom vocabulary (`MD In`, `Ready in 1/2/3`,
  `Late Cancel within 48 hrs`) stored verbatim
- 32 rows with blank (`''`) status, preserved as blank
- 2 deleted rows kept
- 33 appointments created at or after their scheduled time — recorded as-is, not
  repaired
- 0 transitions flagged missing

Intake was unaffected: 3,015 submissions, **0 rows modified by the sync**, app
`/healthz` 200, all intake workflows untouched (none show an `updatedAt` from
this session).

---

## 8. Cleanup performed

This n8n instance has no MCP execution path for manual triggers, so the pilot was
run through a temporary webhook: random 32-hex path, 56-character header secret,
TLS, on this workflow only. It has been fully removed:

- temporary trigger node deleted — the only trigger left is `Manual Trigger`
- temporary credential deleted (credential list is back to 4 + the sync writer)
- workflow **deactivated**; no schedule or cron node exists in it
- no pinned data
- local plaintext copies of the webhook secret shredded; the disposable local
  Postgres cluster removed
- no real patient identifiers appear in the workflow, the tests or this document

---

## 9. Rollback / disable

In increasing order of severity. **Nothing here drops a populated table.**

1. **Stop it running.** The workflow is already inactive and has no schedule.
   Deactivating is sufficient; nothing runs on its own.
2. **Revoke the writer.** `ALTER ROLE drsnip_sync_rw NOLOGIN;` — instant, keeps
   all data and all history.
3. **Rotate the credential.** `ALTER ROLE drsnip_sync_rw PASSWORD '<new>';` then
   update n8n credential `tMxuwymCiFRtg1QW`. The password is not recorded
   anywhere outside n8n, so rotation is the recovery path if it is needed.
4. **Reset the sync without losing evidence.**
   `UPDATE appointment_sync_state SET watermark = NULL, active_run_id = NULL,
   lease_expires_at = NULL, history_complete = false;`
5. **Unstick a crashed run.** Leases expire on their own (30 minutes). To force:
   `UPDATE appointment_sync_state SET active_run_id = NULL WHERE scope_key = '…';`
6. **Remove the schema.** Only after an explicit decision to discard the data,
   and only by hand. `0012` is `CREATE TABLE IF NOT EXISTS` throughout and
   contains no `DROP`. Removing `0012_appointment_sync` from the `STEPS` array in
   `api-server/migrate.ts` stops it being replayed on deploy without touching any
   row.

The migration was applied with `lock_timeout = '5s'` and
`statement_timeout = '120s'`, inside a transaction, as the application role so
object ownership matches what a deploy would produce. It is additive only: no
existing table, column, index or grant was altered or weakened. Replaying every
migration from `0000` twice was verified clean on a disposable cluster first.

---

## 10. What is deliberately not done

- **No historical backfill.** All three scope watermarks are `NULL` and
  `history_complete` is false everywhere. `backfillStartFloor()` **refuses** to
  start from an inherited watermark and requires an explicit floor.
- **No recurring execution.** No schedule node exists; the workflow is inactive.
- **No conversion metrics and no dashboard change.** `coverage` and
  `committed_generation` exist so a later dashboard can tell finished data from
  work in progress, but nothing reads them yet.
- **The catch-up queue is built but not wired** into the workflow. Blocks [9]–[11]
  of `appointment-sync.sql` are tested and ready; the pilot did not need them.

## 11. Before scheduling this (next task's checklist)

1. Point it at `practice_incremental`, not `pilot_bounded`, and set
   `coverage: 'incremental_window'`.
2. Raise `$pageCount` in `completeExpression` deliberately, and keep the sync's
   share of DrChrono's 500/hour well under the limit — five live intake
   workflows share that credential.
3. Decide the backfill floor explicitly. Do not let it inherit a cursor.
4. Confirm with the clinic what the custom statuses mean before any metric treats
   them as arrival or attendance. That question is still open in
   `DRSNIP_PATIENT_JOURNEY_DEFINITIONS.md` §10.
