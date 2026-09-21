# Attendance status review and approval — implementation specification

**Date:** 21 September 2026 · Specification only. Nothing was built, migrated,
deployed or approved, and no workflow or approval state was changed.

No patient identifiers, appointment identifiers, notes or clinical payloads
appear here. All counts are aggregates already published in
`DRSNIP_ATTENDANCE_STATUS_REVIEW.md`.

---

## 0. The one-sentence summary

Everything except the clinic's answers can be built now, because the gate is
already a single well-placed boolean — but that boolean needs to become a
**stored, versioned, per-label decision with a named clinic confirmer**, and the
attendance calculation it unlocks **does not exist yet anywhere in the codebase**
and has to be written from scratch.

---

## 1. Current implementation — what is actually there

### 1.1 The gate exists and is correctly placed

| Thing | Where | State |
| --- | --- | --- |
| Mapping contract | `lib/metrics/attendance-mapping.ts` | `version: "0.1.0-draft"`, `approval.state: "awaiting_clinic_confirmation"`, `provenance: null`, `approved_on: null` |
| The only gate | `attendanceIsApproved()`, same file | Returns true only when `state === "approved"` **and** `arrival_candidates.length > 0` |
| API consumer | `api/reports/booking.ts` L124–130 | Emits `attendance: { available, mapping_version, approval_state, reason, outstanding_decision }` |
| UI consumer | `artifacts/intake-form/src/pages/admin/Journeys.tsx` | Renders an `UnavailableCard` plus a "What is needed" card |
| Registry entry | `lib/metrics/registry.ts` → `UNAVAILABLE_METRICS` | `appointment_attendance_rate`, blocked on a decision, not on data |
| Unknown-label rule | `classifyStatus()` | Anything unnamed returns `"unknown"` — never `non_arrival` |

The design here is sound and should be kept. In particular `classifyStatus`
already refuses to fold an unrecognised label into "did not arrive", which is
the single most important safety property of the whole feature.

### 1.2 What does **not** exist

**There is no attendance calculation.** A repository-wide search finds no
arrival logic in any migration, SQL constant or metric function. `0015`'s
`drsnip_booking_metric` computes booking evidence only; `drsnip_status_evidence`
returns a status inventory. The `arrival_candidates` list in
`attendance-mapping.ts` is **never read by any query**. Approving the mapping
today would flip a flag and produce nothing.

So this feature is: a stored mapping, an approval workflow, **and a new metric**.

### 1.3 The mapping is a hard-coded constant, not data

`CURRENT_MAPPING` is a TypeScript literal compiled into the bundle. Approving it
means a code change and a deploy, there is no audit history, no reviewer
identity, and no way for the clinic to revise it. That is the core gap.

### 1.4 Permissions today: two roles, and neither fits

`api/_lib/permissions.ts` defines exactly `"admin" | "viewer"`.
`normalizeRole()` resolves anything that is not literally `"viewer"` to
`"admin"`, matching migration `0007`'s `DEFAULT 'admin'`. Named predicates
(`canDeleteSubmission`, `canExportSubmissions`, …) all reduce to `isAdmin`.
Guards live in `api/_lib/auth.ts`: `requireAuth`, `enforceAdmin`,
`requireAdmin`.

**There is no capability that means "authorised to state what this clinic's data
means."** Every developer and every operations account is `admin`. Approving a
clinical definition is not the same privilege as exporting a CSV, and the role
model currently cannot tell them apart. §4 fixes this.

### 1.5 Suppression already has the right primitives

`lib/metrics/contract.ts`: `SUPPRESS_BELOW = 5`, `suppressCount`,
`suppressPair` (withholds both sides and the rate when either side or the
complement is small), `suppressPartition` (withholds the next-smallest until at
least two cells are unknown, so a total cannot recover one), `suppressDurations`.

**Reuse these. Do not write new suppression.** `suppressPartition` is exactly
the rule needed for a status inventory and for the impact preview.

### 1.6 Evidence available to build on

From `DRSNIP_ATTENDANCE_STATUS_REVIEW.md`, already verified:

- Nine labels appear **only in transition history**, never as a current status —
  they are in-visit states. Current status alone is blind to arrival.
- 969 appointments carry a transition to a label the patient could not reach
  remotely.
- 945 end `Complete`; 924 also have in-person evidence, 11 only a `Ready in N`,
  **10 none at all**.
- 627 end blank; **zero** of them have in-person evidence; all but a handful are
  past-dated; spread evenly over three offices, six of seven providers, ~30% of
  past appointments every month since June.
- 15 appointments have arrival evidence *and* a cancel/no-show/reschedule
  somewhere; for 9 that is the final status.

---

## 2. Classifications

### 2.1 Three choices are not sufficient

The proposed set — *confirms arrival* / *does not establish arrival* / *unsure* —
fails on three real cases in this data:

1. **`No Show`.** Lumping it with "does not establish arrival" throws away the
   only positive evidence of non-attendance the clinic records. Without it there
   is no defensible denominator, ever.
2. **`Checked In Online`.** Genuine presence, possibly not *physical* presence.
   Forced into a binary it is either a false positive or a silent undercount.
