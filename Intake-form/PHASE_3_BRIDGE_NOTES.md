# PHASE 3 — n8n Bridge

**Date built:** 2026-05-27
**Author:** Claude (Intake-form session)
**Status:** Bridge code complete on `phase-3-n8n-bridge`. Awaits Fly
secrets + deploy.

The custom intake app already writes every successful submission to its own
Postgres. This phase adds a **fire-and-forget bridge** from the API submit
handler to the v2 n8n webhooks so DrChrono gets the patient + the doctor-
friendly PDF on the same submission.

---

## 1. Architecture

```
+---------------------+    POST /api/submit     +-------------------------+
| Patient (browser)   +------------------------>+ Intake-form API (Fly)   |
+---------------------+                         |   - validate + DB INSERT|
                                                |   - 200 to client       |
                                                |   - fire-and-forget ---+|
                                                +------------------------++
                                                                          |
                              N8N_WEBHOOK_* + X-DrSnip-Token              |
                                                          v
                                                +-------------------------+
                                                | n8n v2 workflows (Fly)  |
                                                |   Registration v2 OR    |
                                                |   Consultation v2       |
                                                +------------+------------+
                                                             |
                                                       OAuth2 |
                                                             v
                                                +-------------------------+
                                                | DrChrono                |
                                                |   - patient (search/    |
                                                |     create/update)      |
                                                |   - PDF document upload |
                                                +-------------------------+

                                  ^                           |
                                  +-----  outcome JSON  ------+
                                  v
                          +-------------------+
                          | UPDATE submissions|
                          |  SET n8n_status,  |
                          |      n8n_patient_id, ...
                          +-------------------+
                                  v
                          +-------------------+
                          | Admin console     |
                          |  shows badge +    |
                          |  DrChrono link    |
                          +-------------------+
```

Patient never waits on n8n. The 200 from `/api/submit` goes out the moment
the DB write commits; the bridge runs in the background, then UPDATEs the
submission row with the outcome.

---

## 2. Env vars

All four come from `fly secrets`. Comments in `fly.toml` mirror this list.

| Var | Value | Purpose |
|---|---|---|
| `N8N_WEBHOOK_REGISTRATION_URL` | `https://n8n-drsnip.fly.dev/webhook/custom-registration-6fe129ab` | Registration v2 webhook URL |
| `N8N_WEBHOOK_CONSULTATION_URL` | `https://n8n-drsnip.fly.dev/webhook/custom-consultation-9f872020` | Consultation v2 webhook URL |
| `N8N_WEBHOOK_SECRET` | (same as `DRSNIP_WEBHOOK_SECRET` on the n8n side) | Sent as `X-DrSnip-Token` |
| `N8N_BRIDGE_ENABLED` | `true` \| `false` | Kill switch |

### Kill switch — `N8N_BRIDGE_ENABLED`

When set to anything other than the literal string `true`, every bridge call
is short-circuited to `{ status: 'failed', errorMessage: 'bridge disabled' }`
and the n8n webhook is never hit. Submissions continue to land in Postgres
exactly as before. Useful for:

- Pausing the bridge if n8n needs maintenance, without redeploying the app.
- Doing a dry-run deploy that wires the code but doesn't yet activate it.
- Investigating a bridge bug.

To flip:

```sh
fly secrets set N8N_BRIDGE_ENABLED=false -a drsnip-intake-demo  # off
fly secrets set N8N_BRIDGE_ENABLED=true  -a drsnip-intake-demo  # on
```

Fly restarts the machines automatically when secrets change.

### One-time setup (per-environment)

```sh
fly secrets set \
  N8N_WEBHOOK_REGISTRATION_URL=https://n8n-drsnip.fly.dev/webhook/custom-registration-6fe129ab \
  N8N_WEBHOOK_CONSULTATION_URL=https://n8n-drsnip.fly.dev/webhook/custom-consultation-9f872020 \
  N8N_WEBHOOK_SECRET=0609634797970ddd7bc4c82677d1904f958b41c55d6a5c621d23a74fd0a66e2f \
  N8N_BRIDGE_ENABLED=true \
  -a drsnip-intake-demo
```

The secret value above matches the `DRSNIP_WEBHOOK_SECRET` already set on the
`n8n-drsnip` Fly app (see `N8N_CUTOVER_NOTES.md` §B). Rotate after first
verified cutover.

---

## 3. New DB columns (migration 0006)

`submissions` gets four new columns, all nullable:

