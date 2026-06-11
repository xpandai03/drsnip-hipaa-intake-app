# Phase 6 — Prompt 2 of 3: Consultation Form Feedback (Plan)

Branch: `phase-6-consultation-feedback`, **cut from `phase-6-registration-feedback` (PR #13)**,
NOT main — confirmed base tip `6ed0956` ("B1 — remove 3 questions from Registration"). PR
target: `main`. No deploy. No Registration / PDF / n8n / admin edits. Plan-first — **awaiting
sign-off before any code.**

All Consultation changes live in one file:
[Consultation.tsx](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx).

---

## Section-name confirmation (for MOVE placement)
The section exists on Consultation as screen `considerations`, titled
**"Medical & Personal Considerations"** ([L505-506](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L505)) — Jeff wrote "Medical and Personal
Considerations" (ampersand vs "and"; same section). **Placement decision (flag for
sign-off):** I'll **append the 3 moved questions to the END of this screen**, after the
genetic-condition question — i.e. "after the section's content," same step. Alternative would
be a new screen after it, but Jeff gave no new screen title and they're 3 short optional
questions, so appending is the lower-risk reading. **Default plan: append to end of the
considerations screen.**

---

## Item-by-item: exact current → final

### C2) Partner-consent → mandatory when Married/Partnered
- **Current** ([L347-351](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L347)): `YesNoField` "Do you consent to us sharing information with your
  partner should they contact us directly?", inside `Reveal show={hasPartner}`
  (`hasPartner = ["Married","Partnered"].includes(status)`). **Not** `required`; relationship
  screen `isValid` is just `data.relationshipStatus !== ""` ([L385](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L385)).
- **Final:** add `required` to the field (asterisk) and extend `isValid` to:
  `data.relationshipStatus !== "" && (!hasPartner || data.partnerShareConsent !== "")`.
  `hasPartner` is exactly the visibility condition, so the requirement applies only when the
  question is shown (Married/Partnered). Question is **not re-added** — existing one modified.

### C3) Child Relation options → Ours / Mine / Hers / Adopted
- **Current** ([L36](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L36)): `CHILD_RELATION = ["Biological", "Step", "Adopted", "Other"]`.
- **Final:** `CHILD_RELATION = ["Ours", "Mine", "Hers", "Adopted"]` (replace).
- ⚠️ **Data-shape flag:** stored child `relation` values change (only "Adopted" carries over).
  Downstream (PDF children block, n8n `relation`, export) — flag only, no change here.

### C4) Make four questions optional (+ conditional-mandatory details)
| Question | Current state | Final |
|---|---|---|
| "Do you wish to have more children in the future?" ([L442-449](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L442)) | **Mandatory** (`ChoiceField required`; in family-planning `isValid`) | **Optional** — remove `required`; drop from `isValid` (screen `isValid` → `true`). No conditional detail. |
| "Does a vasectomy conflict with your religion?" ([L510-515](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L510)) | **Mandatory** (`YesNoField required`; in considerations `isValid`). **Has NO details field today.** | **Optional**; **if "Yes" → details mandatory.** Requires **adding** a `religionConflictDetails` field + a `Reveal` details textarea shown on "Yes", required-when-shown. |
| "Do you, or does your partner, have any sexual problems or concerns?" ([L516-528](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L516)) | **Mandatory** Yes/No; details reveal exists but **not** required | **Optional** Yes/No; **if "Yes" → `sexualConcernsDetails` required.** |
| "Are you choosing sterilization because of a genetic condition concerning you or your partner?" ([L529-541](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L529)) | **Mandatory** Yes/No; details reveal exists but **not** required | **Optional** Yes/No; **if "Yes" → `geneticConditionDetails` required.** |

> ⚠️ **Structural addition flagged:** the religion question has **no** details box today. To
> honor "if Yes, the details response becomes mandatory" I will **add** a details textarea
> (new key `religionConflictDetails`) revealed on "Yes". **Confirm this is what Jeff wants.**

