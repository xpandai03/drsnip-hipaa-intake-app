# DrChrono appointment-type name lookup

**Date:** 23 September 2026, 15:52–16:00 UTC
**Scope:** investigation only. Nothing was committed, pushed, deployed or mapped.
**Follows:** `DRSNIP_POST_CALL_REPORTING_BRIEF.md` §4, `DRCHRONO_APPOINTMENT_ACCESS_CONFIRMATION.md`, `DRSNIP_PATIENT_JOURNEY_DEFINITIONS.md` §2.2.

**Result:** the lookup is **still refused (HTTP 403)** on both documented routes.
The credential itself works: a non-patient control call returned 200. **No
appointment-type name was resolved.** All 13 stored IDs remain unresolved.

This report contains no patient identifiers, appointment identifiers,
credential values, authentication headers or raw payloads. Appointment-profile
IDs are practice configuration and appear below.

---

## 1. Documentation (verified today, not from memory)

**Source:** DrChrono's own OpenAPI schema, which drives the ReDoc page at
`https://app.drchrono.com/api-docs/`. The schema was fetched from
`https://app.drchrono.com/openapi-schema` and reports version "v4 - Hunt
Valley", OpenAPI 3.0.0.

| Endpoint | Methods | Documented OAuth scopes (as listed) |
| --- | --- | --- |
| `/api/appointment_profiles` | GET, POST | `calendar:read`, `calendar:write`, `settings:read`, `settings:write` |
| `/api/appointment_profiles/{id}` | GET, PUT, PATCH, DELETE | same four |
| `/api/appointment_templates` (carries only a `profile` ID, not a name) | GET, POST | same four |
| `/api/appointments` (for comparison) | GET, … | `calendar:read`, `calendar:write`, `clinical:read`, `clinical:write` |

- **How to read the scope lists.** The schema lists read *and* write scopes
  together on every endpoint. Our credential holds `calendar:read` without
  `calendar:write`, and it reads `/api/appointments` successfully. So in
  practice these lists behave as "one of", not "all of". That makes
  `calendar:read` look sufficient on paper, yet the endpoint refuses it (§3).
  **The documentation does not state the actual requirement unambiguously.**
- `settings:read` is described as *"View resources that requires Settings
  permission, such as custom fields."* That wording points to a DrChrono
  **account-level Settings permission** as well as an OAuth scope.