| Column | Type | Meaning when populated |
|---|---|---|
| `n8n_status` | text | `'success'` / `'manual_review'` / `'failed'` |
| `n8n_patient_id` | bigint | DrChrono patient_id returned on `'success'` |
| `n8n_response_at` | timestamptz | When the bridge wrote the outcome back |
| `n8n_response_body` | jsonb | Full bridge view: `{ bridge_status, response?, error_message? }` |

NULL `n8n_status` = the bridge hasn't reported yet (either still in flight,
or the kill switch is off, or the row was written before the bridge shipped).

The migration adds a partial index `submissions_n8n_status_idx` over rows
where `n8n_status IS NULL OR n8n_status NOT IN ('success', 'manual_review')`
so backfill / replay queries hit only the rows that need attention.

Apply via the standard Fly release_command (bundled into `dist/migrate.cjs`
by `pnpm build:migrate` — same pattern as 0001-0005). Migration is
idempotent.

---

## 4. Outcome states — how to interpret each

### `success`
- HTTP 200 from n8n with `success: true`.
- `n8n_patient_id` is populated — clickable link in the admin detail view
  → `https://app.drchrono.com/patients/<id>`.
- DrChrono should now have the patient + the Registration/Consultation PDF
  attached. Verify the chart if the row is unusual.

### `manual_review`
- HTTP 200 from n8n with `success: false, reason: 'manual_review_required'`.
- Triggered by:
  - **Consultation**: strict identity match (DOB + email + phone) failed —
    no DrChrono candidate or ambiguous candidates. The `ManualReview` Sheet
    tab has a row for this submission (see N8N_CUTOVER_NOTES §D.1).
  - **Registration**: tighter disambiguation found no clear winner.
- No DrChrono document was attached. A human needs to decide whether to
  create a new patient, attach to an existing one, or contact the patient
  for clarification.

### `failed`
- Anything else: network error, n8n 5xx, 30-second timeout, kill switch off,
  missing env config.
- `n8n_response_body.error_message` carries a short non-PHI reason
  (`"bridge disabled"`, `"timeout after 30000ms"`, `"HTTP 502"`,
  `"missing config: N8N_WEBHOOK_REGISTRATION_URL"`, etc).
- The patient was never lost — their submission is in Postgres and the
  admin can manually replay (Phase 4 retry mechanism) or hand-deliver to
  DrChrono.

### `null` (pending)
- Submission row exists; the bridge hasn't reported yet.
- If a row stays NULL longer than ~60 seconds, something's wrong with the
  bridge — check Fly logs (`fly logs -a drsnip-intake-demo | grep
  n8n-bridge`).

---

## 5. Common failure modes & debug recipe

When you see `failed` (or pending-forever) on the admin detail view:

1. Open the submission detail → look at the **Failure detail** block
   directly under the n8n / DrChrono section. As of the 2026-05-27
   bridge-fix patch, this surfaces a structured diagnostic:
   - `kind` — `http` (n8n responded), `fetch` (thrown before/during
     transport), or `config` (kill switch / missing env var).
   - `httpStatus`, `contentType`, `bodyLength`, `bodySnippet` — what n8n
     actually sent back. The snippet is capped at 2KB so you'll usually see
     the whole response body inline.
   - `parseError` — populated when n8n returned a body that wasn't valid
     JSON (HTML error page, empty body, partial body). The bridge captures
     the JSON.parse() exception message here.
   - `errorName`, `causeMessage`, `stackHead`, `elapsedMs` — populated on
     `fetch` kind (network errors, DNS, abort/timeout, TLS).
2. Map the diagnostic to a cause:
   - `kind=config, error_message=bridge disabled` → flip
     `N8N_BRIDGE_ENABLED=true` (kill switch is off).
   - `kind=config, error_message=missing config: N8N_WEBHOOK_*` → set the
     named env var via `fly secrets set ... -a drsnip-intake-demo`.
   - `kind=fetch, errorName=AbortError`, `error_message=timeout after
     30000ms` → n8n took longer than 30s. Check
     `https://n8n-drsnip.fly.dev` health, check that execution in n8n's
     execution log — it may have actually succeeded, just slow.
   - `kind=fetch, errorName=TypeError`, `causeMessage` mentions
     `ENOTFOUND`/`ECONNREFUSED` → DNS/network. Custom-app machine can't
     reach n8n.
   - `kind=fetch, errorName=TypeError`, `causeMessage` mentions cert →
     TLS issue.
   - `kind=http, httpStatus=401` → `N8N_WEBHOOK_SECRET` doesn't match
     `DRSNIP_WEBHOOK_SECRET` on the n8n side. Check both fly secrets.
   - `kind=http, httpStatus=200, parseError=Unexpected token...` → n8n
     returned a 2xx with a non-JSON body. Almost certainly an n8n
     workflow-level error before the Respond node fires. Open the n8n
     execution log to see what failed; the Respond expression itself is
     a common offender (e.g. referencing an unexecuted node without
     `$if(node.isExecuted, ...)`).
   - `kind=http, httpStatus=200, parseError=empty response body` → n8n
     reached a Respond node but the body was empty. Usually a misconfigured
     `responseBody` expression that evaluated to undefined.
   - `kind=http, httpStatus=200, parseError=null, body matches a shape
     other than success/manual_review` → unexpected response shape. The
     `bodySnippet` tells you what n8n sent.
