# Feasibility: pulling patient statements from DrChrono via API

**Date:** 28 October 2026 · **Asked by:** Jeff · **Mode:** read-only investigation, nothing built

## Verdict

**There is no native statement endpoint. A statement can be rebuilt from billing data, but our token can't read that data yet. Verdict: "Yes, needs scope `billing:read` + `billing:patient-payment:read`".**

- In DrChrono, a patient statement is a screen feature (Billing → Patient Statements → *Print Itemized Statement*, *Print PDF*, or *Mail Statements* through DMA at $0.90 each). It is not part of the API. DrChrono's public API schema has no statement resource and no endpoint that returns a statement PDF or URL.
- The data a statement is made from *is* in the API: billing line items, insurance transactions and patient payments. Each line item already carries a DrChrono-computed **patient balance** (`balance_pt`).
- **Live probe, test chart 135620405 only:** the token is valid (`/api/users/current` returned 200). `/api/line_items` and `/api/patient_payments` both returned **403** *"You do not have permission to perform this action."* No billing data came back, so the field lists below are **from the docs, not observed**.
- To get past the 403, **Jeff** must grant the two billing scopes. Jeff owns the `DRSNIP-CHRONO` n8n credential and the DrChrono login behind it. The DrChrono user may also need billing permission at the account level. From outside, a 403 doesn't tell us which of the two is missing; the same thing happened with `settings:read` on 23 Sep.

## 1. What DrChrono exposes (public docs, no login needed)

Source: DrChrono's OpenAPI schema `https://app.drchrono.com/openapi-schema` (v4 "Hunt Valley", fetched today), plus DrChrono's support articles on Patient Statements.

| Endpoint | Method | Scope | Returns | Patient filter | Use for a statement |
|---|---|---|---|---|---|
| *(statement)* | — | — | **does not exist** | — | — |
| `/api/line_items` | GET | `billing:read` | JSON | `patient`, `appointment`, `since`, `service_date`, `posted_date` | Charges: `service_date`, `code`, `description`, `billed`, `allowed`, `adjustment`, `ins1/2/3_paid`, `pt_paid`, **`balance_pt`**, `balance_ins`, `balance_total`, `billing_status`, `insurance_status` |
| `/api/transactions` | GET | `billing:read` | JSON | **no patient filter**, only `line_item`, `appointment`, `since` | Insurer payments and adjustments: `ins_paid`, `adjustment`, `adjustment_group_code`, `adjustment_reason`, `check_date`, `claim_status`, `ins_name` (1 = primary, 2 = secondary) |
| `/api/patient_payments` | GET | `billing:patient-payment:read` *(separate scope)* | JSON | `patient`, `since`, `posted_date` | `amount`, `payment_method`, `payment_transaction_type` (credit / refund / correction / copay / coinsurance), `posted_date`, `received_date`, `line_item` |
| `/api/line_item_deletions` | GET | `billing:read` | JSON | `appointment_id`, `since` | Needed by any sync so deleted charges don't linger |
| `/api/eobs` | GET | `billing:read` | JSON (+ `scanned_eob` file link) | doctor only | Context only; not needed for a statement |
| `/api/day_sheet_charges`, `/api/day_sheet_patient_payments` | GET | legacy `billing` | **response undocumented** | `patient_id` | Not probed; the response shape is unknown |
| `/api/line_items_list`, `/api/transactions_list` | GET/POST | `billing:read` | async batch (uuid) | — | Bulk alternative for a large batch |
| `/api/appointments` | GET | `calendar:read` *(we have it)* | JSON | `patient` | `billing_status`, `first_billed_date`, `last_billed_date`, which probably refer to claims, not statements |
| `/api/doctor_options` | GET | `user:read` *(we have it)* | JSON | — | `patient_statement_office`: the remit-to office printed on statements |

Write variants (POST/PUT/DELETE) exist on several of these. We don't need them and shouldn't ask for them.

## 2. Our access

- The intake app has **no DrChrono credential**. Every DrChrono call goes through the n8n OAuth2 credential `DRSNIP-CHRONO`, owned by Jeffery Cho.
- n8n's API never returns a credential's scopes. The last recorded grant was `user:read patients:read patients:write patients:summary:read patients:summary:write clinical:read clinical:write calendar:read`. **Neither billing scope is on that list, and today's 403s are consistent with that.**
- **Adding a scope means someone clicks through DrChrono's OAuth consent while logged in as the practice user. That someone is Jeff.**
  - Re-authorising `DRSNIP-CHRONO` itself replaces the token used by the five live intake workflows and the appointment sync, and it can't be rolled back.
  - **Recommended instead:** create a *second* n8n OAuth credential, `DRSNIP-CHRONO-BILLING-RO`, that requests only `billing:read billing:patient-payment:read user:read`. Jeff authorises it once (about 10 minutes, with us on the call). The intake token is never touched.
  - If the 403 continues after that, the DrChrono user also needs billing permission in DrChrono's staff settings.

## 3. Live probe (28 Oct 2026, 23:21 UTC)

