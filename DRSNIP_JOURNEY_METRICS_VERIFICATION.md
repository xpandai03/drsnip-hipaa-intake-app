# Dr. Snip journey metrics — calculation layer and verification

**Date:** 2026-09-20
**Data as-of:** 2026-09-20 02:00 UTC (read-only production query)
**Definition version:** 1.0.0
**Scope:** the calculation layer — reusable queries, metric contracts, tests, and
verified production results. **Not** dashboards, API routes, deployment, or
completing the backfill.

> Counts only. No patient identifiers, appointment identifiers, individual
> timelines or small identifying groups appear here. Cells below 5 are withheld
> together with their complements so a hidden value cannot be recovered.

---

## 1. Verified coverage, and corrections to the backfill report

Everything here was re-derived from the database. Nothing was carried over from
the previous report's prose. Four of its claims needed correcting.

### 1.1 The sweep horizon is contiguous — now proven, not asserted

| | |
|---|---|
| Complete windows | **26** |
| Union | **2000-01-01 → 2028-03-31** |
| Gaps or overlaps | **0** |

**Correction.** The report described "26 windows covering 2000–2028" *and*
"quarterly windows" without reconciling them; both are true but the shape was
never stated. Window 0 is a **single 22-year window** (2000-01-01 → 2021-12-31),
which is possible because a `date_range` entirely in the past has no length
limit. Windows 1–25 are **calendar quarters** from 2022-01-01 to 2028-03-31.
Contiguity is now computed (`lag(range_end)` against `range_start`) rather than
assumed, because every horizon-bounded negative claim rests on it.

### 1.2 "1,436 definitively answered" was wrong

A positive match proves existence. A negative proves only what was searched.
Conflating them produced a number the ledger does not support.

| Coverage bucket | Patients | What is actually established |
|---|---:|---|
| Appointment found, history complete | **77** | Has appointments; whole history known. |
| Appointment found, sweep only | **1,335** | Has appointments (**proven**); more may exist outside the horizon. |
| No appointment, history complete | **24** | **No appointment on record at all** — the only lifetime-negative group. |
| No appointment, sweep only | **595** | None scheduled 2000-01-01 → 2028-03-31. Says nothing beyond it. |
| **Total linked patients** | **2,031** | |

- **1,412** patients have an appointment *found* (1,335 + 77).
- Only **101** patients have *complete history retrieved* (77 + 24).
- Only **24** patients support "this patient has never booked".

The earlier figure added 1,412 + 24 and called the result "definitively
answered". The 1,335 sweep-only positives are definitive about *existence* but
not about *completeness*, and the 595 are not definitive at all.

### 1.3 The out-of-horizon example was inside the horizon

**Correction.** The report cited a probe of 2027-04-01 → 2027-09-27 as evidence
of appointments beyond coverage. That range sits **inside** the 2028-03-31
horizon, and windows `sched:0022`/`sched:0023` swept it (13 appointments each).
It demonstrated nothing about out-of-horizon records.

What is actually known: among the 101 history-complete patients — the only ones
retrieved with no date bound — **0 of their 169 appointments fall outside
2000-01-01 → 2028-03-31**. That is real evidence that out-of-horizon records are
rare, but it is a 101-patient sample chosen by retrieval order, so it bounds
nothing for the other 1,930.

### 1.4 Linkage drift was zero, not one

**Correction.** The report said the population grew 2,030 → 2,031 "mid-run" and
implied a catch-up need. Using `n8n_response_at` (the write-back timestamp — the
one linkage time the schema actually records):

- latest linkage: **2026-09-19 23:12:37 UTC**
- first sweep window completed: **2026-09-19 23:32:06 UTC**

Every completed window therefore ran against the **full 2,031-patient**
population. Patients linked after the sweep's last window: **0**. No catch-up is
outstanding for the sweep.

### 1.5 Transition retrieval

| Per-appointment state | Appointments |
|---|---:|
| `transitions_retrieved_present` | **418** |
| `transitions_retrieved_empty` (confirmed none) | **0** |
| `transitions_not_retrieved` (**unknown**) | **2,153** |
| Total | 2,571 |

**84% of appointments are in a state where absence of transitions means nothing.**
Any metric reading "no transitions" as "no progression" would be measuring the
retrieval strategy, not the patient. This is the single fact that blocks
attendance.

---

## 2. Implemented metric definitions

Files: [`lib/metrics/contract.ts`](Intake-form/lib/metrics/contract.ts),
[`lib/metrics/coverage.ts`](Intake-form/lib/metrics/coverage.ts),
[`lib/metrics/journey-sql.ts`](Intake-form/lib/metrics/journey-sql.ts).

### 2.1 Conventions that apply to every metric

