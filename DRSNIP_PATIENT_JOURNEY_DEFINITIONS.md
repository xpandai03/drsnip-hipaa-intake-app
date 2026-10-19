# Dr. Snip — patient journey definitions

**Date:** 2026-09-19 · Read-only investigation and metric definition.
**Nothing was implemented, migrated, synced or deployed.** No production
workflow, credential, patient record or appointment was changed.

**Evidence labels:** **[LIVE-API]** observed in a real DrChrono response ·
**[LIVE-DB]** read-only aggregate over our Postgres · **[REPO]** repository ·
**[DOCS]** official DrChrono documentation · **[PROPOSED]** my recommended
default · **[STAFF]** needs Jeff or clinic staff to decide.

Prior reports: `DRCHRONO_APPOINTMENT_ACCESS_CONFIRMATION.md`,
`DRCHRONO_N8N_TRACE_AND_CONSULTATION_PROGRESSION.md`,
`DOCTORSNIP_CONSOLE_REDESIGN_PLAN.md`.

---

## 1. Recommended journey model, in plain English

**There is no single sequential funnel, and forcing one would misrepresent the
clinic.** A 100-appointment sample settled three things that change the design:

1. **Current `status` is mostly blank — 64 of 100.** But `status_transitions` is
   populated on **100 of 100**, carrying **322 transitions**. So the appointment
   *history* is rich and the appointment *current state* is not. **Every
   attendance measure must be derived from transition history, not from
   `status`.** **[LIVE-API]**

2. **The clinic runs a custom status workflow**, not DrChrono's stock list:
   `Scheduled → Confirmed → Arrived → Checked In → Ready in 1/2/3 → In Room →
   MD In → MD Out → Complete → Signed No Review`, plus `Late Cancel within
   48 hrs`, `Cancelled`, `No Show`, `Rescheduled`. Four of those
   (`Ready in 1/2/3`, `MD In`, `MD Out`, `Signed No Review`, `Late Cancel within
   48 hrs`) appear nowhere in DrChrono's documented vocabulary. **[LIVE-API]**
   **[DOCS]**

3. **Appointments are overwhelmingly with providers our intake never writes
   to.** In the sample, `403924` had 50 and `518094` had 36, while `324569` —
   the doctor our integration hard-codes on every patient it creates — had **8**.
   A booking metric filtered to `324569` would see roughly 8% of the practice.
   **[LIVE-API]** **[REPO]**

So the recommended model is:

> **One sequential cohort funnel that stops at "attended", plus parallel cards
> for everything that is not a stage.**
>
> - **Registration journey (sequential):** registration submitted → appointment
>   booked → attended.
> - **Consultation is NOT in that funnel.** It is a **pre-appointment readiness**
>   measure shown beside it. 665 of 666 patients submitted it *after*
>   registering, but 148 consultation patients have no registration with us at
>   all, so its absence proves nothing about booking. **[LIVE-DB]**
> - **Insurance journey (branching, not sequential):** inquiry submitted →
>   *either or both of* registered / booked → attended. Registration and booking
>   are **parallel outcomes**, because an inquirer can be booked by staff without
>   ever filling the registration form.
> - **Chart created, estimate sent, insurance verified and patient responded are
>   not stages.** The first is processing; the other three have no data source.

---

## 2. Verified data sources and limitations

### 2.1 Local intake (Postgres)

| Form | Rows | Distinct identified patients | Row linkage | Window (Pacific) |
|---|---|---|---|---|
| registration | 1,891 | **1,830** | 98.2% | 2026-06-15 → 2026-09-18 |
| consultation | 1,009 | **814** | 81.4% | 2026-06-15 → 2026-09-18 |
| insurance | 97 | **69** | 77.3% | 2026-08-12 → 2026-09-18 |

**[LIVE-DB]**

- **Identity key: `submissions.n8n_patient_id`** — the DrChrono patient id,
  written back by the n8n bridge. 2,018 distinct ids held. It is NULL on
  `manual_review` (188), `failed` (35), `not_applicable` (20) and pending rows.
  **[LIVE-DB]** **[REPO]**
