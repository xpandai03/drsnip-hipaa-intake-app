# Attendance status review — production release

**Date:** 21 September 2026

| | |
| --- | --- |
| **Released commit** | `09119d6` |
| **PR** | [#55](https://github.com/xpandai03/drsnip-hipaa-intake-app/pull/55) — OPEN, not merged |
| **Fly release** | **v87**, image `drsnip-intake-demo:deployment-01M32WDYQDKFCETEMB1C692D3V` |
| **Migration** | `0020_attendance_review.sql` applied by hand; `0020a` runs in `release_command` |
| **Rollback point** | v85, `drsnip-intake-demo:deployment-01M304DH39S5KEC32QZT453NG8`, commit `2b09177` |

**No clinic definition is approved. No account has approval capability. No
synthetic attendance figure is published.** Verified against production below.

No patient identifiers, appointment identifiers, notes or clinical payloads
appear in this report.

---

## 1. Release ordering — measured, not assumed

The implementation report said the schema change and migration must ship
together because `findActiveUserByEmail` does a `SELECT *`. **That reason is
wrong**, and the real situation is tighter.

Drizzle's `.select()` emits an **explicit column list**, and
`getSessionFromCookie` names `users.can_approve_definitions` directly — so the
column is required on *every authenticated request*, not just login. Tested by
running the built new server against a copy of the pre-migration schema:

```
healthz  200
LOGIN    500        <- total authentication outage
```

Adding the column to the running database fixed it immediately, no restart.

The other direction was tested too: the **currently deployed build was rebuilt
from its own commit** (`2b09177`) and run against the post-migration schema.

| | old schema | new schema |
| --- | :--: | :--: |
| deployed app (v85) | ✓ (production today) | **✓ verified** — login, session, journey, booking, freshness all `200`, zero errors |
| new app | **✗ authentication outage (verified)** | ✓ |

### The compatibility fix

Rather than document the hazard, it was removed. **`0020a_approval_capability_column.sql`**
carries that one idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and **is
registered in `migrate.ts`**, so Fly's `release_command` runs it before new
machines take traffic. Whatever order a human applies things in, authentication
survives.

The rest of `0020` — tables, SECURITY DEFINER functions, grants to
`drsnip_metrics_fn` — stays a by-hand migration like `0012a` and `0014`–`0019`,
because it grants to a role `migrate.ts` cannot create.

**Rollback is safe with the migration in place**, verified above. Do not drop
the new tables to roll back.

---

## 2. Migration verification (production)

Applied to `drsnip_intake_demo` through the DB machine. Pre-flight confirmed
none of the objects existed first.

| Check | Result |
| --- | --- |
| `drsnip_attendance_evidence` / `_metric` / `_preview`, `drsnip_status_inventory` | owner `drsnip_metrics_fn`, `SECURITY DEFINER` ✓ |
| `drsnip_refresh_status_labels` | **not** SECURITY DEFINER — it is the only writer, and making the restricted role its owner would have meant granting it INSERT/UPDATE |
| PUBLIC may execute preview / raw evidence / metric | `false` / `false` / `false` ✓ |
| Reporting role may execute the preview | `false` ✓ — a report consumer must not compute against an unapproved mapping |
| App role: metric, preview, inventory, refresh | all `true` ✓ |
| Constraints | `provenance_check`, `state_check`, `confirmed_via_check` ✓ |
| Indexes | `one_approved_idx`, `one_draft_idx` (partial unique) ✓ |
| `users.can_approve_definitions` | `boolean NOT NULL DEFAULT false` ✓ |

### One gap found and fixed during the migration

The file is applied as the operator, who is a superuser, so the three new tables
came out owned by `postgres` while **every table beside them is owned by
`drsnip_intake_demo`**. Privileges were already correct, so nothing was broken
and nothing would have looked broken until somebody ran an `ALTER TABLE` as the
app role and it failed for no visible reason. Found by comparing ownership
against the existing tables, fixed in production, and folded into the migration
so a fresh apply lands in the same state (commit `f39a4b6`).

### Nothing was seeded

```
mappings 0 | approved 0 | audit_rows 0 | capability_grants 0 | labels_observed 33
```

The 33 labels are the practice's **observed** status vocabulary, populated by an
additive refresh. They carry no interpretation — every one is `undecided`.

---

## 3. Correction to the implementation report

> "Is `No Show` reliably set? **This alone decides whether a rate is ever
> publishable.**"

That was wrong and has been corrected in place. A reliable absence marker is
**necessary but not sufficient**. A publishable rate also needs:

- an agreed **population** — which patients, and which of their appointments;
- an **observation window** and a maturity rule measured against the evidence
  cutoff, not the clock;
- **coverage** — what to do with patients whose history was never retrieved;
- a rule for **unknown and conflicting evidence** (a patient who arrived and was
  later marked cancelled is already both);
- a rule for patients holding **several appointments**.

`No Show` unblocks the question. It does not answer it.

---

## 4. Suppression, reviewed across all three outputs together

Two corrections were made before release, and they run in opposite directions:

**The four attendance buckets are a partition.** `evidenced_in_window +
evidenced_untimed + evidenced_outside_window + not_established` equals the
eligible cohort exactly. They were originally suppressed per cell, which leaks —
subtract the other three. They now use the same withhold-until-two rule as
`suppressPartition()` in `contract.ts`, verified against a fixture that puts
exactly three patients in one bucket: the small cell is withheld *and* so is a
second, so the residual does not identify it.

**The status inventory is the opposite case.** Its rows overlap — one visit
passes through several statuses — so partition treatment would be theatre. Plain
per-cell suppression, a withheld row withholds its office and provider counts
too, and **no total is published** for rows to be differenced against.

**Previews return bands, never exact counts.** An exact preview is a probe.
Hiding deltas does not help when the caller holds both numbers; auditing records
an attack rather than preventing it.

**Banding is a mitigation, not a proof, and is not described as one.** Residual
exposure: a reviewer could binary-search a band boundary across many previews,
and someone who can approve could compare two published exact figures across two
approved mappings to learn what a single label contributed. Previews and
approvals are both audited, and both require an admin.

---

## 5. Production verification (authenticated)

Signed in as the application's own provisioned viewer account. No fabricated
session, no weakened authentication, no approval, no fake clinic decision, and
no production mutation beyond the additive label refresh that reading the
inventory performs.

### Live console

| Check | Result |
| --- | --- |
| Login and existing navigation | PASS |
| Registration journey loads | PASS (898 ms) |
| Insurance journey loads | PASS (781 ms) |
| Attendance review card present | PASS |
| Card opens the panel | PASS at 1440 and 390 |
| Real status labels listed with counts | PASS — 40 classification controls |
| Card says "Not published yet" | PASS |
| Any approved-looking attendance count | **none** ✓ |
| Horizontal overflow, dashboard and panel | **0 px** at 1440 and 390 |
| Panel closes on its button | PASS |
| Panel closes on **Escape** | PASS (see below) |
| Focus lands on the dialog on open | PASS |
| Page errors | none |

### Routes (authenticated, as viewer)

```
/api/reports/status-inventory        200
/api/reports/attendance              200   status: "unapproved", no counts, no rate
/api/attendance-mapping/history      200
/api/attendance-mapping/draft        200
/api/attendance-mapping/preview      403   <- viewer
/api/attendance-mapping/approve      403   <- viewer
/api/reports/{journey,booking,freshness}  200
```

Unauthenticated: all seven new routes return `401`.

### Inventory contract

| Check | Result |
| --- | --- |
| `unit` | `appointments` ✓ (not patients) |
| Overlap flagged in the payload | ✓ |
| Mapping state | `unconfigured` ✓ |
| **Every label starts undecided** | ✓ (33 of 33) |
| Small cells withheld | ✓ |
| A withheld row also withholds office/provider counts | ✓ |
| No total published | ✓ |
| Viewer: `edit_draft` and `approve` both false | ✓ |

Production has **no `NULL` status** — only the empty string, exactly as the
earlier data analysis found. Both blank forms render as *"(empty status)"*, one
row per source column, and are classified separately. The `NULL` path is still
representable and is covered by local fixtures.

### Existing reporting unchanged

Every figure the console displayed was re-derived from the database
independently, at the same instant and with the same filters. All matched
exactly:

| Measure | Console (v87) | Independent DB |
| --- | --- | --- |
| Consultation observed to date | 680 / 1,869 | 680 / 1,869 |
| Consultation within 14 days (mature) | 372 / 1,572 | 372 / 1,572 |
| Booking eligible / recorded / advance | 1,572 / 999 / 985 | 1,572 / 999 / 985 |
| Appointment cutoff | 2026-09-21 21:05:00Z | same |

These differ from the figures quoted a day ago (674/1,845, 1,554/989) because
intake and the appointment cursor advance continuously. That is the system
working, not a regression — the comparison that matters is console against
database at one instant, which is exact.

### Appointment sync still healthy

```
incremental_hourly      enabled  success  idle  recurring_active  0 failed/24h
patient_catchup_hourly  enabled  success  idle  recurring_active  0 failed/24h
```

### Two things found during verification

1. **The modal ignored Escape.** A `div` with `role="dialog"` gets none of that
   from the browser. Fixed: Escape closes it, focus moves into the dialog on
   open and returns to the opener on close, and the listener is removed with the
   dialog. Three assertions pin it. Deployed as v87.

2. **A route was never committed.** `api/reports/status-inventory.ts` was on
   disk but unstaged. Every local check passed; the Fly image build from a clean
   checkout failed with `TS2307: Cannot find module`. That is the build doing
   its job, and the reason deploys come from a pristine worktree rather than the
   working tree. Committed as `c649dd2`; without it the review panel would have
   had no data source.

### Not verified in production

**The admin draft/preview path.** Doing so needs an admin session, and the only
credential this environment provisions is the viewer account. The gate itself is
verified in both directions — the viewer receives `403` on preview and approve
in production, and the full admin and approver paths (draft, preview, approve,
withdraw, 409 conflicts, four provenance rejections) pass against a real local
server with three real accounts. Anyone with an existing admin login can confirm
the draft and preview controls in a few seconds.

---

## 6. Tests

**607 tests, 607 passing, 0 failing, 0 skipped, 0 cancelled.** Typecheck and
production build clean.

Previously 15 tests were silently skipping: the booking database suite wanted
`BOOKING_TEST_DATABASE_URL`, and enabling it revealed it had been sharing a
database with the journey suites. It now has its own, and those 15 assertions
run for the first time.

The assertions that carry the release:

- Classifying **every** label "tells us nothing" produces results identical to
  classifying nothing — zero arrivals, zero inferred non-attendance.
- Current-status-only evidence lands in *untimed*; it never fabricates a
  within-window arrival.
- Remote never counts as physical; classifying it physical *does* count.
- `NULL` and `""` classified independently and additively; `MD In` does not
  match a recorded `MD  In`.
- An arrival later cancelled still counts; evidence on a deleted record is kept
  and counted separately.
- A small bucket is withheld together with another, so it cannot be recovered.
- The published exact figure falls inside the band the preview returned for the
  same labels and snapshot — one calculation, two protections.
- Two approved mappings per scope impossible (database index); stale revision
  writes nothing; approval without full provenance refused.

---

## 7. Approval capability

**No account has been granted approval authority, and none was inferred.**

This prompt named no account, and admin role and display name are not
authorisation. The review panel is fully usable for **drafting and previewing**
by the existing admins without any grant — that is the point of the split.

To grant one verified account later, one statement:

```sql
UPDATE users SET can_approve_definitions = true WHERE email = '<the named person>';
```

run by a database operator against a named, verified account. There is no
endpoint that grants it, and no self-service path.

Building and deploying this feature does not authorise approving clinic
definitions.

---

## 8. Remaining limitations

1. Preview banding reduces precision; it does not prevent inference across
   repeated mappings. Residual: band-boundary search, and cross-version
   differencing of published exact figures by someone who can approve.
2. `remote_only` and `in_window_resting_on_deleted_record` **overlap** the four
   buckets — annotations, not extra buckets. Summing everything over-counts.
3. Scope is practice-wide only. The column exists and the inventory reports how
   many offices each label spans, but per-office mappings are not implemented.
4. `explicit_absence` is storable and drives nothing.
5. The audit table has no UI; version history is exposed, raw audit rows are not.
6. The admin draft/preview path is unverified in production (§5).

---

## 9. Before a real clinic approval

1. Grant the capability to one named, verified account (§7).
2. Have that person confirm the clinic's answers — the eight questions in
   `DRSNIP_ATTENDANCE_STATUS_REVIEW.md`, answerable one at a time.
3. Approve through the panel, which records who confirmed it, their role, how,
   on what date and for what scope — separately from who entered it.
4. Re-check the published card: unknowns must remain visible beside anything
   evidenced, and no rate should appear.
