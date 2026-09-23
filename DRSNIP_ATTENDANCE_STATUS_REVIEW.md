# Attendance statuses — what the data already shows, and what Jeff has to decide

**Date:** 21 September 2026 · Read-only investigation. No code, mapping, workflow,
permission or production data was changed, and nothing was deployed.

**Source:** stored appointment history only — 2,574 appointments and their status
transitions, current to the hourly sync cursor. No new DrChrono calls.

No patient identifiers, appointment identifiers, notes or raw payloads appear
here. Counts are **appointments**, not patients, and they overlap — one
appointment passes through several statuses on its way through a visit, so these
columns must never be added together.

**Suppression rule used throughout:** any cell under 5 is shown as *withheld*,
and where a published total would let a withheld cell be recovered by
subtraction, the complement is withheld too. That is why some rows below give a
total and a description instead of a breakdown.

---

## The short version

**Current status cannot establish attendance. The transition history can.**

That is the single most useful finding, and it was not obvious. Nine of the
clinic's statuses — `Arrived`, `Checked In Online`, `In Room`, `In Session`,
`MD In`, `MD Out`, `Ready in 1`, `Ready in 3`, `Ready in 4` — appear **only in
the transition history, never as a final status**. They are states an
appointment passes *through* while the patient is in the building. By the time
the appointment settles, the status has moved on to `Complete`, blank,
`Rescheduled` and so on.

So anything that reads only the current status is blind to arrival. Everything
below reads the history.

Three things follow, and they are what the conversation with Jeff is actually about:

1. **A large group already answers itself.** 969 appointments have a transition
   to a status the patient could not reach without being physically present.
   That does not need a judgement call — it needs Jeff to confirm the list is
   what he thinks it is.

2. **`Complete` is very nearly, but not quite, an arrival signal.** Of 945
   appointments whose final status is `Complete`, 924 also have in-person
   evidence in their history, 11 have only a `Ready in N`, and **10 have no
   in-person evidence at all**. So `Complete` is a good indicator and a bad
   definition. It should not be used as proof on its own, and it certainly is
   not proof that a procedure happened.