3. **`Complete` and `Procedure Not Performed`.** These speak to what happened
   during a visit, not whether one occurred. A single axis makes `Complete` look
   like an arrival answer, which §1.6 shows it is not.

### 2.2 Recommended: four classes on one axis, two independent attributes

**Axis — what this label says about physical arrival.** Exactly one per label.

| Class | Reviewer-facing wording | Meaning | Default |
| --- | --- | --- | --- |
| `arrival_confirmed` | "The patient was physically here" | Positive evidence of physical presence | — |
| `no_arrival_evidence` | "Tells us nothing either way" | Carries no information about arrival. **Never means the patient did not attend.** | — |
| `explicit_absence` | "The patient did not come" | A positive record of non-attendance | — |
| `unclassified` | "Not decided yet" | Not yet reviewed, or deliberately deferred | **Yes** |

**Independent attributes.** Checkboxes, not classes — they never make a label
count as arrival:

| Attribute | Reviewer-facing wording | Why separate |
| --- | --- | --- |
| `remote_presence` | "Patient was present, but remotely" | Presence without physical arrival. Counted in its own figure, never in physical attendance |
| `procedure_signal` | "Says something about whether the procedure happened" | Procedure completion is a different measure. Flagging it here stops it leaking into attendance, and records it for later |

**Rules that follow, and must be enforced in code:**

- `no_arrival_evidence` may **never** be counted as non-attendance anywhere. It
  is the absence of information.
- `unclassified` may never establish arrival **or** absence.
- `remote_presence` may never contribute to physical attendance, whatever its
  class. A label may be `arrival_confirmed` + `remote_presence` only if the
  clinic says the remote check-in requires the patient to already be on site; in
  that case the attribute is a note, not a modifier.
- `procedure_signal` has no effect on any attendance figure. It exists so the
  review captures the fact while the reviewer is looking at it.
- No label is classified by this specification. Every one starts `unclassified`.

### 2.3 Label identity and matching

**Store and match on the exact source string.** Never mutate what DrChrono sent.

- **Primary key:** the raw label, byte for byte, plus its source column
  (`current_status` or `to_status`) — these are separate inventories (§2.6).
