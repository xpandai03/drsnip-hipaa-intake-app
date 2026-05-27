# N8N CUTOVER NOTES — DrSnip custom-app workflows

**Date built:** 2026-05-27
**Author:** Claude (n8n MCP session)
**Status:** Workflows built, validated, and activated. Smoke tests blocked
pending a single n8n env-flag flip (see §A below). The existing JotForm-driven
workflows are **untouched** and continue to serve real patients.

---

## 0. TL;DR

Two new active n8n workflows accept submissions from the custom intake app at
`https://drsnip-intake-demo.fly.dev`. They handle the full pipeline — webhook
auth check → Sheets audit → DrChrono patient match-or-create → in-process PDF
generation → DrChrono document upload → manual-review tab on no/ambiguous
match → upload-failure tab on document failures.

| Workflow | n8n ID | Nodes | Active | Webhook URL |
|---|---|---|---|---|
| `[Custom App] DrSnip Registration v2` | `H2HihkGKntbfRNcK` | 22 | ✅ | `https://n8n-drsnip.fly.dev/webhook/custom-registration-6fe129ab` |
| `[Custom App] DrSnip Consultation v2` | `4UicLLZRRMeENXhx` | 15 | ✅ | `https://n8n-drsnip.fly.dev/webhook/custom-consultation-9f872020` |

Both require an `X-DrSnip-Token` HTTP header. Without it, the workflow short-circuits to a `401 unauthorized` response.

---

## A. ACTION REQUIRED — flip the env-access flag

