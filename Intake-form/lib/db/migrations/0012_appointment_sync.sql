-- 0012_appointment_sync.sql — the appointment data foundation.
--
-- WHAT THIS IS: a minimal, evidence-preserving projection of DrChrono
-- appointments and their status history, keyed on the DrChrono patient id we
-- already store as submissions.n8n_patient_id. It is the substrate a later
-- task turns into booking/attendance metrics. It deliberately computes NO
-- metric and asserts NO clinical outcome.
--
-- ============================ PRIVACY ======================================
-- These tables are NOT PHI-free. Removing names does not de-identify a patient
-- identifier joined to an appointment history — that combination is health
-- information about an identifiable person. Treat them exactly like
-- `submissions`:
--   * NO grant to drsnip_reporting_ro (explicitly revoked at the bottom).
--   * NO column for name, contact detail, DOB, appointment `reason` free text,
--     `clinical_note`, `vitals`, `custom_vitals`, `reminders` or billing.
--   * NO raw API payload column. `verbose=true` returns clinical fields; the
--     writer strips them before they ever reach a row (see
--     lib/sync/n8n-appointment-sync.code.js).
--
-- ============================ EVIDENCE =====================================
-- Ingestion preserves what the source said and classifies nothing:
--   * Original `from_status` / `to_status` strings are stored verbatim,
--     including the clinic's custom vocabulary. No "arrival set" is applied
--     here — that mapping is unconfirmed and belongs to the metric task.
--   * There is no `attended` column and no procedure-completion column.
--   * The latest transition is called LATEST, not "terminal": the last one
--     observed may not be final.
--   * Cancelled / deleted / archived rows are KEPT. Exclusion is a metric-time
--     decision; ingestion must not destroy evidence.
--
-- ============================ COMPLETENESS =================================
-- `appointment_sync_runs.coverage` and `.complete` exist so a bounded pilot can
-- never be mistaken for a historical backfill, and so a later dashboard can
-- tell finished data from work in progress via `committed_generation`.
--
-- Idempotent (IF NOT EXISTS / DO-block guards) — safe to re-run via the Fly
-- release_command, which replays every migration on every deploy.

-- ---------------------------------------------------------------------------
-- 1. Sync runs — one row per execution. Written FIRST so snapshots can
--    reference the run that last touched them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_sync_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- incremental | patient_catchup | reconcile | backfill | pilot
  mode                   text        NOT NULL,
  -- Human-readable scope, e.g. 'practice_incremental' or 'patients:12'.
  scope_key              text        NOT NULL,
  -- Free description of the bound actually applied on this run.
  scope_detail           text,

  started_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz,

  -- running | success | partial | failed | budget_exhausted | lock_contended
  outcome                text        NOT NULL DEFAULT 'running',

  -- Captured ONCE at run start. Everything this run claims is "as at" here.
  run_cutoff             timestamptz NOT NULL,

  -- Cursor movement. watermark_after stays NULL unless the run completed its
  -- whole authorized scope — a partial run must never advance the cursor.
  watermark_before       timestamptz,
  watermark_after        timestamptz,

  requests_made          integer     NOT NULL DEFAULT 0,
  pages_fetched          integer     NOT NULL DEFAULT 0,
  appointments_seen      integer     NOT NULL DEFAULT 0,
  appointments_persisted integer     NOT NULL DEFAULT 0,
  appointments_discarded integer     NOT NULL DEFAULT 0,  -- not linked to intake
  transitions_persisted  integer     NOT NULL DEFAULT 0,

  -- bounded_pilot      — a deliberately small manual run; never coverage.
  -- incremental_window  — a last-modified window from the incremental cursor.
  -- historical_window   — ONE scheduled-date window of the historical sweep.
  -- patient_history     — one patient's complete history via ?patient=.
  -- patient_subset      — a bounded set of patients.
  -- historical_complete — reserved: every planned unit finished. Only the
  --                       window ledger can justify this; no single run may
  --                       claim it.
  coverage               text        NOT NULL DEFAULT 'bounded_pilot',
  -- TRUE only when the run finished its entire authorized scope.
  complete               boolean     NOT NULL DEFAULT false,

  -- Monotonic marker a later dashboard can use to read only finished data.
  -- Set when (and only when) the run completes successfully.
  committed_generation   bigint,

  -- SANITIZED only: status codes and short reasons. Never a payload or id.
  error_summary          text
);

CREATE INDEX IF NOT EXISTS appointment_sync_runs_scope_started_idx
  ON appointment_sync_runs (scope_key, started_at DESC);