- **Row coverage ≠ person coverage.** The 34 unlinked registration rows and 22
  unlinked insurance rows represent an unknown number of people (1..34 and
  1..22). Person-level insurance coverage is bounded **75.8%–98.6%** and cannot
  be pinned down. **[LIVE-DB]**
- **Repeat submissions exist:** 27 patients registered twice, 7 consulted twice,
  one inquirer submitted the insurance form **6** times. **[LIVE-DB]**
- **`updated_at` is never bumped** — 0 of 2,996 rows. Freshness must key on
  `n8n_response_at`. **[LIVE-DB]** **[REPO]**
- **Test-record markers are heuristic only.** An email/name pattern scan found 8
  consultation, 7 insurance and 4 registration rows that look like tests. At 7 of
  97 rows, this matters most for insurance (~7%). **No agreed marker exists.**
  **[LIVE-DB]** **[STAFF]**
- **Location** lives in `raw_payload.officeLocation` (canonical `Seattle, WA` /
  `Portland, OR` / `Plano, TX`) and is **never sent to DrChrono**. Consultation
  does not ask for it. **[REPO]**
- **Source/attribution is effectively empty** — zero click IDs and zero UTMs
  across 2,131 submissions, because an embedded iframe cannot read its parent's
  URL. Treat `source` as a website entry-point tag, never an acquisition channel.
  **[REPO]**
- **Timezone:** `America/Los_Angeles` throughout the console and its exports.
  **[REPO]**
- **Privacy:** `<5` small-cell suppression on every grouped cell; a PHI-free
  reporting view plus a read-only role already exist. **[REPO]**

### 2.2 DrChrono appointments — now readable

Confirmed working, and patient linkage confirmed on 3 of 3 sampled patients
(3, 3 and 2 appointments each). **[LIVE-API]**

**Fields available and populated** (100/100 unless noted): `id`, `patient`,
`doctor`, `office`, `exam_room`, `created_at`, `scheduled_time`, `updated_at`,
`status`, `profile`, `duration`, `reason`, `status_transitions`,
`deleted_flag`, `custom_status`, `is_walk_in`, `ins1_status`/`ins2_status`,
`recurring_appointment`, `clinical_note`, `vitals`.

**The appointment type field is `profile`**, not `appointment_profile`.
**[LIVE-API]**

**Limitations that constrain the definitions:**

| Limitation | Evidence |
|---|---|
| **`/api/appointment_profiles` returns 403** even with calendar read. Profile IDs cannot be resolved to names. | **[LIVE-API]** |
| **Current `status` is blank on 64%** of sampled appointments | **[LIVE-API]** |
| **`created_at` is not always a forward booking action** — only 72 of 100 were created before their own `scheduled_time`. The other 28 were recorded at or after the visit. | **[LIVE-API]** |
| The sample is **100 appointments in one `date_range`**, `has_next: true`. It is a bounded sample, not a census. | **[LIVE-API]** |
| No Plano appointments appeared in the sample (Seattle 62, Portland 38) | **[LIVE-API]** |
| `/api/appointments` GET **requires** one of `since` / `date` / `date_range`; `date_range` capped at 190 days | **[DOCS]** |
| Rate limits: 500/hour, 429 over; throttle at 10/sec and 290 per rolling 10 min | **[DOCS]** |

**Reference data** **[LIVE-API]**:

- **9 providers**: `324569` Kelly White, `324679` Philipp Klotz, `363965` DrSnip
  Seattle *(Reproductive Medicine)*, `364050` DrSnip Portland *(General
  Practice)*, `403924` Enrique Leon, `403925` Steven Dresang, `499036` Samuel
  Crane, `518094` Sean Trafficante, `520714` Robert Brown.
  Two of these — "DrSnip Seattle" and "DrSnip Portland" — look like **resource or
  location calendars rather than people**. **[STAFF]**
- **3 offices**: `345226` Seattle, `377544` Portland, `558299` Plano. All three
  have **`online_scheduling: false`**, so patients do not self-book — **every
  booking is a staff action.** That materially supports treating `created_at` as
  a staff booking event.

---

## 3. Journey definitions

### 3.1 Registration journey (sequential)

> **Registration submitted → appointment booked → attended**
> with **consultation submitted** shown alongside, not inside.