The auth IF node references `$env.DRSNIP_WEBHOOK_SECRET`. The n8n Fly app
currently has `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` (n8n's default) which
prevents workflow expressions from reading OS env vars. The auth check
therefore fails with `ExpressionError: access to env vars denied` at runtime.

**Fix — one Fly command + redeploy:**

```sh
fly secrets set N8N_BLOCK_ENV_ACCESS_IN_NODE=false -a n8n-drsnip
```

Fly will automatically restart the n8n machines. After it comes back up, the
auth check will resolve `$env.DRSNIP_WEBHOOK_SECRET` correctly and the
workflows will work end-to-end.

Until this is done, every request to either webhook fails at the IF: Auth
Check node and the webhook returns an empty body. The Webhook node logs the
expression error but no response is sent.

---

## B. Webhook secret (store securely)

```
DRSNIP_WEBHOOK_SECRET = 0609634797970ddd7bc4c82677d1904f958b41c55d6a5c621d23a74fd0a66e2f
```

You confirmed in chat that this is already set as a Fly secret on
`n8n-drsnip`. The custom intake app needs the **same value** as
`N8N_WEBHOOK_SECRET` (or whatever env name you wire it under), and must send
it as the `X-DrSnip-Token` HTTP header on every POST to either webhook.

**Rotate after cutover.** This value lived briefly in our chat history and
in this file — once cutover is verified, rotate via:

```sh
NEW=$(openssl rand -hex 32)
fly secrets set DRSNIP_WEBHOOK_SECRET=$NEW -a n8n-drsnip
# then update the custom app's matching env var and redeploy it
```

---

## C. Webhook payload contracts

### C.1 Registration v2

`POST https://n8n-drsnip.fly.dev/webhook/custom-registration-6fe129ab`

Headers:
- `Content-Type: application/json`
- `X-DrSnip-Token: <DRSNIP_WEBHOOK_SECRET>`

Body:

```json
{
  "submissionId": "<uuid from custom app>",
  "formType": "registration",
  "submittedAt": "2026-05-27T20:00:00Z",
  "patient": {
    "officeLocation": "Portland",
    "legalFirstName": "John",
    "preferredFirstName": "Johnny",
    "middleInitial": "A",
    "legalLastName": "Doe",
    "dateOfBirth": "1985-03-15",
    "streetAddress": "123 Main St",
    "addressLine2": "Apt 4B",
    "city": "Portland",
    "state": "OR",
    "postalCode": "97201",
    "country": "US",
    "phone": "(555) 123-4567",
    "email": "john@example.com",
    "primaryCarePhysician": "Dr. Smith — Portland Family Medicine"
  },
  "consent": {
    "voicemail": true,
    "text": true,
    "voicemailQuestion": "Do you give consent for DrSnip to leave voicemails at the number provided?",
    "textQuestion": "Do you give consent for DrSnip to send text messages to the number provided?"
  },
  "medicalHistory": {
    "mhMentalIllness":   { "answer": "Yes", "details": "Mild depression managed with therapy" },
    "mhPainSensitive":   { "answer": "No",  "details": "" },
    "mhFainting":        { "answer": "No",  "details": "" },
    "mhBleeding":        { "answer": "No",  "details": "" },
    "mhKidney":          { "answer": "No",  "details": "" },
    "mhSTI":             { "answer": "Yes", "details": "Chlamydia, 2019" },
    "mhTesticleAbnormality": { "answer": "No", "details": "" },
    "mhTesticleInjury":  { "answer": "No",  "details": "" },
    "mhSurgeries":       { "answer": "No",  "details": "" },
    "mhSurgyComplications": { "answer": "No", "details": "" },
    "mhMedications":     { "answer": "No",  "details": "" },
    "mhAspirin":         { "answer": "No",  "details": "" },
    "mhAllergies":       { "answer": "No",  "details": "" },
    "mhChronic":         { "answer": "No",  "details": "" }
  },
  "insurance": {
    "status":   "Own Insurance",
    "provider": "Blue Cross",
    "memberId": "ABC123",
    "groupId":  "GRP456",
    "cardFront": { "filename": "card-front.jpg", "contentType": "image/jpeg", "base64Data": "<base64>" },
    "cardBack":  { "filename": "card-back.jpg",  "contentType": "image/jpeg", "base64Data": "<base64>" }
  }
}
```

`cardFront` / `cardBack` are optional. If omitted (or both `base64Data`
strings empty), the card upload step is skipped.

**Response shapes:**

| Path | HTTP | Body |
|---|---|---|
| Auth fail | 401 | `{ "success": false, "error": "unauthorized" }` |
| Manual review (ambiguous DrChrono match) | 200 | `{ "success": false, "reason": "manual_review_required", "submission_id", "candidate_count", "match_reason" }` |
| Success | 200 | `{ "success": true, "submission_id", "patient_id", "drchrono_action": "created" \| "updated", "documents_uploaded", "manual_review_required": false }` |

### C.2 Consultation v2

`POST https://n8n-drsnip.fly.dev/webhook/custom-consultation-9f872020`

Headers same as Registration.

Body:

```json
{
  "submissionId": "<uuid from custom app>",
  "formType": "consultation",
  "patientId": "<custom-app patient_id from URL param, optional>",
  "submittedAt": "2026-05-27T20:00:00Z",
  "patient": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "(555) 123-4567",
    "dateOfBirth": "1985-03-15"
  },
  "aboutYou": {
    "occupation": "Engineer",
    "employer": "Acme Co",
    "jobTitle": "Senior Engineer",
    "jobDemands": "Office-based, occasional travel"
  },
  "relationship": {
    "status": "Married",
    "partnerFirstName": "Jane",
    "partnerLastName": "Doe",
    "partnerPhone": "(555) 987-6543",
    "partnerShareConsent": true,
    "partnerAge": 38,
    "partnerOccupation": "Teacher",
    "partnerEducation": "Masters",
    "yearsInRelationship": 12,
    "marriageNumberSelf": 1,
    "marriageNumberSpouse": 1
  },
  "children": {
    "count": 2,
    "details": [
      { "age": 8, "relation": "biological", "gender": "male" },
      { "age": 5, "relation": "biological", "gender": "female" }
    ]
  },
  "familyPlanning": {
    "wantMoreChildren": "No",
    "considerAdoption": "No",
    "vasectomyConsideredDuration": "6 months"
  },
  "birthControl": {
    "consideredTubal": "No",
    "consideredTemporaryBC": "Yes",
    "currentBC": ["Condoms"],
    "currentBCOther": "",
    "priorBC": ["Birth control pills"]
  },
  "medicalPersonal": {
    "religionConflict": "No",
    "sexualConcerns": "No",
    "sexualConcernsDetails": "",
    "geneticCondition": "No",
    "geneticConditionDetails": ""
  },
  "emergencyReferral": {
    "name": "Jane Doe",
    "phone": "(555) 987-6543",
    "relationship": "Spouse",
    "howHeard": "TV",
    "howHeardOther": "",
    "referringProfessional": "",
    "additionalNotes": ""
  }
}
```

**Response shapes:**

| Path | HTTP | Body |
|---|---|---|
| Auth fail | 401 | `{ "success": false, "error": "unauthorized" }` |
| Manual review (no DrChrono match or ambiguous) | 200 | `{ "success": false, "reason": "manual_review_required", "submission_id", "candidate_count", "match_reason" }` |
| Success | 200 | `{ "success": true, "submission_id", "patient_id", "documents_uploaded": 1, "manual_review_required": false }` |

Consultation does **not** create new DrChrono patients — by design, it requires a strict match (DOB + email + phone, all three) on an already-registered patient. No-match → manual review.

---

## D. Audit Sheet — required new tabs

The existing audit Google Sheet (`1EOmhE2wcDW45MUHdF3ffLhzACRq7CBc_qlq4YkOfUbI`) needs **two new tabs** created manually before the workflows can write to them. n8n's Google Sheets node won't auto-create tabs.

### D.1 `ManualReview` tab

Created when a submission can't be linked to a unique DrChrono patient. Columns (first row, in order):

```
timestamp | form_type | source | submission_id | first_name | last_name | dob | email | phone | candidate_count | passing_count | candidates_summary | match_reason
```

`candidates_summary` contains DrChrono candidate IDs only (e.g. `id=12345;id=67890`) — **never** full PHI of the wrong-patient candidates.

### D.2 `UploadFailures` tab

Created when DrChrono document upload fails. Columns:

```
timestamp | source | form_type | submission_id | patient_id | document_type | error
```

`document_type` is one of: `registration_pdf`, `consultation_pdf`, `insurance_card_front`, `insurance_card_back`.

### D.3 `source` column on `DrSnip_Intake_Sheet`

The new workflows write `source: "custom-app-v2"` or `"custom-app-v2-consultation"` into the existing audit tab. The existing tab already accepts arbitrary new columns via `mappingMode: autoMapInputData`, so this should just-work — but if the tab doesn't yet have a `source` column header, add one for cleanliness.

---

## E. Audit-found bugs fixed (vs. originals)

| # | Bug from `N8N_AUDIT.md` | Fix in v2 |
|---|---|---|
| 1 | Hardcoded JotForm `APIKEY: c23de1a3...` in Download File nodes | **Removed.** No JotForm fetch anywhere in v2. Insurance cards arrive as base64 inline; Consultation PDF generated in-process. |
| 2 | Consultation silent 200-OK on no-match / ambiguous | **Fixed.** Now writes to `ManualReview` tab + responds with explicit `manual_review_required: true`. |
| 3 | Two dead `Sheets: Fallback Log` nodes pointing at `REPLACE_WITH_SPREADSHEET_ID` placeholder | **Removed.** Real `UploadFailures` tab on the real Sheet. |
| 4 | Registration dup detection on name+DOB only, `results[0]` wins silently | **Fixed.** New `Disambiguate Patient` Code node: 0 matches → create; 1+ matches → require email OR phone to also match; ambiguous → manual review. |
| 5 | No webhook authentication | **Added.** `IF: Auth Check` compares `X-DrSnip-Token` header to `$env.DRSNIP_WEBHOOK_SECRET`. Failure → 401. |
| 6 | Consultation JotForm `generatePDF` HTTP call | **Removed.** New `Generate Consultation PDF` Code node — pure JS, in-process, no external service. |
| 7 | `q29_q29_textarea27` discarded by parser | N/A — payload shape is now custom-app native, all fields land in submission_full and are rendered into the PDF. |

`doctor: 324569` and `gender: Male` literals kept on Create Patient — both flagged in the audit as DrSnip-specific intentional defaults. Confirm with Jeff if you want office-based doctor routing or non-Male patients later.

---

## F. Smoke test results

| # | Test | Expected | Actual | Status |
|---|---|---|---|---|
| F.1 | Auth fail (wrong `X-DrSnip-Token`) | HTTP 401, `{"success":false,"error":"unauthorized"}` | Webhook returned empty body; IF: Auth Check throws `ExpressionError: access to env vars denied` at runtime — the `N8N_BLOCK_ENV_ACCESS_IN_NODE` block is still in effect on the running n8n process (3 retry attempts, executions 297/298/301). | ⏳ Blocked on §A |
| F.2 | Registration end-to-end (synthetic) | HTTP 200, `success:true`, `drchrono_action:"created"`, `documents_uploaded:1`, new DrChrono patient created | Not run — depends on F.1 passing | ⏳ Blocked on §A |
| F.3 | Consultation matched | HTTP 200, `success:true`, same patient_id as F.2 | Not run — depends on F.2 | ⏳ Blocked on §A |
| F.4 | Consultation manual review | HTTP 200, `success:false`, `reason:"manual_review_required"`, ManualReview Sheet row written | Not run — depends on F.1 passing | ⏳ Blocked on §A |

**Confirmation that the rest of the pipeline is sound** (validated without executing): every node accepted by n8n's validator except 1 false-positive on the PDF generator code (the validator can't fully reason about long nested-array PDF assembly; the identical pattern is in production today on the original Registration workflow). Both workflows are `active: true` in n8n.

