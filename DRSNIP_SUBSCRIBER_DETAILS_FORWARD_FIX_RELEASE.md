# Subscriber details forward fix: release record

**Date:** 23 September 2026 (all times UTC)
**Status:** The forward fix is **live** in the app and in the Registration v2 workflow. No new Partner's or Both registration has arrived since the release, so **real DrChrono delivery has not been observed yet**. No historical document has been changed, and the chart Jennifer reported has **not** been repaired.

This document contains no patient information. Evidence is limited to counts, presence flags, version identifiers and synthetic data.

---

## 1. Root cause (from the investigation)

The problem sat in three layers, all deterministic and all present since launch:

1. **Payload.** The form stored the insured (policyholder) fields and the whole partner policy, but `buildRegistrationPayload` sent n8n only the coverage type, company, member ID and group number.
2. **Workflow.** Registration v2's **Parse & Normalize** and **Generate Registration PDF** nodes had no fields or rows for a policyholder or a second policy.
3. **Form.** The policyholder's name and DOB were never required, on the client or the server.

Full evidence is in `DRSNIP_SUBSCRIBER_DETAILS_INCIDENT_INVESTIGATION.md`.

---

## 2. Active registration paths

| Path | Status | Covered by this fix? |
|---|---|---|
| Custom app `/register` → `POST /api/submit` → `callN8nRegistration` → **[Custom App] DrSnip Registration v2** (`H2HihkGKntbfRNcK`) → DrChrono | Active. Handles effectively all registrations. | **Yes**: form, server, payload, normaliser and PDF. |
| App retry or replay | **None exists.** `api/internal/sweep.ts` reports only; it explicitly never replays, because the webhook is not idempotent. | Not applicable. |
| **Legacy: "Patient Intake — Jotform → Sheets → DrChrono"** (`6warkNFZSSzuasMB`, webhook `job-form-submission`), fed by the clinic's Jotform "DrSnip Registration Form" | **Still active.** It ran once today (a successful chart create plus a PDF upload); that is its only run in the retention window. Today's run is **not** the chart Jennifer reported (checked in-process as a boolean, with nothing printed). | **No. See §9.** Its normaliser maps only `q31`–`q34`, and its PDF has no policyholder rows. The Jotform payload carries four more insurance fields (`q35` full name, `q36` text, `q37` date, `q38` text). They were empty in today's run, and their labels can't be confirmed from this account. |
| Consultation v2, Insurance v1 | Not registration paths. | Untouched. |

**Field semantics (preserved, now written down in `lib/registration/insurance.ts`):**

| Coverage | Flat `insurance*` / `insured*` fields | `partnerInsurance*` / `partnerInsured*` fields |
|---|---|---|
| Own Insurance | The patient's own policy | Not applicable (blanked) |
| Partner's Insurance | **The partner's policy; the partner is the policyholder** | Not applicable (blanked) |
| Both | The patient's own policy (primary) | **The partner's policy (secondary); the partner is the policyholder** |
| No Insurance | Not applicable (blanked) | Not applicable (blanked) |

The patient's identity is never substituted for the policyholder, and the two policies are never merged.

---

## 3. Exact fixes

