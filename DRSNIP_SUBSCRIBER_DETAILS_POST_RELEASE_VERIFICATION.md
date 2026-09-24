# Subscriber details: post-release verification

**Date:** 23 September 2026, last check 23:50 UTC. All times are UTC.
**Scope:** read-only verification and investigation. Nothing was committed, pushed or deployed, no workflow or form was changed, and no patient record was touched.

**The incident is not fully resolved.**
- Jennifer's chart has not been repaired.
- No real post-release delivery has been observed.
- The legacy Jotform path is still active and unfixed.
- Names containing non-ASCII characters are still altered on the document.

This report contains no patient information. It uses presence and absence, match and no-match, counts, and internal execution and submission IDs only.

---

## 1. Jennifer's reported case: **matched**

**Method.** Registration v2 keeps successful execution data (`saveDataSuccessExecution: all`), with a retention window of 10 Sep – 23 Sep.
- I searched those retained executions **in-process** for the chart reference from the forwarded email, newest first, stopping at the first match. Only the matching execution ID and the node names were printed.
- Consultation v2 (173 executions) was searched in full: **no match**.
- The one legacy Jotform run had already been checked earlier: **no match**.
- No DrChrono API call was needed, and no patient directory was scanned.

| Question | Finding |
|---|---|
| Source path | **Custom app → Registration v2** (`H2HihkGKntbfRNcK`), execution **6788**. The chart reference appears only in the output of **DrChrono: Create Patient**, so this run created the chart. Not Jotform. |
| Submission | `a3b4d5f6-c71d-44a3-bde6-99f74ab25d6a` |
| Timing | Submitted and stored 23 Sep 22:12:06. n8n ran from 22:12:06 to 22:12:10. The bridge write-back was recorded at 22:12:07; `n8n_status = success`. |
| Coverage | Partner's Insurance |
| Source and stored submission (`raw_payload`) | Subscriber (insured) first name **present**, last name **present**, DOB **present**, employer absent. No partner-policy fields (none apply under Partner's Insurance). |
| What the app sent n8n | `insurance` = {status, provider, memberId, groupId} only. **No subscriber fields**; this was before the release. |
| Generated document | Retained inline in the execution (3 pages). It contains the stored company, member ID and group number. It does **not** contain the subscriber's first name or DOB, and it has **no policyholder or insured row at all**. The subscriber's last-name string appears only where the patient's own name is printed (header, Patient Information, page footers), not as subscriber data. |
| Delivery | **DrChrono: Upload Registration PDF** ran once with this binary and returned a document ID, with no error. No card upload (no cards). |
| Evidence limit | The document was **not** re-downloaded from DrChrono. The evidence is the binary that the successful upload sent, taken from the same execution. |
| Recoverability | **Sufficient for a later repair.** The stored name and DOB, plus the current payload builder and the deployed template, would regenerate a correct document. The employer was never given. **The chart is unrepaired.** |

This is the pre-release defect exactly as diagnosed: the details were entered and stored, but dropped between the app and the document. The release fixed that for new submissions only.

---

## 2. Live form behaviour on intake.drsnip.com, with no submission

**Method.**
- Headless Chromium drove the production form with synthetic values.
- **Every non-GET request was aborted at the browser.** The only ones attempted were the drop-off beacon `POST /api/registration-partial` and Matomo analytics; both were aborted. **`/api/submit` was never requested.**
- The run reached the Review step and then stopped. **Submit was never clicked**, and Enter was never pressed.
- The served bundle is the v90 build (`index-Bg-ilu6V.js`).
- The same script run against a local dev server of the released commit gave **identical** results.

**Result: 34 of 35 checks pass.**

| Check | Result |
|---|---|
| Steps 1–3 usable with synthetic data | Pass |
| Partner's: first name, last name and DOB marked required; employer optional; hint "The partner who holds this policy." | Pass |
| Partner's: Continue blocked with company and ID only, blocked until DOB, blocked for a whitespace-only name, enabled when complete | Pass |
| Partner's: DOB shows the picked date exactly (July 4, 1985) | Pass |
| Review reached; Back returns with all partner values intact | Pass |
| Partner's → Both: primary set cleared (it held the partner's policy); primary relabelled "Your insurance"; partner holder required and patient's own holder optional | Pass |
| Both: blocked until the partner holder's name and DOB are given; enabled with the patient's own holder left blank | Pass |
| Both → Review → Back: own and partner values stay in their own sections | Pass |
| Both → Partner's: patient's own policy cleared; partner-section values **not** carried into the primary set; blocked until re-entered | Pass (safe) |
| Partner's → Own: partner's details cleared; insured fields optional; usable with company and ID | Pass |
| Own → No Insurance → Own: values restored. Partner's → No Insurance → Own: partner policy not relabelled as the patient's own | Pass |
| No page errors | Pass |
| **A notice when values are cleared on a coverage switch** | **Fail: usability defect** |

