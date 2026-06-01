# Phase 4, Block B — Form-side UX polish (Jeff round-2 feedback)

Branch: `phase-4-jeff-feedback-forms` (from `main`) · PR target: `main` · **No deploy this session.**

Scope: **frontend form logic only.** Files in play:

- `artifacts/intake-form/src/pages/Home.tsx` — the public **Registration** form (mounted at `/`; there is no `Registration.tsx` — `Home` *is* it).
- `artifacts/intake-form/src/pages/Consultation.tsx` — the **Consultation** intake.
- `artifacts/intake-form/src/components/ui/form-fields.tsx` — shared field kit (`TextField`, `TextAreaField`, `SelectField`, `YesNoField`, `ChoiceField`, `MultiChoiceField`, `Reveal`).
- `artifacts/intake-form/src/lib/phone.ts` — **new** tiny formatter helper (B.1).

**Out of scope (do NOT touch):** PDF templates (`lib/pdf/**`), n8n bridge/payload (`lib/n8n/**`), admin console, DB migrations, deploy. Where a change implies a downstream data-shape change, it is flagged in the PR description only.

The `FormData` shape lives **inline per form** (`RegistrationData` in Home.tsx, `ConsultationData` in Consultation.tsx) — there is no shared `FormData` module. Type changes are kept additive; the two breaking-ish content changes (insurance status values, `howHeard` string→array) are called out explicitly.

---

## The 12 items

| # | Item | File(s) | Approach | Downstream flag |
|---|------|---------|----------|-----------------|
| 1 | Phone auto-format `(xxx) xxx-xxxx` while typing, both forms | `lib/phone.ts` (new), `form-fields.tsx` (TextField `type="tel"`), both forms | Format on input via a pure `formatPhone()` that strips to digits (max 10) then re-lays the mask. Idempotent → pasting a formatted/partial number won't double-format. Applied only to `type="tel"` fields so non-phone inputs are untouched. Existing stored values never reformatted (format is input-time only). | — |
| 2 | PCP placeholder `"Optional"` → `"Name & Location"` | Home.tsx (PCP TextField) | One-line placeholder change. | — |
| 3 | Registration medical "Yes" explanations become **mandatory** | Home.tsx (`MEDICAL_SCREENS` map `isValid`) | A screen is valid only when every `Yes`-answered question on it has a non-blank `medicalDetails[key]`. Blocks Continue until filled. | — |
| 4 | Insurance refactor → Own / Partner's / Both / No Insurance | Home.tsx | **See B.4 proposal below — paused for sign-off.** | status value-set + new partner fields → n8n/PDF |
| 5 | Replace every `(Optional)` label with a neutral treatment | `form-fields.tsx`, Home.tsx | No literal `(Optional)` parenthetical labels exist. The only "Optional" UI strings are two **placeholders**: `TextAreaField`'s default `"Optional"` and the PCP placeholder (handled by B.2). Replace the `TextAreaField` default with a neutral empty placeholder so optional textareas read neutrally. Required-ness stays signalled by the `*` only. | — |
| 6 | Consultation Job Demands → `Desk Job / Active / Combination` | Consultation.tsx (`JOB_DEMANDS`) | Replace the 4 old options (`Sedentary/Light/Moderate/Heavy`) with the 3 new ones, matching JotForm intent. Field stays a single-select `SelectField`. | value-set change → n8n/PDF (note only) |
| 7 | Consultation Relationship status: add `Separated` | Consultation.tsx (`RELATIONSHIP_STATUS`) | Insert `"Separated"` into the list (additive). | — |
| 8 | Move consent-for-contact next to partner phone (Spouse/Partnered) | Consultation.tsx | Relocate the `partnerShareConsent` `YesNoField` to sit immediately under the Partner/Spouse's Phone field inside the `hasPartner` reveal. State key unchanged. | — |
| 9 | Remove spouse/partner **education** field | Consultation.tsx | Remove the `partnerEducation` `SelectField` and the `PARTNER_EDUCATION` constant. Keep the `partnerEducation` key in the type as `""` (or drop it) — see note. | field drop → n8n/PDF (note only) |
| 10 | Hide "Which marriage is this" unless status = **Married** (not Partnered) | Consultation.tsx | Gate both marriage-number `SelectField`s behind `relationshipStatus === "Married"`. On a Married→Partnered toggle, **clear** `marriageNumberSelf`/`marriageNumberSpouse` so stale data isn't submitted. | — |
| 11 | Consultation Emergency Contacts → optional | Consultation.tsx (last screen `isValid`) | Drop the emergency-name/phone/relationship requirements; remove `required` flags. Screen `isValid` → `true`. | — |
| 12 | "How heard about DrSnip" → **multi-select** + missing JotForm options | Consultation.tsx | Convert `howHeard` from `string` → `string[]`, render with `MultiChoiceField`. Adopt the **authoritative JotForm option set** (sourced live, see below). Reveal logic updated to `.includes(...)`. | **string→array** breaks n8n Parse & Normalize (expects string) → flagged in PR |

