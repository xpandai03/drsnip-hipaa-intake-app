# Dr. Snip journey dashboard — release notes

**Released:** 2026-09-20 02:30 UTC (19:30 Pacific, Sep 19)
**App:** `drsnip-intake-demo` (Fly org `it-snip`, region `lax`)
**Release:** **v83** · image `deployment-01M2YAAW90CQFGMDFWZC29N2BJ`
**Commits:** `1a5d663` (feature) + `c49f271` (route-registration fix)
**PR:** [#55](https://github.com/xpandai03/drsnip-hipaa-intake-app/pull/55) — open, mergeable

---

## 1. What shipped

**`/admin/journeys` — real patient-journey reporting.** Two tabs for two cohorts
that overlap and must never be summed:

- Registration → consultation form submitted
- Insurance inquiry → registration

Each shows **observed-to-date and mature-window side by side**, never collapsed
into one number. Appointment evidence appears as **observed minima** with the
unresolved count beside it, rendered as cards because the categories overlap.
Attendance and procedure completion render as **unavailable with a reason**.

Also in this release, captured from work that was previously local only:

- the responsive console shell and the synthetic insurance follow-up demo
  (`42d9ec4`, deployed as v81 on 2026-09-18 **without a PR**),
- an Ask AI suggested-prompt fix (`f7182e1`),
- appointment sync + backfill code and migrations `0012`/`0012a`/`0013`,
- the aggregate reporting boundary `0014`,
- two fixes to the shared waterfall component (§5).

**Release bookkeeping, stated plainly:** PR #55 does **not** precede the v81
deployment. v81 shipped from an unpushed local branch, which
[CLAUDE.md](CLAUDE.md) forbids. This PR records that work retrospectively
alongside the current release so the branch and `main` can be reconciled.

---

## 2. Migration state

| Migration | Registered in `migrate.ts` | Applied to production |
|---|---|---|
| `0012_appointment_sync` | yes | yes (earlier task) |
| `0012a_appointment_sync_grants` | **no** (creates roles) | yes (operator-run) |
| `0013_appointment_backfill_windows` | yes | yes (earlier task) |
| `0014_journey_metrics_access` | **no** (creates roles) | yes (operator-run) |

The Fly `release_command` replays every registered migration on each deploy, so
that replay was **rehearsed against production first**, as the application role,
before deploying: all 14 steps plus the admin seed ran clean, `0014`'s two
functions and their grants were intact afterwards, and row counts were
unchanged. The real deploy then reported `release_command … completed
successfully`.

**Access boundary.** `0014` creates `drsnip_metrics_fn` — a **NOLOGIN,
non-superuser** role owning two `SECURITY DEFINER` functions with `SELECT` on
four tables and nothing else. `search_path` is pinned to `pg_catalog, pg_temp`
(every object schema-qualified, `pg_temp` last); the metric name is matched
against a fixed allow-list; suppression runs **inside** the function; `EXECUTE`
is revoked from `PUBLIC`. Verified in production: the reporting role cannot
`SELECT` from `submissions`, `appointment_snapshots` or
`appointment_status_transitions`, but can obtain aggregates through the function.

---

## 3. Verification

### Automated

| Run | Result |
|---|---|
| Typecheck | clean |
| Production build | clean |
| Full API suite, **database-backed suites enabled** | **489 tests — 469 pass, 0 fail, 17 cancelled, 3 skipped** |
| Full API suite, default (no DB URLs) | **489 tests — 406 pass, 0 fail, 17 cancelled, 64 skipped** |

The **17 cancelled** are the pre-existing `DATABASE_URL` gap in the auth tests,
unchanged by this release. The **3 skipped** with DB enabled are conditional
cases. Nothing here is a skipped check being reported as verified: the
database-backed suites (`appointment-sync-db` 29, `journey-metrics` 42,
`journey-endpoint` 33) were each run to completion against a disposable cluster,
including calls made as the **actual restricted reporting role**.

### Privacy, swept rather than sampled

Every metric × window × period combination — **60 calls** — checked for any cell
in 1–4, small complements, and subtraction recovery: **zero leaks**. The
authenticated production response was also checked for identifier keys: none.

### Reconciliation (three-way, at the same instant)

| Source | cohort | observed | mature-14 den | mature-14 num |
|---|---:|---:|---:|---:|
| Independent SQL (different structure) | 1,844 | 672 | 1,548 | 366 |
| Deployed database function | 1,844 | 672 | 1,548 | 366 |
| **Authenticated production API** | **1,844** | **672** | **1,548** | **366** |

**Zero discrepancies.** The cohort moved 1,842 → 1,844 since the earlier report;
that is ordinary drift as registrations arrive, not an error — no figure is
hard-coded anywhere.

### Authenticated production checks — **passed**

Signed in to production as the application's **own provisioned viewer account**
(`viewer@drsnip.com`, seeded by the deploy's `release_command`). No session was
fabricated and no authentication was bypassed; the credential was read from the
app's own environment, never printed, and the local copy was shredded afterwards.

- `/admin/journeys` renders, **0px horizontal overflow**, 0 page errors
- badges read *Actual intake data* and *Appointment snapshot — last refreshed …*;
  **no "Live" badge**
- both modes shown; attendance reads *Not available yet*; the
  "overlapping categories, not a funnel" note is present
- `/api/reports/journey` returns **200** with the reconciled figures and
  `appointment_sync_active: false`
- response contains **no** patient id, appointment id, individual timestamp or
  raw payload
- insurance demo renders with both waterfalls, clearly badged **DEMO** in the nav
- mobile (390×844): **0px overflow**, full navigation present

### Unauthenticated checks

`/healthz`, `/`, `/consultation`, `/insurance` all 200. Protected endpoints
(`/api/reports/journey`, `/api/reports/summary`, `/api/reports/counts`,
`/api/submissions`) all **401** with a body that leaks nothing.

### Visual

Desktop 1440×900, intermediate 820×1180, mobile 390×844 — all 13 console and
public routes render with **0px horizontal overflow** and no page errors. 11
keyboard focus stops on the journeys page, every one with a visible focus ring.
Screenshots in [`journey-screenshots-2026-09-20/`](journey-screenshots-2026-09-20/);
the `PROD-` ones are from production and contain **aggregates only**, the rest
are from synthetic fixtures including small-cell cases.

---

## 4. A defect that reached production, and how

**v82 shipped with `/api/reports/journey` returning 404.** `api-server/index.ts`
registers every API route by hand, and the new one was missed. The handler,
its tests and the page all looked correct in the repo; nothing in the suite
covered the wiring. It was caught by the first post-deploy production probe —
the endpoint answered 404 where every sibling answered 401 — and fixed in
`c49f271`, released as **v83** four minutes later.

The suite now walks `api/reports/` and asserts each handler has a matching
`app.all()` registration, so a handler cannot ship unwired again.

**No user saw the broken state**: v82 was live for ~3 minutes, outside clinic
hours, and the journeys page had not been announced.

---

## 5. Other fixes in this release

Two pre-existing defects in the shared waterfall component:

1. An `unavailable` stage captioned itself **"not measured"** — a different
   claim ("nothing tracks this" versus "the source cannot answer yet"). It now
   uses the same state vocabulary as the marker above it.
2. In vertical (mobile) mode the silhouette was centred on the full width while
   stage labels sit in a left gutter, putting dark label text on a dark navy
   band. A `VERTICAL_LABEL_GUTTER` now insets the drawing region.
   (Before/after crops are in the screenshots folder.)

And one from this release's own review: `/admin/journeys` did not wrap itself in
`AdminLayout`. Pages self-wrap in this app; the route does not. Without it the
page would have shipped with **no navigation and no sign-out**. Caught in
pre-deploy visual verification, fixed before the first deploy, and covered by a
test.

---

## 6. Rollback

**Restore point: v81 · `registry.fly.io/drsnip-intake-demo:deployment-01M2SERKZK99MXGAY17QS0274R`**

```sh
fly deploy --image registry.fly.io/drsnip-intake-demo:deployment-01M2SERKZK99MXGAY17QS0274R -a drsnip-intake-demo
```

v81 remains schema-compatible: every database change in this release is
**additive** (new tables, new functions, new grants) and v81's code references
none of them.

**Rollback restores the application image only.** Do not drop
`appointment_snapshots`, `appointment_status_transitions`,
`appointment_sync_windows` or the `drsnip_journey_*` functions as part of a
rollback — they hold evidence and are shared. If reporting access must be
withdrawn urgently, revoke execution instead:

```sql
REVOKE EXECUTE ON FUNCTION public.drsnip_journey_metric(text,date,date,integer) FROM drsnip_reporting_ro, drsnip_intake_demo;
```

---

## 7. Still outstanding

| Item | Blocks | Owner |
|---|---|---|
| **Phase B**: per-patient retrieval for ~1,930 patients | Attendance; turning appointment minima into rates | A backfill task |
| Arrival-status mapping (`MD In`, `Ready in 1/2/3`, blank, `Late Cancel within 48 hrs`) | Attendance | Clinic staff |
| Procedure-completion source field | Any procedure metric | Clinic staff |
| `/api/appointment_profiles` returns 403 | Filtering by appointment type | Access change |
| Test-record identification rule | Removing test submissions from denominators | Clinic staff |

**Recurring sync remains INACTIVE.** All three appointment workflows are
inactive, no schedule node exists in any of them, and this release activated
nothing. Appointment data is a stored snapshot last refreshed
**2026-09-19 17:34 Pacific**, and the UI says so rather than implying live data.

---

## 8. Monday walkthrough

1. **Reports → Patient journeys.** Read the two badges aloud: *Actual intake
   data*, and *Appointment snapshot — last refreshed …*. Appointment records do
   not update on their own yet.
2. **Registration journey.** Registration → had 14 full days → submitted the
   consultation form. The middle stage is the point: recent registrations are
   removed from the denominator, not counted as failures.
3. **Observed vs equal windows.** "36.4% observed to date" and "23.6% within 14
   days" answer different questions. The first keeps rising as people respond,
   so it can never be used to compare two months.
4. **Appointment evidence.** "At least 60.6%" — a floor, because 685 patients
   have neither a record found nor a complete history. All providers and all
   appointment types; **not** confirmed vasectomy bookings.
5. **Switch to the demo.** Insurance follow-up, badged *DEMO* in the nav.
   Everything there is synthetic.
6. **Staff review without sending.** Approve / Edit / Skip change local state
   only — there is no messaging endpoint behind them. Reset restores the fixture.
7. **Decisions needed for the paid pilot.** Finish Phase B; confirm which status
   values mean the patient arrived; confirm what records procedure completion;
   decide whether appointment-type filtering is worth unblocking
   `/api/appointment_profiles`.