| Decision | Definition | Basis |
|---|---|---|
| **Entry event** | The patient's **first** `form_type='registration'` submission carrying an `n8n_patient_id` | **[PROPOSED]** |
| **Eligible population** | Distinct `n8n_patient_id`. Unlinked rows are reported as a separate "could not be linked" count and are **excluded from both numerator and denominator** | **[PROPOSED]** |
| **Repeat registrations** | Do **not** open a new episode. One patient = one entry, anchored on the first. 27 patients would otherwise be double-counted | **[LIVE-DB]** **[PROPOSED]** |
| **Which appointment counts** | The **earliest appointment whose `created_at` is strictly after the entry timestamp**. Ties broken by lowest `id` | **[PROPOSED]** |
| **Appointments created before registration** | **Excluded from conversion**, reported in a separate **"already had an appointment"** card. Never silently dropped | **[PROPOSED]** |
| **Consultation before registration, or with no local registration** | Excluded from the registration cohort. 148 consultation patients have no registration; 1 consulted before registering | **[LIVE-DB]** |
| **Consultation as a stage?** | **No.** Separate readiness measure — §6 | **[PROPOSED]** |

### 3.2 Insurance-inquiry journey (branching)

> **Inquiry submitted →** *(parallel)* **registered** and/or **booked** **→ attended**

| Decision | Definition | Basis |
|---|---|---|
| **Entry event** | The patient's **first** `form_type='insurance'` submission with an `n8n_patient_id` — currently **69 people** from 97 rows | **[LIVE-DB]** |
| **Repeat inquiries** | Collapse to the person. One inquirer submitted 6 times; they are one denominator entry, not six | **[LIVE-DB]** **[PROPOSED]** |
| **Already registered before inquiry** | **2 of 69.** Excluded from the *registration* denominator (they cannot "become" registered); still eligible for booking and attendance | **[LIVE-DB]** **[PROPOSED]** |
| **Already booked before inquiry** | Excluded from the *booking* denominator, shown in the "already had an appointment" card | **[PROPOSED]** |
| **Eligibility differs per metric** | Registration denominator **67**; booking and attendance denominators are their own eligible sets. **Do not reuse one denominator across all three** | **[PROPOSED]** |
| **One appointment, two inquiries** | Attribution is to the inquirer's **first** inquiry only. Since each patient appears once, an appointment can attach to at most one entry | **[PROPOSED]** |
| **Overlap with the registration journey** | The two cohorts **intersect by design** — an inquirer who registers appears in both. **Their totals must never be summed as unique patients.** Publish the intersection count beside them | **[PROPOSED]** |

**Explicitly not connected:** estimate sent, insurance verified, patient
responded. No data source exists. `ins1_status` is a **billing/claim** status
(`Payer Acknowledged`, `Rejected Payer`, `ERA Received`) — it is *not*
pre-visit eligibility verification and must not be relabelled as one.
**[LIVE-API]**

---

## 4. Stage-definition matrix