### B.12 — authoritative "How heard" options (sourced from live JotForm, not the inferred doc list)

The doc (`DRSNIP_FORMS.md`) marked these `⚠️ inferred`. Pulled the real list from the live Consultation JotForm (`260987597803071`) — and submissions confirm it's a multi-select (values like `"Family Friend Facebook Radio"`):

```
Family, Friend, Medical Professional Referral, Facebook, Instagram, Google, Brochure, Event, Radio, Other
```

**Decision:** adopt the JotForm set verbatim (this is "match JotForm + add missing options"). This *replaces* the current inferred list (`Google / Search`, `Social media`, `TV`, `Friend or family`, `Doctor referral`, `Insurance provider`, `Other`). Rationale: item 12 says "match JotForm"; the current list was never authoritative. The `"Other"` → free-text reveal is kept; the referring-professional reveal now triggers on `"Medical Professional Referral"` (the JotForm equivalent of "Doctor referral"). Assumption noted in PR.

---

## B.4 — Insurance refactor: proposed schema (★ PAUSE FOR SIGN-OFF ★)

**Today** (`RegistrationData`): one status field `insuranceCoverage: string` with options
`Private/Commercial`, `Medicare`, `Medicaid`, `Self-pay/No insurance`, `Other`, plus **one** flat set of detail fields:
`insuranceCompany`, `insuranceIdNo`, `insuranceGroupNo`, `insuredFirstName`, `insuredLastName`, `insuredDob`, `insuredEmployer`, `insuranceCardFront/Back`.

**Target** (JotForm): status options become **Own Insurance / Partner's Insurance / Both / No Insurance**. On JotForm itself the detail fields appear once, but "Both" semantically implies capturing two policies.

### Recommended — Approach A: keep existing set as "primary", add a conditional partner set

- `insuranceCoverage` keeps its key & `string` type; only the **allowed values** change to the 4 above.
- The **existing flat `insurance*`/`insured*`/`insuranceCard*` fields are reused unchanged** as the *primary* policy:
  - `Own Insurance` → primary set = the patient's own policy.
  - `Partner's Insurance` → primary set = the partner's policy.
  - `Both` → primary set = own policy **+** a new *secondary* set = partner's policy.
  - `No Insurance` → no detail fields shown.
- Add **new, additive** flat fields for the secondary policy, shown only when `Both`:
  `partnerInsuranceCompany`, `partnerInsuranceIdNo`, `partnerInsuranceGroupNo`, `partnerInsuredFirstName`, `partnerInsuredLastName`, `partnerInsuredDob`, `partnerInsuredEmployer`, `partnerInsuranceCardFront/Back`.
- Validation: each **visible** set requires Company + ID No. (mirrors today's rule). `No Insurance` requires nothing.

**Why A:** purely additive — every existing payload key keeps its name and meaning, so the PDF/n8n mapping for the primary policy is undisturbed. Only two downstream-shape changes to flag (not implement): (1) `insuranceCoverage` now emits the 4 new strings instead of the old 5; (2) new `partnerInsurance*` keys appear on `Both`. Both noted in the PR for a later n8n/PDF block.

### Alternative — Approach B: nest into `ownInsurance` / `partnerInsurance` objects

Cleaner conceptually (`ownInsurance: InsuranceDetails`, `partnerInsurance: InsuranceDetails`), maps 1:1 to the options — **but** it renames/restructures every existing flat insurance key, which *breaks the current payload shape* the PDF and n8n already read. That violates "keep additive; don't force downstream changes," so I do **not** recommend it for this block.

**Question for you:** approve **Approach A** (reuse existing set as primary + additive partner set for "Both")? Or do you want B's nested restructure (accepting the downstream-shape churn)? I'll implement the rest of the 12 in parallel and hold B.4 until you confirm.