**Once §A is verified live**, run these from any shell that can reach the n8n Fly app:

The auth check needs `$env.DRSNIP_WEBHOOK_SECRET` to resolve. Once Section A is done, run these from any shell that can reach the n8n Fly app:

### F.1 Auth fail

```sh
curl -sS -X POST 'https://n8n-drsnip.fly.dev/webhook/custom-registration-6fe129ab' \
  -H 'Content-Type: application/json' \
  -H 'X-DrSnip-Token: WRONG' \
  -d '{"submissionId":"test-auth-fail","formType":"registration"}' \
  -w '\nHTTP %{http_code}\n'
```

Expected: `HTTP 401`, body `{"success":false,"error":"unauthorized"}`.

### F.2 Registration end-to-end (creates a synthetic test patient in DrChrono)

Use a clearly synthetic name (`Zzz` / `SyntheticSmoketest`) so it's easy to delete after. See `f2_registration_payload.json` in the chat scrollback or build one yourself with:

```json
{
  "submissionId": "smoketest-reg-2026-05-27",
  "formType": "registration",
  "submittedAt": "2026-05-27T17:30:00Z",
  "patient": {
    "officeLocation": "Seattle, WA",
    "legalFirstName": "Zzz",
    "legalLastName": "SyntheticSmoketest",
    "preferredFirstName": "Smoke",
    "middleInitial": "X",
    "dateOfBirth": "1990-01-15",
    "streetAddress": "123 Smoke Test St",
    "city": "Seattle",
    "state": "WA",
    "postalCode": "98101",
    "phone": "(555) 010-0001",
    "email": "smoketest+reg-2026-05-27@example.invalid",
    "primaryCarePhysician": "Test PCP"
  },
  "consent": { "voicemail": true, "text": true },
  "medicalHistory": { "mhMentalIllness": { "answer": "No", "details": "" } },
  "insurance": { "status": "Self-pay" }
}
```