| Stage | Business meaning | Evidence / source | Timestamp | Identity key | Eligibility | Exclusions | Confidence | Staff confirmation |
|---|---|---|---|---|---|---|---|---|
| **Registration submitted** | A completed registration arrived | `submissions`, `form_type='registration'` | `created_at` (Pacific) | `n8n_patient_id` | all identified | test rows; unlinked | **High** **[LIVE-DB]** | test marker |
| **Insurance inquiry submitted** | Someone asked about cost/coverage | `submissions`, `form_type='insurance'` | `created_at` | `n8n_patient_id` | all identified | test rows; unlinked | **High** **[LIVE-DB]** | test marker |
| **Chart created / matched** | The EHR write-back succeeded | `submissions.n8n_status` + `drchrono_action` | `n8n_response_at` | row | — | — | **High — but PROCESSING, not a journey stage** | no |
| **Appointment record created** | An appointment row exists | `/api/appointments.created_at` | `created_at` | `patient` | after entry | `deleted_flag=true` | **High** **[LIVE-API]** | — |
| **Booked** (the metric) | Staff scheduled a visit | same, **plus** `created_at < scheduled_time` | `created_at` | `patient` | after entry | back-dated rows (28% of sample) → separate bucket | **Medium** — see §7 | which profiles count |
| **Currently scheduled** | A future visit stands right now | `scheduled_time > now` **and** last transition not in a terminal set | `scheduled_time` | `patient` | — | cancelled/no-show/rescheduled | **Medium** | terminal set |
| **Consultation form submitted** | Pre-visit form completed | `submissions`, `form_type='consultation'` | `created_at` | `n8n_patient_id` | after registration | before registration (1) | **High** **[LIVE-DB]** | does it always follow booking? |
| **Attended** | The patient physically arrived | **`status_transitions[].to_status`** ∈ arrival set | that transition's `datetime` | `patient` | booked | — | **Medium — provisional** | **which statuses = arrived** |
| **Cancelled** | Visit called off | transition `to_status` ∈ {`Cancelled`, `Late Cancel within 48 hrs`} | transition `datetime` | `patient` | booked | — | **Medium** | is "Late Cancel" distinct? |
| **No-show** | Did not attend, not cancelled | transition `to_status` = `No Show` | transition `datetime` | `patient` | booked | — | **Medium** | — |
| **Rescheduled** | Moved to another slot | transition `to_status` = `Rescheduled` | transition `datetime` | `patient` | booked | — | **Low** — does a new row appear? | linkage between old and new |
| **Procedure completed** | The vasectomy happened | **NO RELIABLE SOURCE** | — | — | — | — | **None** | **`Complete` must NOT be read as this** |

**`Complete` is an appointment-closure status, not a clinical outcome.** In the
sample it is followed by `Signed No Review`, which suggests a note-signing step —
that is documentation, not proof a procedure occurred. **[LIVE-API]** **[STAFF]**

---

## 5. Metric definitions

### 5.1 Rules that apply to every metric

1. **Cohort = people, not submissions.** Always `count(distinct n8n_patient_id)`.
2. **Entry-anchored.** The window belongs to the **entry event**, never the
   outcome. Never divide this month's bookings by this month's registrations.
3. **Observed-to-date vs matured** are different numbers and both get labels. A
   fixed-window metric uses only patients who have had the full window.
4. **Coverage is published** beside every figure (98.2% / 81.4% / 77.3% row
   linkage), plus the unlinked count.
5. **Four distinct empty states:** measured zero · not instrumented · not
   available for this period · suppressed (`<5`). Never collapse them.
6. **Pacific day boundaries** for bucketing and windows; raw UTC timestamps
   preserved underneath.
7. **Pre-existing bookings are their own category**, never numerator or
   denominator.

### 5.2 The metrics

Notation: `E` = entry timestamp; `W` = follow-up window in days; `A` = the
selected appointment.

| # | Metric | Numerator | Denominator | Entry window | Follow-up | Exclusions |
|---|---|---|---|---|---|---|
| M1 | **Registration → subsequent booking** | patients with ≥1 appointment where `created_at > E` (and `created_at < scheduled_time`) within `W` | distinct identified patients whose first registration ∈ entry window **and** who had **no** appointment before `E` | rolling; report by entry month | **30 d** primary; 7/14 secondary | unlinked; test rows; pre-existing bookings (separate card) |
| M2 | **Registration → consultation submitted** | patients with a consultation `created_at > E` within `W` | same, minus the pre-existing-booking exclusion | rolling | **30 d** primary | unlinked; test rows; consultation before registration |
| M3 | **Registration → attendance** | patients whose selected appointment has a transition `to_status` ∈ arrival set | **M1 numerator** (must be booked to attend) | rolling | **30 d from `E`**, or **14 d past `scheduled_time`**, whichever is later | not-yet-occurred appointments → `not_yet` |
| M4 | **Inquiry → subsequent registration** | inquirers with a registration `created_at > E` within `W` | identified inquirers **not already registered** at `E` — currently **67** | rolling | **14 d** primary (see maturity) | the 2 pre-registered; unlinked; test rows |
| M5 | **Inquiry → subsequent booking** | inquirers with an appointment `created_at > E` within `W` | identified inquirers **not already booked** at `E` | rolling | **14 d** primary | pre-existing bookings (separate card) |
| M6 | **Inquiry → attendance** | inquirers whose post-inquiry appointment has an arrival transition | **M5 numerator** | rolling | 14 d + 14 d past `scheduled_time` | as M3 |
| M7 | **Time from entry to booking** | — | patients **with** a qualifying booking only | rolling | — | median + p25/p90. Never average over patients who never booked |
| M8 | **Time registration → consultation** | — | patients with a consultation only | rolling | — | **already measured: p25 5.8 d, median 11.3 d, p90 35.3 d** over 665 **[LIVE-DB]** |

