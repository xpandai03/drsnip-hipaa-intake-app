# Attendance status review — local implementation

**Date:** 21 September 2026 · Built and tested locally. **Not deployed, not
committed, no production migration applied, no production capability granted,
and no real mapping approved.**

Everything exercised below ran against disposable local databases of **synthetic
fixtures**. No DrChrono write, no patient message, no n8n change.

No patient identifiers, appointment identifiers, notes or clinical payloads
appear in this report or in any screenshot.

---

## 1. What was built

### The thing that did not exist

The specification called this an approval workflow. It is also **a metric that
had never been written**. A repository-wide search found no arrival logic in any
migration, SQL constant or metric function; `arrival_candidates` in
`attendance-mapping.ts` was read by nothing. Approving the old mapping would
have flipped a boolean and produced no number at all.

So the bulk of this work is the calculation.

### Files

| File | What it is |
| --- | --- |
| `lib/db/migrations/0020_attendance_review.sql` | Tables, the capability column, and five functions — including the one shared calculation |
| `lib/metrics/attendance-contract.ts` | Classifications, NULL-safe label identity, validation, provenance rules. Pure |
| `api/_lib/attendance-store.ts` | The only code that writes `attendance_mappings`; lifecycle rules in one place |
| `api/reports/status-inventory.ts` | The practice status vocabulary, both sources, suppressed |
| `api/reports/attendance.ts` | Published attendance. Resolves the approved mapping **in the database** |
| `api/attendance-mapping/{draft,preview,approve,withdraw,history}.ts` | The lifecycle |
| `components/reporting/attendance-review.tsx` | The card and the review panel |
| `components/reporting/attendance-outcome.tsx` | The published outcome card |
| `api/_test/attendance-review.test.ts` | 48 assertions |

Modified: `api/_lib/permissions.ts`, `api/_lib/auth.ts`, `lib/db/src/index.ts`,
`api-server/index.ts`, `pages/admin/Journeys.tsx`, `package.json`.

### The calculation, in one place

`drsnip_attendance_evidence(labels, metric, from, to, window)` is called by
**both** public entry points:

- `drsnip_attendance_metric(...)` — published. Resolves the approved mapping
  itself. **An ordinary caller cannot supply classifications.** If the API could
  pass a label set, "approved" would be advisory rather than a gate.
- `drsnip_attendance_preview(labels, ...)` — draft only, separately granted, and
  banded (§2.3).

It refuses, structurally, to: turn "tells us nothing" into non-attendance; count
a remote label as physical arrival; invent an arrival time; or publish a
patient-level "did not attend".

### Four outcomes, not two, and no rate

| Bucket | Meaning |
| --- | --- |
| `evidenced_in_window` | A **timed** transition to an approved physical status, after entry and inside the window |
| `evidenced_untimed` | Real evidence with no usable arrival time — an untimed transition, or a current status, which carries none. **Never** placed in the window |
| `evidenced_outside_window` | Timed, real, attributable to a different period |
| `not_established` | No record either way. Not a count of people who did not come |

Plus two overlapping annotations: `remote_only`, and
`in_window_resting_on_deleted_record`.

---

## 2. Corrections to the specification, and why

### 2.1 Unconfirmed evidence removed from the copy

The spec's card copy said *"969 past appointments already carry a record that the
patient was physically in the clinic"* and *"one decision away"*. Both were
wrong to ship: 969 is an appointment-level figure derived from a **proposed**
arrival set nobody approved, and "one decision away" overpromises when ten
labels are undecided.

The card now says exactly what was asked for and nothing more:

> **Attendance status review** — Appointment history is available. Confirm which
> clinic statuses establish physical arrival before publishing attendance.

No hardcoded counts anywhere in the UI; every number comes from the live
inventory. **No label is preselected**, and the spec's "Confirm all six as
physically here" bulk button was dropped — it would have been the product making
a clinical claim on the clinic's behalf.

### 2.2 The inventory is not a partition

The spec said to apply `suppressPartition` to the status inventory. That is
wrong and would have been security theatre: `suppressPartition` withholds the
next-smallest cell so a **total** cannot recover a withheld one, and status rows
**overlap** — one visit passes through several — so there is no total to
subtract from.

Implemented instead: plain per-cell suppression at 5, and **no total published
at all**. A withheld row also withholds its transition, office and provider
counts, so the row discloses nothing rather than narrowing the value.

### 2.3 Preview differencing: bands, not hidden deltas