POST with the correct `X-DrSnip-Token`. Expected: HTTP 200, `success: true`,
`drchrono_action: "created"`, `documents_uploaded: 1`, a fresh
`patient_id`.

### F.3 Consultation matched (uses the patient from F.2)

Same identity (`Zzz SyntheticSmoketest`, same email/phone/DOB) so DrChrono's strict match passes. Expected: HTTP 200, `success: true`, `patient_id` matching F.2.

### F.4 Consultation manual review (no match)

Use a clearly-fake identity (`Nomatch Patient`, fake email/phone/DOB). Expected: HTTP 200, `success: false`, `reason: "manual_review_required"`, and a row appears in the `ManualReview` Sheet tab.

---

## G. DrChrono test patient cleanup

F.2 will create a real DrChrono patient. Identify and delete:

- **Search name:** `Zzz SyntheticSmoketest`
- **Email:** `smoketest+reg-2026-05-27@example.invalid`
- **DOB:** `1990-01-15`

Plus the registration PDF + any insurance card documents attached to that chart.

---

## H. Architecture diff vs. originals

### Registration v2 (22 nodes; original was 21)
```
Webhook → IF:AuthCheck ─false─→ Respond:Unauthorized (401)
                       ─true──→ Parse&Normalize          ← rewritten for custom-app shape
                                → Sheets:AuditLog (source=custom-app-v2)
                                → DrChrono:SearchPatient
                                → Disambiguate Patient   ← NEW: 0/1/many email+phone tighten
                                → IF:IsManualReview ─true─→ Sheets:ManualReview → Respond:ManualReview (200, success:false)
                                                    ─false→ IF:PatientExists?
                                                              ─true→ DrChrono:UpdatePatient ─┐
                                                              ─false→ DrChrono:CreatePatient ┴→ Resolve Patient ID
                                                                                              → Generate Registration PDF
                                                                                              → DrChrono:Upload Registration PDF
                                                                                              → IF:HasInsuranceCards? ─false→ Respond:Success
                                                                                                                     ─true→ Prepare Card Binaries (b64 decode, fan-out)
                                                                                                                            → DrChrono:Upload Card Document (per-card)
                                                                                                                            → IF:CardUploadFailed? ─true→ Sheets:UploadFailures → Respond:Success
                                                                                                                                                   ─false→ Respond:Success
```

