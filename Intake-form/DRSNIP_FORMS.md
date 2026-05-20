# DrSnip Forms — parsed question structure

Source: Jotform MCP, fetched 2026-05-20.

- **Registration Form** — Jotform `260987576842071` — 40 questions, 74 submissions.
- **Consultation Intake** — Jotform `260987597803071` — 87 questions, 84 submissions.

> **Data-fidelity note.** The Jotform MCP's `fetch`/`display_form` return question
> **labels and section grouping** cleanly, but not per-field type metadata,
> exact select-option lists, required-ness flags, or conditional-logic rules.
> Field **types**, **required** flags, **options**, and **conditional logic**
> below are *inferred* from the labels and medical-intake context. Real patient
> submissions were deliberately **not** pulled (PHI). Items needing the client's
> confirmation are marked **⚠️** and collected in `PHASE_2_NOTES.md`.

Type vocabulary: `text · email · tel · number · date · select · multi-select ·
textarea · yesno · file`.

---

## Form 1 — Registration

The everyday patient-registration form: identity, contact, a medical-history
screening checklist, and insurance.

### Screen 1 — Patient Information
| Label | Type | Required | Notes |
|---|---|---|---|
| Office Location | select | yes | ⚠️ options unknown — default placeholder list of clinic locations |
| Legal First Name | text | yes | |
| Preferred First Name (if different) | text | no | |
| Middle Initial | text | no | 1-char |
| Legal Last Name | text | yes | |
| Date of Birth | date | yes | |

### Screen 2 — Contact & Consent
| Label | Type | Required | Notes |
|---|---|---|---|
| Street Address | textarea | yes | |
| Mobile Number | tel | yes | |
| Email (I agree to receive emails about my appointment) | email | yes | label doubles as a consent acknowledgement |
| I consent to receiving detailed voicemails at the phone number provided. | yesno | yes | |
| I consent to receiving care-related text messages at the phone number provided. | yesno | yes | |

### Screen 3 — Medical Background
| Label | Type | Required | Notes |
|---|---|---|---|
| Current Primary Care Physician (Name and Location) | text | no | |
| Testicle/scrotum abnormality, hernia, infection, or tumor? | yesno | yes | |
| Serious injury to, or surgery of, the testicles or scrotal area? | yesno | yes | |
| AIDS, Chlamydia, Epididymitis, Gonorrhea, Hepatitis, or Prostatitis? | yesno | yes | |
| Kidney abnormality or abnormal kidney function? | yesno | yes | |
| Take medication regularly / taken any in the last 2 weeks? | yesno | yes | |
| Have you had any surgeries? | yesno | yes | |
| Ever fainted or almost fainted during/after a medical procedure? | yesno | yes | |
| Allergies to a drug, medication, or anesthetic? | yesno | yes | |
| Major or chronic medical problems? | yesno | yes | |
| You/family tendency to bleed easily? | yesno | yes | |
| Complications / excessive pain or bleeding after surgery? | yesno | yes | |
| More sensitive to pain than the average person? | yesno | yes | |
| Currently taking / will take aspirin products in the 5 days pre-procedure? | yesno | yes | |
| If you answered Yes to any of the above, please provide details + timeframe. | textarea | no | **conditional** — reveal if any medical-history answer is "Yes" |

### Screen 4 — Insurance
| Label | Type | Required | Notes |
|---|---|---|---|
| Select your current insurance coverage | select | yes | ⚠️ options inferred: `Private/Commercial`, `Medicaid`, `Medicare`, `Self-pay / No insurance`, `Other` |
| Insurance Company | text | conditional | reveal unless coverage = Self-pay/No insurance |
| ID No. | text | conditional | " |
| Group No. | text | conditional | " |
| Insured's Legal First Name | text | conditional | " |
| Insured's Legal Last Name | text | conditional | " |
| Insured's Date of Birth | date | conditional | " |
| Insured's Employer | text | conditional | " |
| Upload the front and back of your insurance card(s) | file ×2 | conditional | front + back; reveal unless Self-pay. **Stubbed** — see PHASE_2_NOTES |

### Screen 5 — Review & Submit
Confirmation / submit screen.

---

## Form 2 — Consultation Intake

The pre-appointment, medical-history-and-life-context-heavy form. 87 raw
Jotform questions — but 32 of those are the repeating **Child 1–8 × {Age,
Relation, Gender, Dependent}** block, rendered here as a dynamic repeat driven
by a "how many children" count (see PHASE_2_NOTES decision).