### 5.3 Window choice, grounded in the data we have

- **Registration cohort** spans 2026-06-15 → 2026-09-18 (~95 days). A **30-day**
  window is supportable and captures ~90% of consultation progression (p90 =
  35.3 d). Already computed: 30-day matured registration→consultation =
  **461/1,192 = 38.7%**, versus observed-to-date 665/1,830 = 36.3%. The matured
  figure is *higher* because it excludes 638 patients who have not had 30 days —
  that is the maturity effect, and it is why one blended number misleads.
  **[LIVE-DB]**
- **Fully matured monthly cohorts land near 50%**: June 50.2% (245 patients),
  July 49.7% (571). August 34.1% and September 11.7% are *younger*, not worse.
  **[LIVE-DB]**
- **Insurance cohort** began 2026-08-12. Maturity: **54 of 69** have 7 days,
  **34** have 14 days, **1** has 30 days. **A 30-day insurance window is not yet
  reportable and 90 days is impossible.** Use **14 days**, labelled
  *observed to date*, and revisit monthly. **[LIVE-DB]**
- **Current insurance → registration**: **25 of 67 eligible = 37.3%** (or 36.2%
  against all 69 identified; 39.1% "ever registered" is wrong — it counts the 2
  who were patients first). **[LIVE-DB]**

### 5.4 Missing-ID and coverage handling

- A submission with no `n8n_patient_id` **cannot** enter a cohort. It is counted
  in a visible **"not linked"** figure with its reason breakdown
  (`manual_review` 188, `failed` 35, `not_applicable` 20).
- Coverage is **directional**: a duplicate chart for one human causes
  **under**-counting of returns, never over-counting. State the direction.
- Never substitute email-only or demographic matching to raise coverage.

---

## 6. Appointment / provider / status mapping (provisional)

### 6.1 Providers

| ID | Name | Specialty | Sample share | Proposed | Rationale |
|---|---|---|---|---|---|
| `403924` | Enrique Leon | Family Practitioner | **50/100** | **Include** | Dominant appointment provider |
| `518094` | Sean Trafficante | Other | **36/100** | **Include** | Second-highest |
| `324569` | Kelly White | Other | 8/100 | **Include** | The id intake writes to |
| `403925` | Steven Dresang | Family Practitioner | 4/100 | **Include** | Seen in sample |
| `324679` | Philipp Klotz | Other | 2/100 | **Unresolved** | Low volume |
| `363965` | **DrSnip Seattle** | Reproductive Medicine | 0 | **Unresolved** | Name suggests a **resource/location calendar, not a person** |
| `364050` | **DrSnip Portland** | General Practice | 0 | **Unresolved** | Same |
| `499036` | Samuel Crane | Other | 0 | **Unresolved** | Not in sample |
| `520714` | Robert Brown | General Surgeon | 0 | **Unresolved** | Not in sample |

**[LIVE-API]** · **[STAFF]** must confirm which providers see vasectomy patients
and whether the two "DrSnip <city>" entries are real clinicians.

> **Do not default to `doctor=324569`.** It is the id our integration writes on
> patient *creation*, and it accounts for ~8% of appointments. Filtering to it
> would silently discard most of the practice. **[PROPOSED]**

### 6.2 Appointment types (`profile`)

| Profile ID | Sample count | Name | Include? |
|---|---|---|---|
| `585137` | 32 | **unknown** | Unresolved |
| `875741` | 24 | **unknown** | Unresolved |
| `874156` | 4 | **unknown** | Unresolved |
| `585138` | 2 | **unknown** | Unresolved |
| `503309` | 2 | **unknown** | Unresolved |
| *(null)* | 36 | no profile set | Unresolved |