The spec proposed hiding deltas, rounding hints and auditing. None of that
prevents subtraction — the caller holds both numbers, and an audit records an
attack rather than stopping it.

Implemented: **the preview never returns an exact count.** Each bucket comes
back as the band it falls in, width 10, floored. The difference of two bands is
not the difference of two counts, so a one-patient change is invisible unless it
straddles a boundary, and then it reveals only a run of ten. A cohort under two
bands is withheld outright (`withheld_small_cohort`).

Per-label impact hints were dropped entirely, as instructed.

This is a mitigation, not a proof: a determined reviewer could still
binary-search a boundary over many previews. It is proportionate because the
preview is admin-only, the population is a handful of named accounts, and every
preview is written to the audit table. Recorded as a limitation in §6.

### 2.4 Untimed evidence is its own bucket

The spec proposed falling back to `scheduled_time` for window attribution. A
scheduled time is not proof of when someone arrived — an appointment can be
recorded after the visit, and 635 of the real appointments were. So untimed
evidence is **never** placed in the window. It is counted, labelled and shown
separately.

### 2.5 Backdated records: the spec's rule was based on a fiction

The spec said a transition earlier than its record's creation is an "impossible
ordering" to be discarded as untimed. Checked against the real data:

```
transition_at IS NULL                                  0 appointments
transition_at < source_created_at                      0 appointments
records created at or after their scheduled time     635 appointments
```

Neither anomaly occurs. What *does* occur is the record being created after the
visit — which makes a transition preceding creation **credible**, not
impossible, if it ever appears. The rule was removed. Credible evidence is not
discarded on ordering alone. What remains is a guard against transitions ahead
of the evidence cutoff, which is a coverage question rather than a plausibility
one.

### 2.6 Remote presence: one contract, and the contradiction made unrepresentable

The spec said in one place that a remote flag may never contribute to physical
arrival, and in another that a label could be `arrival_confirmed` +
`remote_presence`. A reviewer cannot be asked to hold both.

Resolved: **remote presence is a classification, not an attribute.** A label is
physically present, or remote, or neither — never two. The contradiction is now
impossible to express rather than merely forbidden, and `validateLabelSet`
rejects a submission that carries a `remote_presence` flag with an explanatory
error. `procedure_signal` stays an attribute, because it genuinely is orthogonal
and touches no attendance figure either way.

### 2.7 No rate, and no "did not attend"

`explicit_absence` is storable as a reviewer's answer and **drives nothing**. No
rate is computed anywhere. A rate needs a dependable non-attendance marker, and
whether `No Show` is reliably set is an open clinic question (§7).

### 2.8 Lower bounds: the promise was wrong

The spec's copy promised figures "can only rise". True for adding
classifications at a fixed snapshot; **false** across revisions and source
corrections. The copy now reads:

> Confirming more statuses can move patients out of "not established". Revisions
> to the definition, and corrections at the source, can move figures in either
> direction.

### 2.9 Scope stated

Every inventory response carries: *"Appointments for patients linked to an
intake submission, as stored here. Not necessarily every appointment in the
practice."*

### 2.10 Booking semantics verified in source, not taken from prose

Checked `0015`/`0019` directly. Booking **excludes** deleted records from its
counts and matures against
`greatest(max(completed_at), practice_incremental watermark)`. Attendance reuses
that freshness rule exactly and **deliberately differs on deletion**: a deleted
record does not erase the observation that a patient was here, so its evidence
is kept and the count that rests on one is reported separately. No booking
behaviour was changed.

### 2.11 "Byte-identical dashboard" dropped

Acceptance criterion 30 of the spec required the unapproved dashboard to be
unchanged. That criterion contradicted the brief — the unavailable card is the
thing being replaced. Dropped deliberately. Existing metric values and approval
behaviour are preserved and tested.

---

## 3. Persistence and permissions

### Schema (migration 0020, applied locally only)

- `attendance_status_labels` — observed vocabulary. Identity is a **generated
  `label_key`** that maps NULL to a sentinel and prefixes real values, because a
  UNIQUE index treats NULLs as distinct from each other and so cannot key a
  nullable column. `normalized_key` exists **only** to surface near-duplicates.
- `attendance_mappings` — versioned, with `labels jsonb` copied in full on
  approval so a later draft edit cannot rewrite history.
- `attendance_review_audit` — append-only; counters and states, never label text
  or a count of people.
- `users.can_approve_definitions boolean NOT NULL DEFAULT false`.

