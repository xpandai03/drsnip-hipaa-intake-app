# Missing subscriber details on registration documents: investigation

**Date:** 23 September 2026
**Reported by:** Jennifer Riley, forwarded by Jeff (23 Sep)
**Status:** Root cause confirmed. Nothing has been fixed or deployed. No chart has been repaired.

This report contains no patient information. It gives counts and presence flags only. The chart reference from the forwarded email was used only inside authorised systems, and every scratch file containing it has been deleted.

---

## 0. Summary

A staff member entered the subscriber's name and date of birth during registration, and the app saved them. They are still missing from the document on the DrChrono chart.

The fields are dropped at the hand-off from the app to n8n. The n8n workflow that builds the DrChrono document has no place for them either. So **no registration document has ever included the subscriber's name or DOB**, for any patient, since launch in mid-June.

The defect is deterministic. It is not related to the recent releases or the database capacity problems.

---

## 1. Confirmed facts and evidence gaps

### Confirmed

| # | Fact | Evidence |
|---|---|---|
| F1 | The form collects the insured's (subscriber's) first name, last name, DOB and employer for the primary policy. It collects the same for the partner's policy when coverage is "Both". | `Home.tsx:158-169`, `:500-564` |
| F2 | The subscriber name and DOB are **not required**. Validation checks only the company and ID number. | `Home.tsx:601-608` |
| F3 | There is **no "Other" coverage option**. The only options are Own, Partner's, Both and No Insurance. | `Home.tsx:37-42` |
| F4 | `/api/submit` keeps every form key (Zod `.passthrough()`) and stores it in `submissions.raw_payload`. Only the card image bytes are stripped. | `api/submit.ts:82`, `:189` |
| F5 | `buildRegistrationPayload` sends n8n **only** coverage status, company, member ID, group number and the cards. The insured fields and the whole partner policy are dropped. | `lib/n8n/payload.ts:70-77` (type), `:286-291` (builder) |
| F6 | The live n8n "Parse & Normalize" node maps only status, provider, member ID, group ID and the cards. | Live workflow `H2HihkGKntbfRNcK`, node code lines ~131-135 |
| F7 | The live n8n "Generate Registration PDF" node's Insurance section prints only coverage, company, ID, group and the card filenames. | Live node code lines 289-295 |
| F8 | No node in Registration v2 references insured, subscriber or partner fields. That includes the DrChrono upload and the Sheets audit. No structured insurance or subscriber data is written to DrChrono. | Full-workflow text search |
| F9 | This has always been the case. `git log -S insuredFirstName` touches only the form (718acb4) and the app-side PDF template (2d612f7), never `payload.ts`. All 12 registration snapshots in `n8n-rollback/`, from July to September, contain 0 insured or subscriber references. | Git history, rollback files |
| F10 | On 23 Sep there were 4 "Partner's Insurance" registrations. They arrived between 15:36 and 22:53 UTC. All 4 were processed successfully by n8n, each within 4 seconds. 3 of the 4 had subscriber name and DOB stored; 1 did not. All Registration v2 executions on 23 Sep ended in `success`. | Read-only DB aggregates; n8n execution metadata (status and times only) |
| F11 | The console CSV export does include insured and partner-insured columns, so staff can see the stored values. | `api/submissions/export.ts:249-259` |

### Evidence gaps

- **The specific submission was not confirmed against the chart.** `submissions.n8n_response_body` stores the DrChrono *patient* ID, not the chart reference in Jennifer's email. Matching the two would need a DrChrono API lookup, which would mean building a new temporary workflow. This task did not authorise that. Two background lookups keyed on the chart reference returned nothing and were stopped.
- The conclusion does not depend on this match: F5–F8 apply to every registration. Among 23 Sep Partner's Insurance registrations, 3 of 4 had values stored and all 4 were delivered without them. So the affected case is one of those 3, or it was delivered without the values in the same way.
- **The DrChrono document itself was not opened.** Doing so would expose PHI. The document's content is inferred from the live template (F7) and from the synthetic render (§4).
- **Past n8n execution data was not inspected.** This instance does not keep execution payloads, and raw logging was not enabled, as instructed. Only execution status and times were read.

---

## 2. Field-by-field trace

"Kept" means the value survives that stage.