**Blocked:** `/api/appointment_profiles` returns **403** even with calendar read
— profile IDs cannot be resolved to names. Either a further scope
(likely `settings:read`) is needed, or staff can read the names off the DrChrono
calendar settings screen. **Until then no appointment-type filter should be
applied**, and the first real metric must say it counts *all* appointment types.
**[LIVE-API]** **[STAFF]**

### 6.3 Statuses — the clinic's actual vocabulary

Observed `to_status` values across 322 transitions on 100 appointments:

| Status | Transitions | Proposed class | Rationale |
|---|---|---|---|
| `Scheduled` | 40 | **Booked** | Entry state |
| `Confirmed` | 24 | Booked (confirmed) | Pre-visit |
| `Arrived` | 12 | **ARRIVAL** | Patient physically present |
| `Checked In` | 28 | **ARRIVAL** | Front-desk check-in |
| `Ready in 1` / `2` / `3` | 10 / 8 / 4 | **ARRIVAL** | Custom; implies on-site |
| `In Room` | 26 | **ARRIVAL** | In an exam room |
| `MD In` | 28 | **ARRIVAL** | Custom; clinician entered |
| `MD Out` | 24 | **ARRIVAL** | Custom; clinician finished |
| `Complete` | 36 | Visit closed — **not** a procedure | Documentation state |
| `Signed No Review` | 2 | Note signed | Custom; documentation |
| `Cancelled` | 4 | **Cancelled** | — |
| `Late Cancel within 48 hrs` | 4 | **Cancelled (late)** | Custom; may matter commercially |
| `No Show` | 4 | **No-show** | — |
| `Rescheduled` | 2 | **Rescheduled** | — |
| `""` (empty) | 66 | **Unknown** | Blank; 64% of current statuses |

**[LIVE-API]**

**Proposed ARRIVAL set** — the earliest transition into any of
`Arrived`, `Checked In`, `Ready in 1/2/3`, `In Room`, `MD In`, `MD Out`.
**[PROPOSED]** **[STAFF]**

**Rationale for using the arrival set rather than `Complete`:** `Complete` is a
closure/documentation state and current status is blank on 64% of rows, so
counting `Complete` alone would undercount attendance badly. A transition
*into a room* is a physical fact. But **only staff can confirm** that
`Ready in N` and `MD In/Out` mean what they appear to mean.

### 6.4 How cancellations and reschedules affect each metric

| Metric | Treatment |
|---|---|
| **"Ever booked" (M1/M5)** | A later cancellation does **not** remove the booking. The booking happened. Report cancellations as a separate rate, not by shrinking the numerator |
| **"Currently scheduled"** | A cancelled/no-show/rescheduled appointment **is excluded**. This is a point-in-time number and will legitimately differ from "ever booked" |
| **Attendance (M3/M6)** | Requires an arrival transition. A cancellation with no arrival is not attendance. A `No Show` is an explicit negative, distinct from "no data" |
| **Reschedule** | A **transition**, not a lost booking. Keep the original booking's `created_at` as the booking time. **Open question:** does a reschedule create a *new* appointment row? If so the pair must be linked or the patient is double-counted. **[STAFF]** / testable |
| **Time-to-booking (M7)** | Uses the **first** qualifying appointment's `created_at`, regardless of what later happened to it |
| **`deleted_flag`** | Excluded everywhere. All 100 sampled were `false` |

---

## 7. Duplicates, prior bookings, back-dating and maturity

- **Duplicate submissions** → collapse to the person on `n8n_patient_id`.
- **Duplicate charts for one human** → under-counts returns, never over-counts.
- **Prior bookings** → their own card: *"had an appointment before they
  registered/inquired"*. Currently 2 of 69 inquirers were already registered.
- **Back-dated appointments** — this is the subtle one. **28 of 100 appointments
  had `created_at` at or after their own `scheduled_time`**, meaning the record
  was made during or after the visit, not as a forward booking. **[LIVE-API]**
  **Proposed:** a booking counts only when `created_at < scheduled_time`;
  the rest go to a **"recorded at/after visit"** bucket, so time-to-booking is
  not polluted by negative intervals. **[PROPOSED]**
