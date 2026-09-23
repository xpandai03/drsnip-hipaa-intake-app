# Reporting meaning and accuracy audit

**Date:** 23 September 2026, 20:40–21:15 UTC
**Scope:** read-only.

- Nothing was changed in code, migrations, definitions, approvals, credentials
  or workflows.
- Nothing was committed, pushed or deployed.
- Production was read under `default_transaction_read_only=on`, plus signed-in
  GET requests as the application's own read-only viewer account.

**Privacy.** This report contains aggregates only. Cells of 1–4 are shown as
`<5`, and complementary cells are merged or withheld.

**Headline:**

- Within its stated provisional scope, **Monthly outcomes answers Jeff's
  question correctly, and its July figures reproduce exactly from an
  independent derivation.**
- **One confirmed defect affects every appointment-based report.** The
  "evidence cutoff" is taken as the latest per-patient catch-up time. That time
  covers one patient, not everyone, so it overstates how current the data is
  and can hide a stalled sync (§3).
- It should be fixed before the Loom. It is a small change.

---

## 1. Live state (verified, not assumed)

| Item | Evidence |
| --- | --- |
| Live release | **Fly v88**, image `deployment-01M37M55X1HM7TBC7J0K0YBGN1`; both machines on v88 |
| Deployed code | `bdab3bf` (release report; built from a pristine worktree). The live bundle `index-DTt9blUe.js` contains the Monthly outcomes page (`outcomes-page`, `provisional-banner`, `Breakdown withheld`) |
| Branch / PR | `feat/console-redesign-insurance-demo` = `origin` = PR #55 head `abba5cf` (docs-only above `bdab3bf`); PR OPEN, not merged |
| Local tree | Only the unrelated `DRSNIP_APPOINTMENT_BACKFILL_REPORT.md` is modified. No code changes |
| Production DB objects | `drsnip_outcome_classify`, `drsnip_outcome_metric` and `drsnip_outcome_definition`, plus the status rules, the scope and the 15-name catalog. All six are **byte-identical** (md5 of `pg_get_functiondef` / seeded content) to a fresh apply of the committed `0021` |
| Definition in force | Scope `selected_procedure_types` v1 **provisional**. Status rules v1 **provisional**, with No Show *unclassified*. 0 approved rows |

### 1.1 What produces each displayed figure

| Displayed | Source |
| --- | --- |
| Monthly outcomes table: Patients counted, the four outcome columns, details | `GET /api/reports/outcomes` (`Intake-form/api/reports/outcomes.ts`) → `drsnip_outcome_metric()` → `drsnip_outcome_classify()` (0021) |
| Table "Data complete to …" | `evidence_cutoff` from `drsnip_outcome_metric()`: **`greatest(max(patient_history completed_at), practice_incremental watermark)`** |
| Header badge "Appointment data complete to … · updates hourly" | `/api/reports/freshness` → `drsnip_journey_freshness()` (0017): **`coalesce(practice_incremental watermark, max completed_at)`**, i.e. the watermark |
| "What is included?" | `drsnip_outcome_definition()` plus role and status wording in `lib/metrics/outcomes.ts` |
| Patient journeys: record-created and advance-booking waterfall, and context cards | `/api/reports/booking` → `drsnip_booking_metric()` (0019), with the same `greatest()` cutoff |
| Patient journeys: consultation-form and insurance-to-registration cards | `/api/reports/journey` → `drsnip_journey_metric()` (0014/0016). Intake only; no appointment data |
| Attendance review card | `/api/reports/attendance` → `drsnip_attendance_metric()` (0020), with the same `greatest()` cutoff. It publishes "unapproved" and no counts |

---

## 2. Monthly outcomes against Jeff's question

Jeff asked (T:129–135): *"All the registration forms that came in in June or
July — if I looked at it today, how many did we actually convert? Meaning they
either have a completed appointment or they're scheduled."*

Monthly outcomes answers exactly that, per entry month, with two deliberate
differences:

- it shows Completed and Scheduled **separately** rather than summed;
- it reserves the word "conversion" until the clinic settles which appointment
  types count.

### 2.1 Column by column

Terms used below:

- **"Included"** means the three `qualifying` profiles: 585137 Consultation with
  Vasectomy, 874151 Auction Winner Consultation with Vasectomy, and 585138
  Vasectomy Only.
