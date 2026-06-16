# Task 3 — "Under review" notification email (plan — PAUSE for sign-off)

Fire a **PHI-free** email to patientmail@drsnip.com when a submission lands in **manual
review**, with a deep link that (after login) opens that submission in the admin portal.
PRODUCTION n8n + a small app change. Nothing edited yet.

## Snapshots taken (rollback pointers)
| Workflow | ID | activeVersionId (rollback) | file |
|---|---|---|---|
| Registration v2 | `H2HihkGKntbfRNcK` | `a7c0d18a-eb7f-4795-b18a-ca7c7dc385ad` | `n8n-rollback/registration_v2_task3_pre.json` |
| Consultation v2 | `4UicLLZRRMeENXhx` | `987359df-3f47-4fe3-b6d4-84b273c88f78` | `n8n-rollback/consultation_v2_task3_pre.json` |

## Where manual review happens (both workflows)
Both have an identical review branch:
`IF: Is Manual Review?` → **(true)** → `Sheets: ManualReview` → `Respond: Manual Review`.
- Consultation: triggered by no/ambiguous DrChrono match (incl. consultation-without-matching-registration).
- Registration: triggered by ambiguous candidate (`multiple/none passed disambiguation`).
The n8n-**success** path (create/update + PDF upload) is separate and is **not** touched — the email fires only on the review branch.

## ⚠️ Required app change first (the deep link has no target today)
The admin submission **detail is opened by React state, not a URL** — `openId` is `useState`
([Submissions.tsx:214](Intake-form/artifacts/intake-form/src/pages/admin/Submissions.tsx#L214)); the URL only carries list filters. And the unauth→login guard builds `?next=` from
wouter's **path-only** `location` ([AdminLayout.tsx:41](Intake-form/artifacts/intake-form/src/pages/admin/AdminLayout.tsx#L41)), which drops any query string. So a
`?id=` link would neither open a submission nor survive login.

**Fix (small, low-risk):** make the detail addressable by a **path** route
`/admin/submissions/:id` (path segments survive the existing `?next=` redirect, and
SignIn's `next` regex already allows `/admin/...`, hyphens, slashes — UUIDs pass):
- `App.tsx`: route `/admin/submissions/:id?` → `Submissions` (optional id param).
- `Submissions.tsx`: initialize `openId` from the `:id` route param; on row-open navigate to
  `/admin/submissions/<id>`, on close navigate back to `/admin/submissions`.
- No change to AdminLayout/SignIn needed (path-based survives `?next=` as-is).
- Separate repo PR, `pnpm build` green, deploy **before/with** the n8n change so links resolve.

**Deep-link URL:** `https://intake.doctorsnip.com/admin/submissions/{{ submission_id }}`
Unauth flow: click → AdminLayout redirects to `/admin/signin?next=%2Fadmin%2Fsubmissions%2F<id>`
→ after login → lands on `/admin/submissions/<id>` → detail opens. ✓

## n8n edit (both workflows) — add one Gmail node on the review branch
Insert a Gmail send **between** `Sheets: ManualReview` and `Respond: Manual Review`
(re-wire: `Sheets: ManualReview → Gmail: Notify Review → Respond: Manual Review`), so the
webhook still responds and a Gmail hiccup can't block it.

**Gmail node config — reuse the existing BAA-covered node verbatim** (same as Registration v2's
`Gmail: Notify patientmail`):
- type `n8n-nodes-base.gmail` v2.2 · resource `message` · operation `send`
- credential `gmailOAuth2` id `66n9Hae31tNosGib` ("Gmail account", IT@drsnip.com)
- `sendTo: patientmail@drsnip.com` · `emailType: text` · `options.appendAttribution: false`
- `onError: continueRegularOutput` (a send failure never breaks the manual-review response)
- `submission_id` source: `{{ $('Parse & Normalize').item.json.submission_id }}` (present in both)

**Exact email copy (PHI-FREE — contains zero patient data):**
- Subject: `DrSnip intake — a submission needs manual review`
- Body (text):
```
A patient intake submission could not be matched automatically and needs manual review in the DrSnip admin portal.

Open it here (sign in if prompted):
https://intake.doctorsnip.com/admin/submissions/{{ $('Parse & Normalize').item.json.submission_id }}

For privacy, this message contains no patient information — the submission details are visible only after you sign in.

— DrSnip automated notification
```
**PHI confirmation:** no name, DOB, contact info, or answers. The only variable is the
opaque submission UUID inside the link (an internal record id, not a patient identifier).
Mirrors the existing patientmail discipline; the Sheets/audit rows on this branch already log
identity to the internal sheet (unchanged) — the **email** stays PHI-free.

## Transport confirmation
- Uses the existing n8n Gmail OAuth2 node only. **App-side SMTP/patientmail mailer is NOT
  re-enabled** (it remains recipient-less by design — real sends go via n8n; see the
  `[patientmail] skipped no_recipient` note). No app-side mail changes.

## Process / order
1. **App PR** (path-based detail route) → build green → **deploy** so the link target exists.
2. **n8n**: snapshot ✔ (above). Add the Gmail node to **both** review branches via
   `n8n_update_partial_workflow` (validate-first), keep workflows active.
3. **Verify**: produce a manual-review submission (e.g. a consultation with no matching
   registration), confirm the email arrives at patientmail@ with a working link that — after
   logging in as the Task-2 viewer — opens the right submission detail. Confirm no PHI in the
   email and no PHI in logs.

## Open questions for sign-off
1. Approve the **app change** (path route `/admin/submissions/:id`) as the deep-link target? (Required for "opens the right submission"; alternative is linking to the list only.)
2. Approve adding the Gmail node to **both** Registration v2 and Consultation v2 review branches (vs consultation only)?
3. Approve the **exact email copy** above (PHI-free)?
