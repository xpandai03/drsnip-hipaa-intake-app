# Post-call reporting brief: monthly patient conversion

**Prepared:** 23 September 2026
**Evidence cutoff used for all production figures:** `2026-09-23 15:40:39 UTC` (the booking function's own cutoff rule, read at 15:48 UTC)
**Call source:** `jeff-meet-transcript.md` (21 September call). Line numbers below are `T:<line>`.

This is a read-only investigation. No application code, workflow, credential,
mapping, permission or production row was changed. Nothing was committed,
pushed or deployed. Every production query ran with
`default_transaction_read_only=on` and returned only aggregates. Cells of 1–4
are shown as `<5`, and complementary cells are withheld where differencing
would recover one. This report contains no patient identifiers, appointment
identifiers, notes or payloads. Appointment-type IDs appear below. They are
practice configuration, not patient data.

---

## 0. The short version

Jeff asked: *"All the registration forms that came in in June or July. Of those,
if I looked at it today, how many did we actually convert? Meaning they either
have a completed appointment or they're scheduled"* (T:129–135).

- **None of the live measures answers that question.** The dashboard counts
  **appointment records created** within 7, 14 or 30 days of entry. It does not
  filter by status, type or deletion. It answers "how fast did a record appear",
  not "where does this patient stand now".
- **The status half of Jeff's definition is now well supported.** He explained
  which statuses mean *completed* and which mean *scheduled*, with specific
  wording (§2).
- **The appointment-type half is not.** We hold 13 numeric type IDs and no
  names. The name lookup was refused with a 403 in every earlier attempt. It
  could not be re-tested here without creating or changing an n8n workflow,
  which this task forbids (§3). The behaviour of each type narrows the question
  down, but it does not name any type.
- **A current-position monthly view is feasible now** with retained data. A
  **true historical month-end view is not**, because appointment dates and
  types are overwritten in place (§5).
- **For the next Loom**, a monthly cohort table is realistic. It would show
  *completed* and *currently scheduled* as separate counts, labelled **"any
  appointment type (provisional)"**, and would come with Jeff's type question
  (§9).

---

## 1. Deployment and build status

### 1.1 Verified in production during this investigation

| Fact | Evidence |
| --- | --- |
| Live release is **Fly v87**, deployed 21 Sep 2026 21:03 | `fly releases` |
| Both machines are on v87 (one started, one auto-stopped) and use image `deployment-01M32WDYQDKFCETEMB1C692D3V` | `fly status`, `fly image show` |
| The image has **no git label**, so the commit is identified by its content | `fly image show` has an empty LABELS column |
| The live SPA bundle (`index-rDJ3GJUd.js`) contains `09119d6`'s Escape and focus handler, and the attendance panel, status-inventory and mapping routes | Fetched the bundle and matched its strings |
| `c2cc4c5` (HEAD) differs from `09119d6` only in docs and screenshots | `git diff --stat 09119d6 c2cc4c5` |
| **So the live code is `09119d6`** (equivalently `c2cc4c5`, which adds no code) | the above |
| PR **#55 is OPEN and not merged**. Its head is `c2cc4c5` (20 commits) and it is fully pushed. **`main` contains none of the reporting work** (journey v83 through attendance v87) | `gh pr view 55`, `git rev-parse` |
| Migration **0020 shipped**: `attendance_mappings`, `attendance_review_audit` and `attendance_status_labels`, plus `drsnip_attendance_{evidence,metric,preview}`, `drsnip_status_inventory` and `drsnip_refresh_status_labels`. `users.can_approve_definitions` also exists | `information_schema` |
| **No attendance definition is approved.** Mappings 0, approved 0, audit rows 0, accounts with approval capability 0 | row counts |
| **33 observed labels**: 12 from `current_status` and 21 from transitions, each set including the blank label | `attendance_status_labels` |
| Sync is healthy. The incremental cursor stood at 15:05 UTC today and the evidence cutoff at 15:40 UTC. The patient queue is empty | `appointment_sync_state`, `appointment_sync_patient_queue` |

**Approval provenance:** none exists to record. No mapping row, no approver and
no audit entry. The call on 21 September is **not** an approval. It is recorded
as source evidence in §2, and nobody entered it through the approval path.

### 1.2 Taken from earlier reports, not re-verified here

- The admin draft and preview path has never been exercised in production
  (`DRSNIP_ATTENDANCE_REVIEW_RELEASE.md` §5). Only the viewer's 403 was
  verified.
- 607 of 607 tests passed at `09119d6` (same report, §6). Tests were not re-run
  here.

### 1.3 Local, uncommitted work (preserved, untouched)

- `DRSNIP_APPOINTMENT_BACKFILL_REPORT.md` has 236 added lines, a "Phase B
  completion" section. It is documentation only.
- About 40 untracked docs and `n8n-rollback/` snapshots.
- None of this is code. No other branch carries reporting work.

---

## 2. Current implementation, as it actually runs

The live metrics are `SECURITY DEFINER` SQL functions. The TypeScript copies in
`Intake-form/lib/metrics/*-sql.ts` are used only by tests.

### 2.1 Cohort formation (shared by every function)

- **One row per linked DrChrono chart, at that chart's first submission of that
  form ever:**
  `min(created_at) … WHERE n8n_patient_id IS NOT NULL AND form_type = <form> GROUP BY patient`.
  Repeat submissions are ignored. A patient whose first registration falls
  before the chosen period is **not** counted in that period.
- The entry date is taken in `America/Los_Angeles`. `p_entry_to` is exclusive.
- **Unlinked submissions are silently excluded** (see §2.5 for how many).
- Registration and insurance cohorts overlap and must never be added together.

### 2.2 Booking (`drsnip_booking_metric`, live definition read from production)

For each patient, over records created in `(entry, entry + N×24h]`:

- `recorded`: any appointment record created in that window.
- `advance_booking`: any record in the window that was **created before its own
  scheduled time** (`source_created_at < scheduled_time`).
- `p50_days_to_advance`: median time from entry to the first advance record.
- Eligible means the patient's history is covered **and** `entry + N days ≤
  evidence cutoff`. Maturity is measured against the data, not the clock.
- **No status, type, office, provider or deletion filter is applied.** Cancelled
  and deleted records count, and are only flagged as sub-counts. (Note: the code
  comment at `0020_attendance_review.sql:329` says booking excludes deleted
  records. The code does not.)

**Correction to the call.** On the call the third column was described as
counting "multiple" records, reschedules, or a later consultation (T:140–153).
That is wrong. **"Advance booking" means at least one appointment record created
within the window *before its own scheduled date*.** It excludes records created
on or after the visit date. The count of records per patient is irrelevant. The
"56% within 7 days" quoted at T:43 is likewise *a record was created*, with no
regard to type, status, cancellation or deletion. It is not "got an
appointment".

### 2.3 Entry-period selection

- **API:** `/api/reports/{journey,booking,attendance}` already accept any
  `from`/`to` date (Pacific time, inclusive), plus `window` ∈ {7, 14, 30}. The
  SQL rejects periods starting before 2026-01-01 or longer than 400 days.
- **UI:** `Journeys.tsx:107–112` offers fixed presets only: *All (from
  2026-06-15)*, *Jul*, *Aug*, *Sep to date*. There is no June preset, no custom
  range and no side-by-side month comparison.

The plumbing for a monthly view therefore exists. What is missing is the
measure itself.

### 2.4 Retained appointment data

| Table | What it keeps | What it does **not** keep |
| --- | --- | --- |
| `appointment_snapshots` (one row per appointment) | Current `scheduled_time`, `profile_source_id`, doctor, office, `current_status`, `deleted_flag`, `archived`, source created and updated timestamps, and our own first and last observed timestamps | **Any previous `scheduled_time`, profile, provider or office.** The upsert overwrites them. When a record was deleted. Duration, reason, notes, the raw payload |
| `appointment_status_transitions` | DrChrono's `status_transitions` (from, to, timestamp), never deleted, with `missing_since` if a transition vanishes from the source | Anything except status |

### 2.5 Coverage in production (at the cutoff)

| | Registration | Insurance |
| --- | --- | --- |
| First submission | 2026-06-15 | 2026-08-12 |
| Submissions | 1,974 | 110 |
| Linked distinct charts (the cohort) | 1,910 | 82 |
| Charts with a completed full-history retrieval | 1,910 (100%) | 82 (100%) |
| Unlinked submissions: Jun / Jul / Aug / Sep | 4 / 9 / 14 / 8 | – / – / 22 / 0 |

Appointment history:

- 2,578 appointments across 1,416 charts.
- Scheduled dates run from 2023-12-15 to 2026-12-28.
- 99 are deleted (retained) and 0 archived.
- 9,883 status transitions (2023-11-20 to 2026-09-22), none missing from the
  source.
- Each linked chart was fetched with `since=1970`, so **per-patient appointment
  history is complete back to the chart's start**.
- **Intake history is the binding limit:** nothing before 2026-06-15, and no
  insurance before 2026-08-12. A year-over-year seasonality comparison
  (T:238) is therefore impossible until mid-2027.
- The assumption that DrChrono's `status_transitions` is itself a complete
  history (rather than recent changes only) has **never been verified** by any
  report.

---

## 3. Jeff's clarifications: source-backed interpretation

"Arrival" means the patient was physically in the clinic. "Completion" means
the appointment was completed. "Active booking" means the record currently
represents a future visit. **None of the rows below is an approved attendance
mapping.** They record what was said. The attendance review in the console is
still unapproved and must stay that way until someone goes through its own
provenance path.

| Exact recorded label | Jeff's words (transcript) | Physical arrival | Appointment completion | Active booking | Open question / type dependency |
| --- | --- | --- | --- | --- | --- |
| `Complete` | "complete is they completed the appointment" (T:55). The appointment type "will tell you … what it is" (T:55) | Not stated. Likely, but a completed appointment of a remote-capable type would not imply arrival | **Yes** | No (terminal) | **Does not prove a vasectomy** (T:55). Whether a procedure happened depends on the type, and types are unnamed |
| `Signed No Review` | "they completed the appointment, but don't send them a review" (T:66). Includes cases where "we did a consultation, but we can't do your procedure" (T:70) | Not stated explicitly. The example implies an in-person consultation | **Yes** | No | May be consultation-only. Conversion credit depends on the consultation-only decision (Q2) |
| `Procedure Not Performed` | "we did the consultation, but we didn't do the procedure" (T:73) | Not stated explicitly | **Yes** (the consultation occurred) | No | Counts as conversion only if consultation-only completion counts (Q2) |
| `Checked In` | "checked in, you know, of course, they're in … in clinic" (T:75) | **Yes** | Not by itself | No | Does **not** cover `Checked In Online`, which was not discussed |
| `Ready in 1`, `Ready in 2`, `Ready in 3`, `Ready in 4` | "Room 1, Room 2, Room 3" (T:78); "Ready and Room 4, yeah" (T:84); "they're in … in clinic" (T:75) | **Yes**, for these **four exact labels** | Not by itself | No | The source labels are `Ready in N`. No `Ready in Room N` variant exists in the data. The explanation applies to these four strings only |
| `Confirmed` | "we're in a window where we're starting to confirm … but the appointment is scheduled" (T:59) | No | No | **Yes, if future-dated** | A past-dated `Confirmed` with no later status is unresolved |
| `Scheduled` | "scheduled, of course, scheduled" (T:57; the transcription is garbled) | No | No | **Yes, if future-dated** | Same past-dated issue |
| `Late Cancel within 48 hrs` | "they canceled … within 48 hours of the appointment … prior to the appointment" (T:60–62) | No (by his wording, the cancellation came *before* the appointment) | No | No | – |
| `Cancelled` | "we'll cancel it because … 'I'll call back and reschedule another time.' … That's not rescheduled" (T:278–280) | No | No | No | The patient may book later. That shows up as a new record, if at all |
| `Rescheduled` | "rescheduled means canceled" (T:276). "The only time we use rescheduled is when they … cancel, and then we're able to reschedule them right away" (T:280). "Almost always" (T:285). "Doesn't mean that they didn't reschedule or cancel again" (T:287) | No | No (this record) | No (this record). A **replacement record is expected** | The link between old and new records is not stored. The replacement may itself be cancelled later |
| `No Show` | Named, then passed over ("No-show, yeah", T:66). **No definition given** | – | – | – | Reliability unknown |
| `In Session` | Said by Raunek only (T:85). **Jeff did not respond** | – | – | – | Unresolved |
| `Arrived`, `In Room`, `MD In`, `MD Out`, `Checked In Online` | Not discussed | – | – | – | Unresolved |
| blank (`""`) | Not discussed | – | – | – | **Material.** See §4.2 |

Other statements recorded:

- **Scheduling is manual and intentional.** Staff call, text or email first,
  and slots are not published (T:118–121, T:167–168).
- **Follow-up testing has its own appointment:** "we create them a PVST
  appointment … that's going to have its own [record]" (T:147–148). It must not
  count as acquisition conversion.
- **Conversion window:** "a one to two-month window" from registration to
  appointment (T:95).
- **Jeff's manual benchmarks:** about 70% for May/June registrations "after
  tracking them for months", 80–85% in October/November, and about 55% during
  staff turnover (T:239–247). These are his figures, computed by hand to an
  unknown definition, and **not a validation target.**
- **Deprioritised:** touchpoint data (T:183), quote automation (T:221–227) and
  emailed reports (T:261–269).

**What this call does *not* settle:**

- There is no blanket approval of any mapping.
- There is no physical-attendance rule. That `Complete` means the appointment
  was completed is not a statement about arrival.
- It does not settle blank statuses, online check-in, `In Session` or the
  reliability of `No Show`.

### 3.1 Correction carried forward: No Show and the attendance denominator

`DRSNIP_ATTENDANCE_APPROVAL_SPEC.md` §9.1 item 6 still reads: *"Is `No Show`
reliably set? This alone decides whether any attendance rate can be published."*
**That is wrong.** A reliable absence marker is necessary but not sufficient. A
publishable rate also needs:

- an agreed population;
- an observation window matured against the evidence cutoff;
- a coverage rule;
- a rule for unknown or conflicting evidence;
- a rule for patients holding several appointments.

The correction was made in `DRSNIP_ATTENDANCE_REVIEW_IMPLEMENTATION.md` §7 and
`…_RELEASE.md` §3, but **the spec file itself was never amended.** It was left
unedited here (read-only task). Amending it is a one-line docs change.

The conversion measure in this brief needs **no** `No Show` rule at all.

---

## 4. Appointment types

### 4.1 Access

- **No name for any type exists anywhere**: not in code, fixtures, n8n JSON or
  any report. `profile_source_id` is stored and read by nothing.
- `/api/appointment_profiles` returned **403** before and after the owner
  re-authorised with `calendar:read` (`DRSNIP_PATIENT_JOURNEY_DEFINITIONS.md`
  §2.2). The missing permission is **unverified**. "Likely `settings:read`" was
  a guess.
- **Not re-tested in this investigation, deliberately.** DrChrono is reached
  only through n8n. The app holds no DrChrono credential. The only existing
  read-only probe (`1tiPE7fxBnuBeWDD`) has a manual trigger and hard-coded
  appointment URLs. Calling the profile endpoint would require editing that
  workflow, creating a new one, or enabling its MCP exposure setting. All three
  are workflow changes, which this task rules out. **Current access is therefore
  unknown, not assumed unchanged.**

### 4.2 Protected aggregate inventory

Counts include deleted records unless noted. The behaviour columns cover
non-deleted records and apply only to types with 20 or more records. "After
another type's completion" means the patient already had a completed
appointment of a different type scheduled earlier.

| Type ID | Records | Charts | Offices | Scheduled span | Median days from record creation to scheduled time | % `Complete` | % `Signed No Review` or `Procedure Not Performed` | % blank | % with an in-clinic transition | % after another type's completion | % cancelled, late-cancelled or rescheduled |
| --- | --: | --: | --: | --- | --: | --: | --: | --: | --: | --: | --: |
| 585137 | 1,749 | 1,327 | 3 | 2023-12 → 2026-12 | +14.9 | 51 | 0 | 0 | 51 | 0 | 29 |
| 875741 | 600 | 581 | 3 | 2026-05 → 2026-10 | **−0.1** | 1 | 0 | **98** | **0** | 8 | 0 |
| 503309 | 103 | 95 | 3 | 2025-03 → 2026-10 | +7.8 | 50 | **25** | 0 | 73 | 0 | 13 |
| 585138 | 75 | 59 | 2 | 2025-05 → 2026-11 | +17.9 | 39 | 1 | 1 | 40 | **94** | 33 |
| 874156 | 17 | 16 | 3 | 2026-08 → 2026-09 | −0.3 (all blank) | | | | | | |
| 866117 | 14 | 14 | 3 | 2026-06 → 2026-09 | −0.1 (most blank) | | | | | | |
| 503310, 594438 | 5 each | 5 each | 2 | 2026 | | | | | | | |
| 594437, 594436, 874151, 886171, 873325, (no type) | <5 each | <5 | 1–2 | | | | | | | | |

"In-clinic transition" means any of these exact labels appeared in the record's
transitions: `Arrived`, `Checked In`, `In Room`, `MD In`, `MD Out`, `In Session`,
`Ready in 1–4`. The column describes behaviour only. It is not a physical-arrival
mapping.

### 4.3 What the behaviour shows, and what it does not

These are observations about how each type's records behave. **None of them is
a type name, and none is used to assign a meaning.**

- **585137** is the bulk of forward-booked activity. It is booked about two
  weeks ahead and is never preceded by another type's completion. It carries
  essentially all `Complete`, cancellation and in-clinic activity.
- **503309** is the only type where a quarter of records end in `Signed No
  Review` or `Procedure Not Performed`. Of the 35 such outcomes in the data,
  about 25 fall here.
- **585138** records almost always (94%) follow a completed appointment of
  another type.
- **875741**, **874156** and most of **866117** behave unlike appointments:
  - created on the same day and **after** their own scheduled time
    (577 of 579 for 875741);
  - blank status, with one blank→blank transition;
  - no in-clinic evidence;
  - not created at intake (2 of 579 were created within 10 minutes of a
    submission).
  - **596 of the 599 non-deleted blank-status appointments belong to these three
    after-the-fact types.** The other 3 are spread thinly across three further
    types. This refines the earlier "about 30% of past appointments every
    month are blank": the blanks come from particular types. They are not
    missing statuses on real visits.

The "Consultation with vasectomy" type Jeff named (T:106, T:112) is
**probably, not provably**, one of 585137 or 503309. Which one, whether the
other is consultation-only, and whether 585138 is PVST follow-up **cannot be
decided from IDs or behaviour.**

### 4.4 What would resolve it (either route)

1. **Clinic confirmation (preferred and fastest):** Jeff or staff name the
   types for the four IDs that matter: 585137, 503309, 585138 and 875741. One
   screenshot of DrChrono's appointment-profile settings would do. No patient
   data is involved.
2. **Metadata access:** a one-off, GET-only `/api/appointment_profiles` read
   through a new n8n workflow, with names and IDs only. This needs explicit
   approval to create the workflow. If it is still refused with a 403, it also
   needs the practice owner to add the missing permission to the shared
   `DRSNIP-CHRONO` credential. **Re-authorising that credential swaps the token
   used by all five live intake workflows and cannot be rolled back**
   (`DRCHRONO_APPOINTMENT_ACCESS_CONFIRMATION.md` §12.4), so route 1 is safer.

Minimal metadata needed per type: `id`, `name`, and ideally `archived` and
`duration`. Nothing else.

---

## 5. Proposed patient-outcome contract

### 5.1 Unit and cohort

- **Unit:** one linked DrChrono chart (`patient_source_id`). One count per
  chart, never per appointment.
- **Cohort:**
  - Charts whose **first-ever** submission of the chosen form falls in the
    chosen entry period, in Pacific time. This is the existing convention.
  - Registration and insurance are separate, overlapping cohorts.
  - Repeat submissions do not create a new entry. The number of charts with a
    repeat submission is reported as an annotation.
- **Outside the patient count, but always shown:** unlinked submissions in the
  period, and charts whose history retrieval is not complete. Neither is placed
  in any outcome category.

### 5.2 Definitions

**Qualifying appointment:** a non-deleted appointment that meets all of these:

- its type is in the approved **qualifying-type set** (§5.4);
- it is scheduled **at or after the start of the entry date** (Pacific time);
- it is at a practice office. All 3 offices apply unless the clinic says
  otherwise.

**Qualifying completion:** a qualifying appointment whose current status is in
the **completion set**. Jeff's words support this set: `Complete`, `Signed No
Review`, `Procedure Not Performed`. Whether consultation-only outcomes count
toward conversion is **Q2**. The set is fixed; which types it applies to, and
whether `Procedure Not Performed` is counted or only shown beside the
conversion count, is the clinic's decision.

**Active qualifying booking:** a qualifying appointment with current status
`Scheduled` or `Confirmed`, and `scheduled_time` **after the evidence cutoff**.

### 5.3 The four categories (mutually exclusive, evaluated in this order)

| # | Category | Rule |
| --- | --- | --- |
| 1 | **Completed a qualifying appointment** | At least one qualifying completion |
| 2 | **Currently scheduled** (no qualifying completion) | Not 1, and at least one active qualifying booking |
| 3 | **Unknown** | Not 1 or 2, and the chart holds evidence that could change the answer and cannot yet be read (list below) |
| 4 | **Neither established** | Not 1, 2 or 3 |

Evidence that puts a chart in Unknown:

- a past-dated qualifying `Scheduled` or `Confirmed` record, where the visit
  date has passed and no outcome was recorded;
- a past-dated qualifying record with a blank or unclassified status;
- a qualifying `Rescheduled` record, with no later-created qualifying record
  visible (Jeff says a replacement "almost always" exists);
- a relevant record whose type is unresolved.

Rules:

- **Completion wins over booking.** A completed patient who also holds a future
  booking, such as the procedure after a consultation or a PVST, counts once, as
  Completed. The future booking can be shown as an annotation, "completed and
  also has a future booking".
- **Unknown only ever replaces Neither.** It never demotes a chart that has
  clear completion or booking evidence.
- **"Neither established" means:** as of the cutoff, there is no qualifying
  completion since entry and no future qualifying booking. It covers:
  - charts that were never booked;
  - charts whose bookings were all cancelled or late-cancelled;
  - no-shows;
  - past visits of non-qualifying types only.

  It does **not** mean lost, failed or ready for outreach, and must never be
  labelled that way. A secondary split can say *"no qualifying record since
  entry"* versus *"had one; none completed or active now"*.
- **Reschedule chains are not reconstructed.** The contract looks at the
  patient's set of records. It does not pair an old record with a new one by
  time proximity. A cancelled-then-rebooked-then-completed patient is Completed
  because of the completed record, not because of a proven chain.
- **Deleted records** never supply completion or booking. Their count is an
  annotation. Archived records (0 today) are treated as current, with an
  annotation if any appear.
- **Pre-existing appointments:**
  - A completion scheduled **before** entry does not count for this entry. For
    example, a returning patient's 2024 visit.
  - A qualifying appointment scheduled after entry but **created before** it
    (booked before the form) does count. It is annotated "booked before entry"
    so its size is visible.
- **Insurance patients who registered before the inquiry** stay in the insurance
  cohort, because the inquiry defines the entry. They are annotated, and there
  are 2 known cases. A later registration is not itself a conversion.
- **Completion is not arrival, and neither is procedure.** The view says
  "completed appointment", never "attended" or "had a vasectomy".
- **Freshness:** "future" is judged against the evidence cutoff, not the clock,
  and the cutoff is printed on the view.

### 5.4 The qualifying-type set

The set is a **server-side configuration with its own provenance**: who
confirmed it, their role, how, and when. It is *separate* from the attendance
mapping.

**Until it is configured, the calculation runs with "any appointment type"**.
While that holds:

- the view must say **"Any appointment type — provisional"**;
- it must **not** use the word "conversion";
- it must show the per-type composition of the Completed count, so any
  follow-up contamination is visible.

This matters because follow-up testing must not count automatically. Showing
"any type" openly is different from silently counting PVSTs as conversion.

### 5.5 Synthetic worked examples

All examples are for the registration cohort, entry 10 June, evidence cutoff 23
September. Types are **Q** (qualifying), **F** (follow-up, not qualifying) and
**U** (unresolved).

| # | Records (type, status, scheduled date) | Outcome | Why |
| --- | --- | --- | --- |
| 1 | Q Complete 1 Jul | **Completed** | |
| 2 | Q Rescheduled 1 Jul → Q Cancelled 20 Jul → Q Scheduled 15 Oct | **Scheduled** | Collection view; no chain needed |
| 3 | Q Complete 1 Jul; Q Scheduled 5 Oct | **Completed** (+ has future booking) | Completion wins |
| 4 | Q Procedure Not Performed 1 Jul | **Completed** if consultation-only counts; otherwise shown on its own line | Q2 |
| 5 | Q Cancelled 1 Jul, nothing else | **Neither** ("had one; none now") | |
| 6 | Q Rescheduled 1 Jul, nothing later | **Unknown** (replacement expected, not visible) | |
| 7 | Q Confirmed 1 Aug (past), no later status | **Unknown** (past-dated open) | |
| 8 | F Complete 1 Aug only | **Neither** | Follow-up is not acquisition |
| 9 | U blank 1 Aug only | **Unknown** (unresolved type) | |
| 10 | Q Complete 1 Mar (before entry), nothing after | **Neither** | Pre-entry visit |
| 11 | Q Scheduled 15 Oct, created 1 Jun (before entry) | **Scheduled** (+ booked before entry) | |
| 12 | Q Complete 1 Jul, record deleted | **Neither** (+ deleted-record annotation) | Deleted never supplies evidence |
| 13 | No appointments; history retrieved | **Neither** ("no qualifying record since entry") | |
| 14 | Chart history not yet retrieved | Outside the count; shown in coverage | |
| 15 | Registration submitted, never linked to a chart | Outside the count; shown as an unlinked submission | |
| 16 | Registered in June and again in August | June cohort only; counted in the repeat annotation | |

---

## 6. The three time-based questions

| View | Question | Can retained data support it? |
| --- | --- | --- |
| **1. Current position** | For the June entries, where do they stand at the cutoff? | **Yes.** Current status, type, date and deletion flag are exactly what `appointment_snapshots` holds. |
| **2. Time to first qualifying outcome** | How long until a qualifying record first appeared, or was first completed? | **Mostly.** First booking uses `source_created_at` of the earliest qualifying record. That is when the record was created, not proof of when a human booked, and it relies on the record's *current* type. First completion uses the completed record's `scheduled_time`, or its `Complete` transition timestamp. This supports the cumulative "of May's registrations, how many completed by June, July, August" view Jeff described (T:251) **for completions only**. |
| **3. Historical position** | Where did the June cohort stand on 31 July and 31 August? | **No, not as fact.** Past `scheduled_time` and type are overwritten. Deletion time is not stored. Status-at-date could be approximated from transitions, but transition completeness is unverified. "Scheduled as of 31 July" cannot be reconstructed reliably. **Do not publish reconstructed month-end positions.** |

**Recommendation for view 3 (not built):**

- Start a **month-end snapshot now**: at each month-end cutoff, store every
  cohort chart's category from §5.3 in a restricted table. From then on,
  historical positions are recorded, not inferred.
- Separately, add an **append-only change log** to the sync upsert. It would
  store the prior `scheduled_time`, type, status and deleted flag whenever they
  change. That makes later reconstruction possible for records changed after it
  starts.
- Neither can backfill the past. The first honest month-end point would be
  **30 September 2026**.

**The fixed-window measures stay as they are, as separate metrics:**

- recorded within 7, 14 or 30 days;
- advance booking;
- median days to first advance record.

They answer "how fast", while the new view answers "where are they now". Both
should be relabelled in plain words:

- "An appointment record was created within 14 days".
- "…and it was created before its scheduled date".

---

## 7. Illustrative production figures (any type, NOT qualifying)

These figures show the measure's shape and how much the type decision matters.
**They are not conversion figures.**

- "Completed" = current status `Complete`, `Signed No Review` or `Procedure Not
  Performed`, on any non-deleted appointment of **any type**, scheduled at or
  after the entry instant.
- "Scheduled" = `Scheduled` or `Confirmed`, any type, after the cutoff, with no
  such completion.
- Unknown is not yet separated out. The two right-hand columns are subsets of
  "Neither".

Cutoff: 2026-09-23 15:40 UTC.

| Form | Entry month | Charts (all history covered) | Completed (any type) | Scheduled, no completion | Neither | …of which past-dated open record | …of which blank after entry |
| --- | --- | --: | --: | --: | --: | --: | --: |
| Registration | Jun | 245 | 153 | <5 | withheld | <5 | 0 |
| Registration | Jul | 571 | 340 | 25 | 206 | <5 | 0 |
| Registration | Aug | 621 | 248 | 123 | 250 | 13 | <5 |
| Registration | Sep (to date) | 473 | 57 | 126 | 290 | 16 | <5 |
| Insurance | Aug | 29 | 6 | 5 | 18 | 0 | 0 |
| Insurance | Sep (to date) | 53 | <5 | <5 | 48 | <5 | 0 |

"Withheld" is complementary suppression: June's Neither would reveal the `<5`
cell. Insurance September's two small cells together total 5 and do not
identify each other.

Readings:

- **All but at most 2 completions per month fall on types 585137 or 503309.**
  So follow-up contamination is small *today*. It will grow as cohorts age and
  PVSTs complete, which is why the type decision must come before anyone uses
  the word "conversion".
- **The after-the-fact blank types hardly touch this measure**: 0–1 charts per
  month. They are inflating the existing *recorded* booking counts, not this
  view.
- **Registration June, "completed or scheduled": about 63%.** Registration
  July: about 64%. Jeff's hand-calculated summer figure is about 70% (T:242),
  to an unknown definition. The gap is worth discussing, not correcting.
  Candidates:
  - Jeff may count unlinked submissions differently.
  - He may count consultation-only visits differently.
  - Charts may be duplicated.
  - Patients may have been converted by phone without a new registration.
- August and September are still inside Jeff's 1–2-month window (T:95), so
  their Neither counts are expected to fall.

---

## 8. Minimal dashboard change

Add **one section above the existing fixed-window cards** on the Journeys page:
**"Where each month's patients stand now"**.

```
[ Registration | Insurance inquiry ]      Entry months: [Jun][Jul][Aug][Sep] [Custom…]
As of 23 Sep 2026, 8:40 am PT · appointment data complete to this time
Appointment types: ANY TYPE — PROVISIONAL (follow-up visits not yet excluded)

Entry month  Patients  Completed  Scheduled  Neither yet  Unknown   ▇▇▇▇▇▇▇░░░▒ (100% bar)
Jun 2026        245        153        <5      withheld       …
Jul 2026        571        340        25         206         …
Aug 2026        621        248       123         250         …
Sep 2026*       473         57       126         290         …     *entry month still open

Not in these counts: 35 registration forms not yet linked to a patient chart.
Completed = the appointment was completed; it does not by itself mean a procedure was performed.
```

- **A 100% stacked horizontal bar per month, not a funnel.** The four
  categories are a partition of the same patients at one instant, not
  sequential stages. A funnel would imply that Scheduled patients "passed
  through" Completed.
- **Completed and Scheduled are always shown separately.** A combined
  "completed or scheduled" figure is shown only once the qualifying-type set is
  approved. Until then, show both numbers and no sum labelled conversion.
- Suppression follows the existing partition rule (`suppressPartition`: a small
  cell is withheld together with a second one).
- Month presets add June and **Custom range**. Selecting several months shows
  them as rows, not merged.
- A secondary, collapsed "details" area holds:
  - the existing 7, 14 and 30-day record and advance-booking cards, with plain
    labels;
  - annotations: completed and also booked, booked before entry, deleted
    records, repeat submitters, pre-inquiry registrants;
  - Completed broken down by appointment-type ID, so type contamination is
    visible.
- **Out of scope:** touchpoints, quotes, emailed reports, outreach lists and any
  patient-level drill-down.

---

## 9. Exact scope for prompt two: building the calculation

**Build:**

1. **Migration `0021_patient_outcome.sql`**, applied by hand like 0014–0020 and
   owned by `drsnip_metrics_fn`:
   - `drsnip_outcome_metric(p_metric text, p_entry_from date, p_entry_to date)`.
     `p_metric` ∈ {`outcome_registration`, `outcome_insurance`}. It uses the
     same bounds checks and the same evidence-cutoff rule as
     `drsnip_booking_metric`.
   - It returns **one row per entry month** in the range: cohort, covered, not
     covered, unlinked submissions, completed, scheduled, unknown (by reason),
     neither (by the two sub-reasons), the annotations from §8, completed-by-type
     composition, `snapshot_cutoff`, `type_set_state`
     (`unconfigured`/`approved`) and `status`.
   - **Partition suppression** runs *inside* the function across
     Completed, Scheduled, Unknown and Neither. Annotations are suppressed per
     cell.
   - A **qualifying-type configuration table**, empty by default. Its
     provenance columns mirror `attendance_mappings`, and it has an approve path
     gated on `can_approve_definitions`. While empty, the function evaluates
     every type and returns `type_set_state = 'unconfigured'`.
   - The completion set and active-booking set are **constants in the
     function**, citing this brief §3. They are not an attendance mapping.
   - Grants and ownership: the same fix as `f39a4b6`; the reporting role
     executes.
2. **Route:** `GET /api/reports/outcome?metric=&from=&to=`, reusing the
   journey route's auth, validation and freshness plumbing.
3. **Tests (DB fixtures):**
   - every worked example in §5.5 as a named assertion;
   - partition suppression at exactly 3 in one cell;
   - the cutoff, not the clock, deciding future vs past;
   - an unconfigured type set never producing the word "conversion" in the
     payload;
   - deleted records ignored;
   - a Unknown case that never demotes a Completed chart.
4. **UI:** the §8 section. Presets, custom range, 100% bars and the provisional
   banner. The existing cards are relabelled and moved under details.
5. **Also fix two small inconsistencies found during this audit:**
   - the stale comment at `0020:329`;
   - `api/reports/booking.ts:124–130`, which reads attendance availability from
     the compiled constant instead of the database approval state.

**Do not build:**

- historical month-end reconstruction;
- the snapshot or change-log tables (they need their own go-ahead; §6);
- any profile lookup workflow;
- any attendance approval;
- anything patient-level.

**Before deploying:** land on PR #55 or a branch stacked on it, not `main`
(see CLAUDE.md on stacked branches). Re-derive the numbers independently
against the database at the same instant, as the v87 release did.

---

## 10. Questions that genuinely need Jeff

1. **What are appointment types 585137, 503309, 585138 and 875741 called?** A
   screenshot of the appointment-profile list would answer it. *Why:* this is
   the only thing standing between the view and the word "conversion". It
   decides whether PVSTs are excluded and whether the view measures
   consultations or procedures.
2. **If a patient's consultation happened but the procedure didn't (`Procedure
   Not Performed`, some `Signed No Review`), did they "convert"?** *Why:*
   consultation-only completion changes the Completed count. The numbers are
   small today (about 35 records in total), but this is a definitional choice.
3. **When an appointment date passes, does staff always change `Scheduled` or
   `Confirmed` to something else?** *Why:* 7 past `Scheduled` and 39 past
   `Confirmed` records exist. Whether they are missed updates or really
   no-outcome visits decides whether they are Unknown or something firmer.
4. **Should a returning patient, one with a completed visit before this
   registration, be counted in the month's cohort?** *Why:* the contract counts
   them, but credits only visits after entry. If Jeff's manual process excludes
   them, the two figures won't reconcile.

(Not asked, because the conversion measure does not need them: No Show
reliability, In Session, online check-in and the physical-arrival mapping.
Those belong to the separate attendance review.)

---

## 11. Closing

### What we can implement now

- The `drsnip_outcome_metric` calculation, route, tests and monthly
  current-position UI (§9). Completion and booking statuses rest on Jeff's
  explicit statements.
- An "any appointment type — provisional" mode, with per-type composition
  visible.
- Plain-language relabelling of the existing fixed-window booking cards, and the
  two small code and comment fixes.

### What is blocked

- **On appointment types:** the qualifying-type set. So is any figure labelled
  "conversion", any combined "completed or scheduled" total, any procedure-level
  claim, and PVST exclusion.
- **On clinic definitions:**
  - whether consultation-only counts (Q2);
  - how to treat past-dated open records (Q3);
  - the returning-patient rule (Q4);
  - separately, any physical-attendance mapping.
- **On time, not people:**
  - a historical month-end view (needs snapshots from 30 Sep onward);
  - a year-over-year seasonality view (intake starts 15 Jun 2026).

### What can realistically be shown in the next Loom

- The monthly table for June to September, registration and insurance. It
  would show **Completed** and **Scheduled** as separate counts, plus
  Unknown/coverage and the "as of" time. The banner would read "Any appointment
  type — provisional".
- One sentence correcting "advance booking".
- The four questions in §10, with Q1 asked on screen, since the type names
  unlock the rest.

Two things should not appear in the Loom:

- a single "conversion %";
- a month-over-month history of past positions.