- **Setup:** a temporary n8n workflow referenced `DRSNIP-CHRONO` by ID, so the secret was never extracted. Every call was hard-wired to `patient=135620405`, and the webhook took no input.
  - An in-workflow sanitiser returned only the HTTP status, content type, field names and types. Field values never left n8n.
  - Execution retention was off. The workflow was deactivated and deleted straight after; no executions were stored.
  - Workflows were 19 before and 19 after, with no `updatedAt` changes. The credential's `updatedAt` was unchanged.
- **Results:**

  | Call | Result |
  |---|---|
  | `GET /api/users/current` (control) | 200 |
  | `GET /api/line_items?patient=135620405` | 403, `{detail}` |
  | `GET /api/patient_payments?patient=135620405` | 403, `{detail}` |
  | `GET /api/transactions?line_item=…` | not sent: no line item to scope it to, and it has no patient filter |

- **Total: 3 DrChrono requests.** Budget before the run was 146 of 150 per hour and 60 of 60 per 10 minutes. No budget row was written (the brief said read-only). Outside the :05 sync slot.
- **Not established:** real field shapes, whether line items exist on the test chart, and the page-size cap on billing endpoints. All three need a re-run once the scopes are granted (about 4 requests, same pattern).

## 4. Reconstruction path

The data is enough for both a balance and an itemised statement, if the docs are accurate:

- **Balance:** sum `balance_pt` across the patient's line items. DrChrono computes it, so we don't re-derive the balance from payments.
- **Itemised rows:** each line item (date, code, description, charge) plus its insurer payments and adjustments from `transactions` (with CARC group and reason) plus patient payments.
- **Insurance adjustments and contractual write-offs:** the `adjustment` field on line items and transactions, with `adjustment_group_code` (CO/PR/OA) to tell write-offs from patient responsibility.

**Still missing, or unknowable without the clinic:**

1. **Statement history.** No API exposes when a statement was last sent, through DMA mail or OnPatient. That only exists in DrChrono's screen.
2. **Layout and wording.** Which of DrChrono's two formats they send (Itemized or the summary PDF), the dunning message, aging buckets, and the remit/payment instructions. Aging can be computed; wording and layout must come from a sample.
3. **Reconciliation.** Whether our total matches the number DrChrono prints. This needs a side-by-side check on a few real accounts, done by clinic staff and not by us.
4. **Unapplied credits.** Patient payments not tied to a line item. `line_item` is optional on payments, but whether the clinic posts payments that way is unverified.
5. **Delivery.** The API can't trigger DrChrono's Mail Statements or OnPatient send. If we render statements, sending them is our job.

## 5. Rate limits and volume (~500 patients)

- **DrChrono limits:** 500 requests per hour and 290 per rolling 10 minutes per token, throttled above 10 per second. The intake workflows share this; non-intake work is reserved 150/h and 60 per 10 minutes via `drsnip_sync_budget()`.
  - A separate billing credential would be a separate token. Whether DrChrono counts limits per token or per app is **unverified**.
- **Per patient:** about 3–5 requests (line items, payments, then transactions per billed appointment). 500 patients is about 2,000 requests, so **roughly 13–14 hours** inside the 150/h reservation.
- **Monthly sweep (better):** pull practice-wide `line_items`, `transactions` and `patient_payments` with `since=<last run>`, plus `line_item_deletions`, then join locally.
  - The cost scales with the practice's monthly billing volume (unknown; probably tens of requests) rather than with patient count.
  - **Trade-off:** it brings the whole practice's billing PHI into our database, a retention decision the clinic should make knowingly.

## 6. Effort (after the scopes are granted)

| Piece | Estimate |
|---|---|
| Re-run probe, confirm real fields, map to the clinic's sample | 0.5 day |
| **One patient on demand in the console** (n8n fetch, console view, PDF matching the sample, reconciliation on 3–5 accounts with staff) | **~2.5 days** |
| **Monthly batch of ~500** (incremental sweep, budget accounting, storage and retention, per-patient PDFs, reconciliation report). Delivery not included | **~3 more days** |

## 7. What we need from the clinic

1. **Jeff:** authorise a new read-only billing credential (`billing:read`, `billing:patient-payment:read`). If it still 403s, give the DrChrono user billing permission.
2. **A sample of the statement they send today, redacted or from a test account,** and which format it is: Itemized or summary PDF.
3. **The purpose.** Staff lookup in the console, patient-facing, or replacing DrChrono's own print/mail? DrChrono can already batch-print and mail statements without any API work.
4. **Cadence and audience.** Who are the ~500 (everyone with a balance? one cycle?), and is there a record of statement-sent dates outside DrChrono?

Sources: [DrChrono OpenAPI schema](https://app.drchrono.com/openapi-schema) · [Creating and Managing Patient Statements](https://support.drchrono.com/home/200039269-creating-and-managing-patient-statements) · [Creating an Itemized Patient Statement](https://support.drchrono.com/home/212528058-creating-an-itemized-patient-statement) · [Patient Billing Statements](https://support.drchrono.com/home/6177657304859-patient-billing-statements)
