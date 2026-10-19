// GENERATED FILE — do not edit.
// Built by lib/sync/build-code-node.mjs from:
//   lib/sync/n8n-appointment-sync.code.js  (logic, unit tested)
//   lib/sync/n8n-code-node.glue.js         (n8n wiring)
// Paste the whole file into the n8n workflow's "Project Page" Code node.

// DrChrono appointment sync — the pure logic, and the SINGLE SOURCE OF TRUTH.
//
// This file is unit-tested directly (api/_test/appointment-sync.test.ts) and is
// pasted VERBATIM into the n8n workflow's "Sync Logic" Code node, followed by a
// short n8n-specific wrapper. Everything below is free of n8n globals and of
// node built-ins on purpose, so the same bytes run in both places.
//
// It computes no metric and asserts no clinical outcome. It projects, it
// de-duplicates, it budgets requests, and it decides when a cursor may move.
// Classification (what counts as "attended", which providers or profiles count)
// is deliberately NOT here — those mappings are unconfirmed and belong to the
// later metric task.

// ---------------------------------------------------------------------------
// Field policy
// ---------------------------------------------------------------------------

// The ONLY appointment fields that may ever reach a database row.
const SNAPSHOT_FIELDS = [
  "id",
  "patient",
  "doctor",
  "office",
  "profile",
  "created_at",
  "scheduled_time",
  "updated_at",
  "status",
  "deleted_flag",
];

// `verbose=true` is required for status_transitions, but it also returns
// clinical content. These must be dropped the moment a response is parsed and
// must never be written, logged or returned.
const FORBIDDEN_FIELDS = [
  "clinical_note",
  "vitals",
  "custom_vitals",
  "reminders",
  "reason", // free text a patient or staff member typed
  "notes",
  "telehealth_url",
  "custom_fields",
  "icd10_codes",
  "payment_profile",
  "ins1_status",
  "ins2_status",
];

/** True if an object still carries anything we refuse to persist. */
function hasForbiddenField(obj) {
  if (!obj || typeof obj !== "object") return false;
  return FORBIDDEN_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(obj, f));
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * DrChrono's documented `since` format: ISO 8601 with NO timezone
 * ("2014-02-24T15:32:19"). We hold watermarks in UTC and render them in this
 * shape. Because the parameter carries no zone, the server's interpretation is
 * not something we control — which is exactly why every incremental read also
 * applies an overlap window (see sinceWithOverlap).
 */