### Screen 1 — About You
| Label | Type | Required | Notes |
|---|---|---|---|
| Name (First / Last) | text ×2 | yes | identity block (appears at the end of the Jotform) |
| Email | email | yes | |
| Phone Number | tel | yes | |
| Date of Birth | date | yes | |
| Field of Work / Occupation | text | no | |
| Employer | text | no | |
| Job Title | text | no | |
| Job Demands | select | no | ⚠️ inferred: `Sedentary`, `Light`, `Moderate`, `Heavy` |
| Education | select | no | ⚠️ inferred: `High school`, `Some college`, `Associate`, `Bachelor's`, `Graduate`, `Other` |
| Please Specify (education) | text | conditional | reveal if Education = Other |
| Ethnicity | select | no | ⚠️ inferred standard US-census-style options |

### Screen 2 — Relationship
| Label | Type | Required | Notes |
|---|---|---|---|
| Relationship Status | select | yes | ⚠️ inferred: `Single`, `Married`, `Partnered`, `Divorced`, `Widowed`, `Other` |
| Please Specify Relationship Status | text | conditional | reveal if status = Other |
| Partner/Spouse's First Name | text | conditional | reveal if Married/Partnered |
| Partner/Spouse's Last Name | text | conditional | " |
| Partner/Spouse's Phone | tel | conditional | " |
| Consent to share information with your partner if they contact us? | yesno | conditional | " |
| Partner/Spouse's Age | number | conditional | " |
| Partner/Spouse's Field of Work / Occupation | text | conditional | " |
| Partner/Spouse's Education | select | conditional | " |
| Years in this relationship? | number | conditional | " |
| Which marriage is this for you? | select | conditional | ⚠️ `1st`, `2nd`, `3rd or more` |
| Which marriage is this for your spouse? | select | conditional | " |

### Screen 3 — Children
| Label | Type | Required | Notes |
|---|---|---|---|
| How many children do you have? | number | yes | 0–8; drives the dynamic repeat below |
| Child _N_ — Age | number | conditional | rendered for N = 1..count |
| Child _N_ — Relation | select | conditional | ⚠️ `Biological`, `Step`, `Adopted`, `Other` |
| Child _N_ — Gender | select | conditional | ⚠️ `Male`, `Female`, `Other` |
| Child _N_ — Dependent | yesno | conditional | |

### Screen 4 — Family Planning & Birth Control
| Label | Type | Required | Notes |
|---|---|---|---|
| Do you wish to have more children in the future? | select | yes | ⚠️ `Yes`, `No`, `Unsure` |
| Would you consider adoption if you chose to have more children? | yesno | no | |
| For how long have you considered vasectomy? | text | no | |
| Considered tubal ligation as an alternative? | yesno | no | |
| Considered temporary birth control (condoms, diaphragm, etc.)? | yesno | no | |
| Select your current birth control methods | multi-select | no | ⚠️ inferred list (None/Condoms/Pill/IUD/etc.) |
| Other current birth control methods | text | conditional | reveal if "Other" selected above |
| Select all prior methods of birth control | multi-select | no | ⚠️ same inferred list |

### Screen 5 — Medical & Personal Considerations
| Label | Type | Required | Notes |
|---|---|---|---|
| Does vasectomy conflict with your religion? | yesno | yes | |
| Do you, or does your partner, have any sexual problems or concerns? | yesno | yes | |
| Details | textarea | conditional | reveal if previous = Yes |
| Choosing sterilization because of a genetic condition? | yesno | yes | |
| Details | textarea | conditional | reveal if previous = Yes |

### Screen 6 — Emergency Contact, Referral & Notes
| Label | Type | Required | Notes |
|---|---|---|---|
| Emergency Contact Name | text | yes | |
| Emergency Contact Phone Number | tel | yes | |
| Emergency Contact Relationship | text | yes | |
| How did you hear about DrSnip? | select | no | ⚠️ inferred: `Google/Search`, `Social media`, `Friend/Family`, `Doctor referral`, `Insurance`, `Other` |
| Please Specify (referral) | text | conditional | reveal if = Other |
| Referring medical professional (name and specialty) | text | conditional | reveal if = Doctor referral |
| Anything else you'd like to share before your appointment? | textarea | no | |

---

## Conditional logic summary

Both forms use straightforward **show-if** reveals — no complex branching:

- **Registration:** medical-history "details" textarea reveals on any Yes;
  insurance sub-fields + card upload reveal unless coverage is Self-pay.
- **Consultation:** partner fields reveal on Married/Partnered; child rows
  reveal up to the stated count; "Other → Please Specify" pairs throughout;
  Details textareas reveal on their Yes.

All implemented with the existing `framer-motion` `AnimatePresence` inline-reveal
pattern (same as CJC's `agency === "Other"` reveal).
