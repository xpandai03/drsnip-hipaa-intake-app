# Train 1 — take Sheets off the critical path

**Date:** 2026-09-16
**Workflows:** `[Custom App] DrSnip Registration v2` (`H2HihkGKntbfRNcK`), `[Custom App] DrSnip Consultation v2` (`4UicLLZRRMeENXhx`), `[Custom App] DrSnip Insurance v1` (`oLbn4ZWFXu8Lei3I`)
**Snapshots:** `n8n-rollback/train1-before/` and `n8n-rollback/train1-after/` (PR #51, `b48a755`). Rollback for any workflow is a single validated PUT of its `_PUT.json`.
**Status:** change complete and live. Step 10 monitoring open — closing on volume (20 registrations / 10 consultations), not on clock.

---

## 1. What was wrong

`Sheets: Audit Log` sat synchronously between `Parse & Normalize` and `DrChrono: Search Patient`, so a Google-side stall held up the webhook response, every DrChrono write, and every notification behind it.

**Root cause, from node-level timelines on all five timed-out executions in retention:** one node consumed the entire wall clock while every other node stayed sub-second.

```
exec 3052 (registration, 190.1 s total)
  +  0.0 s  Webhook / IF: Auth Check / Parse & Normalize   0.23 s
  +  0.2 s  Sheets: Audit Log                            185.52 s   <-- the whole stall
  +185.7 s  DrChrono: Search Patient                       0.22 s
  +186.2 s  DrChrono: Create Patient                       0.71 s
  +189.2 s  Respond: Success / Gmail: Notify patientmail   0.91 s
```

The other four are the same shape: **185.5 s, 185.4 s, 185.1 s, 269.0 s**. The near-constant ~185 s points at a fixed retry ladder inside the Google API client rather than a random network stall.

**The stall is size-independent.** Exec 3088 stalled 185.6 s carrying 761 KB; exec 3450 finished in 2.7 s carrying 10.1 MB. Payload size and stall are uncorrelated — which matters, because a second, unrelated defect in the same node *is* size-driven (§3).

**This corrected the Aug 25 premise.** Sheets does dominate steady-state node time (2.1 s of a 5.7 s median registration, ~37%, against ~1.9 s for all four DrChrono calls combined) — but the distribution is bimodal, not creeping: ~470 runs under 20 s and five at 186–271 s. Shaving the median would have moved p50 from 5.7 s to 3.6 s and prevented **none** of the timeouts.

**No per-node timeout exists, and a timeout would have been the wrong fix anyway.** The Google Sheets node has zero of 47 properties matching "timeout"; only HTTP Request has `options.timeout`. n8n's real mechanisms are workflow-level `settings.executionTimeout` and instance-level `EXECUTIONS_TIMEOUT`, neither set here. Both *abort* the run — applied to these five executions they would have killed each one at the Sheets node, **before** `DrChrono: Create Patient`, turning five patients who got charts into five who got nothing.

## 2. What changed

| | Registration v2 | Consultation v2 |
|---|---|---|
| `Parse & Normalize →` | `DrChrono: Search Patient` (direct) | `DrChrono: Search Patient` (direct) |
| audit node mapping | `defineBelow`, 38 columns | `defineBelow`, 12 columns |
| `columns.schema` | `[]` | `[]` |
| `executeOnce` | `true` | not set (not needed) |
| audit node fed by | `Gmail: Notify patientmail`, `Gmail: Notify Returning Patient`, `Gmail: Notify Review`, `Respond: Failed` | `Gmail: Notify Review`, `Respond: Success` |
| document retries | `maxTries: 3`, `waitBetweenTries: 2000` on PDF + card upload | same, on PDF upload |

Retries are on document upload nodes **only** — never on Search / Create / Update Patient, asserted in the diff.

**Principle applied:** the audit write is the one node that can stall, so nothing patient-facing or staff-facing may sit downstream of it. Every diff was built offline, compared field-by-field against the before-snapshot, and guarded on node set, positions, credentials, sheet/tab/operation before any PUT.

### Time-to-Respond

| | before | after |
|---|---:|---:|
| Registration, success | ~5.7 s p50 | **1.58 s** |
| Consultation, success | ~3.8 s p50 | **1.20 s** |
| Consultation, manual review | 4.70 s | **2.49 s** |

## 3. Separate finding — registration audit rows were silently not being written

**Before:** `Parse & Normalize` emitted `insurance_card_front_b64` and `insurance_card_back_b64` — observed up to **10,129,620 characters** — and `autoMapInputData` shipped them into the Sheets append. The node returned `Bad request - please check your parameters`, and `continueOnFail: true` swallowed it.

Measured over 25 recent executions:

| | runs | Sheets errors |
|---|---:|---:|
| carried card b64 | 20 | **19** |
| no b64 | 8 | **0** |

A 58 KB run passed and a 349 KB run failed, so the cutoff sits between them. Cards have been on the form since June, so **roughly 76% of card-carrying registrations wrote no audit row for three months**, and nothing surfaced it.

**After:** the two `*_b64` keys are dropped from the explicit map (38 columns remain, header untouched at 56). Verified on a card-carrying run: audit node `runs=1`, `items=1`, result OK, 38 keys, no `*_b64`.

Ruling on record: the card bytes live in Postgres and in DrChrono; the sheet is an audit log and image data should never have been written there.

## 4. Verification

Five smokes, all against test identities.

| Smoke | Result |
|---|---|
| Consultation manual review | `Respond → Gmail → Audit`, audit OK 12 keys, **no DrChrono write** |
| Consultation success | `unique_strict_match` → chart 135620405, **update only**, audit OK 12 keys |
| Registration success (2 cards) | `Respond: Success` got **2 items**, audit ran **once with 1 item** — `executeOnce` proven against a real fan-out; 38 keys, no b64 |
| Registration failure branch | audit row written after `Respond: Failed` (HTTP 500) |
| Registration manual review | `candidates=1, passing=0, single_candidate_failed_disambiguation`, **no DrChrono write**, audit OK 38 keys |

### Two things that went wrong during the train

**A rolled-back first attempt.** The initial Consultation PUT preserved the node's existing 8-entry `columns.schema` as the minimal diff. `defineBelow` validates that schema against the live 56-column header and refused with *"Column names were updated after the node's setup"* — surfaced as `executionStatus: success` with `{error}` in the output, so `continueOnFail` hid it and the audit row was silently lost. Restored to the before-snapshot immediately rather than tuned in place; re-applied with `schema: []`, the pattern the sibling `Sheets: ManualReview` node already proves.

**A chart created in error.** A registration manual-review smoke used a novel identity, which is safe on consultation but not on registration: `Disambiguate Patient` routes zero candidates to **`create`**, not manual review. That produced DrChrono chart **135966665** and registration PDF **424266713**. Both are on the cleanup list. The corrected recipe — matching name+DOB with non-matching email and phone — was dry-traced and approved before the retry, which then behaved exactly as traced.

**`zipCode` vs `postalCode`.** Registration payloads use `postalCode`. An empty ZIP makes the DrChrono PATCH return 400 and routes the run to the failure branch. This has now caught three people, including the 2026-07-20 rehearsal.

## 5. Error workflow — corrected finding, and a standing rule

**An earlier report in this train said the API-set `errorWorkflow` binding persists but does not fire, and must be bound through the n8n UI. That was wrong.**

The inference came from `GET /executions?workflowId=<Error Notify>` returning zero rows. But `[Custom App] DrSnip — Error Notify` had **no `saveDataSuccessExecution` override**, so it inherited the instance defaults — `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none` and `EXECUTIONS_DATA_SAVE_ON_ERROR=none` — and its successful runs were never persisted. Zero executions said nothing about whether it ran. All workflows are also in a single project, so there was no cross-project scoping problem either.

After setting Error Notify to retain both, a throwaway workflow bound **via the API** threw once:

- Error Notify execution **3481**, status success
- Error Trigger carried the failing workflow's identity
- `Gmail: Notify Failure` → message id **`1a0aa7b073b521d0`**, `labelIds: ['SENT']`

Probe deleted, confirmed 404. Registration v2, Consultation v2 and Insurance v1 all carry `settings.errorWorkflow = "5oQPdAMJOfBgR8OJ"`, set via API, and are covered. Insurance v1's binding was added in this train — it had none, and it is the only other workflow that writes to DrChrono.

> **Standing rule.** Any n8n workflow whose runs matter for audit must set
> `saveDataSuccessExecution: "all"` explicitly. The instance default is `none`,
> so **absence of executions is not evidence that a workflow did not run.**
> Check a workflow's save settings against the instance defaults before drawing
> any conclusion from an empty execution list.

Error Notify's retention stays at `all`: an error notifier whose runs leave no record cannot be audited, which is precisely what caused the wrong conclusion.

## 6. Known limits, deferred

**Consultation's success branch is the one place audit-last is not enforced.** `Respond: Success` is shared by the normal path and the upload-failure path, so wiring `Respond: Success → Gmail: Notify Returning Patient` would fire a returning-patient email on the upload-failure branch where none fires today, while moving the audit onto that Gmail node would drop the audit row on that branch. Both are behaviour changes rather than moved edges. Accepted as-is: on consultation success only, `Gmail: Notify Returning Patient` still runs after the audit write, so a stall there would delay that email. Registration has no such constraint because its notify Gmails hang off a separate `IF: New Patient Created?` branch.

**`Sheets: ManualReview` still sits upstream of `Respond`** in both workflows — same node type, same stall exposure. Measured at 2.94 s on the registration manual-review smoke, which alone pushed time-to-Respond to 3.28 s. Deferred to Train 1b, after Step 10 closes.

## 7. Step 10 — monitoring (open)

Clock started 2026-09-16 05:20 UTC, when the registration reorder landed. Closing on **volume** — 20 registrations and 10 consultations — not on elapsed time; the first 8.5 hours were overnight and produced only six executions, which is not a sample.

Reading at 14:00 UTC:

| | executions | non-success | median | max |
|---|---|---|---|---|
| registration | 5 / 20 | 0 | 5.7 s | 6.7 s |
| consultation | 1 / 10 | 0 | 4.8 s | 4.8 s |

Zero NULL, zero failed, zero branch regressions, one audit row per execution. Wall-clock figures include the audit write, which now happens *after* the response; time-to-Respond is the 1.2–3.3 s measured in the smokes.

## 8. Cleanup list for the client

| Item | Detail |
|---|---|
| DrChrono chart **135620405** | `Rehearsal Qaignore0819` — pre-existing test chart, already on the deletion list. Gained documents **424266357** (consultation PDF), **424266392** (registration PDF), **424266393**, **424266394** (card images). |
| DrChrono chart **135966665** | `Mrsmoke Qaignore0915d` — **created in error** during this train. Document **424266713** (registration PDF). |
| Test submissions | `2eb5ccaa`, `a827b808`, `2191c359`, `3e9f552d`, `0fcc2f0b`, `6d3e12ea`, `c86df042`, `ebbddd80` — all `@xpandai.com` with a `Qaignore` name, so existing test heuristics exclude them. |
| Staff emails to ignore | Manual-review, returning-patient, new-patient and one "FAILED to process" alert, 2026-09-15 evening and 2026-09-16 morning. |

Insurance v1 is otherwise untouched; only `settings.errorWorkflow` was added, and n8n does not bump `versionId` for a settings-only change.