**Usability defect (documented; production not changed).** Values that have been cleared can't lead to an incomplete form being accepted, because Continue stays disabled until the required fields are refilled. But the clearing is **silent**, which causes two problems:
- **Partner's → Both:** a staff member's partner entries disappear. They must re-enter them in the new "Partner's insurance" section, with no message saying why.
- **Both → Partner's:** partner details already typed in the Both section are not moved into the primary set, so they must be typed again.

Two further gaps: nothing says which required field is missing (an existing pattern across the whole form, since Continue is simply disabled), and there is no cross-session save/resume on this form.

**Suggested focused fix:**
- Show an inline notice when a switch clears values ("Partner policy details were cleared because coverage changed").
- For Partner's ↔ Both, *move* the partner policy between the primary set and the partner set, instead of clearing it. It is the same person's policy in both cases.

**Server-side validation** is covered only by the local tests (the handler returns 400 with `fieldErrors` before storage) and by the presence of the gate in the deployed server bundle. It was **not** probed in production: an unexpected acceptance would create a real chart.

---

## 3. Real post-release v2 delivery: **pending**

- The corrected workflow has been live since 23:27 and the app since about 23:31.
- **No registration of any coverage** had arrived by the last check at 23:50. The database showed 0 rows since 23:27. Registration v2, the legacy Jotform workflow and Error Notify each had 0 executions since 23:27.
- No replay, no invented patient, and no ongoing poll.

**Remaining step.** On the first real Partner's or Both registration, check each of the following, using presence and comparison only:
1. The stored `raw_payload` has the holder's name and DOB.
2. The retained Registration v2 execution has the webhook body `insurance.policyholderContract = 1` with non-empty `insured` (or `partnerPolicy.insured` for Both).
3. **Parse & Normalize** outputs `insurance_insured_*` (or `partner_insured_*`).
4. The **Generate Registration PDF** binary, which is retained inline, contains the holder's name and DOB under the correct policy heading, plus the company, ID and group number where given. For Both, each holder must sit under its own policy.
5. The upload returns a document ID for the patient that the same execution resolved.

A successful upload alone does not prove the document is correct. Step 4 is the proof. A DrChrono GET of the document would add confirmation that it was stored as sent.

---

## 4. Legacy Jotform path

### Confirmed facts