CREATE INDEX IF NOT EXISTS appointment_sync_runs_outcome_idx
  ON appointment_sync_runs (outcome);

-- ---------------------------------------------------------------------------
-- 2. Sync state — one row per scope. The durable watermark.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_sync_state (
  scope_key                 text PRIMARY KEY,

  -- Last cursor value that was FULLY processed. Advanced only on completion.
  watermark                 timestamptz,
  -- What the watermark means for this scope, so a backfill can never silently
  -- inherit a pilot's cursor and skip history.
  watermark_meaning         text,

  last_run_id               uuid REFERENCES appointment_sync_runs (id),

  -- Concurrency lease. Two runs of the same scope must not interleave, and the
  -- guard has to work across separate pooled connections, so it is a row-level
  -- compare-and-set on THIS row rather than an advisory lock: under READ
  -- COMMITTED a blocked UPDATE re-evaluates its WHERE against the committed
  -- row, so the loser matches nothing and reports 'lock_contended'.
  -- lease_expires_at also means a crashed run cannot hold the scope forever.
  active_run_id             uuid,
  lease_expires_at          timestamptz,

  last_committed_generation bigint      NOT NULL DEFAULT 0,
  -- TRUE once a historical backfill has genuinely completed for this scope.
  history_complete          boolean     NOT NULL DEFAULT false,

  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. Appointment snapshots — current known state of one source appointment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_snapshots (
  -- TEXT, not bigint: source ids are opaque. Never assume they fit an integer.
  source_appointment_id text PRIMARY KEY,

  source                text NOT NULL DEFAULT 'drchrono',
  practice_group_id     text,

  -- Joins to submissions.n8n_patient_id (stored there as bigint; compared as
  -- text). NOT NULL: an appointment we cannot attribute is discarded, never
  -- persisted, so this table only ever holds intake-linked patients.
  patient_source_id     text NOT NULL,

  doctor_source_id      text,
  office_source_id      text,
  -- DrChrono calls the appointment-type field `profile`. Names are NOT
  -- resolvable today (/api/appointment_profiles returns 403), so the id is
  -- stored raw and classified later.
  profile_source_id     text,

  source_created_at     timestamptz,
  scheduled_time        timestamptz,
  source_updated_at     timestamptz,

  -- NULL = the field was absent. '' = present and empty (which is the majority
  -- of this practice's appointments). That distinction is load-bearing and
  -- text preserves it exactly — do not coalesce.
  current_status        text,

  deleted_flag          boolean,
  archived              boolean,

  -- Provenance.
  first_observed_at     timestamptz NOT NULL DEFAULT now(),
  last_observed_at      timestamptz NOT NULL DEFAULT now(),
  last_sync_run_id      uuid REFERENCES appointment_sync_runs (id),
  committed_generation  bigint
);

CREATE INDEX IF NOT EXISTS appointment_snapshots_patient_idx
  ON appointment_snapshots (patient_source_id);
CREATE INDEX IF NOT EXISTS appointment_snapshots_scheduled_idx
  ON appointment_snapshots (scheduled_time);
CREATE INDEX IF NOT EXISTS appointment_snapshots_source_created_idx
  ON appointment_snapshots (source_created_at);
CREATE INDEX IF NOT EXISTS appointment_snapshots_updated_idx
  ON appointment_snapshots (source_updated_at);

-- ---------------------------------------------------------------------------
-- 4. Status transitions — the history, stored verbatim.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_status_transitions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source_appointment_id text NOT NULL
    REFERENCES appointment_snapshots (source_appointment_id) ON DELETE CASCADE,

  -- Present only if the source supplies one. DrChrono's transition objects
  -- carry `appointment`, `datetime`, `from_status`, `to_status` and no id of
  -- their own, so this is expected to be NULL and dedupe_key does the work.
  source_transition_id  text,

  transition_at         timestamptz,

  -- Verbatim. Includes this practice's custom vocabulary (e.g. 'MD In',
  -- 'Ready in 1', 'Late Cancel within 48 hrs'). Nothing is normalised here.
  from_status           text,
  to_status             text,

  -- Deterministic identity when the source gives none: a delimited composite
  --   <appointment>|<iso(transition_at)>|<from_status>|<to_status>
  -- with the delimiter escaped, built by transitionDedupeKey() in
  -- lib/sync/n8n-appointment-sync.code.js. Deliberately NOT a hash: the n8n
  -- Code node has no crypto import, and a readable key can be diagnosed by
  -- eye. Replaying a page therefore hits the unique index and is a no-op.
  dedupe_key            text NOT NULL,

  first_observed_at     timestamptz NOT NULL DEFAULT now(),
  last_observed_at      timestamptz NOT NULL DEFAULT now(),
  observed_in_run_id    uuid REFERENCES appointment_sync_runs (id),

  -- Set when a later response no longer contained this transition. The row is
  -- NOT deleted: an omitted field is not proof of a correction.
  missing_since         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS appointment_status_transitions_dedupe_uidx
  ON appointment_status_transitions (source_appointment_id, dedupe_key);
CREATE INDEX IF NOT EXISTS appointment_status_transitions_appt_idx
  ON appointment_status_transitions (source_appointment_id, transition_at);
CREATE INDEX IF NOT EXISTS appointment_status_transitions_to_status_idx
  ON appointment_status_transitions (to_status);

-- ---------------------------------------------------------------------------
-- 5. Catch-up queue — patients whose intake linkage appeared after a sweep.
--
--    Populated by set-difference against submissions, NOT by
--    submissions.updated_at, which is never bumped (0 of 2,996 rows) and
--    therefore cannot detect anything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_sync_patient_queue (
  patient_source_id text PRIMARY KEY,
  -- newly_linked | reconcile | manual
  reason            text        NOT NULL DEFAULT 'newly_linked',
  queued_at         timestamptz NOT NULL DEFAULT now(),
  last_attempt_at   timestamptz,
  last_success_at   timestamptz,
  attempts          integer     NOT NULL DEFAULT 0,
  -- pending | done | error
  state             text        NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS appointment_sync_patient_queue_state_idx
  ON appointment_sync_patient_queue (state, queued_at);

-- ---------------------------------------------------------------------------
-- 6. Access boundary.
--
--    drsnip_reporting_ro must never see these tables. It has no default
--    privileges here (its migration grants SELECT on one view only), but this
--    is stated explicitly so the boundary survives someone later adding a
--    blanket grant.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE appointment_snapshots           FROM drsnip_reporting_ro';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE appointment_status_transitions  FROM drsnip_reporting_ro';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE appointment_sync_runs           FROM drsnip_reporting_ro';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE appointment_sync_state          FROM drsnip_reporting_ro';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE appointment_sync_patient_queue  FROM drsnip_reporting_ro';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. The sync writer role, its view and its grants live in the SIBLING file
--    0012a_appointment_sync_grants.sql, which is deliberately NOT registered
--    in api-server/migrate.ts.
--
--    Why: migrate.ts has no ledger — it replays every registered step on every
--    deploy, so anything registered here must be safe to run on every deploy
--    forever. CREATE ROLE needs CREATEROLE or superuser.
--
--    The application's role (drsnip_intake_demo) is in fact a superuser today,
--    so this WOULD run — that was checked, not assumed. It is split out anyway:
--    a per-deploy migration should not depend on the app holding superuser,
--    because the day someone rightly de-escalates that role, every deploy
--    starts failing on a step that has nothing to do with the deploy. Role
--    provisioning is a one-time operator action and belongs in an operator
--    script.
-- ---------------------------------------------------------------------------

-- Seed the two scopes so a backfill can never inherit a pilot cursor.
INSERT INTO appointment_sync_state (scope_key, watermark, watermark_meaning, history_complete)
VALUES
  ('practice_incremental', NULL,
   'DrChrono ?since= = LAST-MODIFIED, not scheduled date. NULL means no completed incremental run yet.',
   false),
  ('patient_catchup', NULL,
   'Per-patient sweeps; the queue table is the cursor, not this timestamp.',
   false),
  ('pilot_bounded', NULL,
   'BOUNDED PILOTS ONLY. A pilot reads a short last-modified window, so its '
   || 'cutoff is NOT a cursor for anything: treating it as one would make a '
   || 'later incremental or backfill run skip every record older than the '
   || 'pilot window. This scope exists so a pilot can never touch '
   || 'practice_incremental. Its watermark must stay NULL.',
   false)
ON CONFLICT (scope_key) DO NOTHING;

-- Added after the first cut of this file: the lease columns above. ADD COLUMN
-- IF NOT EXISTS keeps the replayed migration correct on a database that
-- already has the table.
ALTER TABLE appointment_sync_state ADD COLUMN IF NOT EXISTS active_run_id    uuid;
ALTER TABLE appointment_sync_state ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