- **Maturity** — every cohort younger than its window is labelled *still
  maturing* and its figure is marked *observed to date*. Insurance currently has
  only **1 of 69** patients with 30 days behind them.

---

## 8. Dashboard recommendations

### 8.1 What can form a valid sequential waterfall

Only this, and only for the registration journey:

```
Registration submitted  ──▶  Booked  ──▶  Attended
      1,830 patients          (new)        (new)
```

All three are person-grain, nested (attended ⊆ booked ⊆ registered), share one
identity key and one entry-anchored cohort. That is a legitimate funnel.

### 8.2 What must NOT be inside it

Render these as **parallel cards beside the funnel**, in the existing design
language:

- **Consultation readiness** — "665 of 1,830 submitted the consultation form,
  median 11.3 days". Beside, not inside: it happens *after* booking, and 148
  consultation patients never registered with us.
- **Already had an appointment** — pre-existing bookings, excluded from
  conversion.
- **Chart write-back** — processing status, already on Sync & Activity.
- **Cancelled / No-show / Rescheduled** — outcome breakdown of the booked
  cohort, not funnel stages.
- **Not linked** — submissions with no patient id, with reasons.

### 8.3 The insurance journey is a branch, not a line

```
                        ┌──▶ Registered (25/67)
Inquiry submitted ──────┤
      69 people         └──▶ Booked (new)  ──▶ Attended (new)
```

Show it as a branch with both outcomes visible. **Never add the registration and
insurance cohorts into one "unique patients" total** — they intersect. Publish
the intersection.

### 8.4 Labels every figure needs

- **Coverage:** "98.2% of registrations carry a patient id."
- **Maturity:** "still maturing — 1 of 69 has 30 days" or "matured 30-day cohort".
- **Freshness:** "appointments last synced <time>" — and if a sync fails, mark
  the stage **stale**, never show a drop.
- **Scope line:** window · Pacific · unit · dedup posture · provider/type filter
  in force.
- **Bounded-sample warning** wherever a figure comes from the 100-appointment
  probe rather than a full sync.

### 8.5 What can launch before staff resolve everything

| Ready now | Needs staff first |
|---|---|
| Registration → consultation (M2, M8) — already computed | Attendance (arrival set) |
| Inquiry → registration (M4) at 14 days | Appointment-type filtering (profiles are 403) |
| Coverage, not-linked, maturity labels | Which providers count |
| "Ever booked" (M1/M5) **counting all providers and all types**, clearly labelled | Procedure completion — **do not build** |

---

## 9. Synthetic examples

All invented. Expected classification under the rules above.

| # | Scenario | Expected |
|---|---|---|
| 1 | **Normal.** Registers 1 Jul. Appointment created 4 Jul for 20 Jul. Consultation submitted 12 Jul. Transitions: Scheduled → Confirmed → Checked In → In Room → Complete. | M1 **booked** (3 d). M2 **consultation** (11 d). M3 **attended** (`Checked In`). Not in "prior booking". |
| 2 | **Repeat registration.** Registers 3 Jun and again 9 Aug. Booked 15 Jun. | One episode, anchored 3 Jun. Booking counted once, 12 d. The August form does not create a second entry. |
| 3 | **Pre-existing appointment.** Appointment created 2 May. Registers 1 Jul. | **Excluded from M1** numerator *and* denominator. Appears in **"already had an appointment"**. |
| 4 | **Back-dated record.** Registers 1 Jul. Appointment created 20 Jul for 20 Jul 09:00. | Not a booking (`created_at ≥ scheduled_time`). Goes to **"recorded at/after visit"**. Still eligible for attendance if an arrival transition exists. |
| 5 | **Cancellation.** Registers 1 Jul, booked 4 Jul for 20 Jul, → `Late Cancel within 48 hrs` on 19 Jul. | M1 **booked = yes** (it happened). M3 **not attended**. Counted in **cancelled (late)**. Not in "currently scheduled". |
| 6 | **No-show.** Booked, then → `No Show`. | Booked yes; attended **no** — a *measured* negative, distinct from unknown. |
| 7 | **Incomplete linkage.** Registration routed to `manual_review`, no `n8n_patient_id`. | **Not in any cohort.** Appears in "not linked — manual review". Never a denominator. |
| 8 | **Consultation without registration.** Consultation submitted, no local registration. | Excluded from the registration cohort. Counted in the readiness view's "consultation only" figure (148 today). |
| 9 | **Repeat inquirer.** Six insurance submissions, one person, registers after the first. | **One** denominator entry. M4 numerator = 1. Not six. |
| 10 | **Blank status.** Booked; transitions end at `MD Out`; current `status` is `""`. | **Attended = yes** via the arrival set. Shows exactly why current status cannot be the test. |