function toDrChronoStamp(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

/** Parse a source timestamp to an ISO string, or null. Never throws. */
function toIsoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The `since` value for the next incremental read.
 *
 * Always rewinds by an overlap so a boundary record cannot fall between two
 * runs — the API's zone handling for `since` is undocumented, ordering is not
 * guaranteed, and a record updated during the previous run may have been
 * missed. Overlap costs duplicate reads, which are free because upserts are
 * idempotent.
 */
function sinceWithOverlap(watermark, overlapMinutes) {
  if (!watermark) return null; // no completed run yet -> caller decides the floor
  const d = new Date(watermark);
  if (Number.isNaN(d.getTime())) return null;
  const minutes = Number.isFinite(overlapMinutes) ? overlapMinutes : 120;
  return new Date(d.getTime() - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Source ids are opaque. Keep them as strings; never coerce to a number. */
function idToText(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Project one raw appointment into the snapshot column set.
 *
 * Returns null when the appointment has no patient — an appointment we cannot
 * attribute is discarded, never stored.
 *
 * `status` keeps the '' vs null distinction: null means the field was absent,
 * '' means it was present and empty (the majority of this practice's rows).
 * Do not coalesce them; the difference is load-bearing.
 */
function projectAppointment(raw, ctx) {
  if (!raw || typeof raw !== "object") return null;
  const id = idToText(raw.id);
  const patient = idToText(raw.patient);
  if (!id || !patient) return null;

  return {
    source_appointment_id: id,
    source: "drchrono",
    practice_group_id: ctx && ctx.practiceGroupId ? String(ctx.practiceGroupId) : null,
    patient_source_id: patient,
    doctor_source_id: idToText(raw.doctor),
    office_source_id: idToText(raw.office),
    profile_source_id: idToText(raw.profile),
    source_created_at: toIsoOrNull(raw.created_at),
    scheduled_time: toIsoOrNull(raw.scheduled_time),
    source_updated_at: toIsoOrNull(raw.updated_at),
    status: Object.prototype.hasOwnProperty.call(raw, "status")
      ? (raw.status === null ? null : String(raw.status))
      : null,
    deleted_flag: typeof raw.deleted_flag === "boolean" ? raw.deleted_flag : null,
    archived: typeof raw.archived === "boolean" ? raw.archived : null,
  };
}

/**
 * Deterministic identity for a transition when the source supplies no id.
 *
 * DrChrono transition objects are {appointment, datetime, from_status,
 * to_status} with no id of their own, so this composite is the key. It is a
 * delimited string rather than a hash: deterministic, collision-free by
 * construction, and readable when something needs debugging.
 */
function transitionDedupeKey(appointmentId, transitionAt, fromStatus, toStatus) {
  const at = toIsoOrNull(transitionAt) || "";
  const from = fromStatus === null || fromStatus === undefined ? "" : String(fromStatus);
  const to = toStatus === null || toStatus === undefined ? "" : String(toStatus);
  return [String(appointmentId), at, from, to].join("|");
}

/**
 * Extract status transitions, verbatim and de-duplicated within the response.
 *
 * Returns { present, rows }. `present: false` means the response carried no
 * transitions field at all — which is NOT the same as "this appointment has
 * none", and the caller must not delete stored history on that basis.
 */
function extractTransitions(raw) {
  if (!raw || typeof raw !== "object") return { present: false, rows: [] };
  const id = idToText(raw.id);
  if (!id) return { present: false, rows: [] };
  if (!Object.prototype.hasOwnProperty.call(raw, "status_transitions")) {
    return { present: false, rows: [] };
  }
  const list = raw.status_transitions;
  if (!Array.isArray(list)) return { present: false, rows: [] };

  const seen = new Set();
  const rows = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const at = toIsoOrNull(t.datetime);
    const from = t.from_status === undefined ? null : t.from_status;
    const to = t.to_status === undefined ? null : t.to_status;
    const key = transitionDedupeKey(id, at, from, to);
    if (seen.has(key)) continue; // the same array can repeat a transition
    seen.add(key);
    rows.push({
      source_appointment_id: id,
      source_transition_id: t.id === undefined || t.id === null ? null : String(t.id),
      transition_at: at,
      from_status: from === null ? null : String(from),
      to_status: to === null ? null : String(to),
      dedupe_key: key,
    });
  }
  return { present: true, rows };
}

// ---------------------------------------------------------------------------
// Ordering / staleness
// ---------------------------------------------------------------------------

/**
 * Should an incoming snapshot overwrite the stored one?
 *
 * Pagination ordering is not guaranteed and retries can replay an older page,
 * so a response is only allowed to win when it is at least as fresh as what is
 * already stored. Equal timestamps overwrite (same record, harmless) so
 * provenance columns still refresh.
 */
function shouldOverwrite(storedUpdatedAt, incomingUpdatedAt) {
  if (!incomingUpdatedAt) return !storedUpdatedAt; // no basis to claim freshness
  if (!storedUpdatedAt) return true;
  const a = new Date(storedUpdatedAt).getTime();
  const b = new Date(incomingUpdatedAt).getTime();
  if (Number.isNaN(b)) return false;
  if (Number.isNaN(a)) return true;
  return b >= a;
}

/** Keep only appointments whose patient is linked to intake. */
function partitionByLinkage(appointments, linkedPatientIds) {
  const linked = linkedPatientIds instanceof Set
    ? linkedPatientIds
    : new Set((linkedPatientIds || []).map(String));
  const keep = [];
  let discarded = 0;
  for (const a of appointments) {
    if (a && linked.has(String(a.patient_source_id))) keep.push(a);
    else discarded += 1;
  }
  return { keep, discarded };
}

// ---------------------------------------------------------------------------
// Rate budget
// ---------------------------------------------------------------------------

/**
 * Two limits at once, because spacing alone is not a budget.
 *
 * DrChrono allows 500 requests/hour, throttles at 10/second, and throttles
 * again above 290 requests in any rolling 10 minutes. Five active intake
 * workflows share this credential, so the sync reserves only a slice:
 * SUSTAINED_PER_HOUR well under 500, and a burst cap far under 290/10min.
 *
 * A 2-second delay yields 1,800 requests/hour — over the limit on its own.
 * That is why this is a counter, not a sleep.
 */
function createRateBudget(opts) {
  const o = opts || {};
  const maxRequests = Number.isFinite(o.maxRequests) ? o.maxRequests : 120;
  const burstWindowMs = Number.isFinite(o.burstWindowMs) ? o.burstWindowMs : 600_000;
  const maxInBurstWindow = Number.isFinite(o.maxInBurstWindow) ? o.maxInBurstWindow : 60;
  const minSpacingMs = Number.isFinite(o.minSpacingMs) ? o.minSpacingMs : 2000;

  const stamps = [];
  let used = 0;

  return {
    get used() { return used; },
    get remaining() { return maxRequests - used; },
    /** Can another request be made at time `now`? Returns a reason when not. */
    check(now) {
      if (used >= maxRequests) return { ok: false, reason: "budget_exhausted" };
      const cutoff = now - burstWindowMs;
      const recent = stamps.filter((s) => s > cutoff);
      if (recent.length >= maxInBurstWindow) {
        return { ok: false, reason: "burst_window_full", retryAfterMs: recent[0] + burstWindowMs - now };
      }
      const last = stamps.length ? stamps[stamps.length - 1] : -Infinity;
      if (now - last < minSpacingMs) {
        return { ok: false, reason: "too_soon", retryAfterMs: minSpacingMs - (now - last) };
      }
      return { ok: true };
    },
    record(now) {
      used += 1;
      stamps.push(now);
      const cutoff = now - burstWindowMs;
      while (stamps.length && stamps[0] <= cutoff) stamps.shift();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP outcome handling
// ---------------------------------------------------------------------------

/** What a status code means for the run. */
function classifyHttp(status) {
  if (status === 200) return "ok";
  if (status === 401) return "auth_failure";
  if (status === 403) return "permission_failure";
  if (status === 429) return "rate_limited";
  if (status === 400) return "bad_request";
  if (status === 404) return "not_found";
  if (typeof status === "number" && status >= 500) return "transient";
  return "unclassified";
}

/** Should the run retry, stop, or fail on this outcome? */
function retryPolicy(kind, attempt, maxAttempts) {
  const max = Number.isFinite(maxAttempts) ? maxAttempts : 4;
  if (kind === "ok") return { action: "continue" };
  // A persistent permission or auth failure will not fix itself. Stop and
  // report rather than burning budget.
  if (kind === "auth_failure" || kind === "permission_failure") {
    return { action: "stop", outcome: "failed" };
  }
  if (kind === "bad_request" || kind === "not_found") {
    return { action: "stop", outcome: "failed" };
  }
  if (kind === "rate_limited" || kind === "transient") {
    if (attempt >= max) return { action: "stop", outcome: "partial" };
    const backoffMs = Math.min(60_000, 1000 * Math.pow(2, attempt));
    return { action: "retry", backoffMs };
  }
  return { action: "stop", outcome: "failed" };
}

/** Honour Retry-After (seconds, or an HTTP date). Falls back to the backoff. */
function retryAfterMs(headerValue, fallbackMs) {
  if (headerValue === null || headerValue === undefined || headerValue === "") return fallbackMs;
  const asNum = Number(headerValue);
  if (Number.isFinite(asNum)) return Math.max(0, asNum * 1000);
  const asDate = new Date(headerValue).getTime();
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return fallbackMs;
}

/**
 * Reduce an error to something safe to store.
 * Strips anything digit-like that could be an identifier, and any email.
 */
function sanitizeError(input) {
  if (input === null || input === undefined) return null;
  const raw = typeof input === "string" ? input : (input.message || String(input));
  return raw
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\d{4,}/g, "[#]")
    .slice(0, 300);
}

// ---------------------------------------------------------------------------
// Run outcome
// ---------------------------------------------------------------------------

/**
 * Decide the run's outcome and — critically — whether the watermark may move.
 *
 * The cursor advances ONLY when the run processed its entire authorized scope
 * without an unrecovered failure. A partial run keeps the old watermark, so the
 * next run re-reads the same ground rather than skipping it.
 */
function finalizeRun(state) {
  const s = state || {};
  const complete = s.completedScope === true && !s.hadUnrecoveredFailure;
  let outcome;
  if (s.lockContended) outcome = "lock_contended";
  else if (s.hadUnrecoveredFailure) outcome = "failed";
  else if (s.budgetExhausted) outcome = "budget_exhausted";
  else if (complete) outcome = "success";
  else outcome = "partial";

  return {
    outcome,
    complete,
    // Only a complete run may publish a generation or advance the cursor.
    watermark_after: complete ? (s.runCutoff || null) : null,
    committed_generation: complete ? (s.generation || null) : null,
    coverage: s.coverage || "bounded_pilot",
  };
}

/**
 * A backfill must never inherit an incremental/pilot cursor: doing so would
 * silently declare all earlier history already covered.
 */
function backfillStartFloor(scopeState, explicitFloorIso) {
  const st = scopeState || {};
  if (st.history_complete === true && st.watermark) {
    return { floor: st.watermark, reason: "history already complete for this scope" };
  }
  if (!explicitFloorIso) {
    return { floor: null, reason: "REFUSED: a backfill needs an explicit floor; it may not inherit a watermark" };
  }
  return { floor: explicitFloorIso, reason: "explicit floor supplied" };
}

// ---------------------------------------------------------------------------
// Exports (stripped when pasted into the n8n Code node)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// n8n glue — the part that talks to n8n, appended to the logic module above.
//
// Everything above this line is lib/sync/n8n-appointment-sync.code.js, copied
// verbatim by lib/sync/build-code-node.mjs. Do not edit the combined file:
// edit the module or this glue and regenerate. A unit test fails if the
// committed generated file drifts from its inputs.
//
// Runs in the "Project Page" Code node, mode: Run Once for All Items.
// Input : one item per DrChrono response page (the HTTP node paginates).
// Output: one item per appointment we are keeping, plus ALWAYS at least one
//         item, so n8n never skips the nodes that finish and release the run.
// ---------------------------------------------------------------------------

// The same generated node runs in both the incremental workflow and the
// backfill workflow, which name their config node differently. Resolving by a
// candidate list keeps ONE generated artifact — and one tested code path —
// instead of two copies that drift.
function readConfig() {
  for (const name of ['Sync Config', 'Pilot Bounds', 'Backfill Config', 'Catchup Config']) {
    try {
      const n = $(name);
      if (n) return n.first().json;
    } catch (e) { /* not this one */ }
  }
  throw new Error('no config node found (expected Sync Config / Pilot Bounds / Backfill Config / Catchup Config)');
}

const bounds = readConfig();
const run = $('Claim Scope').first().json;

// The linked-id set is the only thing this workflow learns about intake.
const linkedIds = $('Linked Patient IDs').all().map((i) => String(i.json.patient_source_id));

// Flatten the pages. DrChrono returns { results: [...], next, previous }.
const raw = [];
for (const item of $input.all()) {
  const body = item.json && item.json.results ? item.json : (item.json && item.json.body) || {};
  if (Array.isArray(body.results)) raw.push(...body.results);
}

// Project first, then filter by linkage — nothing unlinked is ever emitted.
const projected = [];
let noPatient = 0;
for (const r of raw) {
  const p = projectAppointment(r, { practiceGroupId: bounds.practice_group_id || null });
  if (!p) { noPatient += 1; continue; }
  // Belt and braces: the projector whitelists columns, so this should never
  // fire. If it ever does, fail loudly rather than write clinical text.
  if (hasForbiddenField(p)) {
    throw new Error('projection produced a forbidden field; refusing to write');
  }
  p._transitions = extractTransitions(r);
  projected.push(p);
}

const { keep, discarded } = partitionByLinkage(projected, linkedIds);

// Did the page cap cut the fetch short? If the last response still carried a
// `next` link, this run did NOT see its whole window, so it must report
// itself incomplete. Otherwise a budget cap would quietly look like coverage.
const pages = $input.all();
const lastBody = pages.length
  ? (pages[pages.length - 1].json && pages[pages.length - 1].json.results
      ? pages[pages.length - 1].json
      : (pages[pages.length - 1].json || {}).body || {})
  : {};
const truncated = Boolean(lastBody && lastBody.next);

const meta = {
  run_id: run.run_id,
  run_cutoff: run.run_cutoff,
  truncated,
  pages_fetched: pages.length,
  appointments_seen: raw.length,
  appointments_persisted: keep.length,
  appointments_discarded: discarded + noPatient,
  transitions_persisted: keep.reduce((n, a) => n + a._transitions.rows.length, 0),
};

const out = keep.map((a) => ({
  json: {
    ...a,
    transitions_present: a._transitions.present,
    transitions: a._transitions.rows,
    transition_keys: a._transitions.rows.map((t) => t.dedupe_key),
    run_id: run.run_id,
    is_sentinel: false,
    meta,
  },
}));

if (out.length === 0) {
  // The sentinel. Every id is null, which every write statement treats as a
  // no-op (INSERT ... SELECT ... WHERE $1 IS NOT NULL), so the run still
  // reaches "Finish Run" and "Release Lease" instead of hanging on to the
  // scope lease until it expires.
  out.push({
    json: {
      source_appointment_id: null, patient_source_id: null, doctor_source_id: null,
      office_source_id: null, profile_source_id: null, source_created_at: null,
      scheduled_time: null, source_updated_at: null, status: null,
      deleted_flag: null, archived: null, practice_group_id: null,
      transitions_present: false, transitions: [], transition_keys: [],
      run_id: run.run_id, is_sentinel: true, meta,
    },
  });
}

return out;
