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