---

## 10. Staff-confirmation checklist

Short, and everything else can proceed without it.

1. **Which appointment types are the target outcome?** Profile IDs `585137`,
   `875741`, `874156`, `585138`, `503309` — what are they called, and which is
   the consultation vs the vasectomy? *(We cannot read the names: 403.)*
2. **Which statuses mean the patient physically arrived?** Confirm
   `Arrived`, `Checked In`, `Ready in 1/2/3`, `In Room`, `MD In`, `MD Out`.
3. **What does `Complete` mean here — and what, if anything, proves a procedure
   happened?**
4. **Which of the 9 providers see vasectomy patients?** And are `DrSnip Seattle`
   / `DrSnip Portland` real clinicians or resource calendars?
5. **Does a reschedule create a new appointment record?** (Determines
   double-count risk.)
6. **Is `Late Cancel within 48 hrs` commercially different from `Cancelled`?**
7. **Does the consultation form always follow booking?** 665/666 orderings say
   yes; one sentence makes it a stated fact.
8. **What marks a test submission?** ~7% of insurance rows look like tests.

---

## 11. Handoff for the next data-sync task

**Not implemented here.** Ready to build when authorised.

**Table** — `appointment_events`, one row per appointment:
`drchrono_appointment_id` (PK), `n8n_patient_id`, `created_at`,
`scheduled_time`, `updated_at`, `status`, `profile_id`, `doctor_id`,
`office_id`, `deleted_flag`, `first_arrival_at`, `terminal_status`,
`terminal_status_at`, `synced_at`.
**No name, no `reason` free text, no `clinical_note`, no `vitals`, no
`ins*_status`.** Keeps a PHI-free projection possible, as
`drsnip_reporting_view` already does.

**Sync** — read-only, `GET /api/appointments?since=<last_success>&verbose=true`,
paged, ~2 s spacing, honouring 429/`Retry-After`; nightly trailing re-read of a
30-day window to catch cancellations, reschedules and back-dated edits. Never
publish a partial sweep as a drop: on failure keep prior values and mark stale.

**Derivations at write time:** `first_arrival_at` = earliest
`status_transitions[].datetime` whose `to_status` ∈ arrival set;
`terminal_status` = last transition's `to_status`.

**Open before first publication:** profile names (403), provider allow-list,
arrival set confirmation, reschedule linkage.

**Rate budget:** ~2,018 patients and an incremental `since` sweep sit far inside
500/hour; a first backfill must be paced under 290 requests per 10 minutes.

---

## 12. Execution record

- **DrChrono API calls:** 5 GETs (profiles, doctors, offices, appointments ×2),
  bounded, one request. Profiles returned 403; the rest 200.
- **Sample size:** 100 appointments in one `date_range`, `has_next: true` — a
  **bounded sample, not a census**, and labelled as such throughout.
- **Records:** none created, modified or deleted. No message sent. No clinical
  note, vitals or document read.
- **n8n:** one isolated temporary workflow created, active ~2 minutes,
  deactivated (endpoint verified **404**) and **deleted**; its temporary
  credential **deleted**. `1tiPE7fxBnuBeWDD` remains **inactive** with no
  identifiers. No production workflow or credential touched.
- **Execution payloads:** **none created** — results returned over HTTP with
  `saveDataSuccessExecution: none` and `saveManualExecutions: false`.
- **Database:** no query this session; local figures are from prior read-only
  aggregates.
- **Application:** unchanged — console still serves v81. Nothing committed,
  pushed or deployed.
- **PHI:** none in this report. Provider and office names are business
  configuration, not patient data. No patient identifier, free-text reason,
  clinical content or individual timeline appears anywhere.