- **Entry periods** filter on the **Pacific calendar day** of the entry instant
  — "which month did this patient come in" is a local-calendar question.
- **Follow-up windows are elapsed durations** (`N × 24 hours`), never calendar
  days, so two cohorts always receive identical time and remain comparable.
- **First entry is computed across all available history, then** the entry
  period is applied. The reverse makes a returning patient look new whenever
  their earlier submission falls outside the selected month.
- **Unit is distinct linked patient IDs.** Where one human could hold two
  charts this is a chart count, not a person count.
- **Registration and insurance cohorts overlap by design** and must never be
  summed. (A test asserts the overlap is non-empty rather than leaving it
  implicit.)
- Values are machine-readable numbers; formatting is a separate concern.
- `status` distinguishes **zero**, **zero denominator**, **immature**,
  **suppressed**, **insufficient coverage**, **unavailable** and **blocked** —
  states a single nullable number would smear together.

### 2.2 Metric register

| ID | Label | Unit | Status |
|---|---|---|---|
| `registration_to_consultation_submitted` | Registration → consultation form submitted | distinct patient IDs | **Ready** |
| `insurance_inquiry_to_registration` | Insurance inquiry → registration | distinct patient IDs | **Ready** |
| `appointment_record_created_after_entry` | Appointment record created after entry | distinct patient IDs | **Conditional** |
| `forward_scheduled_appointment_record` | Forward-scheduled appointment record created after entry | distinct patient IDs | **Conditional** |
| `appointment_recorded_at_or_after_scheduled` | Appointment recorded at/after its scheduled time | distinct patient IDs | **Conditional** |
| `appointment_record_predating_intake` | Appointment record predating intake | distinct patient IDs | **Conditional** |
| `appointment_attendance_rate` | Attendance | — | **Blocked** |

Names say **"form submitted"** and **"record created"** deliberately. Neither is
booking, arrival or attendance.

---

## 3. Production results

Entry period for the headline figures is the full intake history,
**2026-06-15 → 2026-09-20 Pacific**, unless stated.

### 3.1 Registration → consultation form submitted — READY

Cohort: **1,842** distinct linked patient IDs whose first registration falls in
the period.

| Mode | Numerator | Denominator | Rate | Note |
|---|---:|---:|---:|---|
| Observed-to-date | 672 | 1,842 | **36.5%** | Lower bound; drifts up as cohorts age. Not comparable between cohorts. |
| Mature 7-day | 213 | 1,690 | **12.6%** | |
| Mature 14-day | 366 | 1,548 | **23.6%** | |
| Mature 30-day | 465 | 1,211 | **38.4%** | |

Time to consultation among the 672 matched: **median 11.4 days**, p75 21.9,
p90 35.3.

By entry month, on equal 14-day windows — the only fair comparison:

| Entry month | Mature 14-day | Rate |
|---|---:|---:|
| July 2026 | 144 / 571 | 25.2% |
| August 2026 | 140 / 621 | 22.5% |

September is deliberately absent: its cohort has not had 14 days, and including
it would make a young month look like a failing one.

### 3.2 Insurance inquiry → registration — READY, and it corrects a published number

Entries: **69**. Already registered before inquiring (cannot convert, reported
separately): **2**. Eligible: **67**. Eligibility unknown: **0**.

| Mode | Numerator | Denominator | Rate |
|---|---:|---:|---:|
| Observed-to-date | 25 | 67 | **37.3%** |
| Mature 14-day | 15 | 35 | **42.9%** |
| Mature 30-day | *withheld* | *withheld* | *withheld* |
| August entries, 14-day | 13 | 29 | **44.8%** |

Median time to registration: **3.1 days**.

**The historical 37.3% reproduces exactly as 25/67 observed-to-date.** It was
never a 14-day conversion rate. Applying a real 14-day outcome window and a
mature denominator gives **42.9% (15/35)** — a different number over a different
population, and the two must not be swapped for each other.

The 30-day figure is **suppressed**: its denominator is 4. Publishing it, or the
rate, would identify individuals; the numerator, denominator and rate are
withheld together so the value cannot be recovered by subtraction.

### 3.3 Appointment-record evidence — CONDITIONAL

These are bounded by retrieval coverage and are reported as **observed minima**,
not conversion rates.

**Registration cohort, 14-day window** (cohort 1,842):

| Measure | Patients | Reading |
|---|---:|---|
| Appointment record created after entry | **1,117** | **Observed minimum 60.6%** — a floor, not a rate. |
| ├ Forward-scheduled (created before scheduled time) | 1,102 | Conservative subset that looks like a genuine forward booking. |
| └ Created at/after its scheduled time | 243 | Its own category — not bad data, not an advance booking. |
| Record predating intake — past visit | 43 | Historical visit before entry. |
| Record predating intake — already-scheduled future visit | 83 | Booked before entry, for a date after it. A different thing. |
| In-window record later deleted | 55 | Evidence retained; the record was created. |
| **Unresolved** | **683** | No record found **and** no complete history — not a negative. |
| Exact subset (history-complete only) | 41 / 83 | **Not generalisable** — 83 patients chosen by retrieval order. |