| Field (form key) | Form (`Home.tsx`) | Required? | Stored in `raw_payload` | n8n payload (`payload.ts:286`) | n8n normaliser | DrChrono PDF | Sheets audit |
|---|---|---|---|---|---|---|---|
| `insuranceCoverage` | yes | yes | kept | `insurance.status` | `insurance_status` | "Current insurance coverage" | yes |
| `insuranceCompany` | yes | yes (if insured) | kept | `insurance.provider` | `insurance_provider` | "Insurance Company" | yes |
| `insuranceIdNo` | yes | yes (if insured) | kept | `insurance.memberId` | `insurance_member_id` | "ID No." | yes |
| `insuranceGroupNo` | yes | no | kept | `insurance.groupId` | `insurance_group_id` | "Group No." | yes |
| `insuredFirstName` | yes | **no** | kept | **dropped** | — | **absent** | absent |
| `insuredLastName` | yes | **no** | kept | **dropped** | — | **absent** | absent |
| `insuredDob` | yes | **no** | kept | **dropped** | — | **absent** | absent |
| `insuredEmployer` | yes | no | kept | **dropped** | — | **absent** | absent |
| `partnerInsuranceCompany` ("Both") | yes | yes | kept | **dropped** | — | **absent** | absent |
| `partnerInsuranceIdNo` ("Both") | yes | yes | kept | **dropped** | — | **absent** | absent |
| `partnerInsuranceGroupNo` ("Both") | yes | no | kept | **dropped** | — | **absent** | absent |
| `partnerInsured{First,Last}Name`, `partnerInsuredDob`, `partnerInsuredEmployer` | yes | **no** | kept | **dropped** | — | **absent** | absent |
| Partner card front/back ("Both") | yes | no | image bytes stripped; not in n8n payload | not sent | — | absent | absent |

Related, but not on the DrChrono path: the app's own registration PDF template (`lib/pdf/templates/registration.ts:73-76`) *does* include the insured fields, but it has no `partner*` fields. That PDF is not what gets uploaded to DrChrono.

---

## 3. Root cause

**Confirmed.** The registration integration contract never included subscriber details, at either end:

1. **App side.** `buildRegistrationPayload` (`lib/n8n/payload.ts:286-291`) and its type `RegistrationN8nPayload.insurance` (`:70-77`) forward four insurance scalars and nothing else. The insured and partner fields are collected and stored, then silently dropped.
2. **n8n side.** "Parse & Normalize" and "Generate Registration PDF" have no inputs or rows for these fields. Fixing only the app would not change the document.

**Contributing factors:**

- **No required-field check.** Staff can move past the insurance step without entering a subscriber name or DOB, so some records never have them (see §5).
- **The form has no "Other" option.** Jennifer's requirement covers "partner's insurance or other". Today, "Other" can't be selected, so a non-spouse subscriber (such as a parent or other policyholder) has to be entered under "Partner's Insurance" or "Own Insurance".

---

## 4. Synthetic reproduction and document rendering

**Harness:** local only, with synthetic markers `Zqsubfirst`, `Zqsublast` and `1985-07-04`. It runs the repo's `buildRegistrationPayload`, then the **live** normaliser code, then the **live** PDF node code (executed locally, byte-for-byte). It writes the PDFs locally and searches their text.

Nothing was sent to production, n8n or DrChrono.

| Scenario | Stored (simulated) | In n8n payload | After normaliser | In rendered PDF |
|---|---|---|---|---|
| Partner's Insurance, full subscriber | yes | no | no | **no** |
| Own Insurance, insured filled | yes | no | no | **no** |
| Both, partner-policy subscriber | yes | no | no | **no** (partner company and ID are also absent) |
| Partner's Insurance, name missing | partial | no | no | no; the form accepted it |
| Partner's Insurance, DOB missing | partial | no | no | no; the form accepted it |

**Control:** the same search found the synthetic company and member ID in every PDF, so the search method is valid.

**Regression tests added (local only, not committed):** `Intake-form/api/_test/registration-subscriber.test.ts`. Three DB-free tests are marked `todo`, so they report without failing CI until the fix lands:

- Partner's Insurance: subscriber name and DOB reach the n8n payload. **Fails today**, which confirms the defect.
- Both: the partner policy and its subscriber reach the payload. **Fails today.**
- No Insurance: stale hidden subscriber fields are *not* forwarded. Passes today; it guards the fix.

Run with: `node --import tsx --test api/_test/registration-subscriber.test.ts`. The fix PR should remove `todo` and add the file to `test:api`.

---

## 5. Impact (bounded, since launch, 16 Jun – 23 Sep 2026)

Counts come from sequential read-only aggregate queries.

| Coverage | Registrations | Subscriber name and DOB stored | Delivered to DrChrono | Delivered document containing them |
|---|---|---|---|---|
| Partner's Insurance | 229 | 222 | 226 | **0** |
| Both (partner policy) | 12 | 12 | all | **0** (the partner company and ID are missing too) |
| Own Insurance | 1,494 | 1,356 (insured fields) | most | **0** |

- **Highest priority: Partner's Insurance (222) and Both (12).** The subscriber is a different person from the patient, and billing depends on those details.
- **Own Insurance** documents also omit the insured fields. The insured is usually the patient, whose name and DOB are already on the document, so the practical impact is lower. It still counts where someone other than the patient holds the policy.
- **7 Partner's Insurance registrations have no stored subscriber name or DOB.** The optional form let staff or patients skip those fields.
- **4 registrations since 16 Sep have a blank coverage value** (2 were delivered). This is unrelated to the omission but worth a separate check.