3. Match the submission ID to n8n's execution log
   (`https://n8n-drsnip.fly.dev` → workflow → Executions). Each n8n
   execution lists the body it received; the submission_id in the body
   matches the custom-app submission UUID.
4. Match against the Audit Google Sheet — every n8n call also writes a row
   to the `DrSnip_Intake_Sheet` tab. If a manual_review fired, there's also
   a row on `ManualReview`.

### 5.1 The "response: null, bridge_status: failed" pattern (pre-2026-05-27)

Before the bridge-fix patch, the bridge stored `{response: null,
bridge_status: 'failed'}` with no further detail whenever n8n returned a
2xx with a non-JSON body OR the fetch threw. That swallowed the actual
cause. The patch:

- Always reads the raw body as text first, then attempts `JSON.parse` on
  the captured text. The text is preserved as a snippet even when the
  parse fails.
- Adds a `diagnostic` field next to `bridge_status` / `response` /
  `error_message` in `n8n_response_body`. The admin detail view renders it
  inline above the "Raw response" expander.
- Promotes the previously-swallowed path to a new structured log event
  `[n8n-bridge] response_failed` carrying status, content-type,
  body_length, body_snippet, parse_error, and elapsed_ms — so the failure
  reason shows up in `fly logs` even if you can't see the DB.

Rows written before the patch will keep their original `response: null`
shape; only new submissions get the diagnostic.

ID-only logging in the bridge means logs are safe to forward to any log
sink without PHI exposure.

---

## 6. Code layout

| Path | Role |
|---|---|
| `Intake-form/lib/n8n/bridge.ts` | `callN8nRegistration` / `callN8nConsultation` — POST + parse + outcome |
| `Intake-form/lib/n8n/payload.ts` | `buildRegistrationPayload` / `buildConsultationPayload` |
| `Intake-form/lib/db/migrations/0006_n8n_bridge.sql` | Adds 4 columns + index |
| `Intake-form/lib/db/src/schema/submissions.ts` | Drizzle schema mirroring the migration |
| `Intake-form/api/submit.ts` | DB insert → 200 to client → fire-and-forget bridge → UPDATE outcome |
| `Intake-form/api/submissions/index.ts` | Lean list returns `n8nStatus` + `n8nPatientId` |
| `Intake-form/artifacts/intake-form/src/pages/admin/Submissions.tsx` | n8n badge column |
| `Intake-form/artifacts/intake-form/src/pages/admin/SubmissionDetailModal.tsx` | n8n / DrChrono section with link + collapsible raw response |

Bridge behaviour: **never throws**. Every code path returns an
`N8nOutcome` the submit handler can persist. 30-second timeout (via
`AbortController`). Structured ID-only logging at `[n8n-bridge] response` /
`[n8n-bridge] error` / `[n8n-bridge] disabled` / `[n8n-bridge] non_2xx` /
`[n8n-bridge] misconfigured`.

---

## 7. Fire-and-forget pattern

`api/submit.ts` calls `res.status(200).json(...)` first, then returns a
top-level `void runN8nBridge(...).catch(...)` promise without `await`. The
Hono adapter (`api-server/vercel-adapter.ts`) builds the HTTP response when
the handler returns, but the unawaited promise continues on the Node event
loop because the long-running Fly process stays alive.

**This works on Fly.io but NOT on a serverless runtime** (Vercel, AWS Lambda,
Cloudflare Workers). If we ever port the API back to a serverless platform,
the bridge call has to move into a separate worker or queue job.

---

## 8. Insurance card handling

Cards are STILL stubbed (per `PHASE_2_NOTES.md`) — `/api/submit` accepts a
`{ filename, size }` reference but no bytes. The bridge therefore omits
`insurance.cardFront` / `insurance.cardBack` from the n8n payload, and
n8n's `IF: Has Insurance Cards?` correctly takes the FALSE branch and skips
card upload. Registration v2 still responds `documents_uploaded: 1`
(Registration Intake PDF), `manual_review_required: false`.