Median time from entry to record creation: **2.5 days**.

The forward-scheduled and at/after counts **overlap** (a patient may have one of
each) and do not partition the 1,117.

**30-day window:** 1,184 positives (observed minimum 64.3%), 620 unresolved.

**Insurance cohort, 14-day window** (cohort 69): 17 positives (observed minimum
24.6%), 52 unresolved. Its exact subset has a denominator of 1 and is
**suppressed**.

**Why these are minima, not rates.** A creation-time window can be satisfied by
an appointment *scheduled* far in the future. The sweep is bounded by scheduled
date, so an appointment created inside the window but scheduled beyond
2028-03-31 is invisible to it. Positives are real; "none found" is only exact for
the 101 history-complete patients.

**Deleted, cancelled and archived records** count as evidence that a record was
created, because that is what these measure. Current state is reported
separately so a cancelled booking is never erased from history.

### 3.4 Attendance — BLOCKED

Returns `blocked`. Three independent reasons, any one sufficient:

1. **Transition retrieval is incomplete** — 2,153 of 2,571 appointments are in
   `transitions_not_retrieved`, where absence is a retrieval artefact.
2. **No approved arrival-status mapping.** The clinic's vocabulary is stored
   verbatim and its meaning is unconfirmed.
3. **Procedure completion is not established** by any stored field.

Computing it over the 101 history-complete patients and generalising would be
the specific error this layer exists to prevent: that group was selected by
retrieval order, not sampled.

`current_status` is **not** a substitute. 627 appointments have blank status and
59 of those have transition history — blank does not mean nothing happened.

---

## 4. Denominators, exclusions and unknowns

| Exclusion | Count | Impact |
|---|---:|---|
| Unlinked intake submissions (no DrChrono id) | **244** | Invisible to every patient metric. They are real submissions; patient-keyed rates cannot see them. |
| Patients already registered before insurance inquiry | 2 | Reported separately, never in the conversion denominator. |
| Insurance entries with unknowable eligibility | 0 | None currently sit at the edge of intake history. |
| **Test records** | **unresolved** | **No test-record exclusion is applied.** Identifying them would need name/email heuristics that are not approved. Any genuine test submissions are therefore *included* in every cohort and inflate denominators by an unknown amount. |

**Intake history begins 2026-06-15.** "Not previously registered" can only ever
mean "not in the intake data we hold". For an inquiry near that boundary the
implementation marks eligibility **unknown** rather than assuming a first-time
patient.

**Source tags are not treated as acquisition channels.** Nothing here attributes
a patient to an original marketing source.

---

## 5. Tests and independent reconciliation

**42 tests in [`api/_test/journey-metrics.test.ts`](Intake-form/api/_test/journey-metrics.test.ts), all passing.**
Full API suite: **383 passing, 0 failures** (17 cancelled from the pre-existing
`DATABASE_URL` gap; 55 skipped are the DB-backed suites).

Every expected number in the fixture tests is worked out **by hand** and written
as a literal. Coverage includes: normal progression; repeated forms where the
first entry falls outside the selected period; a consultation preceding
registration; same-timestamp ties; missing patient IDs; pre-existing past and
future appointments; multiple bookings with cancellation and rebooking; records
created after their scheduled time; deleted records; horizon-limited versus
complete history; missing versus empty transitions; immature cohorts; zero
outcomes; zero denominators; DST boundaries; and small-cell suppression
including the complementary-disclosure case.

### Two real bugs the tests caught

**`bool_or` returns NULL over zero rows, and `NOT NULL` is NULL.** Patients with
*no appointments at all* were silently dropped from every `FILTER` — including
`unresolved`, which exists precisely to account for them. Fixed with explicit
`COALESCE(..., false)`.

**`timestamptz + interval '7 days'` is calendar arithmetic in the session time
zone.** Across the Pacific fall-back it spans **169 hours, not 168**, so a cohort
would receive an extra hour purely because of when it fell, and the result would
depend on the connection's `TimeZone`. The contract says windows are elapsed
durations; the SQL did not implement that. Now written as `(N * 24) || ' hours'`.
A test asserts both the trap (169) and the fix (168).

### Independent reconciliation against production

Six checks written with **different SQL structures** than the implementation
(`DISTINCT ON` + `EXISTS` instead of correlated `min()`; a `DISTINCT` join
instead of `bool_or`; explicit `interval '336 hours'`):

