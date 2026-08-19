# DrSnip — n8n bridge & DrChrono investigation for insurance chart creation

**Date:** 2026-08-19 · **Posture:** READ-ONLY. Zero mutations in the repo, the n8n instance, the
database, or DrChrono. No test submissions. No DrChrono API calls of any kind (all DrChrono facts
below come from documentation or from production artifacts already recorded in this repo).
**PHI:** no patient values anywhere in this document. **Secrets:** no credential values, webhook
secrets, or tokens — credentials are referenced by n8n id/name only.

**Purpose:** produce the map and the architecture recommendation that Trains C (insurance →
DrChrono chart), D (card images → DrChrono documents), and E (chart-linked notification) will be
built from, so that each build prompt can be written from this document alone.

---

## TL;DR

1. **Insurance is excluded in the APP, before the bridge — not in a workflow.**
   [`api/submit.ts:242`](Intake-form/api/submit.ts#L242) branches on `body.formType === "insurance"`
   and never enters `runN8nBridge`. Every n8n call in the app lives inside
   [`lib/n8n/bridge.ts`](Intake-form/lib/n8n/bridge.ts), which that branch never reaches. **The two
   production workflows contain no insurance logic at all** — they cannot, because no insurance
   payload has ever been sent to them. Adding a separate insurance enqueue leaves the registration
   and consultation workflows byte-identical.

2. **Additive is not just the bias — it is the only defensible shape.** A new
   `[Custom App] DrSnip Insurance v1` workflow on its own webhook, its own `Respond` nodes, its own
   Gmail nodes. Branching inside Registration v2 would require editing `Parse & Normalize`,
   `Disambiguate Patient` and `Resolve Patient ID` — the three nodes that decide which chart a form
   is attached to. Recommendation in §2.

3. **The insurance form already collects everything DrChrono needs to create a chart.** The
   gender/sex gap flagged in `insurance-form-recon-2026-07-25.md` §3 was **closed when the form
   shipped**: `sex` is collected and **required**
   ([`Insurance.tsx:77`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L77),
   [`:233`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L233)), as are DOB and a full
   structured address. Per DrChrono's own docs only `doctor` and `gender` are strictly required on
   `POST /api/patients`. **There is no required-field gap.**

4. **The dangerous interaction is not the create — it is what happens on the patient's SECOND
   form.** An inquirer whose chart is created by Train C, who later completes Registration, will
   take the **UPDATE** branch and receive the *"Returning DrSnip patient … attached to their
   existing chart"* email on their first real registration. That branch also carries the live
   create-vs-update ZIP asymmetry (`verification-test-2026-07-20.md`), which can turn a would-be
   success into `n8n_status='failed'`. Full analysis in §3.

5. **Do not put card bytes in the insurance webhook payload.** Base64 cards inside n8n execution
   records are what made registration executions 38–85 MB and OOM-killed production n8n twice
   (`notification-audit-2026-07-13.md` §0). Both production workflows still run
   `saveDataSuccessExecution: "all"`. Recommendation: n8n pulls the bytes from a **new
   service-token-authed internal endpoint** on the app, and the insurance workflow ships with
   `saveDataSuccessExecution: "none"` — the precedent the Insurance Notify workflow already set. §4.

6. **The chart deep link is `https://app.drchrono.com/patients/<patient_id>`** — in production use
   since June 2026 in two Gmail nodes, and confirmed against a real chart id in
   `verification-test-2026-07-20.md`. §5.

7. **Observed bridge latency is 5s, not 30s.** Registration median **5.35 s**, p95 **7.68 s**
   (n=30 live executions, 2026-08-18/19). One outlier at **188.6 s** — longer than the app's 30 s
   abort — proves the double-send case Train E must tolerate. §6.

8. **Sequencing: C → D → E is correct, with one amendment — D's transport work must be designed
   during C, not after it.** §8.

---

## 1. The bridge as it exists

### 1.1 Enqueue mechanics (app side)

| Aspect | Value | Citation |
|---|---|---|
| Entry point | `POST /api/submit` | [`api/submit.ts:77`](Intake-form/api/submit.ts#L77) |
| Body validation | zod object, `.passthrough()`; `formType` enum is `["registration","consultation","insurance"]` | [`api/submit.ts:60-75`](Intake-form/api/submit.ts#L60-L75) |
| Ordering | DB row commits **and the 200 is sent** before any n8n call | [`api/submit.ts:186-187`](Intake-form/api/submit.ts#L186-L187) |
| Dispatch | fire-and-forget `void runN8nBridge(...)` after the response | [`api/submit.ts:257`](Intake-form/api/submit.ts#L257) |
| Kill switch | `N8N_BRIDGE_ENABLED !== "true"` ⇒ every call is a no-op returning `failed / "bridge disabled"` | [`bridge.ts:55`](Intake-form/lib/n8n/bridge.ts#L55), [`bridge.ts:284-291`](Intake-form/lib/n8n/bridge.ts#L284-L291) |
| Webhook URLs | `N8N_WEBHOOK_REGISTRATION_URL`, `N8N_WEBHOOK_CONSULTATION_URL` | [`bridge.ts:56-57`](Intake-form/lib/n8n/bridge.ts#L56-L57) |
| Auth | header `X-DrSnip-Token: $N8N_WEBHOOK_SECRET` | [`bridge.ts:131`](Intake-form/lib/n8n/bridge.ts#L131) |
| Timeout | `AbortController`, **30 000 ms** | [`bridge.ts:62`](Intake-form/lib/n8n/bridge.ts#L62), [`bridge.ts:124-125`](Intake-form/lib/n8n/bridge.ts#L124-L125) |
| Never throws | every path returns an `N8nOutcome` | [`bridge.ts:18-44`](Intake-form/lib/n8n/bridge.ts#L18-L44) |

**Webhook shape (live, verified against the n8n instance today):**

| Route | Workflow | id | Webhook path | Method | Response mode |
|---|---|---|---|---|---|
| Registration | `[Custom App] DrSnip Registration v2` | `H2HihkGKntbfRNcK` | `/webhook/custom-registration-6fe129ab` | POST | `responseNode` |
| Consultation | `[Custom App] DrSnip Consultation v2` | `4UicLLZRRMeENXhx` | `/webhook/custom-consultation-9f872020` | POST | `responseNode` |
| Insurance notify | `[Custom App] DrSnip Insurance Notify` | `VhHMOWKHrbxDt0bj` | `/webhook/custom-insurance-notify-8fa21c` | POST | `responseNode` |
| Error notify | `[Custom App] DrSnip — Error Notify` | `5oQPdAMJOfBgR8OJ` | (Error Trigger, no webhook) | — | — |

Host is `https://n8n-drsnip.fly.dev` (documented in [`fly.toml:14-15`](Intake-form/fly.toml#L14-L15)).

**Payload shape.** Pure mappers, no I/O:
`buildRegistrationPayload` ([`payload.ts:227-311`](Intake-form/lib/n8n/payload.ts#L227-L311)) emits
`{submissionId, formType:"registration", submittedAt, patient{…15 fields}, consent{4},
medicalHistory{14 keyed {answer,details}}, insurance{status,provider,memberId,groupId,cardFront?,cardBack?}}`.
`buildConsultationPayload` ([`payload.ts:317-443`](Intake-form/lib/n8n/payload.ts#L317-L443)) emits the
consultation contract (`aboutYou`, `relationship`, `children`, `familyPlanning`, `birthControl`,
`medicalPersonal`, `medicalHistory` (3 keys), `emergencyReferral`), plus optional `patientId`.

One mapping quirk worth carrying into any new builder: the local key `mhSurgeryComplications` is
re-keyed to the JotForm typo `mhSurgyComplications` on the way out
([`payload.ts:176`](Intake-form/lib/n8n/payload.ts#L176)) because n8n's `Parse & Normalize` expects it
(`MEDICAL_ORDER` entry, live node source).

**Card bytes today.** Cards are attached to the *registration* payload only when `base64Data` is
present and non-empty ([`payload.ts:292-308`](Intake-form/lib/n8n/payload.ts#L292-L308)). The bridge
logs a non-PHI `cards_outbound` breadcrumb (count / with_bytes / total_kb) before posting
([`bridge.ts:313-337`](Intake-form/lib/n8n/bridge.ts#L313-L337), [`:360-368`](Intake-form/lib/n8n/bridge.ts#L360-L368)).
Consultation has no card path.

### 1.2 Registration v2 — node-by-node (live graph, 29 nodes / 23 connections)

```
Webhook (custom-registration-6fe129ab, responseNode, onError=continueRegularOutput)
  └─ IF: Auth Check            headers['x-drsnip-token'] == $env.DRSNIP_WEBHOOK_SECRET
       ├─ false → Respond: Unauthorized (401)
       └─ true  → Parse & Normalize (Code)
            └─ Sheets: Audit Log (append, continueOnFail=true)
                 └─ DrChrono: Search Patient   GET /api/patients?first_name&last_name&date_of_birth
                    (continueOnFail=true, cred oAuth2Api vCwf0HNhIwA3cFV1 "DRSNIP-CHRONO")
                      └─ Disambiguate Patient (Code)  → match_outcome ∈ create|update|manual_review
                           └─ IF: Is Manual Review?
                                ├─ true  → Sheets: ManualReview → Gmail: Notify Review → Respond: Manual Review (200)
                                └─ false → IF: Patient Exists?  (match_outcome == 'update')
                                     ├─ true  → DrChrono: Update Patient  PATCH /api/patients/{id}
                                     └─ false → DrChrono: Create Patient  POST /api/patients
                                        (both onError=continueErrorOutput → error output ⇒ Gmail: Notify Failure → Respond: Failed (500))
                                          └─ Resolve Patient ID (Code)  → {patient_id, drchrono_action}
                                               ├─ Generate Registration PDF (Code, ~16 KB source)
                                               │    └─ DrChrono: Upload Registration PDF
                                               │       POST /api/documents (multipart, continueOnFail=true)
                                               │         └─ IF: Has Insurance Cards?
                                               │              ├─ true  → Prepare Card Binaries (Code)
                                               │              │            └─ DrChrono: Upload Card Document
                                               │              │               POST /api/documents (multipart, continueOnFail=true)
                                               │              │                 └─ IF: Card Upload Failed?
                                               │              │                      ├─ true  → Sheets: UploadFailures → Gmail: Notify Upload Failure → Respond: Success
                                               │              │                      └─ false → Respond: Success (200)
                                               │              └─ false → Respond: Success (200)
                                               └─ IF: New Patient Created?  (drchrono_action == 'created')
                                                    ├─ true  → Gmail: Notify patientmail          ("New DrSnip patient …")
                                                    └─ false → Gmail: Notify Returning Patient    ("Returning DrSnip patient …")
```

**Match / create / update logic — `Disambiguate Patient` (live source).** Search is by
`first_name + last_name + date_of_birth`. Each returned candidate passes only if
`email` matches (case-insensitive, trimmed) **OR** digit-normalized phone matches. Then:

| candidates | passing | `match_outcome` | `match_reason` |
|---|---|---|---|
| 0 | — | `create` | `no_candidates_create_new` |
| ≥1 | exactly 1 | `update` | `unique_disambiguated_match` |
| 1 | 0 | `manual_review` | `single_candidate_failed_disambiguation` |
| >1 | 0 | `manual_review` | `no_candidate_passed_disambiguation` |
| ≥2 | >1 | `manual_review` | `multiple_candidates_passed_disambiguation` |

`Resolve Patient ID` merges the DrChrono response back: on `update` it prefers the disambiguated id
(PATCH can return an empty body), on `create` it takes `drchrono.id`, and it stamps
`drchrono_action ∈ {'updated','created'}`.

**PDF attachment step.** `Generate Registration PDF` (Code) produces a binary on field `pdf`;
`DrChrono: Upload Registration PDF` POSTs `multipart/form-data` to `https://app.drchrono.com/api/documents`
with `patient`, `description: "Registration Intake (custom app v2)"`, `document` (formBinaryData
from `pdf`), `doctor: 324569`, `date: {{ $now.format('yyyy-MM-dd') }}`.

**Card attachment step.** `Prepare Card Binaries` (Code) reads `insurance_card_{front,back}_b64`
from `Parse & Normalize` and emits **one item per card present**, each with binary field `data`
and json `{patient_id, submission_id, card_side, document_type}`. `DrChrono: Upload Card Document`
POSTs each to `/api/documents` with `description: "Insurance card ({{ card_side }} — custom app intake)"`.

**Error branches.** Four distinct ones:
- **Auth fail** → `Respond: Unauthorized` 401.
- **Manual review** → Sheets row + `Gmail: Notify Review` (to `patientmail@` + `raunek@`) + `Respond: Manual Review` **200** with `{success:false, reason:"manual_review_required", …}`.
- **Patient create/update error** (`onError: continueErrorOutput`) → `Gmail: Notify Failure` → `Respond: Failed` **500**.
- **Document upload error** (`continueOnFail: true` on both upload nodes) → `IF: Card Upload Failed?` → Sheets row + `Gmail: Notify Upload Failure` → *still* `Respond: Success`. **A failed card/PDF upload is reported to the app as success.**

**Workflow settings:** `executionOrder: v1`, `saveDataSuccessExecution: "all"`,
`saveDataErrorExecution: "all"`, `saveManualExecutions: true`, `errorWorkflow: 5oQPdAMJOfBgR8OJ`.

### 1.3 Consultation v2 — node-by-node (live graph, 18 nodes)

Same head (Webhook → Auth → Parse & Normalize → Sheets: Audit Log → DrChrono: Search Patient), then:

```
DrChrono: Search Patient   GET /api/patients?first_name&last_name        ← NOTE: no date_of_birth
  └─ Resolve Patient ID (Code)   strict: DOB AND email AND phone must all match
       └─ IF: Is Manual Review?
            ├─ true  → Sheets: ManualReview → Gmail: Notify Review → Respond: Manual Review (200)
            └─ false → Generate Consultation PDF (Code)
                         └─ DrChrono: Upload Consultation PDF  POST /api/documents (continueOnFail=true)
                              └─ IF: Upload Failed?
                                   ├─ true  → Sheets: UploadFailures → Gmail: Notify Upload Failure
                                   └─ false → Respond: Success (200)
```

Consultation **never creates a patient** — it is match-only. Outcomes are `matched` or
`manual_review`. Same settings block including `errorWorkflow: 5oQPdAMJOfBgR8OJ`.

The two rules differ, deliberately (documented in `failure-analysis-2026-07-24.md` §4):

| Form | Search keys | Pass condition | Can create? |
|---|---|---|---|
| Registration | name + **DOB** | email **OR** phone | yes |
| Consultation | name only | DOB **AND** email **AND** phone | no |

### 1.4 Write-back to the app

`runN8nBridge` ([`api/submit.ts:325-370`](Intake-form/api/submit.ts#L325-L370)) awaits the bridge and
writes four columns in one UPDATE ([`:336-345`](Intake-form/api/submit.ts#L336-L345)):

| Column | Source | Notes |
|---|---|---|
| `n8n_status` | `outcome.status` ∈ `success` / `manual_review` / `failed` | classified from the response body: `success===true` ⇒ `success`; `success===false && reason==='manual_review_required'` ⇒ `manual_review`; anything else ⇒ `failed` ([`bridge.ts:65-77`](Intake-form/lib/n8n/bridge.ts#L65-L77)). `'not_applicable'` is also written, by the insurance skip path only. |
| `n8n_patient_id` | `response.patient_id`, coerced number-or-numeric-string | [`bridge.ts:198-206`](Intake-form/lib/n8n/bridge.ts#L198-L206); `bigint` column ([`schema/submissions.ts:66`](Intake-form/lib/db/src/schema/submissions.ts#L66)) |
| `n8n_response_at` | `new Date()` at write time | — |
| `n8n_response_body` | `{bridge_status, error_message?, response?, diagnostic?}` | [`api/submit.ts:376-382`](Intake-form/api/submit.ts#L376-L382) |

**`action_label` is NOT an app column and is never written back.** It is derived in the PHI-free
reporting VIEW ([`mcp/drsnip-reporting/sql/001_reporting_view_and_role.sql:98-106`](Intake-form/mcp/drsnip-reporting/sql/001_reporting_view_and_role.sql#L98-L106)):

```sql
CASE WHEN n8n_status='manual_review' THEN 'manual_review'
     WHEN n8n_status='failed'        THEN 'failed'
     WHEN n8n_status IS NULL         THEN 'pending'
     WHEN form_type='consultation'   THEN 'matched'
     WHEN lower(n8n_response_body->'response'->>'drchrono_action') IN ('created','create') THEN 'create'
     WHEN lower(n8n_response_body->'response'->>'drchrono_action') IN ('updated','update') THEN 'update'
     ELSE 'unknown' END
```

⚠️ **This CASE is a Train C landmine.** An insurance row with `n8n_status='success'` that is neither
`consultation` nor carries a `drchrono_action` falls to **`'unknown'`**. If the insurance workflow's
`Respond: Success` emits `drchrono_action`, it lands in `create`/`update` and silently pollutes the
new-vs-returning *patient* metric with *inquirer* rows. Either way the view needs an explicit
`form_type='insurance'` branch, applied in the same train that starts writing those rows.

### 1.5 Retry behavior

**There is none, at any layer.**
- App: single `fetch`, no retry loop, no queue, no replay job, no admin "re-run" button
  ([`bridge.ts:117-282`](Intake-form/lib/n8n/bridge.ts#L117-L282)).
- n8n: every node has `retryOnFail` unset. HTTP nodes use `continueOnFail`/`onError` to *route*
  failures, never to retry them.
- The n8n webhook is not idempotent: a replay would re-run search → create/update → re-upload the PDF.
  (`verification-test-2026-07-20.md` records a real chart that ended up with **2 registration PDFs**
  after two submissions.)

### 1.6 Known failure modes

| # | Mode | Symptom in the app | Alerted? | Evidence |
|---|---|---|---|---|
| F1 | **Bridge never reaches n8n** (n8n restart, network, DNS) | `n8n_status='failed'`, `diagnostic.kind='fetch'` | **No.** No n8n execution exists, so no n8n email fires and the Error Trigger cannot fire either. | `failure-analysis-2026-07-24.md` §6; [`bridge.ts:247-278`](Intake-form/lib/n8n/bridge.ts#L247-L278) |
| F2 | **Process dies before write-back** | `n8n_status` stays **NULL forever** ("pending") | **No.** | `failure-analysis-2026-07-24.md` §6. Aggravated by [`fly.toml:49-51`](Intake-form/fly.toml#L49-L51) (`auto_stop_machines=true`, `min_machines_running=0`) — the bridge runs *after* the response, so a machine that idles down can kill it in flight. |
| F3 | **App aborts at 30 s while n8n keeps going** | `n8n_status='failed'`, `errorMessage='timeout after 30000ms'`, but the chart **was** created | **No** (n8n reports success) | Observed: exec **2409** ran **188.6 s** (2026-08-18T20:58:40Z→21:01:49Z), 1 of 30 sampled |
| F4 | **Disambiguation miss** → manual review | `n8n_status='manual_review'` | Yes — `Gmail: Notify Review` | `failure-analysis-2026-07-24.md` §3: 6/6 sampled were this class; rate flat at ~8–9% |
| F5 | **DrChrono create/update rejects** | `n8n_status='failed'`, `diagnostic.kind='http'`, HTTP 500 from `Respond: Failed` | Yes — `Gmail: Notify Failure` | `failure-analysis-2026-07-24.md` §2: 2 organic in 30 days |
| F6 | **create-vs-update ZIP asymmetry** | update path 400s on sentinel ZIP `00000`; create path accepts it | Yes (as F5) | `verification-test-2026-07-20.md` — `{"zip_code":"Unknown or invalid ZIP code"}` on PATCH. Sentinel is set by `Parse & Normalize` when the address can't be parsed. |
| F7 | **Document upload fails** | app records **`success`** | Yes — `Gmail: Notify Upload Failure` + Sheets row | `continueOnFail:true` on both upload nodes; `IF: Card Upload Failed?` routes to `Respond: Success` regardless |
| F8 | **n8n OOM from base64 in execution records** | webhook 502 / n8n restart ⇒ F1 for concurrent traffic | No | `notification-audit-2026-07-13.md` §0: 38–85 MB executions, machine OOM-killed twice; since scaled to 4 GB/2 vCPU (`failure-analysis-2026-07-24.md` header) |
| F9 | **`errorWorkflow` doesn't fire** | Error Notify has **0 executions ever**, `triggerCount: 0` | — | Confirmed live today. Matches the standing note that an `errorWorkflow` bound via the API persists but does not fire; bind in the UI or use inline `onError`. |
| F10 | **Misconfiguration** (missing URL/secret, kill switch off) | `n8n_status='failed'`, `diagnostic.kind='config'` | No | [`bridge.ts:284-308`](Intake-form/lib/n8n/bridge.ts#L284-L308) |

**Observed latency (live, read-only, execution metadata only — no payloads fetched):**

| Workflow | n | min | median | p90 | p95 | max |
|---|---|---|---|---|---|---|
| Registration `H2Hih…` | 30 (2026-08-18→19) | 2.32 s | **5.35 s** | 7.68 s | 7.83 s | **188.56 s** (1 outlier) |
| Registration, excl. outlier | 29 | 2.32 s | 5.35 s | — | 7.68 s | 7.85 s |
| Consultation `4UicL…` | 15 (2026-08-17→19) | 1.64 s | **4.15 s** | — | — | 5.47 s |

`n8n_executions(status='error')` across the whole instance returns **0 rows** — consistent with
`failure-analysis-2026-07-24.md`: DrChrono errors are swallowed by `onError: continueErrorOutput`
and manual review is a normal branch, so **n8n execution status can never surface a bad outcome.**
The app's `n8n_status` column and the Gmail alerts are the only outcome record.

### 1.7 Where the insurance form_type diverges — **ANSWER: in the app, before enqueue**

[`api/submit.ts:242-264`](Intake-form/api/submit.ts#L242-L264):

```ts
if (body.formType === "insurance") {
  void markBridgeSkipped(submissionId);          // → n8n_status = 'not_applicable'
  void notifyInsuranceSubmission({ … });         // → console-link doorbell email
} else {
  void runN8nBridge(submissionId, body)…         // ← the ONLY caller of lib/n8n/bridge.ts
}
```

The comment at [`:237-241`](Intake-form/api/submit.ts#L237-L241) states this explicitly: *"the bridge
must be unreachable for form_type 'insurance' by construction — the only calls into n8n live inside
runN8nBridge, and this branch never enters it."*

**Consequences that follow, all verified:**
- No insurance payload has ever reached Registration v2 or Consultation v2. Neither workflow contains
  a `form_type` branch of any kind.
- Insurance rows carry `n8n_status='not_applicable'` and
  `n8n_response_body={bridge_status:'not_applicable', reason:'phase1_insurance_no_workflow'}`
  ([`api/submit.ts:304-323`](Intake-form/api/submit.ts#L304-L323)).
- `lib/n8n/payload.ts` has **no** insurance builder.
- Card bytes for insurance submissions **are** stored (see §4) but are dropped from the bridge path
  entirely, because there is no bridge path.

**Therefore: a parallel enqueue targeting a NEW workflow leaves the two existing workflows
byte-identical.** This is the positive-finding shape the brief asked for, and it holds.

---

## 2. Additive vs shared — **recommendation: fully separate workflow**

### Can it be provably additive?

Yes. The isolation boundary already exists in three places and none of them need to move:

1. **App:** the `else` branch at [`api/submit.ts:256`](Intake-form/api/submit.ts#L256) is untouched;
   Train C only replaces the *body* of the `if (insurance)` branch.
2. **Transport:** a new env var `N8N_WEBHOOK_INSURANCE_URL` + a new `callN8nInsurance` in
   `lib/n8n/bridge.ts` reusing `postToN8n`. `callN8nRegistration` / `callN8nConsultation` are not
   edited. (`postToN8n` is already shared and parameterized by URL —
   [`bridge.ts:117-122`](Intake-form/lib/n8n/bridge.ts#L117-L122).)
3. **n8n:** a new workflow id. The two production workflow JSONs are never opened.

Provability: snapshot `versionId` + `updatedAt` for `H2HihkGKntbfRNcK` and `4UicLLZRRMeENXhx` before
the train and re-read after. Unchanged ⇒ proven. (Today: Registration
`updatedAt 2026-07-20T22:19:20.751Z`, Consultation `updatedAt 2026-07-20T22:19:29.233Z`.)

### Why not a branch inside Registration v2

An insurance branch inside Registration v2 would have to modify, at minimum:
`Parse & Normalize` (different payload shape: nested `insurance.primary/secondary`, `sex`, no
medical history, no consents), `Disambiguate Patient` (different search/attach semantics),
`Resolve Patient ID`, `IF: Has Insurance Cards?` (four card slots, not two), `Generate Registration
PDF` (wrong template), and every `Respond` node (different response contract). **Those are exactly
the nodes that decide which patient chart a form is attached to.** Editing them puts ~400
registrations/month and the daily consultation flow at risk to add a third, lower-volume path. The
recon doc reached the same conclusion independently (`insurance-form-recon-2026-07-25.md` §4:
*"branching inside registration would tangle the matching logic"*).

**No evidence was found that overrules the additive bias.** Recommendation stands: a new
`[Custom App] DrSnip Insurance v1` workflow, modelled on Registration v2 but with its own nodes,
its own webhook path, its own Sheets tab, and its own Gmail nodes.

**Deliberate sharing (unavoidable, and acceptable):** the DrChrono OAuth2 credential
(`vCwf0HNhIwA3cFV1`), the Gmail OAuth credential (`66n9Hae31tNosGib`), the Google Sheets credential
(`hQTs0UCcXWEtQ3j0`), the spreadsheet `1EOmhE2wcDW45MUHdF3ffLhzACRq7CBc_qlq4YkOfUbI`, the
`DRSNIP_WEBHOOK_SECRET` env var, the doctor id `324569`, and the n8n machine itself. Each is a
blast-radius item — see §7.

---

## 3. Chart creation for insurance

### 3.1 What DrChrono needs vs what the insurance form collects

Per DrChrono's API reference (`app.drchrono.com/api-docs-old/`), `POST /api/patients` marks only
**two** fields required: `doctor` ("ID of the patient's primary provider") and `gender`
(`"Male"` | `"Female"` | `"Other"`). Everything else — including `first_name`, `last_name`,
`date_of_birth` — is documented optional. In practice the production create node sends 12 fields
and DrChrono's *update* path additionally validates `zip_code` (see F6).

| DrChrono create field (as sent by Registration v2) | Insurance form supplies? | Citation |
|---|---|---|
| `first_name`, `last_name` | ✅ required | [`Insurance.tsx:228-229`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L228-L229) |
| `date_of_birth` | ✅ **required** — deliberate deviation from the Jotform, "DrChrono matching needs it"; `DatePicker` emits `YYYY-MM-DD`, same as registration | [`Insurance.tsx:232`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L232), [`DatePicker.tsx:14`](Intake-form/artifacts/intake-form/src/components/ui/DatePicker.tsx#L14) |
| `gender` | ✅ **required** — `SEX_OPTIONS = ["Male","Female","Other"]`, exactly DrChrono's enum | [`Insurance.tsx:77`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L77), [`:233`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L233) |
| `email`, `cell_phone` | ✅ required | [`Insurance.tsx:230-231`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L230-L231) |
| `address`, `city`, `state`, `zip_code` | ✅ all four **required and structured** — so the `00000`/`Unspecified` sentinel path is not reachable from this form | [`Insurance.tsx:235-238`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L235-L238) |
| `doctor` | ➖ constant `324569`, as in both existing workflows | live node config |
| `nick_name` (preferred first name) | ❌ not collected | — (registration sends it; optional) |

**There is no required-field gap.** The `gender` gap that
`insurance-form-recon-2026-07-25.md` §3 flagged as "likely the main gap" was closed when the form
shipped; the form's own comment records it as a deliberate deviation *"Required per the brief for
future profile creation."* Registration-only data (medical history, consents, PCP, middle initial)
is genuinely absent, but none of it is required by DrChrono.

**Insurance-specific data with no DrChrono home yet.** The form collects, per carrier
(primary required, secondary optional): carrier, subscriber first/last, policy no, group no,
subscriber DOB, relationship-to-patient ([`Insurance.tsx:100-116`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L100-L116),
payload at [`:284-312`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L284-L312)).
Registration's DrChrono mapping carries **no** insurance fields at all — the four registration
insurance fields go into the PDF, not into DrChrono structured fields. **Open question** on whether
Train C should write DrChrono's insurance objects or follow registration's precedent and put them in
a generated PDF (see OPEN QUESTIONS).

### 3.2 How the match logic behaves across a patient's two forms

This is the part with real risk. Two directions:

**(a) Inquirer first (insurance creates a chart), registers later.**

Registration v2 searches `first_name + last_name + date_of_birth` and passes a candidate on
`email OR phone`. The chart Train C created carries the same name, DOB, email and phone — all from
the same person filling the same identity block.

- ⇒ exactly 1 passing candidate ⇒ `match_outcome='update'` ⇒ **PATCH**, not POST.
- ⇒ `drchrono_action='updated'` ⇒ `IF: New Patient Created?` false ⇒ **`Gmail: Notify Returning
  Patient`**: *"Returning DrSnip patient — … (ready to schedule) … This is a returning patient —
  their form has been attached to their existing chart in DrChrono."*
- ⇒ reporting view `action_label='update'` ⇒ counted as a **returning** patient.

**Both are wrong from the practice's point of view: this is a brand-new patient completing their
first registration.** Nothing breaks technically, but the staff email says the opposite of the truth
and the new-vs-returning metric shifts by however many inquirers convert. This is the single
largest behavioral side effect of Train C, and it lands on the *untouched* registration path.

Second-order: the UPDATE branch is where the ZIP asymmetry lives (F6). If the registration form's
freeform street blob fails to parse and `Parse & Normalize` substitutes `zip_code='00000'`, the
PATCH 400s — a submission that today would have succeeded as a create instead **fails**, emails
`Gmail: Notify Failure`, and records `n8n_status='failed'`. Train C converts a latent edge into a
live one for every converting inquirer.

Mitigations to decide between (this is a build decision, stated here so the Train C prompt can carry it):
- **M1 — accept it**, and reword `Gmail: Notify Returning Patient` to be honest about the case.
  Cheap, but it edits a Registration v2 node, which breaks the "byte-identical" guarantee.
- **M2 — accept it and leave Registration v2 alone**, documenting the mislabel for staff. Zero risk,
  wrong-sounding email.
- **M3 — don't create charts for inquirers at all** (match-only, consultation-style), and attach the
  insurance PDF/cards only when a chart already exists. Kills the mislabel and the ZIP exposure —
  but it also fails the client's stated ask, since most inquirers have no chart yet.
- **M4 — tag inquirer-created charts in DrChrono** (a metatag on the document, or a chart flag) so
  staff can tell them apart. Depends on the OPEN QUESTION below.

Recommendation: **M2 for Train C, revisit M1/M4 in Train E** — because Train E is already opening
the notification surface, and a wording change is safer to make there than mid-C.

**(b) Registrant first, insurance inquiry later.**

The chart already exists with name/DOB/email/phone. A Train C workflow that mirrors Registration's
rule (search name+DOB, pass on email OR phone) finds exactly 1 passing candidate ⇒ attach to the
existing chart. Correct, low-risk. The only hazard is a **duplicate chart** if the insurance search
is looser or stricter than registration's and misses — hence:

> **Design constraint for Train C:** the insurance workflow's search + disambiguation must be a
> *character-for-character copy* of Registration v2's `Disambiguate Patient`, including the
> `email OR phone` pass rule and the DOB-in-search requirement. Any divergence risks a second chart
> for a patient who already has one — the worst failure this system can produce short of attaching
> a form to the wrong chart. **DOB stays mandatory in the search and the pass rule; no "2 of 3"
> and no fuzzy matching** (the family-member mis-attach risk is documented in
> `failure-analysis-2026-07-24.md` §4 and is not negotiable).

---

## 4. Card images into DrChrono

### 4.1 What DrChrono offers

`POST https://app.drchrono.com/api/documents`, `multipart/form-data`. Documented fields: `patient`
(int), `doctor` (int), `date` (date), `description` (string), `document` (file), `metatags` (array,
optional). *"Files are passed using multipart/form-data encoding, but returned as URLs."*
The docs **do not publish a file-type allowlist or a size limit**.

**Auth scope:** the docs list the required scope for `/api/documents` as **`patients`** — the same
scope the existing credential already exercises. Stronger evidence than the docs: the existing
`DRSNIP-CHRONO` credential (`vCwf0HNhIwA3cFV1`) **already uploads both PDFs and card images to
`/api/documents` in production today**, from both workflows. **No new scope, no new credential, no
DrChrono-side change is needed for Train D.** (Verified by reading the live node configs; no API
call was made.)

Practical constraints to carry, from this repo rather than the docs:
- App-side accepted MIME set: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`,
  `application/pdf` ([`card-files.ts:14-21`](Intake-form/api/_lib/card-files.ts#L14-L21)).
- App-side size caps: client/schema **5 MB** per card
  ([`api/submit.ts:48`](Intake-form/api/submit.ts#L48)), storage defense-in-depth **10 MB**
  ([`card-files.ts:13`](Intake-form/api/_lib/card-files.ts#L13)).
- HEIC (iPhone default) is *accepted and stored* but is not browser-renderable
  ([`card-files.ts:25-30`](Intake-form/api/_lib/card-files.ts#L25-L30)). Whether DrChrono renders
  HEIC in the chart is **UNVERIFIED** — see OPEN QUESTIONS.
- A community report of `502` timeouts on large `POST /api/documents` uploads exists
  (drchrono-api Google Group, "File Upload Timeout - POST /api/documents (502)"). Treat >5 MB as
  risky; the existing 5 MB client cap is a reasonable ceiling.

### 4.2 Where the bytes live today

Since 2026-08-17 (`fb99e6e`), card bytes are persisted to Postgres:
`storeSubmissionFiles` ([`card-files.ts:65-115`](Intake-form/api/_lib/card-files.ts#L65-L115)) runs
after the response ([`api/submit.ts:204`](Intake-form/api/submit.ts#L204)), decodes base64, classifies
(`stored` / `too_large` / `rejected` / `failed`) and inserts into `submission_files`
(`bytea` column, [`schema/submission-files.ts:21-41`](Intake-form/lib/db/src/schema/submission-files.ts#L21-L41)).
Four slots are recognized: `insurance_front`, `insurance_back`, `partner_front`, `partner_back`
([`card-files.ts:70-75`](Intake-form/api/_lib/card-files.ts#L70-L75)) — the insurance form maps
primary→`insuranceCard*` and secondary→`partnerInsuranceCard*`
([`Insurance.tsx:117-124`](Intake-form/artifacts/intake-form/src/pages/Insurance.tsx#L117-L124)).
Bytes are stripped from `raw_payload` by `sanitizeForPersistence`
([`api/submit.ts:391-421`](Intake-form/api/submit.ts#L391-L421)).

They are served by exactly one route: `GET /api/files/:id`, **session-cookie auth only**
(`requireAuth` at [`api/files/[id].ts:20`](Intake-form/api/files/[id].ts#L20); cookie name
`cjc_admin_session`, [`_lib/auth.ts:18`](Intake-form/api/_lib/auth.ts#L18)). n8n has no session and
cannot call it today.

### 4.3 The three transport options

| Option | How | Verdict |
|---|---|---|
| **A. bytes-in-webhook-payload** (what registration does) | app base64s the cards into the insurance payload; workflow decodes in a `Prepare Card Binaries` clone | **Reject.** This is the mechanism that produced 38–85 MB n8n execution records and OOM-killed production n8n twice (`notification-audit-2026-07-13.md` §0). Insurance carries up to **four** cards vs registration's two, so it is strictly worse. It also means PHI card images sit in n8n's execution store. |
| **B. direct Postgres read from n8n** | a Postgres node in the insurance workflow selects `bytes` from `submission_files` | **Reject.** Grants n8n a DB credential with read access to a PHI table — a second, weaker path into patient data alongside the app's own auth, outside the reporting view's PHI boundary. Also requires n8n to reach `drsnip-intake-db.flycast` (same-Fly-org reachability is plausible but **UNVERIFIED**). Not worth the boundary erosion. |
| **C. n8n pulls from a new service-token internal endpoint** ✅ | new `GET /api/internal/submission-files/:submissionId` (list) and `GET /api/internal/files/:id` (bytes), authenticated by a **new** shared secret header (e.g. `X-DrSnip-Service-Token`), separate from `N8N_WEBHOOK_SECRET`; workflow calls them with an HTTP Request node and pipes the binary straight into `/api/documents` | **Recommend.** |

**Why C:** it keeps bytes out of the webhook payload *and* out of n8n's execution store (an HTTP
Request node's binary output is only persisted if execution saving is on — so pair it with
`saveDataSuccessExecution: "none"`, exactly what the Insurance Notify workflow already does). It
reuses the existing shared-secret pattern the bridge already proves
([`bridge.ts:131`](Intake-form/lib/n8n/bridge.ts#L131)). It adds no DB credential to n8n. It gives a
single auditable app-side chokepoint for card-byte egress, which the compliance story wants. And the
per-file cap stays the existing 5 MB, well under the 502-timeout risk zone.

**Sizing:** 4 cards × ≤5 MB = ≤20 MB moved per insurance submission, in four separate HTTP fetches
rather than one 27 MB base64 blob (base64 inflates by ~33%). Each `/api/documents` POST stays a
single-file multipart, matching what production already does successfully.

**Sequencing note:** the endpoint in option C must be **built in Train C or before**, even though it
is only *used* in Train D — because whether the insurance payload carries bytes changes the Train C
payload contract. See §8.

---

## 5. Chart deep links

**Pattern: `https://app.drchrono.com/patients/<patient_id>`**

Evidence (production, not documentation):
- Live node `Gmail: Notify patientmail` (Registration v2): `Open in DrChrono: https://app.drchrono.com/patients/{{ $('Resolve Patient ID').item.json.patient_id }}`
- Live node `Gmail: Notify Returning Patient` (Registration v2): same pattern.
- Rendered against a real chart and recorded verbatim in `verification-test-2026-07-20.md`:
  `https://app.drchrono.com/patients/135211892` for the chart created during that test.

In production use since 2026-06-25 (`notification-audit-2026-07-13.md` §1 pins the cutover) and
delivered on 193/193 returning-patient notifications since, with no report of a broken link.

⚠️ **UNVERIFIED against documentation.** DrChrono publishes no deep-link URL spec; a web search for
one returns only the iframe-embed contract (`?doctor_id&patient_id&practice_id&iat&jwt`), which is a
different mechanism. **Manual check for Raunek (30 seconds, no data created):** open
`https://app.drchrono.com/patients/135211892` while signed in to DrChrono and confirm it lands on the
patient chart. (That is the QA chart from the July test, flagged for deletion — if it has since been
deleted, use any real chart id instead.) If a more specific sub-page is wanted (e.g. the Documents
tab, so staff land directly on the uploaded card), capture that URL from the browser at the same time.

---

## 6. Notification timing

### 6.1 Where the insurance notification fires today

**In the app, at submit time, before anything touches DrChrono.**
[`api/submit.ts:250-255`](Intake-form/api/submit.ts#L250-L255) calls `notifyInsuranceSubmission`
inside the insurance branch, fire-and-forget.

- Builder is pure and whitelist-narrow: `{submissionId, name, office, submittedAt}` in ⇒
  `{subject, body}` out ([`insurance-notify.ts:62-76`](Intake-form/lib/n8n/insurance-notify.ts#L62-L76)).
- Body: *"<name> submitted an insurance form on <Aug 16, 2:14 PM PT> (<office>). View it here:
  <base>/admin/submissions/<id>"* — **a console link, never a chart link**
  ([`insurance-notify.ts:69-75`](Intake-form/lib/n8n/insurance-notify.ts#L69-L75)).
- Transport: POST to `N8N_WEBHOOK_INSURANCE_NOTIFY_URL` with `X-DrSnip-Token`, 15 s timeout
  ([`insurance-notify.ts:85-88`](Intake-form/lib/n8n/insurance-notify.ts#L85-L88),
  [`:105`](Intake-form/lib/n8n/insurance-notify.ts#L105)), landing on workflow `VhHMOWKHrbxDt0bj`
  (Webhook → Auth → `Gmail: Notify patientmail` → `Respond: Sent`), which sends the app-supplied
  subject/body verbatim via the shared Gmail credential to `patientmail@drsnip.com`.
- Missing URL ⇒ clean skip, not an error ([`insurance-notify.ts:140-143`](Intake-form/lib/n8n/insurance-notify.ts#L140-L143)).
- A one-shot, dry-run-by-default backfill exists for the Aug-12→Aug-17 gap
  ([`api-server/backfill-insurance-notify.ts`](Intake-form/api-server/backfill-insurance-notify.ts)).

Note the contrast with registration/consultation, where the *n8n* Gmail nodes are the real sender.
The app's own `lib/email/patientmail.ts` path is gated on `PATIENTMAIL_TO` and is a documented no-op
in production (`[patientmail] skipped no_recipient` is expected, not a bug) — it also only fires on
`shouldNotify(status) === (status === 'success')`
([`patientmail.ts:78-80`](Intake-form/lib/email/patientmail.ts#L78-L80),
[`api/submit.ts:360-369`](Intake-form/api/submit.ts#L360-L369)).

### 6.2 Train E — moving the send into the bridge, with a guaranteed fallback

**Evaluation: yes, do it — but implement the fallback as a mutually-exclusive app-side branch, not
as a timer.**

Recommended shape:

- **Success path (chart link).** The insurance workflow gains its own `Gmail: Notify patientmail
  (insurance)` node downstream of `Resolve Patient ID`, carrying
  `https://app.drchrono.com/patients/{{ patient_id }}` **plus** the console link (the
  `Gmail: Notify Returning Patient` node is the exact template to copy — it already carries both).
  The app-side `notifyInsuranceSubmission` call moves *out* of the pre-bridge position.
- **Fallback path (console link).** The app keeps `notifyInsuranceSubmission` but fires it **only
  when the bridge did not report success** — i.e. keyed on the same `outcome.status` the app already
  computes at [`api/submit.ts:331-334`](Intake-form/api/submit.ts#L331-L334):

  ```
  if (outcome.status === 'success')  → workflow already emailed (chart link). App sends nothing.
  else                               → app sends the console-link doorbell it sends today.
  ```

**How the fallback is triggered — precisely.** Not by a separate timer. The existing 30 s
`AbortController` in `postToN8n` **is** the timeout: on abort, `catch` returns
`{status:'failed', errorMessage:'timeout after 30000ms', diagnostic.kind:'fetch'}`
([`bridge.ts:247-278`](Intake-form/lib/n8n/bridge.ts#L247-L278)), `runN8nBridge` resumes, and the
`else` branch above fires. The same branch covers non-2xx, connection refused, kill-switch-off and
missing-config — every failure mode in §1.6 that leaves the app with a non-`success` outcome. The two
senders are mutually exclusive by construction, which is the property that makes "guaranteed" true.

**What timeout is sane.** **Keep 30 s.** Observed registration latency is median 5.35 s / p95 7.68 s
(§1.6); 30 s is already ~4× p95. Insurance will run *longer* than registration once card uploads are
added (up to 4 documents vs 2), so shortening it would be actively wrong. Do **not** raise it either:
30 s is comfortably inside any reverse-proxy limit and the cost of the rare timeout is one extra
email, not a lost submission.

**The one hole, stated plainly.** F3 (§1.6): the 188.6 s outlier. When n8n exceeds 30 s the app sends
the console-link fallback *and* n8n later sends the chart-link email — **two emails for one
submission.** Observed rate ≈ 1/30 (~3%) on registration. This is the correct trade (a duplicate
beats a silent miss), but the fallback body must be worded so a duplicate reads sensibly — e.g.
*"…is being processed; open it in the console"* rather than *"…failed"*. Rewording the existing
`buildInsuranceNotification` body is a small, pure, unit-testable change
([`insurance-notify.ts:62-76`](Intake-form/lib/n8n/insurance-notify.ts#L62-L76) — the builder is
already exported precisely so its content whitelist can be asserted).

**Latency numbers cited are from n8n execution metadata, not the reporting view.** The reporting view
does expose `observed_latency_seconds` and `bridge_elapsed_ms`
([`001_reporting_view_and_role.sql:108-112`](Intake-form/mcp/drsnip-reporting/sql/001_reporting_view_and_role.sql#L108-L112)),
but the reporting MCP (`claude.ai dr-snip-demo`) is **not authenticated in this session** and the DB
is on Fly's private network. **UNVERIFIED / manual check:** run
`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY observed_latency_seconds), percentile_cont(0.95) WITHIN GROUP (ORDER BY observed_latency_seconds), max(observed_latency_seconds) FROM drsnip_reporting_view WHERE n8n_status='success' AND created_at >= current_date - 30;`
against the reporting role to confirm the app-observed distribution matches the n8n-observed one
above. Expect app-observed to be slightly *higher* (it includes network + write-back).

---

## 7. Blast-radius audit

Everything below could break registration/consultation chart creation if the recommended approach
were implemented carelessly. Each row names the guardrail the corresponding build train must carry.

| # | Hazard | How it breaks reg/consult | Guardrail (per train) |
|---|---|---|---|
| B1 | Editing Registration v2 / Consultation v2 to "reuse" a node | Any change to `Parse & Normalize`, `Disambiguate Patient`, `Resolve Patient ID` changes which chart a form attaches to | **C/D/E:** do not open `H2HihkGKntbfRNcK` or `4UicLLZRRMeENXhx`. Snapshot `versionId` + `updatedAt` before and after each train; both unchanged is an acceptance test. Export JSON to `n8n-rollback/` before any train that touches n8n at all. |
| B2 | Shared DrChrono OAuth credential `vCwf0HNhIwA3cFV1` | A third workflow hitting the same credential adds refresh contention and rate-limit pressure; a revoked/re-authed credential takes down all three paths at once | **C:** reuse the credential (a second DrChrono app would be worse), but keep insurance's DrChrono call count minimal and add **no** polling. Do not re-authenticate the credential during a train. |
| B3 | Shared Gmail credential `66n9Hae31tNosGib` | Gmail per-user send quota is shared; an insurance email storm (e.g. a retry loop) throttles the registration alerts that staff depend on | **C/E:** no retries on Gmail nodes; `onError: continueRegularOutput` on every new Gmail node, matching existing practice. |
| B4 | Shared spreadsheet `1EOmhE2wcDW45MUHdF3ffLhzACRq7CBc_qlq4YkOfUbI` | Appending insurance rows to the existing `DrSnip_Intake_Sheet` / `ManualReview` / `UploadFailures` tabs changes column semantics staff read daily | **C:** new tabs (e.g. `InsuranceAudit`, `InsuranceManualReview`), never the existing three. All Sheets nodes `continueOnFail: true`, as today. |
| B5 | n8n machine capacity | Card bytes in execution records OOM the shared machine; an OOM during a registration submission = F1/F8 for that patient, silently | **D:** transport option C (§4) + `saveDataSuccessExecution: "none"` on the insurance workflow. Never fetch a production execution payload during verification. |
| B6 | `DRSNIP_WEBHOOK_SECRET` / `N8N_WEBHOOK_SECRET` | Rotating or mistyping it 401s **all** webhooks at once | **C:** reuse the existing secret for the insurance webhook (no rotation); introduce the card-fetch service token as a **separate** variable so a card-path problem can't 401 the bridge. |
| B7 | `runN8nBridge`'s shared `else` branch | Refactoring the dispatch at [`api/submit.ts:242-264`](Intake-form/api/submit.ts#L242-L264) into a generic switch risks routing a registration to the wrong URL | **C:** add the insurance call inside the existing `if` branch only; leave `else` textually unchanged. Diff review on `api/submit.ts` must show zero lines changed in the `else`. |
| B8 | `lib/n8n/bridge.ts` shared helpers | Changing `postToN8n`, `classify`, `TIMEOUT_MS` or `outcomeForDb` to suit insurance changes registration behavior | **C:** add `callN8nInsurance` as a new exported function; treat `classify` ([`bridge.ts:65-77`](Intake-form/lib/n8n/bridge.ts#L65-L77)) and `TIMEOUT_MS` as frozen. If insurance needs a different response contract, make the insurance workflow conform to the existing one instead. |
| B9 | Inquirer→registrant flow (§3.2a) | Converting inquirers arrive at Registration v2 as **UPDATE**, exposing them to the ZIP-asymmetry 400 (F6) and to the wrong "returning patient" email | **C:** ship with this explicitly documented; add a `diag`/reporting check for a rise in registration `failed` with `diag_http_status='400'` in the two weeks after Train C. **E:** revisit the email wording. |
| B10 | Duplicate charts | An insurance disambiguation rule that diverges from registration's creates a second chart for an existing patient | **C:** copy `Disambiguate Patient` verbatim; DOB mandatory in both search and pass rule; no 2-of-3, no fuzzy. Acceptance test: a fabricated identity matching an existing test chart must resolve to `update`, not `create`. |
| B11 | `action_label` CASE in the reporting view | Insurance rows fall to `'unknown'` or, worse, pollute `create`/`update` patient counts | **C:** update the CASE with an explicit `form_type='insurance'` branch **in the same train** that starts writing insurance `success` rows. The view is `CREATE OR REPLACE` and idempotent. |
| B12 | `n8n_status='not_applicable'` disappearing | Anything reading that value (admin badge fallthrough, the failed/pending digest `WHERE n8n_status IS NULL OR = 'failed'`) changes meaning when insurance starts writing real statuses | **C:** treat the transition as a data-model change; confirm the digest query and the admin badge behave for the new values before enabling. |
| B13 | Kill switch coverage | `N8N_BRIDGE_ENABLED` currently gates *all* n8n calls; wiring insurance under it means disabling insurance disables registration too — and vice versa | **C:** add a **separate** `N8N_INSURANCE_BRIDGE_ENABLED` flag so insurance can be killed without touching registration. This is the workflow-level kill switch the brief asks for; the n8n-side complement is deactivating `Insurance v1` alone. |
| B14 | Fly machine auto-stop | `auto_stop_machines=true` / `min_machines_running=0` ([`fly.toml:49-51`](Intake-form/fly.toml#L49-L51)) can kill post-response work → F2 | **C/D/E:** every train that adds post-response async work (card fetches, extra emails) increases the window. Consider `min_machines_running = 1` as a separate, one-line ops change — flagged, not actioned. |

---

## 8. Sequencing check

**Confirmed: C → D → E, with one amendment.**

- **C before D** is right. D (card documents) needs `patient_id`, which only exists once C creates or
  matches the chart. Building D first would have nowhere to attach.
- **D before E** is right. E's whole value is the chart link; sending it before documents land means
  staff open a chart that is still missing the card. Also, E is the only train that should touch
  notification wording, and it benefits from knowing what D actually produced.
- **C before E** is right, and additionally: E should not move the send into the workflow until C's
  success path is stable, or a C-side bug turns into a *missing* notification rather than a
  mislabeled one. The current pre-bridge send is a safe floor to keep until then.

**Amendment — one piece of D must be designed during C.** The card-transport decision (§4, option C)
determines the Train C payload contract: whether `buildInsurancePayload` carries `base64Data` or
carries only a `submissionId` that n8n later dereferences. Deciding that in D means either rewriting
C's payload builder and workflow parse node, or shipping C with bytes-in-payload and inheriting the
OOM risk. **Build the internal card-fetch endpoint and its service-token auth in Train C** (unused
until D), and have C's payload deliberately carry **no** card bytes.

No argument was found for combining or reordering the trains beyond this.

---

## Recommended architecture, per train

### Train C — insurance → DrChrono chart

- **App:** `N8N_WEBHOOK_INSURANCE_URL` + `N8N_INSURANCE_BRIDGE_ENABLED`; new `callN8nInsurance` in
  `lib/n8n/bridge.ts` reusing `postToN8n` unchanged; new `buildInsurancePayload` in
  `lib/n8n/payload.ts` (identity + `sex` + structured address + nested `insurance.primary/secondary`,
  **no card bytes**); inside the existing `if (formType === 'insurance')` branch, replace
  `markBridgeSkipped` with the real bridge call + the same four-column write-back `runN8nBridge`
  already performs. `else` branch untouched.
- **n8n:** new workflow `[Custom App] DrSnip Insurance v1`, new webhook path, `saveDataSuccessExecution: "none"`,
  inline `onError` (not `errorWorkflow` — F9), nodes: Webhook → IF: Auth Check → Parse & Normalize →
  Sheets: InsuranceAudit → DrChrono: Search Patient (**name + DOB**) → Disambiguate Patient
  (**verbatim copy**) → IF: Is Manual Review? → IF: Patient Exists? → Update/Create Patient →
  Resolve Patient ID → Respond: Success/Manual Review/Failed, response contract **identical** to
  Registration v2's so `classify()` needs no change.
- **Also in C:** the internal card-fetch endpoint + service token (unused until D); the
  `action_label` CASE branch for `form_type='insurance'`.
- **Not in C:** card uploads, PDF generation, chart-linked email.

### Train D — card documents

- **App:** nothing new if C shipped the endpoint; otherwise build it.
- **n8n:** append to Insurance v1 — `HTTP: List Submission Files` → `IF: Has Cards?` → per-file
  `HTTP: Fetch Card Bytes` → `DrChrono: Upload Card Document` (multipart, `continueOnFail: true`,
  `description: "Insurance card (<slot>) — custom app intake"`) → `IF: Upload Failed?` →
  `Sheets: InsuranceUploadFailures` + `Gmail: Notify Upload Failure` → Respond: Success.
  Mirrors Registration v2's card branch exactly, minus the base64-in-payload step.
- **Open:** whether an insurance PDF (carrier/policy/subscriber summary) should also be uploaded,
  as registration does. See OPEN QUESTIONS.

### Train E — chart-linked notification

- **n8n:** new `Gmail: Notify patientmail (insurance)` in Insurance v1, downstream of
  `Resolve Patient ID`, template copied from `Gmail: Notify Returning Patient`, carrying both the
  DrChrono chart link and the console link; recipient `patientmail@drsnip.com` only (PHI-carrying
  emails go to patientmail@ only — the `+ raunek@` CC is reserved for the PHI-free alert emails).
- **App:** gate `notifyInsuranceSubmission` on `outcome.status !== 'success'`; reword its body to the
  neutral "is being processed" form so the ~3% duplicate reads correctly.
- **Timeout:** unchanged at 30 s.

---

## OPEN QUESTIONS — for Raunek / the client

1. **Should inquirer-created charts be distinguishable in DrChrono?** A chart created from an
   insurance inquiry is not a registered patient. Options: a `metatags` value on the uploaded
   document, a distinct `description` prefix, a DrChrono patient flag/tag, or nothing. This changes
   Train C's create payload and cannot be inferred.
2. **The "returning patient" mislabel (§3.2a).** Accept it (M2), reword the registration email (M1,
   requires touching Registration v2), or tag charts (M4)? Recommend M2 for C, decide in E.
3. **Should insurance data be written to DrChrono's structured insurance objects, or only rendered
   into a PDF?** Registration's precedent is PDF-only — DrChrono receives no insurance fields today.
   Writing structured insurance requires new endpoints and a new scope question; PDF-only matches
   the existing pattern and needs no new DrChrono surface.
4. **Should Train D also upload an insurance summary PDF** (carrier / policy / group / subscriber /
   relationship, primary + secondary), the way registration uploads a registration PDF? If yes it is
   a new `lib/pdf` template plus an `INSURANCE_SECTIONS` layout — a Train D scope increase.
5. **Does DrChrono render HEIC document uploads?** iPhone default capture is HEIC; the app accepts
   and stores it. If DrChrono does not render it, Train D needs server-side transcoding to JPEG,
   which is a meaningful scope addition. Cheapest resolution: Raunek uploads one HEIC to a scratch
   chart manually and looks at it — that is a deliberate write, so it needs an explicit go-ahead.
6. **Canonical console domain.** `insurance-notify.ts` falls back to
   `https://drsnip-intake-demo.fly.dev` when `PUBLIC_APP_URL` is unset
   ([`insurance-notify.ts:35-39`](Intake-form/lib/n8n/insurance-notify.ts#L35-L39)), while the n8n
   Gmail nodes hardcode `https://intake.doctorsnip.com`
   (`domain-hardcode-sweep-2026-07-20.md`). Train E introduces a *third* place a console URL is
   composed. The canonical-domain decision is still pending and should be made before E ships.
7. **Should Train C backfill the existing insurance submissions** (everything since the Aug 12 embed
   go-live, currently `n8n_status='not_applicable'`) into DrChrono charts? If yes, a dry-run-first
   script in the shape of `backfill-insurance-notify.ts` is the right pattern — but it creates real
   charts, so it needs an explicit decision and a controlled run.
8. **Is `min_machines_running = 1` acceptable** (cost) to close the F2 post-response-work window?
   Ops decision, not a build decision.

---

## Verification appendix

**Verified live, read-only, this session (n8n REST via MCP; zero writes):**
workflow list; `H2HihkGKntbfRNcK` structure (29 nodes / 23 connections) + full config of Webhook,
IF: Auth Check, all four DrChrono HTTP nodes, all six IF nodes, all four Respond nodes, all five
Gmail nodes, all three Sheets nodes, and the Code nodes `Parse & Normalize`, `Disambiguate Patient`,
`Resolve Patient ID`, `Prepare Card Binaries`; `4UicLLZRRMeENXhx` selected nodes; `VhHMOWKHrbxDt0bj`
and `5oQPdAMJOfBgR8OJ` in full; execution **metadata** for 30 registration + 15 consultation runs and
an instance-wide `status='error'` query. **No execution payload was fetched** — the OOM incident in
`notification-audit-2026-07-13.md` §0 makes that unsafe, and metadata was sufficient.

**Verified from the repo:** every `file:line` citation above.

**Verified from documentation:** DrChrono `POST /api/documents` field set and multipart encoding;
`POST /api/patients` required fields (`doctor`, `gender`); the `patients` scope requirement for
`/api/documents` — all from `app.drchrono.com/api-docs-old/`. The current `app.drchrono.com/api-docs/`
is a JS app and returned no extractable text.

**UNVERIFIED, with the manual check named in-line:**
(a) the chart deep-link URL against documentation — §5;
(b) app-observed latency percentiles from `drsnip_reporting_view` — §6.2;
(c) n8n → `drsnip-intake-db.flycast` network reachability — §4.3 option B (moot if option C is taken);
(d) DrChrono HEIC rendering and any `/api/documents` size limit — OPEN QUESTIONS 5.

**Zero DrChrono API calls were made.** No test submissions. No workflow was opened for edit,
activated, deactivated, or exported to the instance. Nothing was created in production.
