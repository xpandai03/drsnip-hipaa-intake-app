# Phase 6 — Prompt 1 of 3: Registration Form Feedback (Plan)

Branch: `phase-6-registration-feedback` (from latest `origin/main`). PR target: `main`.
No deploy. No Consultation / PDF / n8n / admin edits. Plan-first — **awaiting sign-off
before any code is written.**

All Registration changes live in a single file:
[Home.tsx](Intake-form/artifacts/intake-form/src/pages/Home.tsx) (mounted at `/`).

---

## STEP 0 — State-required reconciliation (finding)

| Question | Finding |
|---|---|
| Is PR #11 (`phase-4-state-required`) merged into `it-snip` main? | **No.** `gh pr list` shows PR #11 **OPEN**, created 2026-06-01, never merged. |
| Is State required on current `origin/main` Home.tsx? | **No.** On main the State `TextField` (line 336–340) has **no `required` prop**, and the `contact` screen `isValid` (line 373–382) does **not** check `data.state`. |

**Path taken:** State-required is **NOT done** on main → I will implement it as part of
**this** branch (item A2 below), replicating PR #11's exact, minimal approach so it ships
with the rest and PR #11 can simply be closed as superseded. (PR #11's diff: add `required`
to the State field + add `data.state.trim() !== ""` to the contact `isValid`.)

---

## Architecture notes (read before the item table)

