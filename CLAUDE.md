# Agent working notes — DrSnip intake

Operational rules earned the hard way on this repo. Each one cost real time or a
real mistake; none of them is guessable from the code.

## Git / PRs

**Do not delete the base branch when squash-merging a stack.** GitHub
**auto-closes** any PR whose base branch is deleted, and a closed PR cannot be
retargeted or reopened — `gh pr edit --base` fails with *"Cannot change the base
branch of a closed pull request"*. That happened to PR #52 (Train 3, stacked on
Train 2's #50) and it had to be rebuilt as #53.

When PR B is stacked on PR A:

1. Merge A **without** `--delete-branch`, or retarget B to `main` first
   (`gh pr edit B --base main`) while B is still open.
2. After A is squash-merged, B's branch still carries A's original commit, whose
   SHA differs from the squashed one. Rebase with
   `git rebase --onto main <A's original SHA> <B's branch>` to drop it, then
   confirm the resulting tree is unchanged (`git diff --stat` before vs after).
3. Force-push with `--force-with-lease`.

**Deployed code must be on a branch and in a PR before the deploy, not after.**
Fly deploys from the working tree, so it is entirely possible to ship something
that exists nowhere in git.

**Branch from the branch you are building on, not from `main`.** Train 3 was
branched off `main` while Train 2 sat unmerged; `lib/lifecycle/` did not exist
and the `submit.ts` edit landed on the pre-Train-2 version. Deploying that would
have silently reverted Train 2's drain handler. When a train depends on an
unmerged train, branch from it and assert the dependency survives — the Train 3
patch script checks that all four of Train 2's `track()` wrappers are still
present.

## n8n

**Absence of executions is not evidence that a workflow did not run.** This
instance sets `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none` and
`EXECUTIONS_DATA_SAVE_ON_ERROR=none`; only workflows that override
`saveDataSuccessExecution` retain anything. `Error Notify` had no override, so it
had zero stored executions — which was misread as "the API-set `errorWorkflow`
binding does not fire". It fires. The binding is fine.

**Standing rule: any workflow whose runs matter for audit must set
`saveDataSuccessExecution: "all"` explicitly.** Currently set on Registration v2,
Consultation v2, Error Notify, Digest Notify and Sweep Scheduler. Before
concluding a workflow never ran, check its save settings against the instance
defaults.

**Switching a Google Sheets node to `defineBelow` also requires clearing
`parameters.columns.schema`.** `autoMapInputData` ignores that cached schema;
`defineBelow` validates it against the live header and fails with *"Column names
were updated after the node's setup"* — reported as `executionStatus: success`
with `{error}` in the output, so `continueOnFail` hides it completely. Use
`schema: []`.

**A node can receive more than one item.** `Respond: Success` in Registration v2
gets one item per uploaded card, so anything hung off it runs per card. Check
item counts in a real execution before attaching a node; use `executeOnce: true`
where one run is required.

**Registration and Consultation diverge on the zero-candidate case.**
Consultation's `Resolve Patient ID` routes zero candidates to `manual_review`;
Registration's `Disambiguate Patient` routes them to **`create`**. A novel test
identity is safe on consultation and creates a real chart on registration. To
land registration in manual review, use a name+DOB that matches an existing
chart with a non-matching email *and* phone
(`single_candidate_failed_disambiguation`).

## Fly

**`kill_timeout` and other top-level `fly.toml` keys must appear above every
table header.** TOML binds a bare key to the most recently opened table, so
`kill_timeout` placed after `[[http_service.checks]]` silently became
`http_service.checks.kill_timeout` and Fly ignored it with no warning.
**Verify with `fly config show`, never by reading the file.**

**Fly retains only ~5 machine events and minutes of logs.** Neither is a
diagnostic source for anything older than the current session.

## App

**`updated_at` is never bumped by the n8n bridge write-back.** All rows have
`updated_at = created_at`. Anything looking for a missing write-back must key on
`n8n_response_at IS NULL`.

**Registration payloads use `postalCode`, not `zipCode`.** An empty ZIP makes the
DrChrono PATCH return 400 and routes the run to the failure branch. This has now
caught three people.

## Read-only database access

Query production through the DB machine with the read-only guard on:

```sh
fly ssh console -a drsnip-intake-db -C "sh -c 'echo <base64-sql> | base64 -d |
  PGPASSWORD=\$OPERATOR_PASSWORD PGOPTIONS=\"-c default_transaction_read_only=on\"
  psql -h 127.0.0.1 -U postgres -d drsnip_intake_demo -X -q'"
```

The app's own `DATABASE_URL` resolves to `drsnip-intake-db.flycast/drsnip_intake_demo`.
The similarly named `drsnip-intake-demo-db` Fly app on the *personal* org is **not**
this system's database.

## HIPAA

Production data is PHI. Keep it out of chat output, commit messages, PR bodies
and logs — counts, submission IDs and console links only. The one Google Sheets
workbook holds full audit rows including card images, and the Drive connector
returns the whole workbook with no tab selector, so reading a single tab is not
currently possible without pulling everything.