### Consultation v2 (15 nodes; original was 12)
```
Webhook → IF:AuthCheck ─false─→ Respond:Unauthorized (401)
                       ─true──→ Parse&Normalize          ← rewritten for custom-app shape
                                → Sheets:AuditLog (source=custom-app-v2-consultation)
                                → DrChrono:SearchPatient (name only)
                                → Resolve Patient ID     ← strict DOB+email+phone match
                                → IF:IsManualReview ─true─→ Sheets:ManualReview → Respond:ManualReview (200, success:false)
                                                    ─false→ Generate Consultation PDF  ← NEW: in-process, no JotForm
                                                            → DrChrono:Upload Consultation PDF
                                                            → IF:UploadFailed? ─true→ Sheets:UploadFailures → Respond:Success
                                                                               ─false→ Respond:Success
```

---

## I. Verification — originals untouched

| Workflow | Pre-session `updatedAt` (audit) | Post-session `updatedAt` | Δ |
|---|---|---|---|
| `6warkNFZSSzuasMB` Patient Intake (JotForm) | 2026-05-09T02:29:42.393Z | 2026-05-09T02:29:42.393Z | ✅ unchanged |
| `xY1NOVVCflSyEme6` Consultation Intake (JotForm) | 2026-04-15T23:56:46.765Z | 2026-04-15T23:56:46.765Z | ✅ unchanged |
| `6warkNFZSSzuasMB` versionCounter | 610 | 610 | ✅ unchanged |
| `xY1NOVVCflSyEme6` versionCounter | 264 | 264 | ✅ unchanged |

Both originals remain `active: true` and continue to serve JotForm-driven traffic. The new `[Custom App]` workflows do not share webhook paths, secrets, or audit-sheet tabs with the originals.

---

## J. What's NOT done — your follow-up checklist

In order of priority:

1. **Flip `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` on the n8n Fly app** (§A). Until this is done, every POST gets a silent failure at the IF: Auth Check node.

2. **Create the two new Sheet tabs** in the audit Google Sheet (§D.1, §D.2): `ManualReview` and `UploadFailures`. Add the column headers listed. Without them, those branches still run but the row write fails silently.

3. **Wire the custom intake app to POST to these webhooks.** This session did NOT touch `Intake-form/api/submit.ts` or anywhere else in the custom app. The app still only writes to its own Postgres and admin console; it does not yet hit n8n. A future task needs to add a fire-and-forget POST from `submit.ts` to the appropriate `[Custom App]` webhook based on `formType`, including the `X-DrSnip-Token` header.

4. **Run the smoke tests in §F** once §A is done.

5. **Clean up the synthetic DrChrono test patient** after F.2 (§G).

6. **Rotate the webhook secret** after cutover is confirmed working (§B).

7. **Decide on `doctor: 324569` / `gender: Male` hardcodes** — keep, or wire to office routing / patient-provided gender.

8. **Build the reconciliation workflow** (audit §8.h carry-over) once the new pipeline is in production — daily scan that every recent Sheet row has a matching DrChrono patient + document.

---

## K. Where this leaves the architecture

- **JotForm path:** unchanged. JotForm → original Registration / Consultation workflows → DrChrono. Still serving production traffic.
- **Custom-app path:** custom app submits to its own DB → admin can view + download PDF. **n8n / DrChrono integration is BUILT but not yet wired from the app side.** After §A + §J.3 are done, the custom-app pipeline will also flow to DrChrono in parallel with JotForm.
- **Cutover:** when ready, deactivate the two JotForm workflows (don't delete — keep for rollback) and let only the `[Custom App]` workflows run. The JotForm webhook URLs can stay active for a grace period.

---

## L. 2026-05-27 patch — Respond:Success crash + doctor-friendly PDF

Manual smoke testing surfaced two issues in the v2 workflows after the
original cutover build. Both are fixed; originals remain untouched.

### L.1 Respond:Success unsafe expression — Registration v2

**Symptom (execution 305 on Registration v2):** every critical step succeeded
(patient created in DrChrono, registration PDF uploaded) but the final
`Respond: Success` node errored:

> An expression references this node, but the node is unexecuted. … There is
> no connection back to the node 'Prepare Card Binaries', but it's used in
> code here.

**Root cause:** the response-body expression referenced `Prepare Card
Binaries` unconditionally, even when the IF: Has Insurance Cards? branch went
FALSE and that node never executed. `$('Prepare Card Binaries').all` is no
longer a safe falsy check on n8n's current runtime — it throws.

**Fix:** swapped the unguarded reference for n8n's first-party `$if(node.isExecuted, …)` pattern (the hint in n8n's own error message):