Database-enforced, not application-enforced:

| Guarantee | Mechanism |
| --- | --- |
| At most one approved mapping per scope | partial unique index `WHERE state='approved'` |
| At most one draft per scope | partial unique index `WHERE state='draft'` |
| An approval always names a confirmer | `attendance_mappings_provenance_check` |
| Stale edits write nothing | `UPDATE … WHERE revision = $expected` → 0 rows → 409 |

### Permissions

`normalizeRole()` resolves anything that is not literally `"viewer"` to
`"admin"`, so every developer account is an admin. Approval therefore hangs off
an explicit capability that **fails closed**: `canApproveDefinitions` requires
the value to be exactly `true`, so a missing column, `"true"`, or `1` all deny.
Verified for junk roles in the tests.

| Action | viewer | admin | admin + capability |
| --- | :--: | :--: | :--: |
| View dashboard, published attendance, inventory, history | ✓ | ✓ | ✓ |
| Save a draft | — | ✓ | ✓ |
| Run a preview | — | ✓ | ✓ |
| Approve / withdraw | — | — | ✓ |

**No self-service escalation exists.** There is no endpoint that grants the
capability. To provision an authorised account later:

```sql
UPDATE users SET can_approve_definitions = true WHERE email = '<the person>';
```

run by a database operator, deliberately, against a named account. **No
production account has been granted anything.**

---

## 4. Test results

`pnpm run test` — **602 tests, 587 passing, 0 failing**, 15 skipped (suites
whose optional databases were not configured). Three consecutive clean runs.
Typecheck and production build clean.

`api/_test/attendance-review.test.ts` — 48 assertions. The ones that matter:

| Property | Result |
| --- | --- |
| Nothing classified → nothing established, nothing inferred | ✓ |
| **Every label "no arrival information" → identical to classifying nothing** | ✓ |
| Current-status-only evidence does not fabricate an arrival time | ✓ (lands in untimed) |
| An arrival later cancelled still counts | ✓ |
| Evidence on a deleted record kept, and counted separately | ✓ |
| Remote never counts as physical; classifying it physical *does* count | ✓ (both directions) |
| NULL and empty string classified independently (and additively) | ✓ |
| `MD In` does **not** match the recorded `MD  In` | ✓ |
| Buckets are mutually exclusive and sum to the eligible cohort | ✓ |
| Immature and uncovered excluded, not counted as absences | ✓ |
| A wider window moves outside-arrivals inside | ✓ |
| Approved row without provenance refused by CHECK | ✓ |
| Two approved / two drafts per scope impossible | ✓ |
| Stale revision writes nothing | ✓ |
| Published is "unapproved" while only a draft exists | ✓ |
| **Published exact figure falls inside the previewed band** | ✓ |
| Preview never returns an exact count | ✓ |
| Small cohort withheld outright | ✓ |
| Inventory suppresses small cells, publishes no total, keeps NULL/"" apart | ✓ |

### End-to-end against a real local server

Built server, real Postgres, three accounts, real sessions — not mocks.

```
GET  /api/reports/attendance          no session   401
GET  /api/attendance-mapping/draft    no session   401
POST preview / approve / withdraw     no session   401

viewer   PUT draft                                 403
viewer   POST preview                              403
viewer   POST approve                              403
admin    PUT draft                                 200
admin    POST approve   (no capability)            403
admin    POST withdraw  (no capability)            403
```

Full lifecycle:

```
draft saved                     → published attendance: "unapproved"
preview (banded)                → in_window 20–29, not_established 30–39
                                  cohort 78, eligible 66, immature 6
approve, stale revision         → 409
approve, no provenance          → "provenance is required"
approve, blank name             → "who confirmed this is required"
approve, confirmed_via junk     → "how it was confirmed is required"
approve, future date            → "the confirmation date cannot be in the future"
approve, correct revision       → version 1
                                  entered_by  approver@local.invalid
                                  confirmed_by Demo Clinic Owner (Practice owner)
                                  labels_approved 3   (the undecided one dropped)
published after approval        → 24 of 66 evidenced, 30 not established,
                                  6 untimed, 6 outside, 6 remote-only,
                                  10 labels still undecided, NO rate field
                                  (24 is inside the previewed 20–29 band)
withdraw, no reason             → 400
withdraw with a reason          → published: "withdrawn", with the reason and
                                  who had previously confirmed it
```

### UI