**Commit:** `f8994ca` on `fix/registration-subscriber-details`
**PR:** [#56](https://github.com/xpandai03/drsnip-hipaa-intake-app/pull/56), stacked on #55 (`feat/console-redesign-insurance-demo`, which is what production runs)

| File | Change |
|---|---|
| `Intake-form/lib/registration/insurance.ts` (new) | **One set of rules** shared by the form and the server:<br>• `policyholderErrors`: for **Partner's Insurance**, the policyholder's legal first name, last name and DOB are required. For **Both**, the *partner-policy* holder's name and DOB are required. Other coverage types stay optional. The employer field stays optional.<br>• `isValidDob`: a real `YYYY-MM-DD` calendar date between 1900-01-01 and today, checked arithmetically in UTC with no `Date` string parsing, so there is no timezone shift.<br>• `withApplicableInsurance`: blanks policy fields that don't apply to the chosen coverage.<br>• `coverageChangePatch`: clears the primary set when its owner changes between patient and partner. |
| `artifacts/intake-form/src/pages/Home.tsx` | • Required markers and a hint ("The partner who holds this policy.") on the relevant branch.<br>• The insurance step can't advance until the shared rules pass.<br>• Submit sends only the fields that apply.<br>• Switching coverage from Partner's to Own or Both clears the primary set, so the partner's details are never relabelled as the patient's policy. The owner is remembered across a detour through "No Insurance".<br>• Back and forward keep all values, as before. There is no cross-session save/resume on this form; the drop-off beacon sends only a whitelist of fields. |
| `artifacts/intake-form/src/components/MultiStepForm.tsx` | `onSubmit` can return a server message, which is shown in the error toast instead of the generic one. Existing forms still return a plain boolean. |
| `Intake-form/api/submit.ts` | For registrations only:<br>• blanks inapplicable fields;<br>• then rejects incomplete policyholder details with `400 {success:false, error, fieldErrors}` **before** the database insert and before any call to n8n;<br>• logs only the names of the invalid fields and never echoes values. |
| `Intake-form/lib/n8n/payload.ts` | Additive only. `insurance` gains `policyOwner`, `insured {firstName,lastName,dob,employer}`, `partnerPolicy {provider,memberId,groupId,insured,cardsUploaded}` (Both only, otherwise `null`) and the marker `policyholderContract: 1`. The existing status, provider, memberId, groupId and card fields are unchanged. Partner card *images* are still stored only in the console; the document says so. |
| `Intake-form/lib/n8n/registration-v2/parse-normalize.js` (new) | The deployed **Parse & Normalize** code. It adds `insurance_policyholder_contract`, `insurance_policy_owner`, `insurance_insured_*`, `partner_policy_present`, `partner_insurance_*`, `partner_insured_*` and `partner_cards_uploaded`. |
| `Intake-form/lib/n8n/registration-v2/generate-registration-pdf.js` (new) | The deployed **Generate Registration PDF** code. See the layout below. |
| `n8n-rollback/H2HihkGKntbfRNcK_2026-09-23_subscriber_pre.json` | The Registration v2 snapshot taken before the change. Scanned: no credential values, no patient data, no pinned data. |
| `Intake-form/api/_test/registration-subscriber.test.ts` | 20 regression tests; see §4. |

**Document layout (Insurance section):**
- **Coverage row.**
- **Primary policy block**, headed:
  - "Patient's own policy (primary)" for Both;
  - "Partner's policy - the partner is the policyholder" for Partner's Insurance;
  - "Patient's own policy" for Own Insurance.

  It lists Company, ID No., Group No., **Policyholder (insured) name**, **Policyholder (insured) date of birth**, **Policyholder (insured) employer**, and the card rows.
- **For Both:** a separate block, "Partner's policy (secondary) - the partner is the policyholder", with the same rows plus "Partner insurance cards: N uploaded - stored in the DrSnip intake console, not attached to this chart".
- **Missing values:**
  - **"Not provided"** when the value was sent but empty;
  - **"Not transmitted by the intake app for this submission (sent before policyholder details were included) - check the DrSnip intake console"** when the payload predates this release.
- **No Insurance or blank coverage:** exactly the old rows, with no policyholder rows.
- **Layout and text handling:**
  - A policy block and its heading are kept on one page.
  - Long names wrap.
  - PDF string delimiters are escaped as before.
  - Accents are folded (José → Jose). The old code printed `?`.

Not changed: patient matching (Disambiguate), chart create and update, the upload destination and document type, alerts (Gmail nodes), the Sheets audit (explicit `defineBelow` columns, which ignore the new keys), the error workflow and the save settings. The other 27 nodes and all connections were verified identical to the snapshot.

---

## 4. Tests and rendered-document verification

### Automated: `api/_test/registration-subscriber.test.ts`, 20 of 20 passing

Everything runs on synthetic data. The tests execute the **real** `buildRegistrationPayload` and the **real node files that were deployed**, called the way n8n calls them (`$input`, `$`, `Buffer`), and then read the text out of the PDF bytes that are produced.

| Area | Cases |
|---|---|
| DOB rules | Valid: `1900-01-01`, `2000-02-29`, `1984-02-29`, today. Invalid: `1899-12-31`, `1900-02-29`, `2023-02-30`, `2023-04-31`, month 00 or 13, the day after tomorrow, `02/03/1990`, `1990-1-5`, ISO timestamps, non-strings. |
| Required fields | Partner's missing name or DOB, whitespace-only names, invalid DOB. Both requires the *partner* holder; filling the primary insured does not satisfy it. Own, No Insurance and blank coverage are not made mandatory. |
| Stale data | Own drops stale partner fields; No Insurance drops the whole policy; owner flip clears the primary set; No-Insurance detours restore values. |
| Payload | Partner complete; Both keeps two distinct holders with no cross-leak; Own scalars unchanged; No Insurance forwards nothing; DOB passes through byte-for-byte. |
| Document | Partner name, DOB and employer rendered; Both renders two blocks in order, each with its own holder; Own keeps its rows with no partner section; No Insurance has no policyholder rows; a **legacy payload shows "Not transmitted", never the patient**; long names, punctuation and accents; a page overflow still leaves a valid PDF (loaded with `pdf-lib`) with correct "Page N of N". |
| Server | Four incomplete bodies get a `400` with exact `fieldErrors` keys, before storage, and no synthetic values echoed. |
| Retry / duplicates | One registration makes **exactly one** POST to n8n, carrying the policyholder block. No retry was added anywhere. The pre-existing `retryOnFail` on n8n's DrChrono upload nodes is unchanged. |

**Mutation check:** against the old node code, 6 document tests fail. Against the old payload builder, 10 tests fail. So these tests detect the defect.

### Full regression, typecheck and build

- `pnpm test`, run against freshly rebuilt local disposable databases: **708 tests, 683 pass, 0 fail, 25 skipped**. The 25 skips are the known attendance-fixture baseline.
- A run without the local databases fails only the database-backed auth suites, as expected; those are not failures in this change.
- `pnpm run build`, which includes a full typecheck of libs, API, form and scripts: **passes**.

### Visual inspection

Six synthetic scenarios were rendered through the real code and viewed as images using macOS PDFKit. Local poppler draws none of the text because it lacks the non-embedded Helvetica fonts; the unmodified live template renders the same way, so this is a local tooling issue and not a defect.

Confirmed on screen:
- the two policy blocks and their headings;
- bold values and italic "Not provided";
- wrapped long names;
- `Jose (Jr.) O'Brien`;
- `A & B (Holdings) "Zq"`;
- the section kept on one page;
- footers reading "Page 3 of 3".

### Inside n8n's own runtime (isolated, synthetic)

A temporary workflow was built from the **exact deployed code** of the two nodes: Webhook → Parse & Normalize → stub resolve → Generate Registration PDF → verdict. It had no credentials and no DrChrono, Gmail or Sheets nodes, and it retained no execution data. Five synthetic payloads from the real builder were sent to it. It was then **deactivated and deleted**; afterwards it returned 404 and had 0 stored executions.

| Case | Result |
|---|---|
| Partner | Valid PDF (header and EOF, 3 pages). Contract marker true; owner partner. Holder name and DOB present. |
| Both | Owner patient; partner policy present. Secondary block rendered; partner holder name and DOB present. |
| Accents | `Jose (Jr.)` rendered. |
| Own | No partner heading. |
| Legacy payload | Contract marker false. "Not transmitted" rendered. Patient's name **not** in the holder row. |

---

## 5. Release

| Step | Identifier | Verified |
|---|---|---|
| Commit | `f8994ca` | Pushed to `origin/fix/registration-subscriber-details` |
| PR | #56 (base `feat/console-redesign-insurance-demo`) | Opened before any deploy |
| Workflow snapshot (rollback point) | Registration v2 `versionId 84d75c9a-1a80-4bb1-91a8-4e83e4ce38cd` | Saved to `n8n-rollback/…_subscriber_pre.json` |
| **Workflow deploy (step 1, backward compatible)** | Registration v2 → **`1ec3ccf9-4b99-42d3-8090-4953989f6eea`**, updated 2026-09-23 23:27:03 | See the checks below |
| **App deploy (step 2)** | Fly **v90**, image `sha256:f96a4b4ad3ac…` | See the checks below |

**Workflow deploy (step 1).**
- **Precheck:** the live version was still `84d75c9a` and 0 executions were running.
- **Method:** a full-workflow PUT that changed only the `jsCode` of the two nodes.
- **Checks after deploy:**
  - `active: true`, and `activeVersionId` equals `versionId` (`1ec3ccf9`).
  - The SHA-256 of both nodes' code matches the repo files, in both the draft and the active version.
  - The other 27 nodes and all connections are identical.
  - `errorWorkflow`, `saveDataSuccessExecution: all` and `saveDataErrorExecution: all` are unchanged.
  - n8n validation: **valid**, 0 errors. The 7 warnings are pre-existing (deprecated `continueOnFail` and similar).

**App deploy (step 2).**
- **Source:** a clean `git archive f8994ca` export, so nothing uncommitted shipped.
- **Result:** both machines are on the v90 image. One is auto-stopped, which is normal.
- **Served form bundle:** `index-Bg-ilu6V.js`, identical to the local build hash. It contains the new form copy.
- **Server bundle** (on the machine): contains `policyholderContract` and the rejection gate.
- **Health checks:** `/`, `/register` and `/healthz` return 200. The Fly health check is passing; it failed for one second before the server started listening, then passed.
- **Release step:** the migration command re-ran idempotently. This change adds no new migration.

**In-flight work.**
- n8n executions already running keep the version they started with.
- The old workflow ignores the new payload fields, and the new workflow tolerates old payloads. So any order, and any execution that spans the switch, stays compatible.
- The app's shutdown drain logged `draining 0 in-flight bridge call(s)` / `remaining:0, timed_out:false`.
- Intake was not disabled at any point.

---

## 6. Production verification

| Check | Result |
|---|---|
| Registration page loads | `/register` returns 200 and serves the new bundle |
| Conditional required fields | In the served bundle and covered by the tests. **Not exercised by clicking through production.** No browser session was run, to avoid any risk of a real submission. |
| Server gate | In the server bundle. **Not probed live.** A POST to production would create a real chart for a synthetic patient if the gate were faulty. |
| Deployed handoff | The server bundle contains the new payload blocks |
| Active workflow mappings and template | Code hashes match the repo in the active version |
| Intake health since release | Checked 23:27–23:34 UTC (last check).<br>• Registration v2: 0 executions; Consultation v2: 0; Error Notify: 0.<br>• App: 0 policyholder rejections logged; 0 errors after the restart.<br>• Last sweep before the release: `failed_24h: 0` (1 stuck and 1 notification problem, both pre-existing). |
| Live Partner's or Both registration since release | **None arrived** (read-only query: 0 registrations of any type since 23:27). |

**Real DrChrono delivery: awaiting observation.** When the first Partner's or Both registration arrives, confirm the following using presence checks only:
1. The accepted submission's `raw_payload` has the holder name and DOB.
2. The Registration v2 execution, which retains data because `saveDataSuccessExecution: all`, shows `insurance_policyholder_contract = true` and non-empty `insurance_insured_*` or `partner_insured_*`.
3. The produced PDF's text contains the holder rows.
4. The upload node returned success for that execution's patient.

No long-running poll was left behind.

---

## 7. Rollback

Either half can be rolled back on its own; each version is compatible with the other.

- **App:** `fly releases rollback -a drsnip-intake-demo` to **v89**, or `fly deploy` the v89 image. The server gate and the new payload go away; the new workflow then renders "Not transmitted" for new registrations.
- **Workflow:** restore the two nodes' `jsCode` from `n8n-rollback/H2HihkGKntbfRNcK_2026-09-23_subscriber_pre.json`, the same PUT method used for the deploy. Alternatively, restore version `84d75c9a-1a80-4bb1-91a8-4e83e4ce38cd` from n8n's version history. The old nodes ignore the extra payload fields.
- **Git:** revert `f8994ca`.

---

## 8. Remaining clarification: "Other"

Jennifer asked for the requirement to apply to "partner's insurance **or other**". The form's options are Own, Partner's, Both and No Insurance; **there is no "Other"**, and none was invented. Things to confirm with Jennifer:
- Should there be an "Other policyholder" option, for example a parent or an ex-spouse?
- What should it be called?
- Should it behave like Partner's Insurance, with the policyholder's name and DOB required?

The rules module makes it a one-line addition once the meaning is agreed. Until then, staff should choose **Partner's Insurance** whenever someone other than the patient holds the policy, which now enforces and delivers the policyholder details.

---

## 9. Not covered: the legacy Jotform path

`Patient Intake — Jotform → Sheets → DrChrono` is still active and has the same omission. Its PDF never lists the policyholder, and its normaliser drops Jotform questions `q35`–`q38`.

It was **not changed** in this release, for two reasons:
- The field meanings can't be confirmed. The clinic's form isn't visible to this Jotform connector, and two of the four fields are plain text boxes.
- Guessing labels onto a medical document would be worse than leaving them off.

To close it, get the question labels for `q35`–`q38` from the clinic's Jotform account, or retire that form if staff no longer use it (it ran once in the retention window).

---

## 10. Historical remediation (separate; not done)

- **Nothing was regenerated or uploaded.** No historical chart or document was touched.
- **Whether saved data can support a later repair:** yes, for most affected cases. `submissions.raw_payload` holds the holder name and DOB for about 222 of 229 Partner's Insurance registrations and all 12 Both registrations (figures from the investigation). The 7 Partner's registrations with nothing stored need staff to re-collect the details.
- **Compatibility of this release with that repair:**
  - Feeding a stored `raw_payload` through the **current** `buildRegistrationPayload` and the deployed node code produces a correct document. `withApplicableInsurance` also discards stale hidden fields that older submissions stored.
  - A repair should upload an addendum, or a clearly labelled replacement, and should not trigger chart create or update. It needs its own authorised dry run, and it must not go through the live webhook, because the webhook is not idempotent.
  - From this release on, new `raw_payload` rows no longer contain inapplicable, stale policy fields, which is cleaner for any later export.
- **Jennifer's reported chart** is still **unmatched and unrepaired**. The submission ID was never linked to the chart reference, because the database stores the DrChrono patient ID and not the chart ID. Staff can meanwhile read the stored values from the console CSV export.

---

## Answers

1. **Is the forward fix live?** Yes. Registration v2 has been running version `1ec3ccf9` since 23:27 UTC, and the app has been on Fly v90 (`f8994ca`, PR #56) since about 23:31 UTC. Both were verified against the repo.
2. **What has actually been verified?**
   - The deployed configuration: workflow code hashes, the active version, structural validity, the served form bundle, the server bundle, and health.
   - The synthetic end-to-end path, both in the test suite and inside n8n's own runtime: the real app payload, through the real deployed node code, to a PDF that contains the policyholder's name and DOB, with Both kept distinct and legacy payloads marked honestly.
   - The full regression suite, the typecheck and the build.
3. **Is real DrChrono delivery confirmed?** **No, it is awaiting observation.** No registration has arrived since the release.
4. **What remains before Raunek can send an accurate resolution update?**
   - Observe one real Partner's or Both registration end to end, using the §6 checklist.
   - Get Jennifer's answer on "Other" (§8).
   - Decide what to do about the legacy Jotform path (§9).
   - Authorise and run historical remediation separately, including Jennifer's chart (§10).

   It is accurate to say today that new registrations are fixed and deployed. It is **not** yet accurate to say that delivery to DrChrono has been seen working, or that past charts have been repaired.