When cards become real (Phase 4, real upload to object storage with a BAA),
the bridge `payload.ts` already has the `base64Data` plumbing in place —
populate the buffer, the payload appears, and n8n uploads both cards.

---

## 9. Cutover plan (once the bridge is verified)

1. `fly secrets set ...` (§2) on `drsnip-intake-demo`.
2. Merge `phase-3-n8n-bridge` → `main`.
3. `fly deploy -a drsnip-intake-demo` — migration 0006 applies automatically
   via the existing release_command.
4. Smoke-test a real form submission with a synthetic name (see §10 below).
5. Confirm the DrChrono chart got the PDF.
6. Verify the admin console badge shows `n8n: success`.
7. Repeat with a Consultation form using the same identity → confirm the
   Consultation PDF lands on the same DrChrono chart.
8. **Manual cutover**: once Jeff and Raunek are happy with a few real
   submissions:
   - Update DrSnip's marketing site (Webflow / drsnip.com) — change the
     "Register" / "Consultation" CTA links from the old JotForm URLs to the
     custom app URLs: `https://drsnip-intake-demo.fly.dev/?form=registration`
     and `?form=consultation`.
   - Keep the JotForm workflows active in n8n for a grace period in case
     anything routes back to JotForm via cached bookmarks.
   - After ~2 weeks of clean traffic, deactivate the JotForm n8n workflows
     (don't delete — keep for rollback).

---

## 10. Smoke-test sequence (real form submission)

After deploy:

1. Open `https://drsnip-intake-demo.fly.dev/?source=n8n-bridge-test`.
2. Submit a Registration form with synthetic data — use `Zzz BridgeTest`
   for first + last name, DOB `1990-01-15`, email
   `bridge-test-2026-05-27@example.invalid`, phone `(555) 010-0001`,
   self-pay insurance, no cards.
3. The success page should appear immediately (no perceptible delay).
4. Wait 5-10 seconds.
5. Log into the admin console
   (`https://drsnip-intake-demo.fly.dev/admin/submissions`).
6. The new row should show `n8n: success` (green badge).
7. Click the row → the n8n / DrChrono section should show the DrChrono
   patient_id with an external link. Click it → DrChrono opens that chart.
8. On the chart, you should see a "Registration Intake (custom app v2)"
   document attached — open it and verify the doctor-friendly PDF.
9. Repeat with a Consultation form using the **exact same identity**
   (`Zzz BridgeTest`, same DOB / email / phone). Strict-match should pass
   and a "Consultation Intake (custom app v2)" PDF should land on the same
   chart.
10. Mark the DrChrono test patient for cleanup (see §11).

If any step fails, follow the debug recipe in §5.

---

## 11. Test patient cleanup

After smoke-test:

- DrChrono patient `Zzz BridgeTest` (DOB 1990-01-15) — created by step 2
  above. Delete the chart + both attached PDFs.
- Audit Google Sheet — leave the row (PHI is fine in audit log).
- Submission rows in Postgres — leave them; they're harmless and useful
  for verifying the bridge worked. Delete via the admin console if needed
  (no UI yet — manual SQL delete on the row by ID).

Earlier test patients still on DrChrono from the n8n cutover session:

- `Zzz SyntheticSmoketest`
- `Yyy CardUploadSmoketest` (patient_id 134347067)
- patient_id 134346203 (from execution 305 — pre-fix state)

---

## 12. What's NOT done — follow-ups

1. **Retry logic** — Phase 4. Today a `failed` outcome just sits there;
   there's no automatic replay. A manual replay button on the admin detail
   view is a small follow-up, and a scheduled retry worker is bigger.
2. **Real insurance card upload** — Phase 4. The bridge already passes
   `base64Data` through when present, so this becomes a custom-app
   change only: store bytes, base64 them on submit. Object storage with
   BAA is the prerequisite.
3. **n8n outcome filtering on the admin list view** — would be useful when
   the queue grows (e.g., "show only failed"). Today the badge is visible
   but not filterable.
4. **Source query-param tagging in n8n logs** — the audit Sheet already has
   a `source: custom-app-v2` column; nothing to add.
5. **Webhook-secret rotation runbook** — rotate the value once cutover is
   verified, both on the n8n side (`DRSNIP_WEBHOOK_SECRET`) and the custom
   app side (`N8N_WEBHOOK_SECRET`). They must match.
