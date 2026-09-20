# Dr. Snip journey dashboard — implementation and verification

**Date:** 2026-09-20
**Scope:** connect the verified calculation layer to the console through a secure
aggregate endpoint, and deliver working live-data views locally.
**Not in scope:** deployment, commit/push, sync activation, completing Phase B.

> Counts only. No patient identifiers, appointment identifiers, individual
> timelines or small identifying groups appear here or in any screenshot.
> Screenshots use synthetic fixtures, including small-cell edge cases.

---

## 1. Routes and components

| Thing | Path | State |
|---|---|---|
| Journeys page | `/admin/journeys` | new, real data |
| Page component | `artifacts/intake-form/src/pages/admin/Journeys.tsx` | new |
| Metric registry | `Intake-form/lib/metrics/registry.ts` | new |
| Aggregate endpoint | `Intake-form/api/reports/journey.ts` | new |
| Access migration | `Intake-form/lib/db/migrations/0014_journey_metrics_access.sql` | new, **applied to production** |
| Suppression upgrade | `Intake-form/lib/metrics/contract.ts` | extended |
| Waterfall component | `components/ui/waterfall-chart.tsx` | two defects fixed (§4) |
| Navigation | `admin-nav.ts` — Reports → Patient journeys | 9 destinations, was 8 |

The synthetic insurance follow-up demonstration stays exactly where it was, at
`/admin/insurance-demo`, still flagged `demo: true` in the nav. **Its source was
not touched** (`git diff` against HEAD is empty for that directory), and a test
asserts the journeys page imports nothing from its fixtures.

---

## 2. Aggregate endpoint contract

`GET /api/reports/journey?metric=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&window=7|14|30`

Auth-guarded with `requireAuth`, exactly like the other reporting routes. Not public.

**Metrics (a closed allow-list):** `registration_to_consultation`,
`insurance_to_registration`, `appointment_evidence_registration`,
`appointment_evidence_insurance`.

The response carries both modes **side by side** — `observed_to_date` and
`mature_window` — so neither can be mistaken for the other, plus `cohort`,
named `secondary` counts, `coverage.unresolved`, `durations`, `provider_scope`,
`is_observed_minimum`, `status`, `scope` and `freshness`.

**Returned:** aggregate counts, rates as fractions, and non-identifying metadata.
**Never returned:** patient or appointment ids, individual event timestamps, raw
statuses tied to a person, or source payloads. Aggregate freshness timestamps
*are* returned, so the UI can label the snapshot's age.

Values are numbers. Formatting happens at the edge; nothing is pre-rounded or
percent-signed, so a display string can never be mistaken for a computed value.

---

## 3. Database access: applied, and why it is shaped this way

`0014_journey_metrics_access.sql` — **applied to production**, idempotent,
verified locally first (twice) and asserted on every run.

It creates `drsnip_metrics_fn`, a **NOLOGIN, non-superuser** role that owns two
`SECURITY DEFINER` functions and holds `SELECT` on exactly four tables.

| Control | Implementation |
|---|---|
| Owner | `drsnip_metrics_fn`, **not** the application role. A `SECURITY DEFINER` function owned by a superuser would hand every caller superuser reach. |
| `search_path` | `pg_catalog, pg_temp`. `public` is **absent** — every object is schema-qualified — and `pg_temp` is listed **last and explicitly**, because omitting it makes it searched *first*, letting a caller shadow a table with a temporary one. |
| Metric selection | Fixed allow-list in a `CASE`; nothing from the caller is concatenated into SQL. |
| Validation | Window ∈ {7,14,30}; `to > from`; span ≤ 400 days; start ≥ 2026-01-01. A future end date is **clamped, not refused**. |
| Suppression | Applied **inside** the function, so a small cell never crosses the boundary — not to the API, not to a log, not to an error message. |
| Cost | `statement_timeout = 15s`, `lock_timeout = 3s`, plus an independent span check in the route. |
| Grants | `REVOKE ALL FROM PUBLIC`; `EXECUTE` to `drsnip_reporting_ro` and the app role only. Verified: `public_exec = f`, `ro_exec = t`. |

**The reporting role gained no table access.** Verified by connecting as
`drsnip_reporting_ro` and confirming `SELECT` on `submissions`,
`appointment_snapshots` and `appointment_status_transitions` all fail with
*permission denied*, while the same role successfully obtains aggregates through
the function.

I did **not** copy the illustrative function from the metrics report. That
sketch had `SET search_path = public` (caller-resolvable, with no `pg_temp`
handling) and no stated owner — reviewing it is what produced the design above.

---

## 4. Corrected metric and privacy issues