| Check | Implementation | Independent | Agreement |
|---|---|---|---|
| Registration cohort / observed | 1,842 / 672 | 1,842 / 672 | ✅ |
| Mature 14-day | 1,548 / 366 | 1,548 / 366 | ✅ |
| Insurance entries / already-registered / converted | 69 / 2 / 25 | 69 / 2 / 25 | ✅ |
| Appointment positives / forward / at-or-after | 1,117 / 1,102 / 243 | 1,117 / 1,102 / 243 | ✅ |
| Coverage buckets sum to linked patients | 2,031 | 1,335+595+77+24 = 2,031 | ✅ |
| Transition states sum to appointments | 2,571 | 2,153 + 418 = 2,571 | ✅ |

**Zero discrepancies.**

---

## 6. Ready / conditional / blocked

**Ready to show now, with their mode stated:**
- `registration_to_consultation_submitted` — observed-to-date and mature 7/14/30-day, plus percentiles.
- `insurance_inquiry_to_registration` — same, with the already-registered group reported separately.

Both are computed purely from intake submissions, which have no retrieval-coverage
problem. They must always carry their **mode**: an observed-to-date number and a
mature-window number are different quantities.

**Conditional — showable only with an explicit coverage label:**
- the four appointment-record measures, as **observed minima** with the
  unresolved count displayed beside them. A dashboard that renders 1,117/1,842 as
  "60.6% booked" without the 683 unresolved would be misleading.

**Blocked:**
- `appointment_attendance_rate` and anything downstream of arrival or procedure
  completion.

---

## 7. What would unblock the blocked metrics

| Blocker | What is needed | Who |
|---|---|---|
| 2,153 appointments with unretrieved transitions | Finish Phase B: per-patient `?patient=` retrieval for the remaining **1,930** patients, ≈1,930 requests at ~300/hour. | A backfill task — **not** this one. |
| Arrival-status mapping unapproved | Clinic confirmation of what `MD In`, `Ready in 1/2/3`, `Late Cancel within 48 hrs` and blank mean. Open as §10 of `DRSNIP_PATIENT_JOURNEY_DEFINITIONS.md`. | Staff decision. |
| Procedure completion not established | Confirmation of which field, if any, records it. | Staff decision. |
| Appointment profile names | `/api/appointment_profiles` returns 403. | Access change. |
| Test-record identification | An approved rule (a flag or an explicit list), not a name/email heuristic. | Staff decision. |

No new DrChrono data was fetched for this task.

---

## 8. Proposed future access (specified, NOT applied)

A dashboard endpoint must not query `submissions` or `appointment_snapshots`
directly — both are PHI-bearing, and `drsnip_reporting_ro` is correctly denied
on the appointment tables today.

**Minimum proposal**, for a later task to review and apply:

```sql
-- Aggregate-only, parameterised, SECURITY DEFINER so the caller never needs a
-- privilege on the underlying PHI tables. Returns one row of counts; it must
-- never return a patient id, an appointment id or a timestamp.
CREATE FUNCTION drsnip_journey_metric(
  metric_id   text,
  entry_from  date,
  entry_to    date,   -- exclusive
  window_days int
) RETURNS TABLE (
  cohort int, numerator int, denominator int,
  unresolved int, exact_numerator int, exact_denominator int,
  p50_days numeric, status text
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$ /* the vetted statements from lib/metrics/journey-sql.ts */ $$;

REVOKE ALL ON FUNCTION drsnip_journey_metric(text,date,date,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION drsnip_journey_metric(text,date,date,int) TO drsnip_reporting_ro;
```

Notes for whoever applies it: `SECURITY DEFINER` requires a pinned
`search_path` (set above) or it is a privilege-escalation path; suppression must
be applied **inside** the function so a small cell never crosses the boundary;
and `metric_id` must be validated against a fixed allow-list, never concatenated
into SQL.

**No grants, functions or migrations were applied by this task.**

---

## 9. Handoff for the dashboard task

1. **Always render the mode.** "36.5% observed-to-date" and "23.6% at 14 days"
   are different quantities. A tile showing one labelled as the other is the
   exact defect this layer was built to stop.
2. **Never sum the registration and insurance cohorts.** They overlap.
3. **Show `unresolved` next to every appointment measure**, or label the value an
   observed minimum. Do not render it as a conversion rate.
4. **Respect `status`.** `zero_denominator`, `immature`, `suppressed` and
   `blocked` each need distinct treatment — none of them is "0%".
5. **Do not compare months on observed-to-date.** Use equal mature windows;
   September has no 14-day figure yet and that is correct.
6. **Attendance is unavailable.** Do not substitute `Complete` or blank status.
7. Values arrive as numbers. Format at the edge; never parse a formatted string.