- **Workflow.** "Patient Intake — Jotform → Sheets → DrChrono" (`6warkNFZSSzuasMB`) is **active**. Its last update was 9 May, it saves all executions, and its webhook path is `job-form-submission`.
- **One run in the retention window:** execution 6763 on 23 Sep 20:30. That run created a patient, uploaded a registration PDF (document ID returned) and wrote the Sheets audit. Its coverage was **No Insurance**, and fields q32–q38 were empty. **No subscriber data was lost in that run.** It is not Jennifer's chart.
- **Source form.** Jotform `260987576842071`, "DrSnip Registration Form", account ITSnip, submitted via HIPAA submit. The alias `form.jotform.com/ITSnip/drsnip-registration-form` resolves to the same form.
- **Still linked from the website.** The **"Register Now" header button and the mobile menu on every drsnip.com page** (home, /schedule-appointment/ and /insurance-terms-glossary/ were checked) link to the Jotform alias. A separate in-page Register Now button links to `intake.drsnip.com/?source=website-registernow`, the custom app. So the legacy path is reachable site-wide, even though it received only one submission in 13 days.
- **Metadata source.** The public form definition: labels, types, options and `JotForm.setConditions`. No submissions were read through Jotform. Our Jotform connector cannot see this account; the only form it lists is a different "Dr. Snip Patient Registration" form.

### Field mapping

| Jotform ID | Exact label | Type | Shown when | Required | Meaning | Existing workflow mapping | Gap |
|---|---|---|---|---|---|---|---|
| `q31_q31_radio29` | Select your current insurance coverage | radio: Own Insurance / Partner's Insurance / Both / No Insurance (no "Other") | always | **No** | Coverage | `insurance_status` | None |
| `q32_q32_textbox30` | Insurance Company | text | Own, Partner's, Both | No | Primary company | `insurance_provider` | None |
| `q33_q33_textbox31` | ID No. | text | Own, Partner's, Both | No | Member ID | `insurance_member_id` | None |
| `q34_q34_textbox32` | Group No. | text | Own, Partner's, Both | No | Group | `insurance_group_id` | None |
| `q35_q35_fullname33` | **Insured's Legal First Name** | *full name* widget with sub-fields First Name and Last Name | **Partner's or Both** | No | Subscriber name | **dropped** | **Ambiguous**: labelled "first name" but captures first *and* last |
| `q36_q36_textbox34` | Insured's Legal Last Name | text | Partner's or Both | No | Subscriber last name | **dropped** | Overlaps with q35's last-name sub-field |
| `q37_q37_datetime35` | Insured's Date of Birth | date {month, day, year} | Partner's or Both | No | Subscriber DOB | **dropped** | Needs a zero-padded `YYYY-MM-DD` and a real-date check |
| `q38_q38_textbox36` | Insured's Employer | text | Partner's or Both | No | Subscriber employer | **dropped** | None |
| `q39_q39_fileupload37` | Upload the front and back of your insurance card(s) | file | Own, Partner's, Both | No | Cards | card URLs → download → upload | None |

### Findings

- **Is subscriber data collected?** Yes, but only for Partner's or Both.
- **Is it required?** No. Nothing on the insurance step is required, not even coverage.
- **Does the workflow drop it?** Yes. The normaliser picks q31–q34 only.
- **Does the document omit it?** Yes. The legacy PDF's Insurance section has Status, Provider, Member ID, Group ID and a card count, and nothing else.
- **"Both" collects only ONE policy.** There are no partner-policy fields, so it is unknowable whose policy q32–q34 describe, and whether the insured is the partner.

### Recommended forward fix (smallest compatible, not applied)

1. **Preferred, with no workflow change:** repoint the drsnip.com header and mobile "Register Now" button to `https://intake.drsnip.com/?source=website-registernow`, where the fixed flow lives.
   - Keep the legacy workflow **active** for stragglers and bookmarks. Retiring it is not part of this recommendation.
   - This is a website (WordPress/Astra header) change, owned by whoever manages drsnip.com.
2. **If the Jotform form must stay in use, patch the legacy workflow as well.** This is additive, following the same pattern as v2:
   - **Normaliser:**
     - `insured_first` = q35.first;
     - `insured_last` = q36, or q35.last if q36 is empty;
     - flag `insured_name_conflict` if both last names are present and differ;
     - `insured_dob` = q37 as a zero-padded `YYYY-MM-DD`, validated; if it is not a real date, show "invalid date on form", never a guess;
     - `insured_employer` = q38.
   - **PDF:** a "Policyholder (insured)" block under Insurance, rendering "Not provided" for empty values.
   - **For Both:** a row stating "This form collects one policy only. Whose policy it is was not specified."
   - **Form (clinic owned):** make q35–q37 required under Partner's and Both, and fix the q35 label or its sub-fields. Adding a second policy for Both is a larger change for the clinic to decide.