**Attendance is no longer blocked on procedure completion.** The earlier report
listed three attendance blockers, including "procedure completion is not
established". That overstates the requirement: procedure completion is a
*separate question with its own separate answer*, not a prerequisite for
reporting attendance. Attendance now carries exactly two blockers — incomplete
transition retrieval and an unconfirmed arrival mapping — and procedure
completion is listed as its own unavailable metric. A test asserts the
attendance blocker list does not mention "procedure".

**"Never booked" and "no appointment on record at all" are gone.** Absence is
now phrased as bounded by accessible records, retrieval scope and as-of time. A
test greps the registry for both banned phrasings.

**Observed minima are labelled as proportions, not conversions.** The card reads
"at least 61.1%" with the unresolved count beside it, and the expandable text
says plainly it is *a proportion of the cohort, but not a complete
booking-conversion rate*. Nothing says "booked" or "attended".

**Cohort maturity: the rule is per entry, not per month — and the earlier report
was wrong about it.** It claimed September had no 14-day figure because "its
cohort has not had 14 days". Against production: September has **405 entries, of
which 111 are mature at 14 days**, with 19 converted. Per-entry maturity is what
the SQL always did; the prose misdescribed it. The UI states the rule explicitly:
*"a September patient who registered on the 2nd IS included; one who registered
yesterday is not."*

**Privacy suppression was re-audited, not copied — and the report itself was
leaking.** Two disclosures published in `DRSNIP_JOURNEY_METRICS_VERIFICATION.md`:

- `already_registered = 2` — a small cell, published directly.
- "its denominator is 4" — a small denominator, disclosed in prose while the
  rate was withheld.

Worse, publishing *both* `entries_total = 69` and `eligible = 67` recovers the
suppressed 2 by subtraction. The boundary now suppresses:

| Risk | Handling |
|---|---|
| Small cell | Withheld (null), never zero. |
| Small **cohort** | The group's own size is withheld first, then every derived figure. |
| Small complement | `n − k` small is as disclosive as `k` small; both sides and the rate go together. |
| Recovery by subtraction | When a sub-group is withheld, a total that would reveal it is withheld too. |
| Percentiles | Withheld whole when matched < 5 — a median of three durations describes those three people. |

**A small sub-group must not destroy a usable metric.** My first cut withheld
*everything* for insurance because the 2-person excluded group forced the cohort
null. Fixed: the **total** is dropped, the metric survives. Production now
returns cohort withheld, `25 / 67` observed and `15 / 35` mature — both
publishable, the small group unrecoverable.

**Two waterfall component defects, both pre-existing:**

1. The caption under a stage was hard-coded to "not measured" for every
   non-suppressed state, so the attendance stage read "not available" above and
   "NOT MEASURED" below. Those mean different things — nothing tracks it, versus
   the source cannot answer yet. Now uses `markerText(stage.state)`.
2. In vertical (mobile) mode the silhouette is centred on the full width while
   labels sit in a 34% gutter, so the widest stage ran from 24% to 76% and put
   dark-slate label text on a dark navy band. A `VERTICAL_LABEL_GUTTER` now
   insets the drawing region. Before/after crops are in the screenshots folder.

---

## 5. Ready, conditional, blocked

**Ready** — shown with both modes, always:
- Consultation form submitted after registration.
- Registration after insurance inquiry.

**Conditional** — shown with an explicit coverage label:
- The four appointment-record measures, as observed minima with `unresolved`
  displayed next to them, and an all-providers/all-types scope note.

**Blocked** — rendered as an unavailable stage and an unavailable card, with a
short reason, never a zero-height stage or a 0%:
- Attendance.
- Procedure completion.

---

## 6. Verification

### Automated

**Full API suite: 406 passing, 0 failures** (17 cancelled from the pre-existing
`DATABASE_URL` gap; 64 skipped are DB-backed suites). Typecheck clean.
**31 tests** in `api/_test/journey-endpoint.test.ts`, of which the database
group runs as the **actual restricted role**.

Covered: auth and method enforcement; allow-list rejection (including
`'; DROP TABLE submissions; --` and prototype keys such as `toString`); input
validation and bounded cost; aggregate-only response shape; no direct PHI-table
read from the route; no driver message echoed to the client; restricted-role
access; small-cell and complementary suppression; percentile suppression;
per-entry maturity; observed-vs-mature labelling; zero versus missing versus
blocked; overlapping categories not summed; actual/demo separation; no "Live"
badge; failure never rendering as zero; function owner not a superuser;
`search_path` pinned with `pg_temp` last; `EXECUTE` revoked from `PUBLIC`.

### Reconciliation against production

The function's output was compared with independently written aggregate queries
(`DISTINCT ON` + `EXISTS` rather than correlated `min()`, explicit
`interval '336 hours'`) over the same as-of conditions:

| Measure | Function | Independent | |
|---|---|---|---|
| Registration cohort | 1,842 | 1,842 | ✅ |
| Observed converted | 672 | 672 | ✅ |
| Mature 14-day denominator | 1,548 | 1,548 | ✅ |
| Mature 14-day numerator | 366 | 366 | ✅ |

**Zero discrepancies.** Current production values (2026-09-20 02:00 UTC):
registration 36.5% observed / 23.6% at 14 days; insurance 37.3% observed /
42.9% at 14 days; appointment evidence ≥60.6% with 683 unresolved; September
19/111 at 14 days; July 144/571 versus August 140/621 on equal windows.

**Expect drift.** These move as forms arrive: the cohort grows, and
observed-to-date rises as existing cohorts age. Only the appointment figures are
frozen, because the snapshot is not refreshed. Numbers are not hard-coded
anywhere in the endpoint, the page or the tests.

### Visual and interaction

Inspected at **1440×900**, **820×1180** and **390×844**.

- **Horizontal overflow: 0px at every width**, on both tabs.
- Keyboard: 11 focus stops — both tabs, both filters, all four waterfall stages
  (each with a descriptive accessible name), and both expandable explanations.
  **Every one shows a visible focus ring.** Enter switches tabs; the window
  filter applies.
- The waterfall is horizontal on desktop and **vertical on mobile**, because
  four horizontal stages at 390px truncate every label.
- Funnel geometry is used **only** for genuinely nested stages. Appointment
  evidence is cards, with "overlapping categories, not a funnel" stated above
  them.
- Attendance renders as an unavailable stage and card, not a zero.
- Small-cell states render as "Withheld" with a reason, not as 0 or a blank.

Screenshots: [`journey-screenshots-2026-09-20/`](journey-screenshots-2026-09-20/)
— six page captures plus before/after crops of the mobile label fix.

**Update — this gap is now closed.** `/admin/insurance-demo` rendered blank
because my API mock was malformed, not because the page was broken:
`/api/auth/me` returns `{email, name, role}` at the top level, and I had wrapped
it as `{user: {...}}`, leaving `name` undefined and crashing the shared shell's
user chip. With the correct shape the demo renders fully — all three views,
Approve/Edit/Skip, Reset — on desktop and mobile, with **0 write requests** and
0 page errors. See `DRSNIP_JOURNEY_DASHBOARD_RELEASE_NOTES.md`.

---

## 7. Remaining dependencies

| Dependency | Needed for | Owner |
|---|---|---|
| Phase B: per-patient retrieval for ~1,930 patients | Attendance; turning appointment minima into rates | A backfill task |
| Arrival-status mapping | Attendance | Clinic staff |
| Procedure-completion field | Procedure metrics | Clinic staff |
| `/api/appointment_profiles` (403) | Filtering by appointment type | Access change |
| Test-record rule | Removing test submissions from denominators | Clinic staff |

---

## 8. Deployment prerequisites

1. **`0014` is already applied to production.** No further DB step is required
   for the endpoint to work. It is **not** registered in `migrate.ts` (it creates
   a role), so a deploy will not replay it.
2. Commit the working tree and open a PR. **Branch
   `feat/console-redesign-insurance-demo` still has unpushed commits and no PR**
   — outstanding from an earlier task and unchanged by this one.
3. Deploy the app. The endpoint needs no new secret or environment variable.
4. After deploy, load `/admin/journeys` signed in and confirm the appointment
   snapshot timestamp renders.
5. Re-verify `/admin/insurance-demo` with the full mock set (§6).

---

## 9. Monday walkthrough

1. **Reports → Patient journeys.** Point at the two badges: *Actual intake data*,
   and *Appointment snapshot — last refreshed …*. Say the sentence under them —
   appointment records do not update on their own yet.
2. **Registration journey.** The funnel is registration → had 14 full days →
   submitted the consultation form. Note the middle stage: recent registrations
   are removed from the denominator rather than counted as failures.
3. **The two cards.** "36.5% observed to date" and "23.6% within 14 days" are
   different questions. The first keeps rising as people respond.
4. **Appointment record evidence.** "At least 61.1%" — a floor, because 683
   patients have neither a record found nor a complete history. All providers and
   all appointment types; not confirmed vasectomy bookings.
5. **Attendance.** Deliberately blank, with the reason. We can say who filled in
   which form and when; we cannot yet say who turned up.
6. **Insurance inquiry journey.** Same shape. Some totals read *Withheld* —
   small groups are not published.
7. **Insurance follow-up (demo)** is the separate, clearly-flagged synthetic page.