---

## 6. Did recent changes or crashes contribute?

| Candidate | Classification | Reason |
|---|---|---|
| Missing mapping in payload builder or n8n template | **Confirmed** (sole cause) | F5–F9; deterministic since launch |
| v88/v89 reporting releases (Sep) | **Unsupported** | They touched reporting and migrations only; `payload.ts` and the registration workflow are unchanged |
| Registration v2 edits (latest 16 Sep) | **Unsupported** | Every snapshot from July to September lacks the fields; the omission predates them |
| Database capacity starvation and crashes | **Unsupported** | The 23 Sep Partner's Insurance submissions all stored and processed with `success` in ≤4 s; a crash cannot remove fields that were never mapped |
| Staff input error | **Plausible for 1 of 4 on 23 Sep** (no values stored) | Not true for Jennifer's case as she reports it, and irrelevant to the other 3 |

---

## 7. Smallest proposed fix (prevention, not yet implemented)

These steps must ship together. Fixing one end alone changes nothing visible.

1. **App → n8n payload** (`lib/n8n/payload.ts`):
   - Add `subscriber { firstName, lastName, dob, employer }` to `insurance`, sent only when coverage is not "No Insurance".
   - Add `secondary { provider, memberId, groupId, subscriber {…} }`, sent only when coverage is "Both".
   - Extend `RegistrationN8nPayload`.
2. **n8n Registration v2.** This needs an authorised workflow change: take a snapshot to `n8n-rollback/` first, then use a partial update.
   - Normaliser: map `insurance_subscriber_*` and `secondary_*`.
   - PDF: add "Subscriber name", "Subscriber DOB" and "Subscriber employer" rows, plus a "Secondary (partner) policy" block.
   - Sheets audit: add these as new columns only if wanted. Follow the `defineBelow` / `schema: []` rule.
3. **Form validation** (`Home.tsx:601-608`):
   - Require the subscriber's first name, last name and DOB when coverage is "Partner's Insurance".
   - Require the partner subscriber's name and DOB for "Both".
   - Mirror these checks server-side in `/api/submit`, so submissions from the embed, partials or other clients can't bypass them.
4. **"Other" option:** a product decision for Jeff and Jennifer. Either add "Other (another policyholder)" and treat it like "Partner's Insurance", or confirm staff should use "Partner's Insurance" for any non-self policyholder. Do not add it without that decision.
5. **Tests:** remove `todo` from `registration-subscriber.test.ts`. Add:
   - a validation test for the server-side requirement;
   - a PDF-render test on a synthetic subscriber, like the harness in §4, run against the snapshot of the new node code.

---

## 8. Historical remediation (separate from the fix; needs its own authorisation)

- **Repairable from retained data: about 222 Partner's Insurance and 12 Both registrations.** The values sit in `submissions.raw_payload`. There are two options:
  - **(a)** Regenerate and upload a corrected registration document, or a short "Subscriber details addendum", for each affected chart. This needs a one-off, authorised n8n or DrChrono run with a dry-run list and a count check.
  - **(b)** Lower effort: staff read the values from the console CSV export (F11) and key them into DrChrono's insurance section. This works for the reported chart now, without engineering.
- **Needs staff to re-collect: the 7 Partner's Insurance registrations with no stored subscriber details.** Plus any case where staff say values were entered but none were stored. On 23 Sep, 1 registration fell into this group.
- **Own Insurance:** fix it going forward; backfill only when staff flag a case where the policyholder isn't the patient.
- **The reported chart has not been repaired.** Remediation must not start until the fix is live, so repaired and new documents come from the same template.

---

## 9. Constraints honoured

- No test patients were submitted, no intakes replayed, no workflows altered, no documents uploaded and no records changed.
- No messages were sent to anyone.
- The database was queried read-only, one query at a time, each with a timeout. The chart reference was kept out of this report, and scratch files containing it were deleted.
- No raw execution logging was enabled.
- No infrastructure was changed.
- No commit, push or deploy.

---

## 10. Plain-English update for Raunek

> When staff register a patient on a partner's insurance, the app *does* save the subscriber's name and date of birth. But the step that hands the registration to DrChrono has never passed those details along, and the DrChrono document template has no space for them. So they've been missing from every registration document since launch, not just Jennifer's patient. The form also doesn't currently require them, and it has no "Other" insurance option. It isn't connected to the recent releases or the server crashes.
>
> About 230 partner or dual-insurance registrations are affected. For almost all of them, the details are still stored, and staff can see them today in the console CSV export. For 7, they were never entered and need to be re-collected.
>
> The fix covers the data hand-off, the document template and the required fields. It's scoped but **not built or shipped**. Repairing past charts is a separate step we'd do after the fix, and **the reported chart hasn't been repaired yet**. In the meantime, staff can copy the details from the export into DrChrono.
