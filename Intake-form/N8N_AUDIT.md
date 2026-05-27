# DrSnip n8n Workflow Audit

**Author:** Claude (read-only audit)
**Date:** 2026-05-27
**Scope:** Pre-cutover audit of the two production n8n workflows that ingest DrSnip patient submissions into DrChrono. No modifications were made; no test executions were triggered.
**Source of truth:** Live n8n instance at `https://n8n-drsnip.fly.dev` queried via n8n-mcp v2.56.0.

> **PHI note.** Execution history was inspected to capture payload *shape* only. No patient identifiers, DOBs, addresses, member IDs, or other PHI are reproduced in this document. Where a sample value is needed, a synthetic placeholder is used.

---

## 1. Executive summary

| Item | Value |
| --- | --- |
| DrSnip workflows found | **5** total — 2 active production, 3 archived/inactive demos |
| Primary workflows | `6warkNFZSSzuasMB` Patient Intake (Registration), `xY1NOVVCflSyEme6` Consultation Intake |
| Total nodes across primary workflows | **33** (21 Registration + 12 Consultation) |
| 30-day success rate | Registration **100%** (67/67), Consultation **100%** (64/64) — see §7 for nuance |
| Companion workflows (reconciliation, error notifier, refresh worker) | **None found** |
| Shared credentials | `DRSNIP-CHRONO` (DrChrono OAuth2) + `Google Sheets account` — both used by both workflows |
| Hosting | Fly.io self-hosted (`fly-region: ord`) per request headers |
| n8n-mcp connectivity | Healthy, API URL `https://n8n-drsnip.fly.dev` |

**Top 3 risks (preview — full list in §8):**
1. **Hardcoded JotForm HIPAA API key in workflow JSON**, in two `Download File` nodes (Registration and Consultation). This is the `APIKEY` header / `apiKey` query value used to pull insurance cards and consultation PDFs from `hipaa.jotform.com`. Should be a credential, not a literal.
2. **Consultation workflow silently 200-OKs on "no match"** — when strict-match fails, the webhook responds with `success: false` but the workflow finishes "success" in n8n's eyes. No alert, no Sheets row, no human in the loop. A real submission can be lost into the void of an OK response.
3. **No reconciliation workflow exists** despite the Phase 1 memory implying one. There is no nightly job verifying that DrChrono actually contains a patient/document for each n8n execution. Webhook-miss / DrChrono 5xx silent failures will not be detected.

**Recommended PDF strategy for the new custom app:** **n8n generates the PDF itself from form data**, exactly the way the Registration workflow already does (Option 3). One-line reason: the in-process PDF builder is already HIPAA-safe, dependency-free, and would let us delete the only JotForm-coupled call in the Consultation workflow at the same time as cutover.

---

## 2. Instance overview

n8n instance hosted on Fly.io. Health check returns `status: ok`, `apiUrl: https://n8n-drsnip.fly.dev`, mcp version 2.56.0. All workflows live in a single personal project: **"Jeffery Cho \<it@drsnip.com\>"** (project ID `1eqm2b4PJgnu0Iij`). The same project owns both credentials.

### Full workflow inventory

| ID | Name | Active | Archived | Nodes | Created | Updated |
| --- | --- | --- | --- | --- | --- | --- |
| `6warkNFZSSzuasMB` | Patient Intake — Jotform → Sheets → DrChrono | ✅ | – | 21 | 2026-04-10 | 2026-05-09 |
| `xY1NOVVCflSyEme6` | Consultation Intake | ✅ | – | 12 | 2026-04-15 | 2026-04-15 |
| `8sbQi1KyJ0MxCmQE` | Connor Demo - Draft Generator | – | ✅ | 5 | 2026-04-16 | 2026-04-16 |
| `dVfmO3CpGq3LHjwH` | Connor Demo - Approve Handler | – | ✅ | 4 | 2026-04-16 | 2026-04-16 |
| `ZkDATn2rB3zrWo5Q` | Connor Demo - Reject Handler | – | ✅ | 2 | 2026-04-16 | 2026-04-16 |

The three "Connor Demo" workflows are unrelated to patient intake (they appear to be a separate human-in-the-loop demo workflow set), are inactive, and are archived. They are out of scope.

**The two primary workflows for Phase 2 cutover are the two active workflows above.**

### Credentials

| Credential ID | Name | Type | Used by |
| --- | --- | --- | --- |
| `vCwf0HNhIwA3cFV1` | `DRSNIP-CHRONO` | `oAuth2Api` | both primary workflows |
| `hQTs0UCcXWEtQ3j0` | `Google Sheets account` | `googleSheetsOAuth2Api` | both primary workflows |

The DrChrono credential was last refreshed `2026-05-26T05:23:28Z` (an OAuth refresh during execution 283). Sheets credential last refreshed `2026-05-27T14:21:21Z`. Both refresh paths are exercised regularly; OAuth health is good.

**No DrChrono refresh-token-worker / standalone auth maintainer workflow exists** — n8n's built-in OAuth2 credential type handles the refresh inline.

**Not a credential:** the JotForm HIPAA API key. It lives as a literal string inside two HTTP Request nodes (see §3.5 and §4.4). This is an audit finding.

---

## 3. Registration workflow — deep audit

**ID:** `6warkNFZSSzuasMB`
**Name:** "Patient Intake — Jotform → Sheets → DrChrono"
**Trigger count:** 1 (single Webhook trigger)
**Node count:** 21
**Version:** `a6abc18d-b663-4db8-8b59-d0b40807c31f`, version counter 610 (the workflow has been edited a lot)
**Last updated:** 2026-05-09

### 3.1 Trigger node