- **"Relevant"** means non-deleted and scheduled on or after the entry clinic
  day.

| Column | Actual rule (0021) | Plain English | Does **not** establish | Mismatch found |
| --- | --- | --- | --- | --- |
| **Patients counted** | Linked charts whose **first-ever** submission of this form falls in the clinic month, **and** whose full history has been read | The people this month's figures are about; each once | That these are distinct people (a person with two charts counts twice) | None. Unlinked submissions and history not yet read are shown beside it, not inside it |
| **Completed** | Any relevant included appointment whose current status is `Complete` or `Signed No Review` | Completed an included appointment since entering | That a procedure was performed; physical arrival; which visit it was | None. The copy says "does not by itself show a procedure was performed" |
| **Currently scheduled** | No completion, and any relevant included appointment `Scheduled`/`Confirmed` with a date **after the evidence cutoff** | Has an included booking still ahead | That they will attend; when it was booked | **Depends on the cutoff, which is overstated (§3).** A booking in the overstated gap reads as past-dated, so Unknown. July was unaffected at the audit instant |
| **Unknown** | Neither of the above, and at least one *relevant* ambiguity: a past-dated open booking; an unresolved status (blank, NULL, in-clinic, **No Show**, unrecognised); a reschedule with no later-created candidate replacement; completion in history but not now; completion only on a deleted record; or a completed/due/unresolved record of an undecided or unnamed type | Evidence exists but cannot be read either way yet | That the patient did or did not convert | Minor: the reason label says "once reached **Complete**"; the code also counts `Signed No Review` |
| **Neither established** | Everything else among patients counted | No included completion or current booking, from the evidence available | That the patient was lost, did not attend, or should be contacted (the page says so) | None. "Had one; none completed or booked now" also covers `Procedure Not Performed`, which the annotation discloses |

### 2.2 Case checks

Each case below was verified against code and synthetic tests (41 of 41
passing on the committed code, re-run during this audit), and against
production aggregates where noted. The number on each line is the finding
class:

1. confirmed implementation defect;
2. misleading wording or presentation;
3. unresolved clinic decision;
4. correct behaviour needing a simple explanation.

**Appointment scope**

- (4) The three included IDs map to the verified names: production catalog
  content is byte-identical to the migration seed.
- (4) Follow-up, lab, PVST and light-duty records (`excluded_known`) cannot
  create Completed or Scheduled, and their ambiguity is ignored. Tested with a
  PVST-only blank and a lab-only future booking; both are Neither.
- (4)/(3) Consultation Only is `comparison`: never inside the columns, reported
  as an annotation. **July: 16 patients** not otherwise completed had a
  Consultation Only completion. Whether it counts is decision **C1** (§6).
- (4)/(3) The six undecided types make a patient Unknown only when a record is
  completed, due or unresolved. July: `<5`.
- (4) Unnamed or NULL type IDs are `unknown_profile`, listed separately from
  known exclusions in "What is included?". July: 0.
- (4) Signed No Review is recognised as appointment completion. Whether it
  qualifies is decision **C3**. July: 0 patients completed via SNR only.
- (4) Procedure Not Performed is its own class, never Completed, and shown as an
  annotation. July: `<5`.

**Patient-level classification**

- (4) Exactly one bucket per counted patient. Buckets sum to covered: July
  321+27+14+209 = 571.
- (4) Precedence is Completed > Scheduled > Unknown > Neither. It is disclosed
  in the column meanings.
- (4) Old cancellations and reschedules never outweigh an active replacement or
  a completion. Tested: cancel then book stays Scheduled; reschedule then book
  stays Scheduled; a reschedule chain ending in cancel is Neither.
- (4) "Rescheduled" alone never proves a replacement. With no later-created
  candidate, the patient is Unknown. This is existence only, never pairing by
  time.
- (4) A past-dated `Scheduled`/`Confirmed` booking is Unknown (past-dated open),
  never future. The cutoff issue affects only *where the past begins* (§3).
- (4) No Show, blank and in-clinic statuses are unresolved: Unknown, never a
  negative. July: 10 of the 14 Unknowns are "status unresolved". No Show never
  erases a completion or future booking (regression test).
- (4) Deleted records never supply a positive, and a completion only on a
  deleted record gives Unknown. Archived records are treated as present; there
  are 0 archived in production. A completion contradicted by a later status on
  the same record gives Unknown (conflicting history). July: 0.