- `AppointmentProfile` fields: `id`, `name`, `archived` ("soft-deleted and
  should not be used"), `duration` (minutes), `online_scheduling`, `doctor`,
  `color`, `reason`, `sort_order`. There is no type or category field. The
  **name is the only interpretive field.**
- `Appointment.profile` is documented as *"ID of an `/api/appointment_profiles`
  instance"*. That confirms our stored `profile_source_id` values are these IDs.
- **No other documented route exposes profile names.** The whole schema was
  searched for any property or endpoint that mentions a profile.
  `appointment_templates` returns only the profile ID. `reminder_profiles` is a
  different object.

---

## 2. Stored IDs (read-only aggregate, production, 15:58 UTC)

There are 13 distinct IDs, plus a few records with no type. The table is in
§4. Counts of 1–4 are shown as `<5`.

---

## 3. What was run

### Execution path

- One **isolated temporary n8n workflow** (`kv1GSaomt1QlLCIp`) with five
  nodes: header-authenticated webhook → allowlisted step planner → one GET →
  in-workflow sanitiser → response.
- The GET node **referenced** the existing `DRSNIP-CHRONO` credential
  (`vCwf0HNhIwA3cFV1`) by ID. Its secret was never extracted.
- Sanitising, inside the workflow:
  - The caller could not supply an arbitrary URL. It could only choose
    `profiles`, `profile_detail` (numeric ID) or `control`.
  - On success, the sanitiser would have kept only `id`, `name`, `archived`,
    `duration`, `online_scheduling` and a `doctor_specific` boolean. **`reason`
    was dropped** as free text.
  - On error it kept only the status, content type, rate-limit headers and
    DRF's `detail` string.
  - For the control call it returned only the status and a boolean, with no
    user identity.
- Retention was **off before the first run**:
  - `saveDataSuccessExecution: none`, `saveDataErrorExecution: none`;
  - `saveManualExecutions: false`, `saveExecutionProgress: false`;
  - no pinned data and no retries.
- **Webhook authentication:** a temporary `httpHeaderAuth` credential
  (`NKzUYHY2DdmLXrGb`).
  - Its secret was generated inside Python, written to a `0600` scratch file,
    and sent to the n8n API over the API's own HTTPS.
  - It was never printed, never passed as a command-line argument (so it is not
    visible in process listings), and never written into a saved script.
  - The n8n API key was read in-process from the MCP config, never printed.
- The run avoided the hourly sync slot (:05). No sync schedule was touched.

### Requests

| # | Call | DrChrono result |
| --- | --- | --- |
| – | Webhook **without** the auth header | Refused by n8n (403 *"Authorization data is wrong!"*). **No DrChrono request** |
| 1 | `GET /api/appointment_profiles?page_size=100` | **403**, `application/json`, body `{"detail": "You do not have permission to perform this action."}`. No rate-limit headers, no `WWW-Authenticate` |
| 2 | Control: `GET /api/users/current` (`user:read`, non-patient) | **200**. Token valid, credential working |
| 3 | `GET /api/appointment_profiles/585137` (documented detail route) | **403**, same body |

**Total: 3 DrChrono requests, out of a budget of 10.** They were well within the
shared 500/hour limit, which the sync's own 150/hour cap sits under.

- Request 3 had one concrete purpose: to separate a list-only restriction from a
  restriction on the resource. It showed the restriction covers the resource.
  No further variations were tried, because the documentation offers no other
  route under existing permissions.
- Any OAuth token refresh n8n might perform is not visible from outside. The
  credential's `updatedAt` did not change (§6), which suggests none was written.

**Coverage: 0 of 13 IDs resolved.** No page was retrieved, so there is no
partial list to report.

---

## 4. Stored IDs → names

| Profile ID | Records | Charts | Scheduled span | Verified name | Archived | Duration |
| --- | --: | --: | --- | --- | --- | --- |
| 585137 | 1,749 | 1,327 | 2023-12 → 2026-12 | **unresolved** | – | – |
| 875741 | 600 | 581 | 2026-05 → 2026-10 | **unresolved** | – | – |
| 503309 | 103 | 95 | 2025-03 → 2026-10 | **unresolved** | – | – |
| 585138 | 75 | 59 | 2025-05 → 2026-11 | **unresolved** | – | – |
| 874156 | 17 | 16 | 2026-08 → 2026-09 | **unresolved** | – | – |
| 866117 | 14 | 14 | 2026-06 → 2026-09 | **unresolved** | – | – |
| 503310 | 5 | 5 | 2026-07 → 2026-09 | **unresolved** | – | – |
| 594438 | 5 | 5 | 2026-07 → 2026-10 | **unresolved** | – | – |
| 594437 | <5 | <5 | 2024-12 → 2026-09 | **unresolved** | – | – |
| 594436 | <5 | <5 | 2026-10 | **unresolved** | – | – |
| 873325 | <5 | <5 | 2026-01 | **unresolved** | – | – |
| 874151 | <5 | <5 | 2026-09 | **unresolved** | – | – |
| 886171 | <5 | <5 | 2026-08 | **unresolved** | – | – |
| (no type) | <5 | <5 | 2026-08 → 2026-09 | n/a | – | – |

The behaviour patterns recorded in the brief (§4.3) remain **hypotheses**. They
are not names and not business meanings. This lookup neither confirms nor
refutes them. In particular:

- nothing here shows that the blank-status types are administrative records;
- nothing here shows that 585138 is follow-up testing;
- nothing here shows which of 585137 and 503309 is "Consultation with
  vasectomy".

---

## 5. Remaining access limitation

- **Exact observation:** a valid token for this credential, which can read
  `/api/users/current` and `/api/appointments`, receives DRF's generic
  permission-denied response on both `/api/appointment_profiles` routes.
- **Cause: not determinable from outside.** There are two candidates, and both
  are consistent with the documentation:
  1. **The OAuth grant lacks `settings:read`.** The credential's configured
     scopes were recorded previously as `user:read patients:read patients:write
     patients:summary:read patients:summary:write clinical:read clinical:write
     calendar:read`. Its data is not readable through the n8n API, so the scopes
     were not re-read today. Nothing in the n8n metadata changed.
  2. **The connected DrChrono user lacks the account-level "Settings"
     permission**, which the `settings:read` description refers to.
- **Why neither was attempted:**
  - Fixing (1) means re-authorising `DRSNIP-CHRONO`, which replaces the token
    used by all five live intake workflows and cannot be rolled back.
  - Fixing (2) means the practice owner changing a user's permissions in
    DrChrono.
  - Both are outside this task's authorisation.

**Cheapest way to resolve it (no access change):** Jeff or a staff member opens
DrChrono's appointment-profile settings and sends the name for each ID in §4. A
screenshot is fine, and it involves no patient data. The four that matter most
are 585137, 503309, 585138 and 875741.

If a programmatic route is preferred later, the owner would first need to grant
`settings:read` and/or the Settings permission. After that, the same temporary
workflow pattern resolves every ID in one or two requests.

---

## 6. Cleanup verification

| Step | Result |
| --- | --- |
| Temporary workflow deactivated | ✓ |
| Webhook callable after deactivation | **No**: n8n returns 404, *"webhook … is not registered"* |
| Temporary workflow deleted | ✓. `GET /workflows/kv1GSaomt1QlLCIp` returns 404 |
| Temporary credential deleted | ✓. `NKzUYHY2DdmLXrGb` is absent from the credential list |
| Temporary secret file removed | ✓ |
| Execution records persisted | **None**. The execution list for the temporary workflow was empty before deletion, so there was nothing to remove |
| Existing workflows | 19 before and 19 after. **No additions, no removals, and no change** to any `name`, `active`, `updatedAt` or `versionId`. That includes the hourly sync `jUNJrRWhZkogFhpX` and the catch-up `9Wvd36XnnbDdypaf` |
| Existing credentials | 5 before and 5 after. **No change** to any `updatedAt`, including `DRSNIP-CHRONO` (`2026-09-21T21:48:46Z` both times) |
| Scopes, account permissions, global n8n settings, sync schedules, patient or appointment records | Not touched |

What remains in the local scratchpad: helper scripts that read the n8n API key
from config at runtime but contain no secret literal, and the downloaded public
OpenAPI schema. Nothing remains in n8n.

---

## 7. Inclusion and exclusion questions for monthly reporting

**Once names are available**, the following would still need answers.

**Suggested treatment.** These are suggestions and approve nothing:

- **Candidate "qualifying" types:** the name(s) that denote an initial
  consultation and/or consultation-with-procedure.
- **Candidate exclusions:** names denoting post-procedure semen testing (PVST),
  follow-ups, phone or administrative entries, or anything archived.
- An archived profile (`archived: true`) that still carries historical records
  stays in the history. Whether it qualifies is decided by its name, not by its
  archived flag.

**Decisions that are Jeff's, whatever the names say:**

1. Does a completed **consultation-only** appointment count as converted, or
   only a procedure appointment? This covers `Procedure Not Performed` and
   `Signed No Review` where no procedure was done.
2. If there are separate "consultation" and "consultation with vasectomy"
   types, does booking *either* one count as "scheduled"?
3. Are the after-the-fact, blank-status types (875741, 874156, 866117) excluded
   entirely? Their names should make this obvious, but Jeff confirms it.
4. Is PVST or any follow-up type excluded from conversion, as he implied on the
   call (T:147–148)? If so, is it still worth showing as a separate secondary
   count?
5. Should any rarely used type (under 5 records) be folded into "other", or
   classified individually?

A profile name alone does not approve a conversion definition. The
qualifying-type set still goes through its own provenance path (brief §5.4).

---

## 8. Answers

1. **Did we resolve the type names?** **No.** Both documented routes still
   return 403 with a working credential. 0 of 13 IDs were resolved, using 3 of
   the 10 budgeted requests.
2. **Can we now distinguish initial appointments from follow-up testing?**
   **No, not from verified names.** We have only the behavioural hypotheses in
   the brief, which must not be used as definitions.
3. **What still requires Jeff's decision?**
   - First, the names themselves. The fastest route is a screenshot of the
     appointment-profile list, especially 585137, 503309, 585138 and 875741.
   - Then the five inclusion questions in §7, above all whether
     consultation-only completion counts.
   - Separately, whether he wants to grant `settings:read` or the Settings
     permission for a programmatic lookup. This is optional, and re-authorising
     affects the live intake workflows.
4. **Is the monthly calculation ready to build?** **The calculation is; its
   qualifying-type set is not.** Prompt two can build the brief §9 scope now:
   status rules, cohort, partition suppression, route and UI, with the type set
   `unconfigured` and the view labelled "Any appointment type — provisional".
   It must not publish anything called "conversion" until the names arrive and
   Jeff approves the set.