3. **Blank is the real unknown, and it is big and steady.** 627 appointments end
   with a blank status. **Not one of them has any in-person evidence in its
   history** — so blank is not hiding attendance, but it is not evidence of
   absence either. They are spread evenly: all three offices (21–31% of each
   office's past appointments), six of seven providers, and a steady ~30% of
   past appointments every month since June. This is not an office quirk or a
   one-off workflow change. It looks like roughly a third of visits simply never
   get front-desk status updates — and only Jeff can say why.

---

## Findings table

Read the two count columns as *separate sources*. An appointment can appear in
both, and in several rows.

| Status | Plain-English proposed meaning | Appears in | Appointments (current status) | Appointments (in history) | Could it establish arrival? | Question for Jeff |
| --- | --- | --- | --- | --- | --- | --- |
| `Arrived` | The patient is in the building | transitions only | — | 75 | **Yes — directly** | "Does your front desk set this only when the patient is physically here?" |
| `Checked In` | Front desk checked the patient in | both | withheld | 931 | **Yes — directly** | "Same question. Is there any way this gets set remotely or in advance?" |
| `Checked In Online` | Patient checked in from their phone | transitions only | — | 31 | **Probably not on its own** | "Can a patient do this from home, or only once they are here?" |
| `In Room` | Patient is in an exam room | transitions only | — | 851 | **Yes — directly** | "Confirm this always means a room in the clinic." |
| `In Session` | Patient is with the provider | transitions only | — | withheld | **Yes — directly** | "Confirm." |
| `MD In` | Provider entered the room | transitions only | — | 873 | **Yes — directly** | "Confirm." |
| `MD Out` | Provider left the room | transitions only | — | 717 | **Yes — directly** | "Confirm." |
| `Ready in 1` – `Ready in 4` | Patient is roomed and waiting, in room *N* | transitions only | — | 349 / 325 / 236 / withheld | **Probably — needs confirming** | "Is 'Ready in 2' a room number, meaning the patient is already roomed? Or does it mean something else?" |
| `Complete` | The visit or its paperwork is finished | both | 945 | 950 | **Not on its own** | "Does 'Complete' mean the patient was seen, or that the chart was closed out? 10 of these have no other sign the patient was ever here." |
| `Signed No Review` | Charting state after a visit | both | 26 | 28 | **Not on its own** | "Is this something only set after a patient has been seen?" (In-person evidence is present on all but a handful; the exact split is withheld.) |
| `Procedure Not Performed` | Patient came in, procedure did not happen | both | 9 | 10 | **Suggests arrival** | "Does this mean the patient came in and the procedure was called off? All 9 have in-person evidence, so it looks like an arrival with no procedure." |
| `Scheduled` | Booked | both | 303 | 1,911 | **No** | "Booking state only — nothing about arrival?" |
| `Confirmed` | Appointment confirmed | both | 101 | 1,099 | **No** | "Does this mean *the patient* confirmed they will come, or something stronger?" |
| `Rescheduled` | Moved to another slot | both | 299 | 322 | **No** | "When you reschedule, does the original keep any record that the patient showed up? A small number of these do carry in-person evidence." |
| `Cancelled` | Cancelled | both | 168 | 184 | **No** | "Same question — a small number have in-person evidence." |
| `Late Cancel within 48 hrs` | Cancelled inside the notice window | both | 62 | 65 | **No** | "Same question — a small number have in-person evidence." |
| `No Show` | Patient did not come | both | 31 | 33 | **No — it is the opposite** | "Is this reliably set, or only sometimes?" |
| *(blank)* | No status ever set | both | 627 | 672 | **No — and no evidence either way** | **The big one.** "About a third of past appointments end with no status at all, across every office and provider. What happens on those days — is the workflow skipped for certain visit types?" |
| 2 further statuses | — | current status | withheld | — | — | Too few to report. |
| 2 further statuses | — | transitions | — | withheld | — | Too few to report. |

---

## Answers to the specific questions

### 1. Which statuses occur where

19 distinct values in current status (2 of them too small to report), 21 in the
transition history (2 too small to report). Twelve appear in both. **Nine appear
only in the history** — and those nine are exactly the in-visit states. The two
sources are not interchangeable.

### 2. Obvious vs genuinely ambiguous

**Obvious enough to confirm in one sentence each** — `Arrived`, `In Room`,
`In Session`, `MD In`, `MD Out`, `Checked In`. A patient cannot reach these
remotely. Jeff confirms rather than decides.

**Genuinely needs a decision** — `Complete`, `Ready in N`, `Checked In Online`,
`Signed No Review`, `Procedure Not Performed`, and the blank status.

None of this is approved. The recommendation above is a recommendation; the
mapping in the code still records `approval.state = awaiting_clinic_confirmation`
with no provenance, and it should stay that way until a named person at the
clinic confirms it on a date.

### 3. Blank current status — is there evidence in the history?

Checked directly, and the answer is clean: **no.** Of the 627 appointments with
a blank final status, **zero** have a transition to any in-person status. Every
one of them has exactly one recorded transition, and it is blank → blank. All
but a handful are past-dated.

So blank should be reported as **unknown**, not as "did not attend". It is also
not concealing attendance — which is worth saying, because it is the outcome
someone would reasonably fear.

### 4. Ambiguous statuses with no stronger evidence elsewhere

| Case | Appointments |
| --- | --- |
| `Complete` with **no** in-person evidence anywhere in its history | 10 |
| `Complete` with only a `Ready in N` | 11 |
| Blank final status with no evidence (all of them) | 627 |
| `Rescheduled` with no evidence | 297 |
| Roomed-only (`Ready in N`, nothing stronger), any final status | 13 |

The 10 `Complete`-without-evidence appointments are the reason `Complete` cannot
be the definition. They are few, but they are the ones that would be silently
wrong.

### 5. Cancellations, reschedules, deletions and conflicts

**"Ever arrived" and "final disposition" are different facts, and the data
proves it rather than assuming it.**

| | Appointments |
| --- | --- |
| Has in-person evidence *and* a cancel / no-show / reschedule somewhere in its history | 15 |
| Has in-person evidence *and* its **final** status is a cancel / no-show / reschedule | 9 |
| Deleted at source, total | 99 |
| Deleted at source **and** has in-person evidence | withheld |

Nine appointments show a patient who was in the building and whose appointment
now reads as cancelled, rescheduled or a no-show. Treating the final status as
the answer would miscount every one of them.

The mapping already has the right rule for this — the earliest qualifying
arrival transition counts, and a later cancellation does not erase it. Deletion
at source does not erase it either: the evidence is retained, deliberately.

### 6. Is the gate all-or-nothing? Could a subset work?

**Yes, it is all-or-nothing today.** `attendanceIsApproved()` returns true only
when `approval.state === "approved"`, and `/api/reports/booking` derives its
single `attendance.available` flag from it. One unanswered question about
`Ready in 2` therefore withholds everything, including the 969 appointments
whose evidence is not in doubt.

**A confirmed subset would support real reporting.** If Jeff confirms only the
core in-person set and nothing else, every appointment falls into one of these,
with nothing forced:

| Bucket | Appointments |
| --- | --- |
| **Arrived** — in-person evidence in history | 969 |
| **Did not arrive** — no evidence, final status No Show / Cancelled / Late Cancel | 254 |
| **Not yet applicable** — Scheduled or Confirmed, no evidence | 404 |
| **Unknown** — blank final status, no evidence either way | 627 |
| **Unknown** — Rescheduled, no evidence | 297 |
| **Unknown** — roomed-only (`Ready in N`), pending Jeff | 13 |
| **Unknown** — anything else | 10 |

Restricted to appointments whose scheduled time has already passed (2,206 of
them): 969 arrived, 241 with no evidence and a no-show/cancel disposition, and
996 unknown.

That is a usable report **as long as unknown stays unknown.** Roughly 45% of
past appointments would be unknown, which is a fact about how the clinic records
things, not a defect to be papered over. Confirming `Ready in N` moves 13 more;
answering the blank question is what would move the needle.

**This report deliberately does not state an attendance rate.** A denominator of
"appointments we can classify" would be a different measure from "appointments
that happened", and publishing one before Jeff confirms the evidence set is
exactly the mistake this whole gate exists to prevent.

---

## If a rate is later published, it must state these three things

- **Cohort** — which patients and which appointments. Proposed: appointments
  belonging to patients linked to an intake submission, whose scheduled time
  falls in the reporting period.
- **Timing rule** — measured against the appointment sync cursor, never the
  clock, and only for appointments whose scheduled time has already passed.
  Appointments still in the future are *not yet applicable*, not absences.
- **Evidence requirement** — the earliest transition to a clinic-approved
  in-person status. Everything else is **unknown**, shown as unknown, and
  excluded from both the numerator and the denominator, with the unknown count
  printed next to the rate.

---

## Recommended card

### Compact card — what sits on the page now

```
┌─ Attendance ────────────────────────────────────────────────┐
│                                                             │
│  Not reported yet — one decision away                       │
│                                                             │
│  969 past appointments already carry a record that the      │
│  patient was physically in the clinic — checked in, roomed, │
│  or with the provider.                                      │
│                                                             │
│  We are not publishing an attendance figure until the       │
│  clinic confirms which of its status labels mean that.      │
│                                                             │
│  Three questions would unlock it   [ Review statuses ▾ ]    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Why this copy: it leads with what is *already true* rather than with what is
missing, gives Jeff a number he can recognise, and names the size of the ask.
No version strings, no approval-state jargon, no "mapping".

### Expanded — "Clinic statuses to confirm"

```
Clinic statuses to confirm                                [ ▴ ]

  THE THREE THAT MATTER

  1. Does "Complete" mean the patient was seen?
     945 appointments end as Complete. 924 of them also show the
     patient checked in or roomed — but 10 show no sign the patient
     was ever here.
     → If Complete alone is not proof, we will not treat it as proof.

  2. Is "Ready in 2" a room number?
     If it means the patient is already roomed, 13 more appointments
     become clear.

  3. About a third of past appointments end with no status at all.
     627 of them, spread evenly across all three offices and nearly
     every provider, steady every month since June. None of them show
     any sign the patient arrived — and none show they didn't.
     → What happens on those days? Is the check-in workflow skipped
       for certain visit types?

  ────────────────────────────────────────────────────────────

  ALREADY CLEAR — please just confirm
  These can only be set with the patient in the building:
     Arrived · Checked In · In Room · In Session · MD In · MD Out
  969 past appointments have at least one of them.

  CLEAR THE OTHER WAY
     No Show · Cancelled · Late Cancel within 48 hrs
  ...except that 9 appointments show a patient who was here and whose
  appointment now reads cancelled or rescheduled. We count those as
  attended. Is that right?

  ONE MORE
     "Checked In Online" — can a patient do this from home?

  ────────────────────────────────────────────────────────────

  FULL STATUS LIST                                          [ ▾ ]
  (19 current-status values, 21 in history, with counts)

  These are appointments, not patients, and they overlap — one visit
  passes through several of these. They do not add up.
```

### Notes for whoever builds it

- The counts in the expanded section can come from the existing
  `drsnip_status_evidence()` function, which already returns status, transitions,
  appointments and patients with suppression applied inside the database
  boundary. It covers **transitions only** — a current-status counterpart would
  need adding, and that is a change for another task, not this one.
- Keep "Not reported yet" as the headline. Not "unavailable", not an error
  state, and never a zero.
- The card should not show an attendance percentage, even a provisional one,
  while the gate is closed.
- If a subset is later approved, the card should show the unknown count beside
  any rate, at the same size. An unknown of ~45% of past appointments is the
  most important number on the card, not a footnote.