- **`NULL` and `""` are different and stay different.** The sync projector
  already preserves this deliberately (`lib/sync/n8n-appointment-sync.code.js`:
  `status` keeps the `''` vs `null` distinction, "the difference is
  load-bearing"). Display as **"(no status set)"** and **"(empty status)"**. Do
  not merge them in the UI or the mapping. *(In current production data only
  the empty-string form occurs; the null form must still be representable.)*
- **Whitespace and case: normalise for grouping, never for storage.** Compute
  `normalized_key = casefold(collapse_internal_whitespace(trim(label)))` and use
  it **only** to detect near-duplicates. When two raw labels share a
  `normalized_key`, the UI shows them as one row **with a visible note**:
  > `MD In` · also seen as `MD  In` — confirm these are the same thing
  Each raw label is classified individually. Silent merging is forbidden: two
  labels that differ only by a space may be two different front-desk habits.
- **New labels** appear automatically in the inventory as `unclassified`, with a
  "new since approval" marker and the date first seen. A new label **never**
  invalidates an existing approval and **never** blocks reporting (§3.6).
- **Office and provider scope.** A mapping row carries a `scope`. Ship with
  `scope = 'practice'` only, but make it a first-class column so a later
  `office:<id>` scope needs no migration of meaning. The inventory shows, per
  label, **how many offices and providers it occurs at** (never their ids), so
  the reviewer can see when a practice-wide claim is unsafe. The approval record
  states the scope it was confirmed for; a practice-wide default is a choice the
  clinic makes explicitly, not one the product makes for them.

### 2.4 What the reviewer is asked, per label

For each label the panel shows: the exact text, where it occurs (current status,
history, or both), suppressed appointment counts for each, how many offices and
providers it appears at, and one plain question. The questions are the ones in
`DRSNIP_ATTENDANCE_STATUS_REVIEW.md` §"Findings table"; the panel is their
delivery mechanism.

### 2.5 Procedure completion is explicitly out of scope

Attendance must not wait on it and must not imply it. `procedure_signal` records
which labels might bear on it. No procedure metric is specified here.

### 2.6 Two outputs that must never be confused

| | **A. Practice status inventory** | **B. Journey attendance metric** |
| --- | --- | --- |
| Purpose | Reviewing definitions | Reporting on a cohort |
| Unit | **Appointments** | **Distinct linked patient ids** |
| Scope | Every stored appointment, all time, all patients | Patients whose first submission of the chosen form type falls in the selected period |
| Window | None | The selected follow-up window, elapsed hours from entry |
| Cutoff | None | Matured against the appointment cursor |
| Overlap | Rows overlap heavily — a visit passes through several labels | Buckets are mutually exclusive per patient |
| Sums to a total? | **No** | **Yes**, to the eligible cohort |
| Where it appears | Inside the review panel only | The Patient journeys dashboard |

Enforcement: different API paths (`/api/reports/status-inventory` vs
`/api/reports/attendance`), different `unit` fields in the payload
(`"appointments"` vs `"distinct_patient_ids"` — both already in `MetricUnit`),
and the literal sentence *"These are appointments, not patients, and they
overlap — they do not add up"* rendered inside the inventory.

---

## 3. The attendance calculation

### 3.1 Evidence

**Arrival evidence for one appointment** exists when either holds:

1. Any row in `appointment_status_transitions` (with `missing_since IS NULL`)
   whose `to_status` maps to a label classified `arrival_confirmed` and **not**
   flagged `remote_presence`; **or**
2. `appointment_snapshots.current_status` maps to such a label.

History is primary; current status is a fallback for the same vocabulary. Both
are needed: `Checked In` and `Ready in 2` do occur as current statuses, and nine
in-visit labels occur only in history.

**`deleted_flag` does not remove evidence.** The appointment record was deleted
at source; the observation that the patient was here was still made. Deleted
appointments are excluded from *booking* counts (existing rule) but their
arrival evidence is retained and reported, with a separate count of how many
arrivals rest on deleted records.

### 3.2 The arrival timestamp

`arrival_at` = the **earliest** `transition_at` among qualifying transitions.

| Situation | Rule |
| --- | --- |
| `transition_at` is NULL | Arrival is **established but untimed**. Counts as arrival evidenced. Excluded from any time-to-arrival statistic. For window attribution, fall back to `scheduled_time`, and flag the appointment `timing_inferred` |
| `transition_at` < the appointment's `source_created_at` | Impossible ordering — treat as **untimed** (as above). Do not invent a time, do not clamp silently |
| `transition_at` > the evidence cutoff (the sync cursor) | Ignore the row for this run; it is ahead of what we claim to have read |
| Two qualifying transitions with the same timestamp | Earliest by `(transition_at, dedupe_key)` — deterministic, and the choice does not change the count |
| Only `current_status` establishes arrival | Untimed. `source_updated_at` is the row's last touch, not an arrival time, and must not be used as one |

### 3.3 Arrival followed by cancellation, no-show, reschedule or deletion

**Arrival stands.** The earliest qualifying arrival is evidence; nothing later
erases it. A patient who walked in and was then marked cancelled still walked
in — 9 appointments in current data are exactly this.

The dashboard therefore reports two different facts and labels them as such:

- **Arrival evidenced** — did the patient come?
- **Final disposition** — what does the appointment say now?

An appointment may be both "arrival evidenced" and "cancelled". That is not a
contradiction and must not be resolved by picking one.

The only thing that removes evidence is the transition **disappearing from the
source**, which the sync records as `missing_since` and which the queries
already exclude. That is re-reading, not inference.

### 3.4 Multiple appointments, and counting units

- **Patient level (the journey metric):** a patient is *arrival evidenced* when
  **at least one** qualifying appointment exists in their window. One patient
  counts once however many times they came.
- **Appointment level (the inventory, and context cards):** counts appointments.
- Never mix. The payload's `unit` field says which, and the two live behind
  different endpoints (§2.6).
- Where one human holds two charts, this is a chart count — the existing
  caveat on the Patient journeys page already says so and still applies.

### 3.5 Pre-existing appointments and arrivals before entry

An arrival only counts toward a journey when `arrival_at > entry_at` (the
patient's first submission of that form type) **and** `arrival_at <= entry_at +
window`. Arrivals before entry are excluded from the metric and reported in the
existing *"Had a past visit before entry"* context card, which already exists
and is already a separate, overlapping category.

For untimed arrivals (§3.2), window attribution uses `scheduled_time`; if that
is also absent the appointment is **not attributable** and is counted as
`arrival evidenced, unattributable` — visible, never silently dropped.

### 3.6 Cohort, window, maturity — identical to booking

Reuse the booking rules exactly, so the two figures are comparable:

- **Cohort:** patients whose first submission of the form type falls in the
  selected Pacific-day period.
- **Window:** `N × 24` elapsed hours from entry. Never `interval 'N days'` —
  that is calendar arithmetic and spans 169 hours across a DST boundary.
- **Maturity:** measured against the appointment cutoff —
  `greatest(max(completed_at) over completed history units, practice_incremental
  watermark)` (migration `0019`) — **never** `now()`. A patient whose window ran
  past the last observation is *immature*, not an absence.
- **Eligibility:** the patient's appointment history must be retrieved
  (`appointment_sync_windows.state = 'complete'`), as booking already requires.

### 3.7 Partial approval — and why it is safe in exactly one direction

With only some labels approved:

- An approved `arrival_confirmed` label **can** establish arrival.
- An `unclassified` label can establish **nothing**.
- Therefore the arrival count is a **lower bound**: approving more labels can
  only move patients from *not established* into *arrival evidenced*.

That asymmetry is what makes partial approval publishable. It must be stated on
the page, in those words, not buried:

> At least this many. Confirming more status labels can only raise this figure.

The inverse is **not** safe: partial approval can never support a "did not
attend" figure, because an unclassified label might have been an arrival.

### 3.8 Can anything defensibly be called "did not attend"?

**Recommendation: ship with two outcomes, not three.**

- **Arrival evidenced**
- **Arrival not established**

Add a third — *did not attend* — only when **both** hold:
(a) at least one label is classified `explicit_absence`, and (b) the clinic has
confirmed that label is **reliably** set. `No Show` occurs on 31 appointments
while 627 end blank, which is not consistent with a reliably-set absence marker.
Until Jeff answers, treating `No Show` as the denominator would mean claiming a
~99% attendance rate, which would be false.

**No attendance rate is specified here.** When one is published it must carry
its cohort, timing rule and evidence requirement (§3.6), and print the
*not established* count beside it at the same size. On a core-only approval that
count is roughly 45% of past appointments — the most important number on the
card, not a footnote.

### 3.9 Worked examples

| # | Situation | Outcome |
| --- | --- | --- |
| 1 | Registers 1 Aug. Appointment created 3 Aug for 20 Aug. History: `Scheduled` → `Confirmed` → `Checked In` → `In Room` → `Complete`. 14-day window | Booked ✓. **Arrival evidenced ✓** at the `Checked In` timestamp — but 20 Aug is outside a 14-day window from 1 Aug, so *not* counted in the 14-day attendance metric. Counted at 30 days. Two different questions, two different answers |
| 2 | Same, but history is `Scheduled` → `Complete` with nothing in between | Booked ✓. **Arrival not established.** `Complete` is not classified `arrival_confirmed`. One of the 10 |
| 3 | History reaches `In Room`, current status is now `Cancelled` | **Arrival evidenced ✓**, final disposition *cancelled*. Both shown. One of the 9 |
| 4 | Two appointments in the window; the first no-shows, the second reaches `MD In` | Patient counted **once**, arrival evidenced. Appointment inventory shows both |
| 5 | `Arrived` transition with a NULL `transition_at` | Arrival evidenced ✓, **untimed**. Window attribution uses `scheduled_time`; excluded from time-to-arrival |
| 6 | Current status blank, one blank→blank transition, appointment was last week | **Arrival not established.** Not "did not attend" |
| 7 | Arrival evidenced, appointment later deleted at source | Arrival evidenced ✓, and counted in "arrivals resting on a deleted record" |
| 8 | Patient's only arrival predates their registration | Excluded from the journey metric; appears in *"Had a past visit before entry"* |
| 9 | A new label `Ready in 5` appears after approval | `unclassified`. Establishes nothing. Approved reporting continues. Card shows "1 new status seen since approval" |
| 10 | `Checked In Online` approved as `arrival_confirmed` + `remote_presence` | Does **not** count toward physical attendance. Reported separately as remote presence |

---

## 4. Lifecycle: Unconfigured → Draft → Preview → Approved → Superseded

### 4.1 States

| State | Meaning | Effect on the dashboard |
| --- | --- | --- |
| **Unconfigured** | No mapping has ever been approved | Attendance unavailable, current copy |
| **Draft** | A reviewer is editing. One draft per scope | **None.** Published metrics read the approved row only |
| **Preview** | Not a stored state — a read-only computation over a draft | None |
| **Approved** | One active mapping per scope | Attendance published, as a lower bound |
| **Superseded** | Replaced by a newer approval, or withdrawn | Retained forever for audit |

### 4.2 Draft isolation

The published path resolves the mapping by `state = 'approved' AND scope = …`.
A draft is invisible to it by construction, not by a flag. Saving a draft
touches no published figure and needs no cache invalidation.

### 4.3 Approval record

Approval writes, atomically:

| Field | Notes |
| --- | --- |
| `version` | Monotonic per scope: `1`, `2`, … Not semver. Never shown in the main flow |
| `scope` | `'practice'` today |
| `approved_by_user_id` | **The authenticated user who pressed the button** |
| `approved_at` | Server clock |
| `confirmed_by_name` | **The clinic person who made the decision.** Free text, required |
| `confirmed_by_role` | e.g. "Practice owner". Required |
| `confirmed_via` | `call` / `email` / `in_person` / `written`. Required |
| `confirmed_on` | The date the clinic actually said it — may precede `approved_at` |
| `note` | Optional, e.g. "Confirmed on the Monday call; follow-up email to come" |
| `evidence_as_of` | The appointment cursor at approval |
| `labels` | The complete label → class + attributes set, **copied in full**, immutable |

Copying the full label set — rather than referencing the draft — is what makes
history auditable: the draft can be edited afterwards without rewriting what was
approved.

**The distinction between `approved_by_user_id` and `confirmed_by_name` is the
point of this table.** An operations user can enter a decision Jeff made
verbally, and the record says so: *who typed it*, *who decided it*, *how*, and
*when they decided*, separately. The UI wording makes this explicit (§6.5), and
both fields are shown wherever provenance is displayed.

### 4.4 Preview and approval share one code path

`computeAttendance(mappingLabels, cohort, window, asOf)` is a pure function of
its inputs, called identically by:

- `POST /api/reports/attendance/preview` with the **draft** label set, and
- `GET /api/reports/attendance` with the **approved** label set.

No second implementation. A test asserts that previewing the approved mapping
returns byte-identical numbers to the published endpoint for the same cohort,
window and `as_of`.

### 4.5 Atomicity and concurrency

- Approval is one transaction: insert the new version, mark the prior approved
  row `superseded`, in that order, under a partial unique index
  `WHERE state = 'approved'` so two active mappings per scope are impossible.
- **Optimistic concurrency:** the approve request carries the draft's
  `revision`. If the stored revision has moved, the server returns **409** with
  a diff summary and refuses. One reviewer cannot silently approve over
  another's newer edits. The same applies to draft saves.

### 4.6 Data drift between preview and approval

The preview returns its `evidence_as_of`. Approval sends it back. If the cursor
has advanced:

- Do **not** block — appointment data advancing is the system working.
- Recompute, and show what moved before committing:
  > Appointment data advanced from 12:05 to 13:05 while you were reviewing.
  > Arrival evidenced: 969 → 972. Approve with the current figures?
- Deltas obey the same suppression as any other cell; a delta that would reveal
  a small cell is shown as *"changed by fewer than 5"* (§6.7).

### 4.7 New labels after approval

Inserted as `unclassified` with `first_seen_at`. They establish nothing, they do
not invalidate the approval, and they do not stop reporting. The card shows
*"2 new status labels since this was confirmed — not counted"* with a link back
to the panel. Silence here would be the failure mode: reporting would quietly
drift downward as the clinic adopted new vocabulary.

### 4.8 Correction and withdrawal

- **Revision:** edit the draft, preview, approve → new version, previous
  superseded. Normal path.
- **Withdrawal:** an approver marks the active mapping `superseded` with a
  required reason. Attendance returns to unavailable, and the page says *why*
  and *when*, not merely that it is unavailable.
- Superseded versions are never deleted.

### 4.9 Recalculation and disclosure

Attendance is computed live from evidence, so **a new mapping changes historical
figures too**. That is correct — the underlying facts did not change, our
reading of them did — but it must never be silent:

- Every attendance response carries `definition_version` and `confirmed_on`.
- The dashboard shows: *"Attendance figures use the definition confirmed by
  {name} on {date}."*
- When a version has ever been superseded, a link offers *"How this definition
  has changed"* — an append-only list of versions with who confirmed each, when,
  and which labels moved class.
- Any exported or screenshotted figure carries the confirmation date in its
  scope line, the same way period and timezone already do.

### 4.10 Smallest practical implementation

Two tables, no role overhaul, no new service:

- `attendance_mappings` — one row per version: `id`, `scope`, `state`,
  `revision`, the approval fields from §4.3, `labels jsonb` (immutable once
  approved), timestamps.
- `attendance_status_labels` — the observed inventory:
  `raw_label`, `source_column`, `normalized_key`, `first_seen_at`,
  `last_seen_at`. Refreshed by an aggregate query, not by the sync workflow —
  **the n8n workflows are not touched**.

Draft state lives as a row with `state = 'draft'`; there is no separate table.
The mapping the metric reads is one indexed lookup.

---

## 5. Permissions

### 5.1 The problem with reusing `admin`

`normalizeRole()` resolves anything that is not `"viewer"` to `"admin"`, so
every developer and every operations account is an admin. Approving what a
clinic's records mean is not in the same class as exporting a CSV, and the
current model cannot express the difference.

### 5.2 Recommended: one explicit capability, not a new role

Add `users.can_approve_definitions boolean NOT NULL DEFAULT false`, granted
explicitly per user. A new predicate in `api/_lib/permissions.ts`:

```ts
export function canApproveDefinitions(u: { role: Role; canApproveDefinitions: boolean }): boolean {
  return isAdmin(u.role) && u.canApproveDefinitions === true;
}
```

and a guard `requireDefinitionApprover` beside `requireAdmin` in
`api/_lib/auth.ts`, returning **403** for an admin without the capability.

Why a flag and not a role: roles here are a two-value enum backed by a CHECK
constraint (`0007`) and threaded through `normalizeRole`. A third role means
touching every call site and re-reasoning the default-to-admin rule. A default-
false capability is additive, cannot accidentally widen access, and reads
clearly in the matrix.

### 5.3 Permission matrix

| Action | viewer | admin | admin + `can_approve_definitions` |
| --- | :--: | :--: | :--: |
| View the Patient journeys dashboard | ✓ | ✓ | ✓ |
| View published attendance, once approved | ✓ | ✓ | ✓ |
| View the status inventory and evidence | ✓ | ✓ | ✓ |
| Open the review panel | — | ✓ | ✓ |
| Create / edit / save a draft | — | ✓ | ✓ |
| Run an impact preview | — | ✓ | ✓ |
| **Approve a mapping** | — | **—** | ✓ |
| **Revise an approved mapping** | — | **—** | ✓ |
| **Withdraw an approval** | — | **—** | ✓ |
| View approval history | ✓ | ✓ | ✓ |

Notes on the choices:

- **Viewers can see the inventory.** It is aggregate, suppressed, and already
  reachable through reporting. Hiding it would not protect anything and would
  stop a viewer understanding why attendance is missing.
- **Viewers cannot preview.** A preview is an unapproved number; putting one in
  front of a read-only user is exactly the confusion the gate exists to prevent.
- **Admins draft but do not approve.** An engineer can prepare the whole thing
  for the call; only an authorised person commits it.
- **All of it is enforced server-side.** UI hiding is convenience, matching the
  existing comment in `permissions.ts`.

### 5.4 Recording a decision Jeff makes verbally

The approval form separates the two people explicitly (§4.3). An authorised
approver fills in:

> **Who confirmed this?** `Jeff ______` · **Their role** `Practice owner`
> **How?** ( ) Phone call (•) Video call ( ) Email ( ) In person
> **On what date?** `2026-09-22`
> **Anything to note?** *optional*

and the record stores the authenticated approver separately. Provenance then
reads, wherever it is displayed:

> Confirmed by Jeff ______ (Practice owner) on a video call, 22 Sep 2026.
> Entered by raunek@xpandai.com, 22 Sep 2026.

`confirmed_by_name`, `confirmed_by_role`, `confirmed_via` and `confirmed_on` are
all **required** — approval cannot be submitted without them. That is what stops
`provenance: null` recurring in a new form.

---

## 6. UI

### 6.1 Compact card — Patient journeys, unconfigured

```
┌─ Attendance ─────────────────────────────────────────────────┐
│  Not reported yet — one decision away                        │
│                                                              │
│  969 past appointments already carry a record that the       │
│  patient was physically in the clinic — checked in, roomed,  │
│  or with the provider.                                       │
│                                                              │
│  We are not publishing an attendance figure until the        │
│  clinic confirms which status labels mean that.              │
│                                                              │
│  Three questions would unlock it    [ Review statuses ▸ ]    │
└──────────────────────────────────────────────────────────────┘
```

Viewers see the same card without the button.

### 6.2 Expanded panel — "Attendance status review"

```
Attendance status review                                  [ Close ]

  Tell us what your status labels mean. We will use them to work out
  who actually came in. Nothing here changes your records in DrChrono.

  ┌ THE THREE THAT MATTER ────────────────────────────────────────┐
  │                                                               │
  │  "Complete"                              945 appointments     │
  │  924 of these also show the patient checked in or roomed.     │
  │  10 show no sign the patient was ever here.                   │
  │  Does it mean the patient was seen, or that the chart was     │
  │  closed out?                                                  │
  │   ( ) Patient was physically here                             │
  │   ( ) Tells us nothing either way                             │
  │   ( ) Patient did not come                                    │
  │   (•) Not decided yet                                         │
  │   [ ] Also says something about whether the procedure happened│
  │                                                               │
  │  "Ready in 2"                            325 appointments     │
  │  Is this a room number — is the patient already roomed?       │
  │   ( ) … (•) Not decided yet                                   │
  │                                                               │
  │  (no status set)                         627 appointments     │
  │  About a third of past appointments end with no status, in    │
  │  every office, every month since June. None of them show any  │
  │  sign the patient arrived — and none show they didn't.        │
  │  What happens on those days?                                  │
  │   (•) Tells us nothing either way    ( ) …                    │
  └───────────────────────────────────────────────────────────────┘

  ┌ LOOKS CLEAR — please confirm ─────────────────────────────────┐
  │  Arrived · Checked In · In Room · In Session · MD In · MD Out │
  │  These can only be set with the patient in the building.      │
  │  969 past appointments have at least one of them.             │
  │                      [ Confirm all six as "physically here" ] │
  └───────────────────────────────────────────────────────────────┘

  ┌ ALL STATUS LABELS ─────────────────────── 19 · 6 decided  [▾] ┐
  │  Label            Where       Appts   Offices   Your answer   │
  │  Arrived          history        75     3       Here       ▾  │
  │  Checked In       both       withheld   3       Here       ▾  │
  │  Checked In       history  ·  also seen as "Checked  In"      │
  │                             — confirm these are the same      │
  │  Scheduled        both      1,911      3        Nothing    ▾  │
  │  Ready in 5       history      new     1        Not decided ▾ │
  │  …                                                            │
  │  These are appointments, not patients, and they overlap —     │
  │  one visit passes through several. They do not add up.        │
  └───────────────────────────────────────────────────────────────┘

  Draft — saved 2 minutes ago. Nothing on the dashboard has changed.
                                  [ Save draft ]  [ See the impact ]
```

### 6.3 Draft and unclassified indicators

- A persistent strip while a draft exists: **"Draft — nothing on the dashboard
  has changed."** Amber, matching the existing demo-surface convention that
  amber never means live reporting.
- Per-label: `Not decided yet` in muted text; `new` badge for labels first seen
  after the last approval.
- Header counter: `19 · 6 decided`.

### 6.4 Impact preview

```
If you save this                            Registration journey · 14 days

  Arrival evidenced                    412 of 1,554 eligible patients
  Arrival not established              1,142

  This is a floor, not a ceiling. Confirming more labels can only
  move patients out of "not established" and into "evidenced".

  Still not decided: 13 labels, covering 640 appointments.
  Deciding "Complete" alone would move about 300 more patients.

  Compared with what is published now: attendance is not published yet.

  Appointment data complete to 21 Sep 2026, 1:05 PM.

                                   [ Back to editing ]  [ Approve ▸ ]
```

*(Figures above are illustrative of the layout only — this specification
computes no attendance figure.)* The **Approve** button is absent, with a one-line
explanation, for an admin without the capability.

### 6.5 Approval confirmation

```
Approve this definition

  You are about to publish attendance figures based on these answers.
  They will appear on the Patient journeys dashboard for everyone.

  Who confirmed this?      [ Jeff ______________ ]  (required)
  Their role               [ Practice owner _____ ]  (required)
  How?                     (•) Video call ( ) Phone ( ) Email ( ) In person
  On what date?            [ 2026-09-22 ]            (required)
  Anything to note?        [ ____________________ ]

  You are signed in as raunek@xpandai.com. We record both: who
  confirmed the decision, and who entered it.

  Appointment data advanced while you were reviewing.
  Arrival evidenced: 969 → 972. These are the current figures.

                                      [ Cancel ]  [ Approve ]
```

### 6.6 Saved state, and the dashboard after partial approval

```
┌─ Attendance ─────────────────────────────────────────────────┐
│  At least 412 of 1,554 patients came in            (26.5%+)  │
│                                                              │
│  A floor, not a ceiling. 1,142 patients have no record       │
│  either way — mostly appointments that end with no status.   │
│                                                              │
│  Confirmed by Jeff ______ (Practice owner), 22 Sep 2026.     │
│  13 status labels are still undecided.   [ Review statuses ▸]│
└──────────────────────────────────────────────────────────────┘
```

- The *not established* count is the same size as the headline figure.
- `26.5%+` — the `+` is load-bearing and is explained on hover and in the
  scope line.
- No mapping version, no approval-state string, no "v3" anywhere in the main
  flow. Version and history live behind *"How this definition has changed"*.
- If a new label appears: *"2 new status labels since this was confirmed — not
  counted."*
- If withdrawn: *"Attendance was withdrawn on 24 Sep 2026 by … — {reason}."*

### 6.7 Suppression, including across repeated previews

- Every count reuses `suppressCount`, `suppressPair` and `suppressPartition`
  from `lib/metrics/contract.ts`. No new suppression logic.
- Inventory rows are a partition, so `suppressPartition` applies: at least two
  cells withheld whenever any is, so the total cannot recover one.
- Preview outputs are a numerator/denominator pair → `suppressPair`, which
  already withholds both sides and the rate together.

**The differencing risk is real and must be handled.** A reviewer could flip one
label, preview, flip it back, preview again, and read a small cell out of the
difference. Practical mitigation, consistent with the existing boundary:

1. **Never return per-label impact counts below the threshold.** The "deciding X
   alone would move about N patients" line is suppressed by the same rule and
   is **rounded to the nearest 10** above it. Rounding a hint is honest; the
   exact figure is not the point of the hint.
2. **Return bucket totals only** — evidenced / not established / undecided —
   never a per-label breakdown of the preview.
3. **Do not show a delta against the previous preview.** Only against the
   currently published figure, which is already public.
4. **Log every preview** (user, timestamp, draft revision) in the same audit
   table as approvals. Differencing attacks are only deterred by being visible,
   and the reviewer population is small and named.
5. Preview is **admin-only** (§5.3), so the audience is already inside the
   reporting boundary.

This is defence in depth, not a proof. It is proportionate: the same reviewer
can already see the suppressed inventory row counts' bucket, and the population
is a handful of named accounts.

---

## 7. Proposed data and API changes (high level)

### 7.1 Database (one migration, additive)

| Object | Purpose |
| --- | --- |
| `attendance_mappings` | Versioned mapping + approval record. Partial unique index on `(scope) WHERE state = 'approved'` |
| `attendance_status_labels` | Observed label inventory with `first_seen_at` |
| `attendance_review_audit` | Append-only: draft saves, previews, approvals, withdrawals |
| `users.can_approve_definitions` | Boolean, default false |
| `drsnip_status_inventory()` | SECURITY DEFINER, owned by `drsnip_metrics_fn`, returns **both** current-status and transition counts with suppression applied **inside** the boundary. Extends the existing `drsnip_status_evidence()`, which is transitions-only |
| `drsnip_attendance_metric(...)` | SECURITY DEFINER. Takes the approved label set as a bound parameter; returns evidenced / not established / undecided per cohort and window |

Follows the existing boundary exactly: `search_path = pg_catalog, pg_temp`,
`EXECUTE` revoked from `PUBLIC`, fixed allow-lists, bound parameters,
suppression inside the function. Grant the two new tables `SELECT` to
`drsnip_metrics_fn`; the app role reads through the functions.

**Not registered in `migrate.ts`** if it depends on `drsnip_metrics_fn` — apply
by hand in numeric order, like `0014`–`0019`, and say so in the file header.

### 7.2 API

| Route | Method | Guard | Returns |
| --- | --- | --- | --- |
| `/api/reports/status-inventory` | GET | `requireAuth` | Suppressed label inventory, both sources, plus current mapping state |
| `/api/reports/attendance` | GET | `requireAuth` | Published attendance for a cohort/window, or `unavailable` with a reason |
| `/api/attendance-mapping/draft` | GET/PUT | `requireAdmin` | Draft label set; PUT carries `revision`, 409 on conflict |
| `/api/attendance-mapping/preview` | POST | `requireAdmin` | Impact over the draft, via the shared calculation |
| `/api/attendance-mapping/approve` | POST | `requireDefinitionApprover` | Atomic approve; 409 on stale revision; requires all four confirmation fields |
| `/api/attendance-mapping/withdraw` | POST | `requireDefinitionApprover` | Supersede with a required reason |
| `/api/attendance-mapping/history` | GET | `requireAuth` | Version list with confirmer, date and labels that moved |

Every handler registered in `api-server/index.ts` — the existing test that walks
`api/reports/` must be extended to cover `api/attendance-mapping/`, because v82
shipped a route as a 404 for exactly this reason.

### 7.3 Frontend

`components/reporting/attendance-review/` — panel, label row, preview, approval
dialog. The dashboard card gains its approved and partially-approved states.
No change to nav or routing: the panel opens from the Patient journeys card.

---

## 8. Acceptance criteria

**Classification**
1. A new source label appears as `unclassified` within one sync cycle and
   establishes nothing.
2. `NULL` and `""` are separately representable and separately classifiable.
3. Two raw labels sharing a `normalized_key` are shown together with a visible
   note and remain independently classifiable. No automatic merge.
4. `no_arrival_evidence` cannot produce a non-attendance count anywhere. Proven
   by a test that classifies every label that way and asserts the "did not
   attend" count is zero, not the cohort size.
5. A label flagged `remote_presence` never contributes to physical attendance.

**Calculation**
6. Arrival evidence is established by history **or** current status.
7. The earliest qualifying transition sets `arrival_at`; a later cancellation,
   no-show, reschedule or deletion does not remove it.
8. A NULL or impossible `transition_at` yields *evidenced but untimed*, excluded
   from timing statistics, never dropped.
9. A patient with several qualifying appointments counts once.
10. Arrivals before entry are excluded from the journey metric and appear in the
    existing prior-visit card.
11. Maturity is measured against the appointment cursor, never `now()`.
12. The metric endpoint returns `unit: "distinct_patient_ids"`; the inventory
    returns `unit: "appointments"`. A test asserts they are never equal by
    construction.
13. With only some labels approved, the evidenced figure is labelled a lower
    bound in the payload, not only in the UI.

**Lifecycle**
14. Saving a draft leaves the published attendance response byte-identical.
15. Previewing the approved mapping returns byte-identical numbers to the
    published endpoint for the same cohort, window and `as_of`.
16. Two concurrent approvals: the second receives 409 and does not write.
17. At most one `approved` row per scope, enforced by a database constraint, not
    application code.
18. Approval is rejected without all four confirmation fields.
19. Superseded versions retain their full label set and are never mutated.
20. Withdrawal returns the dashboard to unavailable with the recorded reason.
21. Every attendance response carries `definition_version` and `confirmed_on`.

**Permissions**
22. A viewer receives 403 on draft, preview, approve and withdraw.
23. An admin **without** `can_approve_definitions` receives 403 on approve,
    revise and withdraw, and 200 on draft and preview.
24. Enforced server-side; verified with the UI bypassed.

**Suppression and privacy**
25. No cell below 5 is returned by any new endpoint, and no published total lets
    one be recovered — `suppressPartition` semantics, reused not reimplemented.
26. Preview returns bucket totals only; per-label hints are suppressed and
    rounded to the nearest 10.
27. No response contains a patient id, appointment id, provider name, office
    name, note or raw payload.
28. Every preview and approval is written to the audit table.

**Non-regression**
29. Nothing in this feature writes to DrChrono, and no n8n workflow is modified.
30. With no approval present, the dashboard is byte-identical to today.

---

## 9. Open decisions

### 9.1 Clinic decisions — blocking publication, not construction

1. Do `Arrived`, `Checked In`, `In Room`, `In Session`, `MD In`, `MD Out` mean
   the patient was physically present? (969 appointments)
2. Does `Complete` mean the patient was seen, or that the chart was closed?
   (945; 10 with no other evidence)
3. Is `Ready in N` a room number — is the patient already roomed? (13 hinge on it)
4. Can `Checked In Online` be done from home?
5. What happens on appointments that end with no status at all? (627, ~30% of
   past appointments, every office, every month)
6. Is `No Show` reliably set? **This alone decides whether any attendance
   *rate* can be published, or only a count.**
7. Nine appointments show a patient who was here and whose appointment now reads
   cancelled or rescheduled. Counting them as attended — correct?
8. Is a practice-wide definition valid, or do offices differ?
9. Separately, not blocking: does any field establish that a procedure was
   performed?

### 9.2 Engineering decisions — resolved here, no clinic input needed

| Decision | Resolution |
| --- | --- |
| Four classes or three | **Four**, plus two independent attributes (§2.2) |
| Label identity | Exact raw string per source column; normalise only to surface near-duplicates (§2.3) |
| Current status vs history | **Both** establish evidence; only history gives a timestamp (§3.1–3.2) |
| Arrival then cancellation | Arrival stands; disposition reported separately (§3.3) |
| Counting unit | Patients for the metric, appointments for the inventory; different endpoints (§2.6) |
| Partial approval | Safe in one direction; published as a lower bound (§3.7) |
| "Did not attend" | **Not shipped** until `No Show` reliability is confirmed (§3.8) |
| Permission model | Capability flag, not a third role (§5.2) |
| Approver vs confirmer | Two separate required fields (§4.3, §5.4) |
| Concurrency | Optimistic via `revision`, 409 on conflict (§4.5) |
| Drift between preview and approval | Disclose and recompute, never block (§4.6) |
| Recalculation of history | Live recompute, disclosed on every figure (§4.9) |
| Suppression | Reuse `contract.ts`; bucket-only previews, rounded hints, audited (§6.7) |
| Storage | Two tables plus an audit table; draft is a row, not a table (§4.10) |
