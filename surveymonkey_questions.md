# SurveyMonkey questions — source of truth

Pulled from live SurveyMonkey on May 5, 2026.

There are TWO forms in production. Phase 1 is replacing only Form 1 (SOFA Evaluation).
Form 2 (Pre-Consult) stays in SurveyMonkey for now — Phase 2 candidate.

---

## FORM 1 — SOFA Evaluation Form (the intake form, Survey ID 55736428)

This is the form Chris drops in chat during presentations. It is what Phase 1 replaces.

### Page 1 — Presentation feedback + intake

**Q1: ABOUT YOU** (Contact Info question type — captures First Name + Last Name)

**Q2: Contact Information** (Contact Info question type — captures Email + Phone + State of Residence)

**Q3: AGENCY (please choose from the drop down)**
- Type: dropdown
- Options: Architect of the Capitol, DC Courts, ► DC Courts: Court of Appeals, ► DC Courts: Superior Court, ► DC Courts: US Tax Court, [...full list, ~80 values, hierarchical with ► glyphs]

**Q4: How would you rate the effectiveness of the speaker?**
- Options: Excellent, Good, Average, Needs work
- ⚠ FEEDBACK QUESTION — pending Chris's decision on whether to keep

**Q5: Was the workshop content informative?**
- Options: Helpful, Neutral, Needs work
- ⚠ FEEDBACK QUESTION — pending Chris's decision

**Q6: Would you like to take advantage of a complimentary pre-retirement review? (recommended for those within ten years of retirement)**
- Options: Yes, No
- This is the qualifying question — "Yes" → continues to Page 2, "No" → likely ends form
- Maps to Salesforce Survey_Monkey_Eval_Type__c

**Q7: Any Additional Comments or Questions**
- Type: open text (Eval Comments)
- Maps to Salesforce Eval_Comments__c

### Page 2 — Qualification (only shown if Q6 = Yes)

> Note text: "NOTE this information is private and confidential"

**Q8: How many years until you plan to retire?**
- Type: single textbox (numeric expected)

**Q9: What is your age?**
- Options: 59 1/2 or over, 55 - 59, 50-54, 40-49, below 40

**Q10: Are you separating from Federal service within the next two months (or are you already separated)?**
- Options: YES, NO

**Q11: Are you married?**
- Options: Yes, No, DIVORCED, WIDOWED
- ⚠ Note: case inconsistency in original form (Yes/No vs DIVORCED/WIDOWED)

**Q12: Are you maxing out your TSP/401K/403B/457 contributions?**
- Options: YES, NO, "If NO what percentage are you contributing?" (text input revealed if NO)

**Q13: Are you regularly contributing money elsewhere (brokerage acct, savings, credit unions, IRA, Roth IRA etc)?**
- Options: YES, NO

**Q14: Which category best describes your TSP balance.**
- Options: Over $1 million, $600k - $1 million, $350k - $600k, Under $350k

**Q15: Please tell us anything additional you wish to add - ex, your areas of concern/focus for this meeting? (debt consolidation, investments, retirement, etc...)**
- Type: comment box
- Maps to Salesforce Re_screening_Comments__c

---

## FORM 2 — Pre-Consult Form (Survey ID 505221864) — NOT IN PHASE 1 SCOPE

This is the form sent to people after they request a consultation. It re-asks the qualification questions (presumably for re-verification before the advisor call).

> Note text: "NOTE this information is private and confidential"

**Q1: How many years until you plan to retire?** — single textbox

**Q2: What is your age?** — same options as Form 1 Q9

**Q3: Are you separating from Federal service within the next two months (or are you already separated)?** — same as Form 1 Q10

**Q4: Are you married?** — same as Form 1 Q11

**Q5: Are you maxing out your TSP/401K/403B/457 contributions?** — same as Form 1 Q12

**Q6: Are you regularly contributing money elsewhere (brokerage acct, savings, credit unions, IRA, Roth IRA etc)?** — same as Form 1 Q13

**Q7: Which category best describes your TSP balance.** — same as Form 1 Q14

**Q8: Please tell us anything additional you wish to add - ex, your areas of concern/focus for this meeting?** — same as Form 1 Q15

---

## Field-to-Salesforce mapping (Form 1)

Per the audit, these are the Salesforce fields the eval form's answers populate:

| Form question | Salesforce field |
|---|---|
| Q1 First Name | FirstName |
| Q1 Last Name | LastName |
| Q2 Email | Preferred_Email__c (or standard Email) |
| Q2 Phone | Phone |
| Q2 State | State |
| Q3 Agency | Federal_Agency__c |
| Q6 Pre-retirement review? | Survey_Monkey_Eval_Type__c |
| Q7 Comments | Eval_Comments__c |
| Q8 Years to retire | Sofa_Consultation_Survey_Q12__c |
| Q9 Age | Sofa_Consultation_Survey_Q4__c |
| Q10 Separating | Sofa_Consultation_Survey_Q15__c (and Separating_from_Federal_Service__c) |
| Q11 Married | Sofa_Consultation_Survey_Q5__c |
| Q12 Maxing out | Sofa_Consultation_Survey_Q8__c |
| Q12 % contributing | Sofa_Consultation_Survey_Q8_Other__c |
| Q13 Contributing elsewhere | Sofa_Consultation_Survey_Q9__c |
| Q14 TSP balance | Sofa_Consultation_Survey_Q10__c |
| Q15 Areas of concern | Re_screening_Comments__c |

⚠ Note: SurveyMonkey question numbers ≠ Salesforce field numbers. The Salesforce field naming is its own scheme that doesn't match SurveyMonkey's numbering. This is confusing but it's how the system was built. The new form must match these answer values exactly so the existing Salesforce Flow `Rank_Update_On_Lead_Based_On_Sofa_Consultation_Survey` continues to compute Rank correctly.

---

## Critical: do NOT change answer option wording

The Salesforce Flow that computes Rank reads these exact strings. If we ship a form that returns "Yes" instead of "YES" for the separating question, scoring breaks. Match the original case sensitivity until Phase 2 cleans it up.

Specifically preserve:
- "59 1/2 or over" (with space, not hyphen)
- "55 - 59" (with spaces)
- "50-54" (no spaces)
- "40-49" (no spaces)
- "below 40" (lowercase)
- "YES" / "NO" (uppercase) for binary qualification questions
- "Over $1 million", "$600k - $1 million", "$350k - $600k", "Under $350k"
- "DIVORCED", "WIDOWED" (uppercase) for marital status — but Yes/No (we'll fix to Married/Single in Phase 2)

This case sensitivity is ugly but it's what the Flow expects. Don't normalize until the Flow is updated.