- (4) Unrelated ambiguity never erases a clear outcome. Tested with Completed
  plus a blank PVST record plus an undecided-type booking: stays Completed.

**Entry and coverage**

- (4) Entry is the first-ever submission per chart per form. Repeats are
  counted once and annotated (July: 10 repeat submitters).
- (4) Registration and insurance are computed separately and never summed.
- (4) Pre-entry bookings for dates after entry count, annotated as "booked
  before entry" (July: 15). Pre-entry completions do not count and are
  annotated (July: 0). Returning patients stay in their cohort. Decision **C6**.
- (4) Already-registered insurance inquirers are **included** and counted, as
  the page states.
- (4) Unlinked submissions are shown as "N submissions not linked to a chart"
  (July: 9). They are counted as submissions, not people, and sit outside the
  columns.
- (4) No 14-day maturity rule applies. Recent cohorts are included, with
  "observed X–Y days" and "Still open".
- (4) The Unknown and Neither copy explicitly denies lost, non-attendance and
  outreach.

**No implementation defect was found in the classification itself.** The one
defect is the evidence cutoff it is evaluated against.

---

## 3. Freshness: the two timestamps (CONFIRMED DEFECT, fix before the Loom)

### 3.1 What each timestamp guarantees

| Timestamp | Computed as | What it guarantees |
| --- | --- | --- |
| **Watermark** (header badge) | `appointment_sync_state.watermark` for `practice_incremental` = `run_cutoff` of the last incremental run that **completed its whole window** (`appointment-sync.sql:230`: advances only when `complete AND outcome='success'`; `run_cutoff` is captured once at run start, `0012:61`) | Every covered patient's appointment changes made up to this instant have been read. **Practice-wide.** Partial, failed and budget-exhausted runs cannot advance it |
| **Patient-history `completed_at`** | `now()` when one patient's full-history read finished (`appointment-sync.sql:376`), set only for `complete` units | That **one patient's** history is complete to that instant |
| **Table cutoff** (outcomes, booking, attendance) | `greatest(max(completed_at over all patient_history units), watermark)` (0019 → 0020 → 0021) | Nothing practice-wide beyond the watermark. **The maximum is one patient's guarantee applied to everyone** |

The watermark is a valid lower bound for **every covered patient**:

- backfilled patients are carried forward by the incremental cursor;
- a patient caught up after the last incremental run is complete to their own,
  later, catch-up time;
- a patient not yet read is excluded as not covered.

So the watermark is the defensible reporting cutoff. `max(completed_at)` is not.
Migration 0018 reasoned correctly when it initialised the cursor from
**`min(completed_at)`**; 0019 then introduced `greatest(max…)`.

### 3.2 Measured in production

- **At the audit instant:** watermark 20:05:00 UTC; table cutoff 20:40:39 UTC.
  The page showed "Data complete to 1:40 PM" beside a badge reading "complete
  to 1:05 PM".
- **Since the incremental sync went live** (77 successful incremental runs in 7
  days, **0 failed or partial**; 83 catch-up completions, about 26 a day):
  - **every** catch-up completion pushed the table cutoff past the watermark;
  - the overstatement had a **median of 36 minutes**, p90 56, max 56;
  - it was in effect **32% of the time**.
- **Classification effect at the audit instant: none for July.** The
  independent derivation gives identical July buckets at either cutoff; no
  included Scheduled/Confirmed booking fell inside the 35-minute gap.

### 3.3 Why it matters anyway

1. **The completeness claim is false for most patients** for up to about an
   hour. The page says "Data complete to 1:40 PM" when practice-wide changes
   are only read to 1:05 PM.
2. **It hides a stalled sync.** The stale warning is driven by the cutoff's
   age. If the hourly incremental sync stopped, the 10-minute catch-up would
   keep advancing the table cutoff whenever a new patient linked (about 26 times
   a day). The stale warning would then never fire, while every other patient's
   data aged indefinitely. In that state "Currently scheduled" would also be
   judged against a moving "now" that the stored statuses do not support.
3. **"Currently scheduled" is judged against the overstated instant.** A
   booking scheduled inside the gap is classified as past-dated (Unknown) though
   the evidence cannot yet say whether it happened. The effect is small but
   systematic, and it grows without bound in the stalled case.