Screenshots in `attendance-review-screenshots/` (9 files), captured against the
real server. Desktop 1440 and mobile 390, approver and viewer.

- **0 px horizontal overflow** at both widths, **0 page errors**.
- Keyboard: focus reaches a classification radio; every control is a real
  labelled input inside a `fieldset` that is `disabled` for a viewer.
- The viewer sees the panel read-only and the line *"Approving a definition
  needs an authorised account."*
- Preview renders ranges (`20–29`), never a count.
- Loading, error+retry, empty, draft, saved, stale-edit (409) and approved
  states are all implemented and reachable.

**One fix made from a screenshot:** every label was flagged `NEW`, because the
flag was "first seen in the last 7 days" and a fresh inventory is entirely new.
It now means *appeared since the approval*, which is the question a reviewer
actually has.

---

## 5. Awaiting release

| Change | Note |
| --- | --- |
| `0020_attendance_review.sql` | Apply **by hand, after 0019**. Not registered in `migrate.ts` — it grants to `drsnip_metrics_fn` |
| `users.can_approve_definitions` | **Release coupling:** `findActiveUserByEmail` does a `SELECT *`, so the drizzle schema change and this migration must ship together or login breaks |
| Seven new routes | Registered in `api-server/index.ts`; the route-walk test now covers `api/attendance-mapping/` too |
| Capability grants | **None made.** See §3 for how to provision one |

`drsnip_refresh_status_labels()` is deliberately **not** `SECURITY DEFINER` — it
is the only function here that writes, and making the restricted metrics role
its owner would have meant granting that role INSERT and UPDATE. It runs as the
application role instead.

---

## 6. Remaining limitations

1. **Preview banding is a mitigation, not a proof.** Repeated previews could
   still binary-search a band boundary, and comparing published exact figures
   across two approved mappings can reveal what a single label contributed.
   Admin-only, audited, small named population.
1b. **The four attendance buckets are a partition** and were originally
   suppressed per cell, which leaked: subtract the other three from the eligible
   cohort. Corrected at release to the withhold-until-two rule. The status
   inventory is the opposite case and correctly keeps per-cell suppression.
2. **`remote_only` and `in_window_resting_on_deleted_record` overlap** the other
   buckets — they are annotations, not a fifth and sixth bucket. The API says
   so; a reader who sums everything will over-count.
3. **Scope is practice-wide only.** The column exists and the inventory reports
   how many offices and providers each label spans, but per-office mappings are
   not implemented.
4. **The audit table has no UI.** History is exposed; raw audit rows are not.
5. **`explicit_absence` is inert.** Stored, never published.
6. **No cross-journey deduplication.** A patient in both the registration and
   insurance cohorts is counted once per journey, as booking already does.
7. **Fixture hygiene:** running the demo server and the test suite against the
   same database at once produced one transient failure. They now use separate
   databases; a `.env.test` convention would make that harder to get wrong.

---

## 7. Clinic decisions still needed before anything is published

Unchanged from `DRSNIP_ATTENDANCE_STATUS_REVIEW.md`, and none of them is
answered by this work:

1. Do `Arrived`, `Checked In`, `In Room`, `In Session`, `MD In`, `MD Out` mean
   the patient was physically present?
2. Does `Complete` mean the patient was seen, or that the chart was closed?
3. Is `Ready in N` a room number?
4. Can `Checked In Online` be done from home?
5. What happens on appointments that end with no status at all (~30% of past
   appointments, every office, every month)?
6. **Is `No Show` reliably set?** Necessary for any rate — but **not
   sufficient**, and the earlier wording here was wrong. A rate also needs an
   agreed population, an observation window, coverage of unknown and
   conflicting evidence, and a rule for patients holding several appointments.
   A reliable absence marker unblocks the question; it does not answer it.
7. Do arrivals followed by a cancellation count as attended?
8. Is a practice-wide definition valid, or do offices differ?

The feature is built so these can be answered **one at a time**: a partial
approval publishes only what was confirmed, and everything else stays unknown
and visible.

---

## 8. Remaining integration and release work

1. Apply `0020` to production, together with the `lib/db` schema change.
2. Commit, push, update the PR, deploy, verify authenticated production.
3. Provision exactly one approval capability, to a named person.
4. Add `/admin/reports` copy pointing at the review, once it is live.
5. Consider a scheduled `drsnip_refresh_status_labels()` so new labels appear
   without someone opening the panel.
6. Optional: expose the audit trail, and per-office scope, if the clinic says
   offices differ.