```diff
- documents_uploaded: 1 + ($('Prepare Card Binaries').all ? $('Prepare Card Binaries').all().length : 0)
+ documents_uploaded: 1 + $if($('Prepare Card Binaries').isExecuted, $('Prepare Card Binaries').all().length, 0)
```

Applied via `n8n_update_partial_workflow` → `patchNodeField` on
`parameters.responseBody`.

**Consultation v2 — no fix needed.** Its `Respond: Success` body is
`documents_uploaded: 1` (literal) and the other expressions reference
`Parse & Normalize` + `Resolve Patient ID`, which always execute on the
non-manual-review branch. Audited — no unguarded conditionally-executed
references.

### L.2 Generate {Registration,Consultation} PDF — doctor-friendly rewrite

**Symptom:** the PDF attached to the test DrChrono patient (134346203) was
the original Phase-1 plain-text dump, not the Phase 3 doctor-friendly format
Jeff approved.

**Fix:** rewrote both Code nodes (pure JS, no npm) so they produce the
Phase-3 visual:

- Top blue brand band (#0F4C81), 80pt, full width.
- White "DrSnip" wordmark on the band + form-type badge top-right.
  - Wordmark deviation: rendered as bold white text rather than the embedded
    logo image, because Code-node base64 image embedding is fragile and the
    logo PNG file isn't reachable from the n8n process. The wordmark + brand
    color carry the identity. Logged as the only intentional deviation.
- Large centered patient legal name (24pt Helvetica-Bold).
- Registration: Age + DOB tiles only (Option A — no spouse, no Children).
- Consultation: spouse oblique line if a partner name was given, then Age +
  Children + DOB tiles.
- Submission timestamp + Submission ID below the tiles, both muted.
- Body sections: brand-color accent bar + bold blue heading + hairline rule.
- Each question/answer renders as a 2-column table row (label ~196pt, value
  ~296pt) with a hairline separator between rows. Medical-history "Yes"
  answers grouped with an italic explanation as a follow-on row, no rule in
  between.
- Consent labels render the full question text the patient saw (per Phase 3
  Jeff feedback).
- Consultation children block: per-child "Child N" with "Age X · Relation:
  Y · Gender: Z" (no Dependent column, per Phase 3).
- Footer on every page: "DrSnip Patient Intake — CONFIDENTIAL / PHI" left,
  "Page X of Y" centered, "Submission <id>" right.
- Pagination is atomic per row (no row splits mid-page).

**Implementation notes:**
- Pure-JS PDF 1.4 raw assembler with three standard fonts (Helvetica /
  Helvetica-Bold / Helvetica-Oblique) and `WinAnsiEncoding`. Special chars
  (em-dash, en-dash, smart quotes, middle dot, bullet) emitted as PDF
  octal escapes (`\227`, etc.) so they render correctly in DrChrono's PDF
  viewer.
- Approximate Helvetica character widths used for centering and wrapping
  (per-character heuristic — uppercase / lowercase / digits / punctuation).
  Visual smoke-tested via `sips` (macOS PDFKit) and the output matches the
  Phase 3 layout. `pdftotext`/`pdftoppm` render text as missing or
  question-marked because of poppler's standard-font handling, but DrChrono
  and Preview render correctly.
- Local Node smoke harness lives at `/tmp/drsnip-pdf-port/` (not committed):
  `registration_pdf.js`, `consultation_pdf.js`, plus `test_*.js`. Re-runnable
  with `node test_registration.js && node test_consultation.js`.
- Sizes: Registration PDF generator ~410 lines, Consultation ~440 lines.
  Both well under the 1,000-line ceiling.

**Validator status post-patch:**

| Workflow | valid | errors | warnings | jsCode validator note |
|---|---|---|---|---|
| Registration v2 (`H2HihkGKntbfRNcK`) | true | 0 | 51 | "Code nodes can throw errors" (generic) |
| Consultation v2 (`4UicLLZRRMeENXhx`) | true | 0 | 38 | "Code doesn't reference input data" (false positive — uses `$('Parse & Normalize')` / `$('Resolve Patient ID')`) |

All warnings are pre-existing (typeVersion drift, `continueOnFail` → `onError`
migration suggestions, Sheets `cachedResultName` cosmetic) and unrelated to
this patch.

### L.3 Smoke-test commands

Section A (env-flag flip) was completed in the previous session — both
workflows now resolve `$env.DRSNIP_WEBHOOK_SECRET` correctly. Run these from
any shell that can reach `https://n8n-drsnip.fly.dev`.

Save the secret once:

```sh
TOKEN='0609634797970ddd7bc4c82677d1904f958b41c55d6a5c621d23a74fd0a66e2f'
```

**L.3.a — Registration v2 end-to-end (no insurance cards).** Creates a
fresh DrChrono patient — flag for cleanup after.

```sh
curl -sS -X POST 'https://n8n-drsnip.fly.dev/webhook/custom-registration-6fe129ab' \
  -H 'Content-Type: application/json' \
  -H "X-DrSnip-Token: $TOKEN" \
  -d '{
    "submissionId": "smoketest-reg-2026-05-27-pdfv2",
    "formType": "registration",
    "submittedAt": "2026-05-27T18:00:00Z",
    "patient": {
      "officeLocation": "Seattle, WA",
      "legalFirstName": "Zzz",
      "legalLastName": "DocFriendlySmoketest",
      "preferredFirstName": "Smoke",
      "middleInitial": "X",
      "dateOfBirth": "1990-01-15",
      "streetAddress": "123 Smoke Test St",
      "addressLine2": "Apt 4",
      "city": "Seattle",
      "state": "WA",
      "postalCode": "98101",
      "phone": "(555) 010-0001",
      "email": "smoketest+reg-2026-05-27-pdfv2@example.invalid",
      "primaryCarePhysician": "Test PCP — Test Clinic"
    },
    "consent": {
      "voicemail": true,
      "text": true,
      "voicemailQuestion": "I consent to receiving detailed voicemails at the phone number provided.",
      "textQuestion": "I consent to receiving care-related text messages at the phone number provided."
    },
    "medicalHistory": {
      "mhMentalIllness":      { "answer": "Yes", "details": "Mild depression managed with therapy." },
      "mhPainSensitive":      { "answer": "No",  "details": "" },
      "mhFainting":           { "answer": "No",  "details": "" },
      "mhBleeding":           { "answer": "No",  "details": "" },
      "mhKidney":             { "answer": "No",  "details": "" },
      "mhSTI":                { "answer": "Yes", "details": "Chlamydia, 2019 — treated." },
      "mhTesticleAbnormality":{ "answer": "No",  "details": "" },
      "mhTesticleInjury":     { "answer": "No",  "details": "" },
      "mhSurgeries":          { "answer": "No",  "details": "" },
      "mhSurgyComplications": { "answer": "No",  "details": "" },
      "mhMedications":        { "answer": "Yes", "details": "Daily multivitamin." },
      "mhAspirin":            { "answer": "No",  "details": "" },
      "mhAllergies":          { "answer": "No",  "details": "" },
      "mhChronic":            { "answer": "No",  "details": "" }
    },
    "insurance": { "status": "Self-pay" }
  }' -w '\nHTTP %{http_code}\n'
```

**Expected:** HTTP 200, body `{"success":true,"submission_id":"smoketest-reg-2026-05-27-pdfv2","patient_id":<int>,"drchrono_action":"created","documents_uploaded":1,"manual_review_required":false}`. Record `<int>` for cleanup.

**L.3.b — Consultation v2 matched.** Re-use the exact identity from L.3.a so
the strict match (DOB + email + phone) passes.

```sh
curl -sS -X POST 'https://n8n-drsnip.fly.dev/webhook/custom-consultation-9f872020' \
  -H 'Content-Type: application/json' \
  -H "X-DrSnip-Token: $TOKEN" \
  -d '{
    "submissionId": "smoketest-consult-2026-05-27-pdfv2",
    "formType": "consultation",
    "submittedAt": "2026-05-27T18:05:00Z",
    "patient": {
      "firstName": "Zzz",
      "lastName": "DocFriendlySmoketest",
      "email": "smoketest+reg-2026-05-27-pdfv2@example.invalid",
      "phone": "(555) 010-0001",
      "dateOfBirth": "1990-01-15"
    },
    "aboutYou": {
      "occupation": "Software Engineer", "employer": "Acme Corp",
      "jobTitle": "Senior Engineer", "jobDemands": "Mostly desk"
    },
    "relationship": {
      "status": "Married",
      "partnerFirstName": "Jane", "partnerLastName": "Doe",
      "partnerPhone": "(555) 987-6543", "partnerShareConsent": true,
      "partnerAge": 38, "partnerOccupation": "Teacher",
      "partnerEducation": "Masters", "yearsInRelationship": 12,
      "marriageNumberSelf": 1, "marriageNumberSpouse": 1
    },
    "children": {
      "count": 2,
      "details": [
        { "age": 8, "relation": "biological", "gender": "male" },
        { "age": 5, "relation": "biological", "gender": "female" }
      ]
    },
    "familyPlanning": {
      "wantMoreChildren": "No", "considerAdoption": "No",
      "vasectomyConsideredDuration": "6 months"
    },
    "birthControl": {
      "consideredTubal": "No", "consideredTemporaryBC": "Yes",
      "currentBC": ["Condoms"], "currentBCOther": "",
      "priorBC": ["Birth control pills"]
    },
    "medicalPersonal": {
      "religionConflict": "No",
      "sexualConcerns": "No", "sexualConcernsDetails": "",
      "geneticCondition": "No", "geneticConditionDetails": ""
    },
    "emergencyReferral": {
      "name": "Jane Doe", "phone": "(555) 987-6543",
      "relationship": "Spouse",
      "howHeard": "TV", "howHeardOther": "",
      "referringProfessional": "",
      "additionalNotes": "Looking forward to the consultation."
    }
  }' -w '\nHTTP %{http_code}\n'
```

**Expected:** HTTP 200, body `{"success":true,"submission_id":"smoketest-consult-2026-05-27-pdfv2","patient_id":<same int from L.3.a>,"documents_uploaded":1,"manual_review_required":false}`.

**L.3.c — Consultation v2 manual review** (no DrChrono match).

```sh
curl -sS -X POST 'https://n8n-drsnip.fly.dev/webhook/custom-consultation-9f872020' \
  -H 'Content-Type: application/json' \
  -H "X-DrSnip-Token: $TOKEN" \
  -d '{
    "submissionId": "smoketest-consult-2026-05-27-nomatch-pdfv2",
    "formType": "consultation",
    "submittedAt": "2026-05-27T18:10:00Z",
    "patient": {
      "firstName": "Nomatch",
      "lastName": "FakeIdentity",
      "email": "nomatch-2026-05-27@example.invalid",
      "phone": "(555) 999-9999",
      "dateOfBirth": "1900-01-01"
    }
  }' -w '\nHTTP %{http_code}\n'
```

**Expected:** HTTP 200, body `{"success":false,"reason":"manual_review_required","submission_id":"smoketest-consult-2026-05-27-nomatch-pdfv2","candidate_count":0,"match_reason":"no_candidates_from_search"}`. A row appears on the `ManualReview` Sheet tab.

### L.4 Visual verification after L.3.a / L.3.b

1. Open the newly created DrChrono patient `Zzz DocFriendlySmoketest`.
2. Download `Registration Intake (custom app v2)` document. Confirm:
   - Blue header band, "DrSnip" wordmark, "Registration Intake" badge.
   - Large patient name centered.
   - Age + DOB tiles (no Children tile, no spouse line).
   - 7 medical sections, each with the brand-color accent + tabular rows.
   - Mental-illness Yes row followed by italic explanation row.
   - Footer on every page with submission ID.
3. Download `Consultation Intake (custom app v2)` document. Confirm:
   - "Consultation Intake" badge.
   - Spouse: Jane Doe oblique line.
   - Age + Children + DOB tiles.
   - 7 sections (About You / Relationship / Children / Family Planning /
     Birth Control / Medical & Personal / Emergency Contact & Referral).
   - Per-child row with "Age N · Relation: X · Gender: Y".

### L.5 DrChrono test-patient cleanup

L.3.a creates a real DrChrono patient. After verification, delete:

- **Search name:** `Zzz DocFriendlySmoketest`
- **Email:** `smoketest+reg-2026-05-27-pdfv2@example.invalid`
- **DOB:** `1990-01-15`

Plus the Registration PDF + Consultation PDF documents attached to that
chart. Note that the **prior** test patient (`Zzz SyntheticSmoketest` from
the original cutover session, DOB 1990-01-15) and **execution 305's patient
(DrChrono patient 134346203)** are still in DrChrono and should be deleted
too if not already cleaned up.

### L.6 Originals — untouched

| Workflow | Pre-patch `updatedAt` | Post-patch `updatedAt` | Δ |
|---|---|---|---|
| `6warkNFZSSzuasMB` Patient Intake (JotForm) | 2026-05-09T02:29:42.393Z | 2026-05-09T02:29:42.393Z | ✅ unchanged |
| `xY1NOVVCflSyEme6` Consultation Intake (JotForm) | 2026-04-15T23:56:46.765Z | 2026-04-15T23:56:46.765Z | ✅ unchanged |

Both originals remain `active: true` and serve JotForm traffic. The
`[Custom App]` workflow webhooks, audit-sheet tabs, and secret are
unchanged — only the `Generate {Registration,Consultation} PDF` Code nodes
and the Registration `Respond: Success` `responseBody` expression were
patched.