4. The **booking** (maturity) and **attendance** functions use the same rule,
   so Patient journeys is affected the same way.

Other checks:

- **Partial or failed runs** do not affect either timestamp. The 38 failed and 1
  partial `historical_sweep` runs in the window never set `completed_at` or
  advance the watermark.
- **Evidence boundaries.** Inventory and coverage counts ("N of M linked
  patients have history loaded") read the same `appointment_sync_windows`
  table the calculation uses, so they are consistent with each other. Only the
  *cutoff instant* differs.

### 3.4 Recommendation

**Use one reporting cutoff: the `practice_incremental` watermark.**

- Apply it in `drsnip_outcome_metric`, `drsnip_booking_metric` and
  `drsnip_attendance_evidence`, ideally through one shared function.
- If there is no watermark, report "unavailable" rather than falling back to
  `max(completed_at)`.
- Keep per-patient catch-up only for **coverage**: whether a patient is counted.
- Show **one** "Appointment data complete to …" time, the same one in the badge
  and the table.

---

## 4. Independent reconciliation: July 2026 registrations

July has full coverage: 571 of 571 linked charts have history read, and 0 are
awaiting a read. It has also been observed for 53–84 days.

**Method.** A third, separately written SQL derivation ("C") was used. It does
per-patient `EXISTS` tests against the definition values and shares no text
with `drsnip_outcome_classify` (nor with the earlier "B" query). It was run at
the same instant as a signed-in capture of the production API and the rendered
page.

| At cutoff 2026-09-23 20:40:39 UTC | Patients counted | Completed | Currently scheduled | Unknown | Neither established |
| --- | --: | --: | --: | --: | --: |
| Independent derivation C | 571 | 321 | 27 | 14 | 209 |
| Production API | 571 | 321 | 27 | 14 | 209 |
| Rendered page | 571 | 321 | 27 | 14 | 209 |
| C at the watermark cutoff (20:05:00) | 571 | 321 | 27 | 14 | 209 |

Accounted for:

- 9 unlinked July registration submissions, outside the count;
- 0 not covered;
- no withheld cells in July.

API detail:

- **Unknown reasons:** status unresolved 10; past-dated open `<5`; reschedule
  without replacement `<5`; undecided type `<5`; conflicting and deleted 0.
- **Neither split:** 165 had no included appointment since entry; 44 had one,
  none completed or current.

### 4.1 The same July cohort on Patient journeys

The population is identical: 571 eligible at 14 and 30 days, because July is
fully mature. The same cutoff applies.

| Measure (old page) | July | What it counts |
| --- | --: | --: |
| Appointment record created within 14 days | 365 | Any appointment record of **any type**, in **any status**, **including later-cancelled and deleted**, whose creation timestamp is within 14 × 24 h after entry |
| "Advance booking recorded", 14 days | 361 | The subset created **before its own scheduled time** |
| Record created within 30 days / advance | 400 / 393 | The same, over 30 days |
| Consultation form submitted (observed / within 14 days) | 289 / 144 | An intake **form**, not an appointment |

The two views cross-tabulated for the same 571 patients (scheduled and unknown
merged to protect a small cell):

| Current outcome | Patients | Record created ≤14 d | Advance ≤14 d | Included-type record ≤14 d | No record ≤14 d |
| --- | --: | --: | --: | --: | --: |
| Completed | 321 | 284 | 280 | 278 | 37 |
| Scheduled or Unknown | 41 | 26 | 26 | 22 | 15 |
| Neither established | 209 | 55 | 55 | 41 | 154 |
| **Total** | **571** | **365** | **361** | 341 | 206 |

The totals reproduce the old page exactly (365 and 361). This is also an
independent check of the booking function.

**Why neither figure can stand in for the other:**

- **55 patients** had an appointment record within 14 days but are now
  *Neither established*. Their records were cancelled, rescheduled away, or not
  an included type; 14 of those 55 patients had no included-type record in that window at all.
- **37 patients** have *Completed* an included appointment with **no** record
  created in their first 14 days. They were booked later, or booked before
  registering.
- Record-created counts **PVST, lab, consultation-only, cancelled and deleted**
  records. Monthly outcomes counts only included types, by current status, at
  any time since entry.
- **"Advance booking" is not a step after "record created".** It is the same
  records filtered on a timestamp comparison, 361 of 365. As a funnel stage it
  implies a second patient milestone that does not exist.

Same population, same instant: the difference is definitional, not business
performance.

---

## 5. The old Patient journeys page

| Element | Verdict | Why |
| --- | --- | --- |
| **Waterfall "Eligible cohort → Appointment record created → Advance booking recorded"** | **Remove as a headline** (class 2) | Presents a record-timestamp filter as a patient stage; 361 of 365 is not progress. Superseded by Monthly outcomes for "did they convert" |
| Registration → **consultation form submitted** (observed to date + mature 14 d) | **Retain**, rename "Consultation form submitted after registration" | A genuine, intake-only progression measure with a clear definition |
| Insurance inquiry → **registration submitted** | **Retain** | Answers "did inquiries turn into registrations". It excludes inquirers already registered; say so |
| Record-created and advance-booking counts, median days to first advance record | **Relocate** to a collapsed "Booking speed (records)" section, relabelled "Appointment record created within N days" / "…and created before its scheduled date" | Useful for speed-to-book and staffing questions, but not an outcome. Never call it "booked" |
| Context cards: at/after scheduled time, prior past visit, already scheduled at entry, later cancelled, later deleted, none recorded | **Relocate** to a collapsed "Data diagnostics" section | Engineering and data-quality diagnostics, not business outcomes |
| Attendance outcome + attendance status review card | **Keep, move under diagnostics/admin** | It publishes nothing until a mapping is approved. It is a definition tool, not a patient stage |
| Reports index card copy "Did registrations turn into booked appointments?" / "Did they reach an appointment?" | **Reword** (class 2) | It currently points people at the record-created measure for the question Monthly outcomes answers |

Do not replace the waterfall with another invented sequence. The honest
structure is:

- **Monthly outcomes**: where people stand now;
- **Form progression**: two intake measures;
- **Booking speed and diagnostics**: collapsed, technical.

---

## 6. Clinic decisions still needed

The sources are Jeff's explanations on the 21 September call (`T:` lines).

| # | Question | What Jeff already said | What is undecided | Affects | Blocks a scoped provisional result? |
| --- | --- | --- | --- | --- | --- |
| **C1** | Does a completed **Consultation Only** count as converted? | "Consultation" and "consultation with vasectomy" are different appointment types (T:106, T:112) | Whether consult-only is "converted" | Completed (July: up to 16 patients not currently Completed would move into it) | No. Shown separately today |
| **C2** | What does **No Show** mean, and is it recorded reliably? | Named, not defined (T:66) | Its meaning | Unknown vs Neither (July: part of the 10 "status unresolved") | No. Left as Unknown |
| **C3** | Does **Signed No Review** / **Procedure Not Performed** count? | SNR = appointment completed, no review request, sometimes consult-only (T:66–71); PNP = consult happened, procedure did not (T:73) | Whether they meet the *business* definition | Completed (July: SNR-only 0, PNP `<5`) | No |
| **C4** | The six undecided types (Repeat DrSnip, Repeat Outside Provider, Prior Reversal Vasectomy, Partial Vasectomy with Consultation, Home Visit, Special Accomodations) | Not discussed | In or out | Unknown (July `<5`) | No |
| **C5** | Are past-dated Scheduled/Confirmed appointments always updated? | Staff schedule manually (T:118–121) | Update discipline | Unknown (July `<5`) | No |
| **C6** | Should returning patients and already-registered inquirers stay in their month's cohort? | Insurance inquirers are asked to register (T:191–197) | Cohort membership | Patients counted | No |

Keep the four concepts apart:

- **Physical arrival:** only `Checked In` and `Ready in 1–4` were described as
  in-clinic (T:75–84). No arrival mapping is approved. Monthly outcomes does not
  use arrival.
- **Appointment completion:** `Complete` and `Signed No Review` (T:55, T:66).
  This is what "Completed" means here.
- **Procedure completion:** not established by any status. `Complete` "does not
  prove a vasectomy occurred" (T:55), and `Procedure Not Performed` explicitly
  says it did not happen.
- **Jeff's business conversion:** "a completed appointment or they're
  scheduled" (T:130–132), for the right appointment types (C1, C3, C4).

A reliable No Show flag alone would **not** supply a valid attendance-rate
denominator. That would also need an agreed population, an observation window,
a coverage rule, a rule for unknown or conflicting evidence, and a
multi-appointment rule.

---

## 7. Documentation drift found

- `DRSNIP_MONTHLY_OUTCOMES_CALCULATION.md` §3.2, §5 and §8 still describe No
  Show as "ended by engineering inference". It was corrected before release
  (`bdab3bf`), and that document was not updated.
- `DRSNIP_MONTHLY_OUTCOMES_RELEASE.md` §7 says the two "complete to" times are
  "both correct". §3 above shows the table's is not a valid practice-wide claim.
- The Unknown reason label "once reached **Complete**" should read "reached a
  completion status".

---

## 1. Can we trust the current Monthly outcomes figures?

**Yes for the counts, within the stated provisional scope; not yet for the
"Data complete to" claim.**

For the counts:

- For July, three independent routes produce the same five numbers at one
  instant: a separately written query, the live API and the rendered page.
- The same numbers hold at the stricter watermark cutoff.
- The production calculation is byte-identical to the committed, tested code.
- Every edge rule in the brief is implemented as disclosed.

For the timestamp:

- The table's cutoff overstates practice-wide completeness by a median of 36
  minutes about a third of the time.
- It would mask a stalled hourly sync entirely.

**Assumption, stated:** a count stays trustworthy as long as no included
booking falls in the gap. That was true for July at the audit instant, and is
not guaranteed at every instant.

## 2. Confirmed defects requiring fixes before the Loom

1. **Evidence cutoff** (class 1). `greatest(max per-patient catch-up,
   watermark)` in `drsnip_outcome_metric`, `drsnip_booking_metric` and
   `drsnip_attendance_evidence` should be the practice-wide incremental
   watermark only, "unavailable" when absent. The table and the badge should
   then show the same time. **This is the only defect found in the
   calculations.**

## 3. Presentation changes that will make the pages understandable

- **Monthly outcomes:**
  - one "Appointment data complete to" time;
  - move the four-card glossary into short column tooltips or one collapsed
    "What the columns mean";
  - keep the provisional banner to one line;
  - keep "What is included?" collapsed;
  - fix the "reached Complete" wording.
- **Patient journeys:**
  - remove the record-created → advance-booking waterfall;
  - lead with the two form-progression measures;
  - move booking speed and data diagnostics into collapsed, plainly labelled
    sections;
  - move attendance review there too.
- **Reports index:**
  - Monthly outcomes answers "did they convert";
  - reword the journey cards ("form progression and booking speed"), and drop
    "booked appointments".
- **Docs:** correct the two drifted statements (§7).

## 4. Remaining clinic decisions, prioritised by impact

1. **C1**, Consultation Only: largest (about 16 patients in July).
2. **C2**, No Show meaning.
3. **C3**, SNR / PNP business qualification.
4. **C5**, past-dated booking updates.
5. **C4**, the six undecided types.
6. **C6**, cohort membership.

None blocks showing the clearly labelled provisional result.

## 5. Exact scope for the next implementation prompt

1. **Migration `0022`**, by hand, additive, replacing function bodies only:
   - a shared `drsnip_evidence_cutoff()` returning the `practice_incremental`
     watermark, or NULL when absent;
   - `drsnip_outcome_metric`, `drsnip_booking_metric` and
     `drsnip_attendance_evidence` use it;
   - status `unavailable` when it is NULL;
   - no definition, scope or rule changes; nothing approved.
2. **Tests:**
   - a patient catch-up after the watermark does **not** move the cutoff;
   - a stalled incremental sync makes the stale warning fire even while
     catch-ups continue;
   - a booking between the watermark and a later catch-up is judged against
     the watermark;
   - July-style hand counts unchanged;
   - existing booking and attendance tests updated only where the cutoff rule
     changes them.
3. **Monthly outcomes UI:** the single timestamp, a compact glossary, one-line
   banner, and the reason-label wording.
4. **Patient journeys:**
   - remove the waterfall;
   - form progression first;
   - collapsed "Booking speed (records)" and "Data diagnostics" with honest
     labels;
   - attendance review under diagnostics.
5. **Reports index copy**, as above.
6. **Doc corrections** (§7).
7. **Release** through PR #55 and the rehearsed migration-then-deploy sequence,
   followed by a July re-reconciliation at the new cutoff.

**Out of scope:** historical month-end trends, rates, a combined conversion
figure, new metrics, and any approval.