| Property | Value |
| --- | --- |
| Node | `Webhook` (type `n8n-nodes-base.webhook` v1.1, id `fe372f2b-...`) |
| Method | `POST` |
| Path | `job-form-submission` |
| Production URL | `https://n8n-drsnip.fly.dev/webhook/job-form-submission` |
| Test URL | `https://n8n-drsnip.fly.dev/webhook-test/job-form-submission` |
| Response mode | `responseNode` (the workflow's `Respond to Webhook` node sends the response) |
| Auth | **None** — public endpoint, security relies on URL obscurity. JotForm posts directly. |
| Error policy | `continueRegularOutput` (errors do not stop execution) |

### 3.2 Trigger payload shape (from execution sample)

JotForm sends `multipart/form-data` with one form field `rawRequest` containing a stringified JSON blob. The Webhook node's output exposes this under `body`:

```text
body.action            : ""
body.webhookURL        : "https://n8n-drsnip.fly.dev/webhook/job-form-submission"
body.username          : "ITSnip"
body.formID            : "260987576842071"
body.type              : "WEB"
body.formTitle         : "DrSnip Registration Form"
body.submissionID      : <jotform-submission-id>
body.rawRequest        : "<stringified JSON of every q* field>"
body.pretty            : "<label:value, label:value, …>"
body.ip                : <submitter IP>
```

`body.rawRequest` is where every real form value lives. It's a JSON string, not an object — the `Parse & Normalize` node `JSON.parse()`s it. Inside `rawRequest`, fields are keyed by JotForm's internal naming convention `q{N}_{label}{N}`:

| Normalized field | JotForm key in `rawRequest` | Notes |
| --- | --- | --- |
| `office_location` | `q3_q3_dropdown1` | "Portland" etc |
| `first_name` | `q4_q4_textbox2` | required |
| `preferred_first_name` | `q5_q5_textbox3` | optional |
| middle initial | `q6_q6_textbox4` | **DISCARDED** by Parse & Normalize |
| `last_name` | `q7_q7_textbox5` | required |
| `dob` | `q8_q8_datetime6` | object `{month, day, year}` |
| address | `q9_q9_address7` | object `{addr_line1, addr_line2, city, state, postal, country}` |
| `phone` | `q10_q10_phone8` | object `{full}` |
| `consent_hipaa` | `q11_q11_radio9` | "Yes"/"No" |
| `consent_treatment` | `q12_q12_radio10` | "Yes"/"No" |
| `email` | `q13_q13_email11` | string |
| `primary_care_physician` | `q15_q15_textbox13` | string |
| medical history Y/N | `q16…q28` | radio "Yes"/"No", 13 questions |
| `surgery_details` | `q29_q29_textarea27` | textarea, currently **DISCARDED** by Parse & Normalize — see §8.d |
| `insurance_status` | `q31_q31_radio29` | "Own Insurance" / "Other" / ... |
| `insurance_provider` | `q32_q32_textbox30` | string |
| `insurance_member_id` | `q33_q33_textbox31` | string |
| `insurance_group_id` | `q34_q34_textbox32` | string |
| (subscriber fields) | `q35–q38` | typically empty; not extracted |
| insurance card uploads | `q39_fileupload37` (array) | array of HIPAA URLs `https://hipaa.jotform.com/uploads/ITSnip/{formId}/{submissionId}/<file>` |

The Parse & Normalize node also scans `src` for any key matching `/fileupload/i` and collects all `https?://` strings — i.e. file upload extraction is robust to the question number shifting. (Other fields are not.)

Note: the workflow checks both `raw.body?.rawRequest` and `raw.rawRequest`, so it is already tolerant of either "JotForm-wrapped-in-body" or "rawRequest at the top level." That is good news for the cutover.

### 3.3 Node-by-node walk

Graph (`connections`):

```
Webhook
  → Parse & Normalize
    → Sheets: Audit Log
      → DrChrono: Search Patient
        → IF: Patient Exists?
            ├── true  → DrChrono: Update Patient ─┐
            └── false → DrChrono: Create Patient ─┴→ Resolve Patient ID
              → Generate Registration PDF
                → DrChrono: Upload Registration PDF
                  → IF: PDF Upload Failed?
                      ├── true  → Sheets: PDF Fallback Log → IF: Has Document?
                      └── false → IF: Has Document?
                        ├── true  → Code in JavaScript (fan out URLs)
                        │            → Download File (Jotform HIPAA URL)
                        │              → Fix MIME
                        │                → Valid File?
                        │                    ├── true (not image) → Sheets: Fallback Log [DISABLED]
                        │                    └── false (is image) → DrChrono: Upload Document
                        │                      → IF: Upload Failed?
                        │                          ├── true  → Sheets: Fallback Log [DISABLED]
                        │                          └── false → Respond to Webhook
                        └── false → Respond to Webhook
```

| # | Node name | Type | Role |
| --- | --- | --- | --- |
| 1 | `Webhook` | webhook | Receives JotForm POST |
| 2 | `Parse & Normalize` | function (JS) | Parses `rawRequest`, normalizes to flat shape (see §3.2) |
| 3 | `Sheets: Audit Log` | googleSheets | Appends one row per submission to `DrSnip_Intake_Sheet` (doc `1EOmhE2wcDW45MUHdF3ffLhzACRq7CBc_qlq4YkOfUbI`, gid `102925546`). **Stores PHI** — full name, DOB, email, phone, full address, insurance member ID. `continueOnFail: true` and `alwaysOutputData: true` — never blocks the workflow. |
| 4 | `DrChrono: Search Patient` | httpRequest | `GET https://app.drchrono.com/api/patients?first_name=&last_name=&date_of_birth=` using `DRSNIP-CHRONO` OAuth |
| 5 | `IF: Patient Exists?` | if | True branch when `$json.results.length > 0` |
| 6 | `DrChrono: Update Patient` | httpRequest | `PATCH https://app.drchrono.com/api/patients/{results[0].id}` with nick_name, email, cell_phone, address, city, state, zip_code |
| 7 | `DrChrono: Create Patient` | httpRequest | `POST https://app.drchrono.com/api/patients` with above fields + first_name, last_name, date_of_birth, **`doctor: 324569` (hardcoded)**, **`gender: Male` (hardcoded)** |
| 8 | `Resolve Patient ID` | function (JS) | Pulls the resulting `patient_id` from either Search or Create response, merges with original normalized payload |
| 9 | `Generate Registration PDF` | code (JS) | **Builds a PDF in-process** — pure JS, no external service, no template engine. Generates Helvetica-only minimal PDF with patient demographics, insurance, consent, medical history Q&A, and submission metadata. Output as `binary.pdf`. **HIPAA-safe** — never leaves the n8n process. |
| 10 | `DrChrono: Upload Registration PDF` | httpRequest | `POST https://app.drchrono.com/api/documents` multipart with the PDF, `patient`, `description: "Registration Intake Form"`, `doctor: 324569`, `date: $now`. `continueOnFail: true` |
| 11 | `IF: PDF Upload Failed?` | if | Branches on `$json.error` non-empty |
| 12 | `Sheets: PDF Fallback Log` | googleSheets | Appends to `PDF_Fallback` tab on the same doc with patient_id, filename, error |
| 13 | `IF: Has Document?` | if | True when `has_insurance_cards == true` (i.e. JotForm provided file URLs) |
| 14 | `Code in JavaScript` | code | Fans out 1 item per insurance card URL |
| 15 | `Download File` | httpRequest | `GET {insurance_card_url}` with hardcoded header `APIKEY: c23de1a35351ef6d98541533b21fd9b0` (the JotForm HIPAA API key). Batched (size 2, 8 s interval). `neverError: true`, `responseFormat: file`. |
| 16 | `Fix MIME` | code | Normalizes mime type from extension, sets a friendly filename |
| 17 | `Valid File?` | if | True if `mimeType` does NOT start with `image/` → routed to Sheets fallback (disabled) |
| 18 | `DrChrono: Upload Document` | httpRequest | `POST https://app.drchrono.com/api/documents` multipart with the card binary, `description: "Insurance card (Jotform intake)"`. `continueOnFail: true` |
| 19 | `IF: Upload Failed?` | if | Branches on `$json.error` non-empty |
| 20 | `Sheets: Fallback Log` | googleSheets | **Disabled (`disabled: true`)** AND references `$vars.SHEETS_DOC_ID || 'REPLACE_WITH_SPREADSHEET_ID'`. Dead node. |
| 21 | `Respond to Webhook` | respondToWebhook | Returns `{ success: true, message: "Submission processed" }` JSON |

### 3.4 Duplicate detection logic

**Phase 1 memory claimed duplicate detection matches on name + DOB + phone + email. This is incorrect for the Registration workflow.**

Actual Registration logic (`DrChrono: Search Patient` → `IF: Patient Exists?`):

- DrChrono is queried with **first_name + last_name + date_of_birth only**.
- If `results.length > 0`, the **first** result (`results[0].id`) is treated as a match and PATCHed.
- No client-side disambiguation. If DrChrono returns multiple matches, the first wins silently.

Behavior on match: `PATCH` the patient with nick_name, email, cell_phone, and full address — overwriting whatever was there. **First/last name and DOB are NOT updated on the existing record** (they were the search key).

This is a **risk** — if two different patients share name+DOB (not impossible in a busy clinic over time), the new submission silently overwrites the wrong record's contact + address fields. Flagging in §8.

### 3.5 PDF handling — Registration

- PDF is **generated inside n8n** by the `Generate Registration PDF` Code node (item #9 above).
- The Code node is a self-contained PDF assembler: it writes raw PDF 1.4 syntax with Helvetica-only text, pagination at 792-pt page height, no external libraries, no fonts loaded from disk.
- Output is `binary.pdf` with `mimeType: application/pdf`, filename `registration_{first}_{last}_{YYYY-MM-DD}.pdf`.
- It is then uploaded to DrChrono via `POST /api/documents` (multipart) on the resolved `patient_id`.
- **HIPAA posture:** good — the PHI never leaves the n8n process before reaching DrChrono.
- **No JotForm PDF is fetched in the Registration workflow.** This differs from the Consultation workflow (§4.4).

### 3.6 Insurance card image handling — Registration

- The Parse & Normalize node scans every key matching `/fileupload/i` and collects every HTTPS URL it finds. This is robust to JotForm question-number drift.
- For each URL collected:
  1. `Code in JavaScript` fans out (1 item per URL).
  2. `Download File` `GET`s the URL with header `APIKEY: c23de1a35351ef6d98541533b21fd9b0` — required because JotForm HIPAA URLs are not publicly accessible.
  3. `Fix MIME` normalizes mime type (jpg/jpeg/png/gif/webp/heic/pdf) from extension if the server didn't set it correctly.
  4. `Valid File?` short-circuits non-image responses (which would mean Jotform returned an error JSON instead of an image binary).
  5. `DrChrono: Upload Document` posts each card as a separate document on the patient chart, description "Insurance card (Jotform intake)".
- The card upload path runs **after** the registration PDF upload, so the chart will end up with the registration PDF plus 0–N card documents.

**Hardcoded `APIKEY` value `c23de1a35351ef6d98541533b21fd9b0` appears literally in the workflow JSON** — see §8.a.

### 3.7 Error handling & notifications — Registration

- No notification nodes (no Slack/email/SMS error path).
- `continueOnFail: true` on the Sheets audit log, DrChrono search, DrChrono document upload, registration PDF upload, and the card download/upload — failures don't abort the run.
- The two `Sheets: Fallback Log` nodes intended to catch upload failures are **disabled** (one) or **misconfigured to a `REPLACE_WITH_SPREADSHEET_ID` placeholder** (the same disabled one). The `Sheets: PDF Fallback Log` is enabled and points at the real doc — that one works for PDF upload failures only.
- Settings: `saveDataErrorExecution: all`, `saveDataSuccessExecution: all` — full payloads retained in execution history (PHI retention concern, see §8.e).
- **There is no path that pages a human when an upload silently fails.** A bad DrChrono response just becomes an unattached document; nobody is notified.

### 3.8 Reconciliation / logging — Registration

- The only audit trail is `Sheets: Audit Log` (one row per submission, contains PHI).
- No reconciliation workflow exists (verified by listing every workflow in §2).
- No nightly job verifies "every Sheet row has a matching DrChrono patient + document on the chart."
- The Phase 1 memory mentioning a weekly reconciliation check could not be located. Either it was never built, or it was deleted. **`[AMBIGUOUS]`**

---

## 4. Consultation workflow — deep audit

**ID:** `xY1NOVVCflSyEme6`
**Name:** "Consultation Intake"
**Trigger count:** 1
**Node count:** 12
**Version:** `cfdb1342-a1a2-40fe-bf53-157a19a7d2b5`, version counter 264
**Last updated:** 2026-04-15

### 4.1 Trigger node

| Property | Value |
| --- | --- |
| Node | `Webhook` (type `n8n-nodes-base.webhook` v1.1, id `da535d3a-...`) |
| Method | `POST` |
| Path | `1ecbab3d-2137-4168-ac3c-29e878d33469` (UUID — was auto-generated, then kept) |
| Production URL | `https://n8n-drsnip.fly.dev/webhook/1ecbab3d-2137-4168-ac3c-29e878d33469` |
| Test URL | `https://n8n-drsnip.fly.dev/webhook-test/1ecbab3d-2137-4168-ac3c-29e878d33469` |
| Response mode | `responseNode` |
| Auth | **None** — public endpoint, URL obscurity only |
| Error policy | default (errors propagate) |

### 4.2 Trigger payload shape

Identical JotForm wrapping to Registration: `multipart/form-data`, fields `body.formID`, `body.submissionID`, `body.rawRequest` (stringified JSON of `q*` fields), `body.pretty` (`"label:value, label:value, …"`).

**Critical difference from Registration:** the Consultation Parse & Normalize node does NOT read `body.rawRequest`. It reads **only `body.pretty`** and parses the human-readable label→value pairs. This is a more form-edit-resilient design (renaming a question label is what you'd have to change to break it, not renumbering questions).

Form ID for Consultation: `260987597803071`.

### 4.3 Node-by-node walk

```
Webhook
  → Parse & Normalize
    → Sheets: Audit Log
      → DrChrono: Search Patient
        → Resolve Patient ID
          → IF: Patient Exists?
              ├── true  → Download File (JotForm generatePDF)
              │            → Fix MIME
              │              → DrChrono: Upload Document
              │                → IF: Upload Failed?
              │                    ├── true  → Sheets: Fallback Log [DISABLED]
              │                    └── false → Respond to Webhook
              └── false → Respond to Webhook    ← !! no logging, no alert
```

| # | Node | Type | Role |
| --- | --- | --- | --- |
| 1 | `Webhook` | webhook | Receives JotForm POST |
| 2 | `Parse & Normalize` | function (JS) | Builds `labelMap` from `body.pretty`, extracts first_name, last_name, dob, email, phone by **label only**. Falls back to splitting a single "Name"/"Full Name" field. Normalizes DOB to `YYYY-MM-DD` via `new Date(dob).toISOString().slice(0,10)` if not already in that form. |
| 3 | `Sheets: Audit Log` | googleSheets | Appends to the **same** sheet/tab as Registration (`DrSnip_Intake_Sheet`, gid `102925546`). The schema is identical to Registration but most insurance/address columns are empty (Consultation form doesn't capture them). |
| 4 | `DrChrono: Search Patient` | httpRequest | `GET https://app.drchrono.com/api/patients?first_name=&last_name=` (DOB intentionally excluded — match is done client-side in step 5). URL is constructed via an inline expression that URL-encodes both. `continueOnFail: true` |
| 5 | `Resolve Patient ID` | function (JS) | **Strict match.** For each candidate in `results[]`, compare `date_of_birth`, `email` (lowercased), and digit-only `cell_phone/home_phone/office_phone`. **ALL THREE must match** the normalized payload. If exactly one passes → that's the patient. If zero pass → `match_reason: 'no_candidate_passed_strict_filter'` (or `'no_candidates_from_search'`). If >1 pass → `match_reason: 'ambiguous_match'`, **refuses to attach**. |
| 6 | `IF: Patient Exists?` | if | True when `matched === true` (i.e. unique strict match) |
| 7 | `Download File` | httpRequest | `GET https://hipaa-api.jotform.com/generatePDF?formid={form_id}&submissionid={submission_id}&apiKey=c23de1a35351ef6d98541533b21fd9b0&download=1` — **calls JotForm to render the submission as a PDF**. `responseFormat: file`. |
| 8 | `Fix MIME` | code | Validates `bin.mimeType === 'application/pdf'` and **throws** if not (so an error JSON from JotForm becomes a hard failure visible in n8n). Renames the file to `consultation_intake_{submission_id}.pdf`. |
| 9 | `DrChrono: Upload Document` | httpRequest | `POST https://app.drchrono.com/api/documents` multipart, `description: "Consultation Intake Form"`, `doctor: 324569`, `date: $now`. `continueOnFail: true` |
| 10 | `IF: Upload Failed?` | if | Branches on `$json.error` non-empty |
| 11 | `Sheets: Fallback Log` | googleSheets | **Disabled.** Same broken `$vars.SHEETS_DOC_ID` placeholder as Registration. |
| 12 | `Respond to Webhook` | respondToWebhook | Returns JSON: `{ success: matched, patient_id, reason: matched ? 'document_uploaded' : match_reason, candidate_count, passing_count }` |

### 4.4 Patient linkage logic

Source of truth: the `Resolve Patient ID` function node.

- Search step queries DrChrono by **name only** (first + last).
- Client-side filter requires **DOB + email + digit-normalized phone all to match exactly**.
- If 1 candidate passes → success, patient found.
- If 0 candidates pass → `matched: false`, **does NOT create the patient, does NOT alert anyone**, just 200s.
- If >1 candidates pass → `matched: false`, `match_reason: 'ambiguous_match'`. Same — silent refusal.

This is the right HIPAA posture (never attach a consultation chart to the wrong person), but the silent-failure behavior is a problem (§8.b).

### 4.5 PDF handling — Consultation

- The consultation PDF is **fetched from JotForm** via `https://hipaa-api.jotform.com/generatePDF?formid=…&submissionid=…&apiKey=…&download=1`.
- This is a JotForm HIPAA endpoint. It will not work for submissions that originated from the new custom intake app — there is no `submissionid` to pass.
- The `apiKey` is hardcoded in the URL query string (and is the same key as Registration's `Download File` node).
- **This is the single most JotForm-coupled call in the entire system.** Cutover requires replacing this node's source.

### 4.6 Error handling & notifications — Consultation

- No notification nodes.
- The "no match" path quietly responds with `success: false`. There is **no Sheets row written for the failure**, no email, no Slack. The submission is visible in n8n execution history but won't surface anywhere else.
- The "ambiguous match" path behaves the same way.
- The `Sheets: Fallback Log` for failed document uploads is disabled (same broken `$vars.SHEETS_DOC_ID` as Registration).
- Settings: same as Registration (`saveDataErrorExecution: all`, `saveDataSuccessExecution: all`).

### 4.7 Reconciliation / logging — Consultation

- `Sheets: Audit Log` is written on every submission, regardless of match outcome. It captures `first_name`, `last_name`, `dob`, `email`, `phone`, `submission_id`, `timestamp`. Other columns are blank.
- No follow-up workflow.

---

## 5. Cross-workflow audit

- **Shared credentials:** `DRSNIP-CHRONO` (DrChrono OAuth2) and `Google Sheets account`. Both workflows use both.
- **Shared external services:** the same Google Sheet (`1EOmhE2wcDW45MUHdF3ffLhzACRq7CBc_qlq4YkOfUbI`, tab `DrSnip_Intake_Sheet` gid `102925546`) is the audit log for both. There is no separation between Registration submissions and Consultation submissions in the sheet — they coexist in the same rows.
- **Shared JotForm API key:** the same literal `c23de1a35351ef6d98541533b21fd9b0` appears in both workflows (Registration's `Download File`, Consultation's `Download File`).
- **No shared sub-workflows.** n8n's "Execute Workflow" nodes are not used anywhere. Each workflow is self-contained.
- **No utility workflow** (auth refresher, scheduled reconciliation, error notifier).
- The same DrChrono `doctor: 324569` literal appears in 4 nodes across the two workflows.

---

## 6. DrChrono integration audit

- **API version:** unversioned base URL `https://app.drchrono.com/api/...`. (DrChrono's main REST API; no `/v1/` segment is used in any node.)
- **Auth mechanism:** OAuth2 (`oAuth2Api`) via the `DRSNIP-CHRONO` credential. n8n's generic OAuth2 credential type handles refresh inline.
- **Endpoints called across both workflows:**

| Method | URL pattern | Used by | Purpose |
| --- | --- | --- | --- |
| GET | `https://app.drchrono.com/api/patients?first_name=&last_name=&date_of_birth=` | Registration | Duplicate search |
| GET | `https://app.drchrono.com/api/patients?first_name=&last_name=` | Consultation | Candidate search |
| PATCH | `https://app.drchrono.com/api/patients/{id}` | Registration | Update existing patient |
| POST | `https://app.drchrono.com/api/patients` | Registration | Create patient (with `doctor: 324569`, `gender: Male` hardcoded) |
| POST | `https://app.drchrono.com/api/documents` | Registration (×2: registration PDF + insurance cards) and Consultation | Upload chart documents |

- **No `office` parameter** is sent on patient creation, despite the form capturing office location. DrSnip multi-office routing happens elsewhere or not at all. **`[AMBIGUOUS]`**.
- **Rate limiting:** no nodes have explicit rate-limit handling, but the `Download File` node in Registration uses `batching.batchSize: 2, batchInterval: 8000` for JotForm card fetches — DrChrono itself sees at most ~3 requests per registration submission (search, create/patch, doc upload[s]) so rate limits are unlikely to bite at current volume.
- No 429 / OAuth-refresh errors observed in execution history.

---

## 7. Execution history audit (last 30 days)

**Window analyzed:** execution IDs 165–295, covering 2026-05-13 → 2026-05-27 (~14 days). The n8n API returned `hasMore: false` for both workflows below 100 results, so this is the entire available history. **`[MCP_LIMITATION]` / instance retention:** the instance's `EXECUTIONS_DATA_MAX_AGE` appears to be ~14 days, not 30 — older executions have been pruned. The audit cannot speak to anything before 2026-05-13.

### Registration (`6warkNFZSSzuasMB`)

- Executions in window: **67**
- Statuses: **67 success, 0 error, 0 waiting**
- Success rate: **100% (n8n-finished basis)** — see caveat below
- Earliest in window: id 166 @ 2026-05-13T19:45:41Z
- Most recent: id 294 @ 2026-05-27T14:21:21Z (success)
- Median duration: ~5–7 s
- Longest run: id 211 @ 2026-05-18, ~11 s (likely a card download with multiple files)

**Caveat:** "100% success" means the workflow finished without n8n marking it errored. Because the upload nodes use `continueOnFail: true` and the Sheets fallback nodes are disabled, a DrChrono document upload could fail without changing n8n's verdict. There is no signal in this dataset to distinguish "true success" from "partial silent failure." Detection would require either (a) per-execution drilldown into node output, or (b) reconciling against DrChrono itself. Neither is done today.

### Consultation (`xY1NOVVCflSyEme6`)

- Executions in window: **64**
- Statuses: **64 success, 0 error, 0 waiting**
- Success rate: **100% (n8n-finished basis)**
- Earliest in window: id 165 @ 2026-05-13T19:43:15Z
- Most recent: id 295 @ 2026-05-27T15:15:31Z (success)
- Median duration: ~5–8 s

**Caveat is bigger here.** Because the workflow returns `success` even on `no_candidate_passed_strict_filter` and `ambiguous_match`, n8n's "success" includes runs where the consultation was **never attached to any chart**. The proportion of "matched vs unmatched" in the window cannot be derived from `n8n_executions list` alone — it requires inspecting each execution's `Resolve Patient ID` output. Strongly recommend running that analysis once before cutover.

### Webhook-miss / Douglas Record-style incident traces

No execution gaps suggesting a webhook drop are evident in the listed IDs (they're sequential, no obvious holes that would clearly indicate a missed JotForm POST vs. just a quiet hour). I did not find a "retryOf" reference for a Douglas Record-style manual replay in the available history. **`[AMBIGUOUS]`** — that incident likely occurred outside the 14-day retention window.

---

## 8. Risk and gap analysis

### 8.a Hardcoded JotForm-specific assumptions

These are the places the new custom app will either need to mimic, OR we'll need to extend/rework:

| Location | Assumption | Cutover implication |
| --- | --- | --- |
| Registration Parse & Normalize (function) | Reads `body.rawRequest` as a JSON string; field keys are JotForm's `q{N}_{type}{N}` convention | New app must either (a) POST a JotForm-shaped body with `rawRequest`, or (b) we add a branch / new normalize node for the app's payload |
| Same node | DOB is `{month, day, year}` object; address is JotForm's `{addr_line1, addr_line2, city, state, postal}` shape; phone is `{full}` | Same — either mimic shape or rework |
| Same node | Insurance card detection scans for any key matching `/fileupload/i` containing HTTPS URLs | New app needs to either upload to a HIPAA-safe URL that n8n can pull, or post the binary inline (see §8.c) |
| Registration `Download File` node | Hardcoded `APIKEY: c23de1a35351ef6d98541533b21fd9b0` header; URL pattern assumes `hipaa.jotform.com/uploads/...` | Will be unused once new app replaces JotForm; remove or rework if PDFs/binaries come from the new app |
| Consultation Parse & Normalize | Reads `body.pretty` — JotForm's human-readable label:value string | New app must either send a `pretty` field with the same label format, OR we replace this node with a JSON-field reader |
| Consultation `Download File` node | Hardcoded `https://hipaa-api.jotform.com/generatePDF?formid={form_id}&submissionid={submission_id}&apiKey=...` | **JotForm-only**, must be replaced. This is the single biggest cutover-blocking call. |
| Both workflows | Webhook auth is "URL obscurity" — anyone with the URL can POST | New app gets the same exposure unless we add a shared-secret header check |
| Both | `doctor: 324569` hardcoded literal | Probably fine (DrSnip presumably has one billing doctor for vasectomy procedures), but flag for confirmation |
| Registration `Create Patient` | `gender: Male` hardcoded | DrSnip-specific (vasectomy clinic), probably intentional, flag for confirmation |
| Audit Sheet | Sheet ID `1EOmhE2wcDW45MUHdF3ffLhzACRq7CBc_qlq4YkOfUbI` hardcoded | Carries forward; no rework needed |

### 8.b What the new custom app's webhook payload would need to look like

**Path of least resistance — make the new app post a JotForm-compatible payload.** Then both Parse & Normalize nodes work unchanged.

**Registration payload** (`POST https://n8n-drsnip.fly.dev/webhook/job-form-submission`, `Content-Type: application/json`; the Function code accepts both `body.rawRequest` and top-level `rawRequest`):

```json
{
  "formID": "<reuse or invent>",
  "submissionID": "<unique per submission, ideally the new app's submission id>",
  "rawRequest": "<STRINGIFIED JSON — see structure below>",
  "pretty": "<optional, not read by Registration>"
}
```

Where `rawRequest` is the stringified JSON of:

```json
{
  "q3_q3_dropdown1": "Portland | Vancouver | …",
  "q4_q4_textbox2": "<first name>",
  "q5_q5_textbox3": "<preferred first name>",
  "q7_q7_textbox5": "<last name>",
  "q8_q8_datetime6": { "month": "MM", "day": "DD", "year": "YYYY" },
  "q9_q9_address7": {
    "addr_line1": "",
    "addr_line2": "",
    "city": "", "state": "", "postal": "", "country": ""
  },
  "q10_q10_phone8": { "full": "(xxx) xxx-xxxx" },
  "q11_q11_radio9":  "Yes" | "No",
  "q12_q12_radio10": "Yes" | "No",
  "q13_q13_email11": "<email>",
  "q15_q15_textbox13": "<primary care physician>",
  "q16_q16_radio14": "Yes" | "No",
  "q17_q17_radio15": "Yes" | "No",
  "q18_q18_radio16": "Yes" | "No",
  "q19_q19_radio17": "Yes" | "No",
  "q20_q20_radio18": "Yes" | "No",
  "q21_q21_radio19": "Yes" | "No",
  "q22_q22_radio20": "Yes" | "No",
  "q23_q23_radio21": "Yes" | "No",
  "q24_q24_radio22": "Yes" | "No",
  "q25_q25_radio23": "Yes" | "No",
  "q26_q26_radio24": "Yes" | "No",
  "q27_q27_radio25": "Yes" | "No",
  "q28_q28_radio26": "Yes" | "No",
  "q29_q29_textarea27": "<surgery details — currently discarded by parser, see §8.d>",
  "q31_q31_radio29": "<insurance status>",
  "q32_q32_textbox30": "<insurance provider>",
  "q33_q33_textbox31": "<member id>",
  "q34_q34_textbox32": "<group id>",
  "<anything>_fileupload<anything>": ["https://...card1.jpg", "https://...card2.jpg"]
}
```

The insurance-card URLs must be reachable by n8n. If we keep the existing `Download File` node, they would need to be HIPAA-safe URLs and we'd have to either (a) make the new app's URLs accept the same `APIKEY` header (ugly) or (b) replace the Download File node with a credentialed fetch. **Cleaner option: have the new app inline-attach binaries, see §8.c.**

**Consultation payload** (`POST https://n8n-drsnip.fly.dev/webhook/1ecbab3d-2137-4168-ac3c-29e878d33469`):

```json
{
  "formID": "<reuse or invent>",
  "submissionID": "<unique>",
  "pretty": "Name:<first> <last>, Email:<email>, Phone Number:<(xxx) xxx-xxxx>, Date Of Birth:<YYYY-MM-DD or any parseable date>, <… any other label:value pairs …>"
}
```

The Consultation Parse & Normalize only reads `pretty` and only requires the identity labels (Name / First Name + Last Name, Email, Phone Number, Date of Birth). The full medical-history Q&A in `pretty` is currently **not parsed by the Consultation workflow** — they live only in the JotForm-generated PDF. If we want them in the chart after cutover, the new app needs to generate the PDF itself (§8.c, Option 1 / Option 3).

### 8.c PDF strategy decision

Three options for the consultation PDF (Registration already generates locally and needs no change):

| Option | Source of PDF | Pros | Cons |
| --- | --- | --- | --- |
| 1. New app sends PDF inline (base64 in webhook payload) | Custom app | One round trip, no extra fetch; new app is already rendering the same form, easy to PDF | Webhook payload bloats; the n8n Webhook node has to be configured to handle larger bodies; binary handling in `multipart-form-data` is tidier than base64-in-JSON |
| 2. n8n fetches PDF from new app via `/api/submissions/:id/pdf` | Custom app, on-demand | Webhook stays small; matches today's "fetch from JotForm" shape; clean separation | Requires the new app to expose an authenticated PDF endpoint that n8n can call; n8n needs credentials for it (more setup); adds a second network hop |
| 3. **n8n generates the PDF itself from form data** (mirror the Registration `Generate Registration PDF` Code node) | n8n | Zero JotForm coupling left after cutover; the in-process generator is already proven HIPAA-safe; lets us delete the JotForm `generatePDF` call entirely; new app stays simple (form data only); identical look between Registration and Consultation PDFs in DrChrono | Have to write the consultation-PDF generator (60+ fields vs Registration's ~25) — bigger Code node; if the new app already produces a polished PDF we'd be duplicating effort |

**Recommendation: Option 3 (n8n generates).** Reasoning:
- The existing Registration PDF Code node proves the pattern is HIPAA-safe, dependency-free, and lives entirely inside the n8n process — no PHI ever crosses a process boundary except into DrChrono.
- It eliminates the **single most JotForm-coupled call in the system** (the `hipaa-api.jotform.com/generatePDF` HTTP request), with no third-party render service to replace.
- The new app stays a simple data sender; we don't have to add a `/pdf` endpoint or pass binaries over the webhook.
- Symmetry: Registration already works this way; Consultation should match.

The downside is real but bounded: someone has to write the consultation PDF generator. That's a few hundred lines of plain JS modeled on the existing Registration generator (`Generate Registration PDF` in workflow `6warkNFZSSzuasMB`). Use Option 1 as a fallback if the new app's PDF rendering is significantly higher fidelity (logo, formatting) and that matters to Jeff.

### 8.d Anything broken or fragile — fix candidates for the cutover

1. **Hardcoded JotForm API key in workflow JSON** (Registration `Download File` + Consultation `Download File`). Even though the workflow JSON is not public, it's exfiltrated to logs/n8n exports trivially. Move to a credential or env var. If we go with PDF Option 3 + drop JotForm card fetch, this evaporates.
2. **Two `Sheets: Fallback Log` nodes are dead** — disabled, point at a `REPLACE_WITH_SPREADSHEET_ID` placeholder. Either wire them up or delete them. Today they create the illusion of a fallback that doesn't exist.
3. **Registration duplicate detection only matches name + DOB** (memory was wrong). Two unrelated patients sharing both name and DOB would cause the first one's contact info to be silently overwritten with the second one's submission. Tighten to also require email or phone match before treating as same patient — and refuse-or-alert on ambiguity.
4. **Consultation silent "no match" / "ambiguous match" responses.** A submission for a patient who never registered (or whose contact info changed) returns `200 OK { success: false }` and produces nothing else — no Sheet row, no alert. Add either (a) a Sheets row for failed matches, or (b) an email/Slack notification, or both.
5. **`q29_q29_textarea27` (surgery details / additional medical history textarea) is captured by Parse & Normalize but discarded by the Sheets log and never reaches DrChrono.** It is included in the generated PDF (under "Surgery Details"), so it does survive into the chart — but it's invisible to the audit sheet. Confirm whether this is intentional.
6. **No webhook authentication.** Both webhook URLs are unauthenticated. Anyone who learns the URL can submit a fake patient. The new app should send a shared-secret header (e.g., `X-DrSnip-Token`) and the webhook should check it via a small `IF` node right after the trigger. Easy add at cutover time.
7. **Settings: `saveDataSuccessExecution: all`** retains full PHI payloads in n8n's execution history indefinitely (or until pruned by `EXECUTIONS_DATA_MAX_AGE`). The 14-day retention we observed suggests pruning IS configured — confirm and document this.
8. **No reconciliation workflow.** Build a scheduled workflow (daily or weekly) that picks N random Sheet rows from the last 24 h / 7 d and verifies a matching DrChrono patient + document exists. This is the single biggest gap relative to "production-grade HIPAA intake."

### 8.e Missing audit trail / HIPAA gaps

- **PHI in Google Sheets.** The audit log contains full name, DOB, email, phone, full address, insurance member ID — i.e. enough identifying data to qualify as PHI. Verify (a) a BAA exists with Google Workspace, (b) the sheet's sharing is restricted to people covered by that BAA, and (c) Drive audit logging is enabled.
- **PHI in n8n execution history.** Both `saveDataSuccessExecution: all` and `saveDataErrorExecution: all` are set; every run keeps the full JotForm payload. With ~14-day retention this is bounded, but anyone with n8n admin access can read every recent patient submission verbatim. Confirm the n8n instance is itself BAA-covered (Fly.io provides BAAs only for specific configurations; verify the n8n Fly app is one of those).
- **No access log for who-viewed-what.** n8n doesn't natively log "user X viewed execution Y." If multiple people have access to the n8n admin UI, there's no PHI access audit trail. Out of scope to fix here but flag for compliance.
- **JotForm API key in plain text in workflow JSON.** Anyone exporting a workflow gets the HIPAA API key. After cutover (and removal of JotForm), this concern disappears; until then, rotate the key if it's been exposed.
- **No PHI access alerting.** No notifications when a workflow runs (which would itself be PHI-adjacent metadata). Not necessarily required, but worth a HIPAA-conscious decision.

---

## 9. Acceptance test answers

1. **How many DrSnip workflows exist; which two are primary?** 5 total. Primary: `6warkNFZSSzuasMB` (Registration) and `xY1NOVVCflSyEme6` (Consultation). The other 3 are archived "Connor Demo" workflows unrelated to intake.
2. **Webhook URLs?** Registration: `POST https://n8n-drsnip.fly.dev/webhook/job-form-submission`. Consultation: `POST https://n8n-drsnip.fly.dev/webhook/1ecbab3d-2137-4168-ac3c-29e878d33469`. Both unauthenticated.
3. **Trigger payload shape?** See §3.2 (Registration: `multipart/form-data` with JotForm `body.rawRequest` JSON string keyed by `q{N}_*`) and §4.2 (Consultation: same multipart wrapper but only `body.pretty` label:value string is consumed).
4. **Where is duplicate detection; what's the logic?** Registration: `DrChrono: Search Patient` node + `IF: Patient Exists?` — searches by first_name + last_name + date_of_birth; takes `results[0]` if any. Consultation: `DrChrono: Search Patient` (name only) + `Resolve Patient ID` function (strict client-side filter requiring DOB + email + phone all to match).
5. **PDF handling?** Registration: generated in-node by the `Generate Registration PDF` Code node (hand-written minimal PDF), uploaded to DrChrono Documents API. Consultation: fetched from `https://hipaa-api.jotform.com/generatePDF` (JotForm-specific), then uploaded to DrChrono Documents API.
6. **How does Consultation link to existing patients?** Strict triple-match on DOB + email + phone client-side (post-name-search). Refuses to attach on zero matches OR multiple matches. **Does NOT create a new patient** if no match.
7. **30-day success rate; top failure modes?** Both 100% (n8n-finished basis) over the 14-day window available (~67 Registration, 64 Consultation). No errored executions surfaced; failures are masked by `continueOnFail` and by the Consultation workflow returning OK on no-match. True success rate cannot be derived without per-execution drilldown.
8. **Hardcoded JotForm assumptions?** See §8.a — primarily: JotForm `body.rawRequest` shape (Registration), JotForm `body.pretty` shape (Consultation), JotForm `generatePDF` endpoint (Consultation), JotForm HIPAA card-upload URLs + API key (Registration), no webhook authentication (both).
9. **What payload would just work?** See §8.b — a JotForm-shaped POST with `formID`, `submissionID`, `rawRequest` (Registration) / `pretty` (Consultation), to the existing webhook URLs.
10. **Recommended PDF strategy?** Option 3 — n8n generates the consultation PDF itself, mirroring the existing Registration PDF generator. Removes the last JotForm-coupled call and keeps the new app simple. See §8.c.

---

## 10. MCP capabilities — what was and was not accessible

**Accessible:**
- `n8n_health_check` — instance health, API URL, MCP version.
- `n8n_list_workflows` — id, name, active/archived, node count, timestamps, tags.
- `n8n_get_workflow` (mode `full`) — entire workflow JSON including node parameters, code, connections, settings, versions.
- `n8n_executions` (list + get with `mode: filtered`) — past execution metadata and per-node input/output data.
- `n8n_manage_credentials` (list with `includeUsage: true`) — credential metadata + which workflows reference them. **Credential values were NOT requested and would not be readable via this server.**

**Limitations encountered (`[MCP_LIMITATION]`):**
- **Execution retention.** Only ~14 days of executions are present, not 30. This is an n8n instance config (`EXECUTIONS_DATA_MAX_AGE`), not a server limitation per se. Documenting it so the chat summary doesn't overclaim.
- **No structural query for "what other workflows talk to JotForm / DrChrono."** Cross-workflow dependency discovery had to be done by reading each workflow JSON.
- **No environment-variable introspection.** The two `$vars.SHEETS_DOC_ID` references in the disabled Sheets fallback nodes cannot be resolved to "is this var set?" via MCP — would need shell access to the Fly machine.

**Capabilities present in the MCP server that were intentionally NOT used (per audit guardrails):** workflow create/update/delete (`n8n_create_workflow`, `n8n_update_full_workflow`, `n8n_update_partial_workflow`, `n8n_delete_workflow`), execution trigger (`n8n_test_workflow`), credential mutation (`n8n_manage_credentials` create/update/delete), workflow version rollback.

---

## Appendix A — Field map for the new app's Registration payload

Mapping from the *normalized* keys the rest of the Registration workflow uses → the JotForm `q*_*` keys the new app would need to put inside `rawRequest`:

| Normalized | JotForm key | Required? | Notes |
| --- | --- | --- | --- |
| `office_location` | `q3_q3_dropdown1` | yes | string |
| `first_name` | `q4_q4_textbox2` | yes | |
| `preferred_first_name` | `q5_q5_textbox3` | no | |
| middle initial | `q6_q6_textbox4` | n/a | parser drops it |
| `last_name` | `q7_q7_textbox5` | yes | |
| `dob` | `q8_q8_datetime6` | yes | object `{month: "MM", day: "DD", year: "YYYY"}`. Strings only. |
| `address_*` | `q9_q9_address7` | yes | object `{addr_line1, addr_line2, city, state, postal, country}` |
| `phone` | `q10_q10_phone8` | yes | object `{full: "(xxx) xxx-xxxx"}` |
| `consent_hipaa` | `q11_q11_radio9` | yes | `"Yes"` / `"No"` |
| `consent_treatment` | `q12_q12_radio10` | yes | `"Yes"` / `"No"` |
| `email` | `q13_q13_email11` | yes | |
| `primary_care_physician` | `q15_q15_textbox13` | no | |
| medical history (13 Q's) | `q16_q16_radio14` … `q28_q28_radio26` | yes | `"Yes"` / `"No"` each |
| `surgery_details` | `q29_q29_textarea27` | no | rendered into PDF, **not Sheet-logged** |
| `insurance_status` | `q31_q31_radio29` | yes | |
| `insurance_provider` | `q32_q32_textbox30` | no | |
| `insurance_member_id` | `q33_q33_textbox31` | no | |
| `insurance_group_id` | `q34_q34_textbox32` | no | |
| (subscriber fields q35–q38) | – | no | unused |
| insurance card URLs | any key matching `/fileupload/i` containing HTTPS URLs | no | array OR single string. The URLs MUST be fetchable with the hardcoded JotForm `APIKEY` header — or this `Download File` path needs to be reworked. |

## Appendix B — Field map for the new app's Consultation payload

The Consultation parser uses `body.pretty` labels (case-insensitive). It needs only:

| Normalized | Acceptable label(s) in `pretty` |
| --- | --- |
| `first_name` | `First Name` / `First` / `Patient First Name` |
| `last_name` | `Last Name` / `Last` / `Surname` / `Patient Last Name` |
| (fallback) | `Full Name` / `Patient Name` / `Patient Full Name` / `Name` — split on first whitespace |
| `dob` | `Date of Birth` / `DOB` / `Birth Date` / `Patient Date of Birth` |
| `email` | `Email` / `Email Address` / `E-mail` / `Patient Email` |
| `phone` | `Phone Number` / `Phone` / `Mobile` / `Cell` / `Cell Phone` / `Patient Phone` / `Patient Phone Number` |

All other consultation fields (medical/social history, etc.) are currently **not parsed by the workflow** — they only survive into the chart via the PDF that JotForm renders. If we adopt PDF Option 3 (n8n generates the PDF), the new app needs to send these as additional `pretty` segments or as a structured JSON field that a new Code node consumes.