1. **The details/explanation prompt is currently ONE shared label** for all 14 medical
   questions — [Home.tsx:418](Intake-form/artifacts/intake-form/src/pages/Home.tsx#L418):
   `"Please share details, including a general timeframe."`
   Jeff wants **different** prompts per question (A3/A4/A5/A6). To do that cleanly I will
   add an optional per-question field `detailsPrompt?: string` to the `MEDICAL_QUESTIONS`
   entries (mirroring the existing optional `explanationPlaceholder`), with a default
   constant for any question Jeff did **not** call out:
   `DEFAULT_DETAILS_PROMPT = "Please share details, including a general timeframe."`
   The render uses `q.detailsPrompt ?? DEFAULT_DETAILS_PROMPT`. This is the only structural
   addition; it changes no wording on its own.

2. **Questions Jeff did NOT specify a details prompt for keep the current default**
   (`"...including a general timeframe."`). After all edits those are: `mhSTI`,
   `mhTesticleAbnormality` (A7 changes its *question* text only), `mhTesticleInjury`,
   `mhSurgeries`. **Flagging for confirmation:** per the "don't apply a reword Jeff didn't
   ask for" rule I am leaving these as-is. Tell me if you want them switched too.

3. **Removing the 3 B1 questions empties the entire first medical screen.** Screen
   `medical-mental-pain` ("Mental Health & Pain Tolerance") holds exactly the 3 removed
   keys (line 92). After removal it has zero questions. **Recommended:** delete that now-empty
   screen. The Primary Care Physician field and the medical-section intro text are gated on
   `msIndex === 0` (lines 388–401), so they **automatically relocate** to the new first
   medical screen ("Bleeding, Kidney & Infections") with no extra work and no orphaned
   field. Result: 4 medical screens instead of 5, PCP still first, no empty/mis-titled
   screen. **Flagging for confirmation** — this is the one screen-structure change.

---

## Item-by-item: exact current wording → final wording

### A2) State on Address → mandatory
- **Current** ([L336-340](Intake-form/artifacts/intake-form/src/pages/Home.tsx#L336)): State `TextField`, no `required`; `isValid` omits state.
- **Final:** add `required` to the State `TextField`; add `data.state.trim() !== ""` to the
  `contact` screen `isValid` (replicates PR #11). Blocks submit/advance when blank.

### A3) Six questions → details prompt becomes exactly `Please share details.`
For each, **only the details prompt changes** (set `detailsPrompt: "Please share details."`);
the question text is untouched. Current details prompt for all six is the shared default
`"Please share details, including a general timeframe."`

| Key | Question text (unchanged) |
|---|---|
| `mhPainSensitive` | Do you think you are more sensitive to pain than the average person? |
| `mhFainting` | Have you ever fainted during, or after, a medical procedure? |
| `mhBleeding` | Do you, or does anyone in your family, have a tendency to bleed easily? |
| `mhKidney` | Do you have a kidney abnormality or abnormal kidney function? |
| `mhSurgeryComplications` | Have you had any complications or excessive pain or bleeding after surgery? |
| `mhChronic` | Have you had any major medical problems or do you have any chronic medical problems? |

> Note: `mhPainSensitive` and `mhFainting` get this prompt in A3, then are **removed** in B1.
> Their post-A3 state is captured in the handoff record below.

### A4) Medications question → details prompt
- **Key:** `mhMedications`
- **Question text (unchanged):** "Is there medication you take regularly or have you taken any medication in the last 2 weeks?"
- **Current details:** shared default `"Please share details, including a general timeframe."`
- **Final details (exact):** `Please share the medication, how often you take it and when you last took it.`

### A5) Aspirin question → BOTH question text AND details
- **Key:** `mhAspirin`
- **Current question** ([L77](Intake-form/artifacts/intake-form/src/pages/Home.tsx#L77)): "Are you currently taking any aspirin products, or anticipate taking aspirin in the five days leading up to your procedure?"
- **Final question (exact):** `Are you currently taking, or do you plan to take in the 5 days before your procedure, any aspirin or aspirin-containing products? Examples include low-dose/baby aspirin, Excedrin, Ecotrin, Anacin, or Alka-Seltzer Original.`
- **Current details:** shared default.
- **Final details (exact):** `Please share what you are taking, how often and why you are taking it` (no trailing period — matches Jeff).

### A6) Drug-allergy question → details prompt
- **Key:** `mhAllergies`
- **Question text (unchanged):** "Do you have any allergies to a drug, medication, or anesthetic?"
- **Final details (exact):** `Please share details of the drug and the allergic reaction` (no trailing period — matches Jeff).

### A7) Testicle/hernia question → reword question text only
- **Key:** `mhTesticleAbnormality`
- **Current** ([L72](Intake-form/artifacts/intake-form/src/pages/Home.tsx#L72)): "Have you ever had Testicle abnormality, scrotum abnormality, hernia, infection, or tumor?"
- **Final (exact):** `Have you ever had a hernia or any abnormality, infection, or tumor of the testicle or scrotum?`
- Details prompt: unchanged (default) — see Architecture note 2.

---

## B1) Remove 3 questions from Registration (after A3 applied)

Removed entirely from Home.tsx: the `MedicalKey` union members, `MEDICAL_QUESTIONS`
entries, `MEDICAL_SCREENS` keys, and `initialData` defaults. The now-empty
`medical-mental-pain` screen is deleted (Architecture note 3). `isValid` for medical screens
iterates `ms.keys`, so removing keys is self-consistent — no validation references break.

**Handoff record for Prompt 2 (recreate faithfully on Consultation) — exact final
post-A3 state:**

| # | Key | Question text | Answer type | Details prompt | Reveal logic |
|---|---|---|---|---|---|
| 1 | `mhMentalIllness` | Does mental illness or depression affect your decision making? | Yes/No | `Please share details, including a general timeframe.` (default — **not** reworded, per instruction) | Details textarea reveals when answer === "Yes"; details required when shown |
| 2 | `mhPainSensitive` | Do you think you are more sensitive to pain than the average person? | Yes/No | `Please share details.` (post-A3) | Details textarea reveals when answer === "Yes"; details required when shown |
| 3 | `mhFainting` | Have you ever fainted during, or after, a medical procedure? | Yes/No | `Please share details.` (post-A3) | Details textarea reveals when answer === "Yes"; details required when shown |

---

## Dropped-key downstream flags (NOT changed here — flag only)

Removing the 3 keys from the Registration form's data shape means Home.tsx stops sending
`mhMentalIllness`, `mhPainSensitive`, `mhFainting`. These keys are still referenced
downstream (all OUT of scope — untouched this PR). Until Prompt 2 wires them to
Consultation, Registration submissions will carry blank values for them:

- [api/submit.ts:92-135](Intake-form/api/submit.ts#L92) — extracts/persists `mhMentalIllness` (others flow via medical map)
- [lib/n8n/payload.ts:162-164](Intake-form/lib/n8n/payload.ts#L162) — maps all 3
- [lib/pdf/templates/registration.ts:50-52](Intake-form/lib/pdf/templates/registration.ts#L50) — renders all 3
- [lib/db/src/schema/submissions.ts:52](Intake-form/lib/db/src/schema/submissions.ts#L52) — `mh_mental_illness` column (nullable; safe)
- [api/submissions/export.ts:71](Intake-form/api/submissions/export.ts#L71) — CSV `mh_mental_illness`
- `api/_test/partner-card-phi.test.ts:88` — test fixture sends `mhMentalIllness` (still accepted; test stays green)

No DB migration needed (columns nullable). No PDF/n8n/admin/api edits in this PR.

---

## Implementation order (after sign-off) — logical commits

1. **A2** State-required (TextField `required` + `isValid`).
2. **A3–A7** verbiage: add `detailsPrompt`/`DEFAULT_DETAILS_PROMPT` plumbing + render change;
   set the six A3 prompts, A4/A5/A6 prompts, A5/A7 question text.
3. **B1** removal: drop the 3 keys (union, questions, screen keys, initialData), delete the
   empty `medical-mental-pain` screen.

## Acceptance (local, before PR)
- `cd Intake-form && pnpm install && pnpm build` green (typecheck + builds).
- DB-free suites still pass (`pnpm test` — pdf/email/api tests).
- Six A3 prompts read `Please share details.`; A4/A5/A6 exact; A5 question + A7 question updated.
- State blocks submit when blank. The 3 B1 questions absent; no broken validation.

## Open questions for sign-off
1. **Note 2** — leave `mhSTI`, `mhTesticleAbnormality`, `mhTesticleInjury`, `mhSurgeries`
   details prompts as the current default `"...including a general timeframe."`? (Jeff didn't
   list them.) **Default plan: leave as-is.**
2. **Note 3** — delete the emptied `medical-mental-pain` screen so PCP + intro relocate to
   the next screen (4 medical screens)? **Default plan: delete it.**