---

## 5. Name fidelity: **the document changes characters**

The earlier release record said "José → Jose" as if that were an improvement. That is **transliteration, not preservation**, and the document is not an exact record of such names.

**Cause.** The template uses the PDF standard fonts (Helvetica, not embedded) with **WinAnsiEncoding**.
- `pdfEsc` first folds accents (the NFD step added in this release).
- It then replaces every remaining character from U+0080 upward with `?`.
- WinAnsi *can* encode all of Latin-1 plus Œ œ Š š Ž ž Ÿ € and the smart quotes, but the code never uses those codes.
- Characters outside WinAnsi (Ł, Vietnamese, Cyrillic, CJK, Arabic) can't be drawn with these fonts at all.

**Synthetic test: 19 names, deployed code versus a local prototype.** The text was extracted with `pdftotext -enc UTF-8`, and the same PDFs were rendered visually with macOS PDFKit. **The visual rendering matches the extracted text in every case.**

| Name | Deployed | WinAnsi prototype |
|---|---|---|
| José, Zoë, Müller, Núñez, François, Siobhán, Šimon | accents dropped: Jose, Zoe, Muller… | **exact** |
| Øyvind, Søren, Ægir, Straße, Œuvre | **`?` substituted**: ?yvind, S?ren, ?gir, Stra?e, ?uvre | **exact** |
| O’Brien (curly apostrophe) | exact | exact |
| Łukasz, Đặng | ?ukasz, ?ang | ?ukasz, ?ang (not in WinAnsi) |
| Nguyễn | Nguyen | Nguyen (folded) |
| Ольга, 王小明, محمد | all `?` | all `?` |

The deployed code changes **18 of 19**; the prototype changes 6 of 19, all of them characters that can't be encoded. The same function prints the **patient's** name in the header and footers, so patient names are affected too. The chart's demographic fields come from the DrChrono API as UTF-8 and are not affected.

**Recommended focused correction:**
1. **Now, small:** replace `pdfEsc` with WinAnsi byte mapping. The prototype is tested locally; it NFC-normalises, emits Latin-1 and the WinAnsi extras as octal escapes, and escapes `\ ( )`. This preserves Western European names exactly. Add these synthetic names to the regression tests.
2. **For characters outside WinAnsi:** never change them silently. Either embed a Unicode TrueType font subset (Type0 / Identity-H with a ToUnicode map) for exact rendering, or, as an interim step, add a visible note next to the value: "Contains characters this document cannot display; see the intake console for the exact spelling."
3. Update the release record's claim accordingly.

---

## 6. Coverage clarification still needed (for Jennifer)

The earlier release record suggested staff "choose Partner's Insurance whenever someone other than the patient holds the policy". **That recommendation is withdrawn.**
- The form, the payload and the document all label that policy "Partner's".
- Using it for a parent, a guardian or an ex-spouse would record the wrong relationship on the document.

**Questions for Jennifer:**
1. Does "partner's insurance or other" mean a spouse or partner specifically, or **any policyholder other than the patient**, such as a parent?
2. Until the answer is in, what should staff select today when the policyholder is not the patient and not a partner?
3. If an "Other" option is added, what should it be called, and should it capture the relationship (for example parent, guardian or other) as well as the policyholder's name and DOB?

No option was added or reinterpreted.

---

## 7. Historical remediation (separate; nothing done)

- No document was replaced, regenerated or uploaded.
- Jennifer's case is recoverable from stored data (§1).
- The wider backlog is the same as in the investigation report.

---

## 8. Load and cleanup