New `considerations` screen `isValid` (optional-but-mandatory-if-Yes for all three, plus the
moved questions below):
```
(religionConflict !== "Yes" || religionConflictDetails.trim() !== "") &&
(sexualConcerns   !== "Yes" || sexualConcernsDetails.trim()   !== "") &&
(geneticCondition !== "Yes" || geneticConditionDetails.trim() !== "") &&
(mhMentalIllness  !== "Yes" || medicalDetails.mhMentalIllness?.trim()) &&
(mhPainSensitive  !== "Yes" || medicalDetails.mhPainSensitive?.trim()) &&
(mhFainting       !== "Yes" || medicalDetails.mhFainting?.trim())
```
Detail-prompt label for the existing sexual/genetic reveals stays "Details" (unchanged — Jeff
didn't ask to reword those).

### C5) "How did you hear about DrSnip" multi-select — option list edit
- **Current** ([L53-64](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L53)): `["Family", "Friend", "Medical Professional Referral", "Facebook",
  "Instagram", "Google", "Brochure", "Event", "Radio", "Other"]`.
- **FINAL full list (for your confirmation):**
  1. `Family / Friend`  ← merges "Family" + "Friend"
  2. `Medical Professional Referral`
  3. `Facebook`
  4. `Instagram`
  5. `Google`
  6. `Brochure`
  7. `Event`
  8. `Radio`
  9. `TV Commercial`  ← new
  10. `Insurance Directory`  ← new
  11. `Magazine Ad`  ← new
  12. `Other`  (kept last — the "Other" reveal keys on this value)
- ⚠️ **Data-shape flag:** merging Family+Friend collapses two stored values into one
  (`"Family / Friend"`). The "Medical Professional Referral" reveal ([L589](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L589)) and "Other"
  reveal ([L582](Intake-form/artifacts/intake-form/src/pages/Consultation.tsx#L582)) are unaffected. Downstream n8n/Sheets mapping of `howHeard` values must
  learn the new labels — flag only, **no n8n change here**.

### MOVE) Recreate 3 questions from PR #13 handoff record — after the considerations section, ALL OPTIONAL
Source of truth = PR #13 handoff record. All Yes/No **optional** (never block advance); on
"Yes" a details textarea reveals and is **required-when-shown**. Appended to the end of the
considerations screen, in this order:

| Key | Question text (verbatim) | Details prompt | Reveal/required |
|---|---|---|---|
| `mhMentalIllness` | Does mental illness or depression affect your decision making? | `Please share details, including a general timeframe.` (**NOT reworded**) | textarea on "Yes", required when shown |
| `mhPainSensitive` | Do you think you are more sensitive to pain than the average person? | `Please share details.` | textarea on "Yes", required when shown |
| `mhFainting` | Have you ever fainted during, or after, a medical procedure? | `Please share details.` | textarea on "Yes", required when shown |

**Data shape (faithful to the n8n contract):** I'll add answer keys `mhMentalIllness`,
`mhPainSensitive`, `mhFainting` and store the explanations under a `medicalDetails` map keyed
by the same local keys — mirroring Registration/Home.tsx, which n8n's `medicalDetail()` reads
as `body.medicalDetails.<localKey>` ([payload.ts:204](Intake-form/lib/n8n/payload.ts#L204)). This makes the future downstream wiring a
drop-in.

---

## Downstream flags (NOT changed here)
1. **3 moved keys now populate from Consultation.** `buildConsultationPayload` and
   `lib/pdf/templates/consultation.ts` do **not** render medical-history today — they'll need
   updating to surface mhMentalIllness/mhPainSensitive/mhFainting. (`buildRegistrationPayload`
   still reads them but Registration no longer sends them after PR #13.) DB column
   `mh_mental_illness` exists; pain/fainting may lack columns — downstream concern, not this PR.
2. **C3 child relation values changed** (Biological/Step/Other → Ours/Mine/Hers).
3. **C5 Family+Friend merged** into `Family / Friend`; 3 new labels added.
   All three are PDF/n8n/export concerns — flagged, untouched here.

## Implementation order (after sign-off) — logical commits
1. **C2** consent mandatory (required + relationship `isValid`).
2. **C3** child relation options.
3. **C4** four questions optional + religion details field + considerations `isValid`.
4. **C5** howHeard option list.
5. **MOVE** add 3 optional questions (+ keys, medicalDetails, reveals) after considerations.

## Acceptance (local + browser-walk, like PR #13)
- `pnpm install && pnpm build` green; DB-free suites pass.
- Browser-verify: C2 blocks advance when Married/Partnered & consent blank (and isn't shown
  for Single); C3 options exactly Ours/Mine/Hers/Adopted; C4 four optional, Yes→details
  required; C5 final list renders; 3 moved questions appear after considerations, optional,
  correct prompts (mental-illness NOT reworded), reveal intact.

## Open questions for sign-off
1. **MOVE placement** — append the 3 questions to the END of the existing "Medical & Personal
   Considerations" screen (vs a new screen)? **Default: append.**
2. **C4 religion details** — OK to **add** a new details textarea (`religionConflictDetails`)
   to the religion question, required when "Yes" (none exists today)? **Default: add it.**
3. **C5 final list + ordering** above (new options before "Other") — approve as written?