- **Database:** 4 sequential, bounded, read-only queries through the read-only guard (`default_transaction_read_only=on`): two single-row lookups by primary key, and two aggregates over rows since 23:27. Values returned by the lookups went to a mode-600 temp file that was deleted immediately; nothing was printed.
- **n8n:** read-only execution reads.
  - The Registration v2 scan stopped after 3 executions.
  - Consultation v2 was scanned in full (173 executions).
  - Legacy execution 6763 was read.
  - **No workflow was created, changed or deleted in this task**, and no credential was created. The earlier temporary render workflow from the release is already deleted and returns 404.
- **DrChrono:** **0 API requests.**
- **Jotform:** the public form page only (metadata). No submissions were accessed.
- **Website:** 4 public page GETs.
- **Browser:** synthetic values only. All writes were aborted and **no submission** was made. The local dev server was stopped.
- **Local artefacts:**
  - No patient document, name, DOB or chart reference was written to disk, apart from the transient temp file already deleted.
  - The scratchpad holds only synthetic PDFs and screenshots, public form HTML, and workflow configuration.
  - There were no secret files to remove.
- **Unchanged:** existing workflows, credentials, global settings and form configuration.

---

## Status

| Area | Verified result | Remaining action |
|---|---|---|
| Jennifer's reported case | **Matched:** v2 execution 6788, submission `a3b4d5f6…`. Chart created 23 Sep 22:12. Name and DOB were stored but omitted from the uploaded document; recoverable. | Authorised repair: regenerate and upload an addendum for this chart. **Not repaired.** |
| Live v2 form | 34/35 checks pass on production with no submission. Required fields, blocking, policy separation and Back/edit are all correct. Server gate verified locally only. | Fix silent clearing on coverage switch; move the partner policy on Partner's ↔ Both. |
| Real v2 DrChrono document | **Pending.** 0 registrations since release (last check 23:50). | Trace the first real Partner's or Both registration through steps 1–5 of §3. |
| Legacy Jotform | **Active and unfixed.** Linked from the drsnip.com header on every page. q35–q38 (subscriber) are collected but optional, then dropped by the workflow and missing from its PDF. Both collects one policy only. | Repoint the header link to intake.drsnip.com. If Jotform stays in use: patch its normaliser and PDF, and make q35–q37 required. |
| Name fidelity | **Altered:** 18 of 19 synthetic names changed by the deployed template (accents dropped or `?`). A local WinAnsi prototype preserves 13 of 19 exactly. | Ship the WinAnsi mapping plus tests. Embed a Unicode font, or add a visible note, for the rest. |
| Historical repair | Data retained for most affected registrations. Nothing changed. | Separate authorised remediation (dry run, then addendum uploads), plus staff re-collection where nothing was stored. |

---

## What the next corrective prompt should authorise

1. **Code, tests and release** for:
   - (a) WinAnsi name preservation in `pdfEsc`, with synthetic regression names;
   - (b) a visible "cannot display" note for characters that can't be encoded;
   - (c) a coverage-switch notice, plus moving the partner policy between the primary and partner sets on Partner's ↔ Both.

   Covering: commit, push, updating PR #56, deploying the app, and a partial update of **only** Registration v2's **Generate Registration PDF** node, with a snapshot first.
2. **Legacy Jotform:** request that the drsnip.com header and mobile "Register Now" link be repointed to `intake.drsnip.com/?source=website-registernow` (a website owner action). Optionally, authorise an additive patch to `6warkNFZSSzuasMB`'s normaliser and PDF (q35–q38 mapping as in §4), with a snapshot first and **no retirement**.
3. **Real-delivery verification:** read access to the first post-release Partner's or Both execution and its submission, plus **one** read-only DrChrono GET of the resulting document, with presence checks only.
4. **Historical repair, as a separate step:** a dry-run list, then addendum uploads for affected charts starting with Jennifer's, without chart updates and without going through the live webhook.
5. **Clinic answers:** the "Other" definition (§6), and whether the Jotform form should stay live.
