-- appointment-sync.sql — the write path, statement by statement.
--
-- This file is the SINGLE SOURCE OF TRUTH for what the n8n sync workflow
-- executes against Postgres. Each block below is pasted verbatim into one
-- Postgres node's "Execute Query" field, with n8n Query Parameters supplying
-- $1..$n. Nothing here is generated at runtime and no value is interpolated
-- into SQL text.
--
-- Executed as drsnip_sync_rw (see 0012a_appointment_sync_grants.sql), which
-- cannot read `submissions`, cannot DELETE appointment evidence, and cannot
-- create objects. The credential's password lives only in the n8n credential
-- store — never in this file, in workflow JSON, or in git.
--
-- Ordering matters: a transition's FK requires its snapshot to exist first.

-- ===========================================================================
-- [1] OPEN A RUN. Always succeeds; claiming the scope is the NEXT step.
--
-- The id comes from the database default, so nothing has to generate a uuid
-- inside an n8n Code node.
--
-- $1 mode   $2 scope_key   $3 scope_detail   $4 coverage
-- ===========================================================================
INSERT INTO appointment_sync_runs (mode, scope_key, scope_detail, run_cutoff, coverage)
VALUES ($1, $2, $3, now(), $4)
RETURNING id AS run_id, run_cutoff;


-- ===========================================================================
-- [1b] CLAIM THE SCOPE — concurrency control.
--
-- WHY A LEASE AND NOT AN ADVISORY LOCK. n8n runs each Postgres node on a
-- pooled connection, and a query with parameters goes over the extended
-- protocol, which forbids several statements in one query text. So the lock
-- can be neither session-scoped (wrong connection) nor transaction-scoped
-- (released the instant the single statement ends), and a multi-statement
-- advisory-lock batch cannot be parameterized at all.
--
-- A compare-and-set on the state row is correct without any of that. Under
-- READ COMMITTED a second UPDATE that collides BLOCKS on the row lock and
-- then RE-EVALUATES its WHERE against the newly committed version, so exactly
-- one claimant matches. ZERO ROWS RETURNED = another run holds this scope:
-- report 'lock_contended', and do not touch the watermark.
--
-- lease_expires_at bounds the damage from a crashed run; re-claiming with the
-- same run id is allowed so a retry of this node is not self-blocking.
--
-- $1 scope_key   $2 run_id   $3 lease interval, e.g. '30 minutes'
-- ===========================================================================
WITH claimed AS (
  UPDATE appointment_sync_state
     SET active_run_id    = $2::uuid,
         lease_expires_at = now() + $3::interval,
         updated_at       = now()
   WHERE scope_key = $1
     AND (active_run_id IS NULL
          OR active_run_id = $2::uuid
          OR lease_expires_at IS NULL
          OR lease_expires_at < now())
  RETURNING scope_key, watermark, watermark_meaning,
            history_complete, last_committed_generation
)
UPDATE appointment_sync_runs r
   SET watermark_before = c.watermark
  FROM claimed c
 WHERE r.id = $2::uuid
RETURNING r.id AS run_id,
          r.run_cutoff,
          c.watermark          AS watermark_before,
          c.watermark_meaning,
          c.history_complete,
          c.last_committed_generation + 1 AS next_generation;


-- ===========================================================================
-- [2] LINKED PATIENT IDS — the only thing the writer learns about intake.
-- Used to discard appointments belonging to patients who never came through
-- our forms, BEFORE anything is persisted.
-- ===========================================================================
SELECT patient_source_id FROM drsnip_linked_patient_ids;


-- ===========================================================================
-- [3] UPSERT SNAPSHOT — idempotent, and it refuses to go backwards.
--
-- The WHERE on DO UPDATE mirrors shouldOverwrite() in
-- lib/sync/n8n-appointment-sync.code.js, so a stale page cannot clobber a
-- fresher row even when two runs interleave:
--   stored NULL                      -> overwrite
--   incoming NULL, stored not NULL   -> keep what we have
--   otherwise                        -> overwrite when incoming >= stored
--
-- Equal timestamps DO overwrite, so replaying a page refreshes provenance
-- rather than being rejected. A genuinely stale response updates nothing at
-- all, including last_observed_at: it told us nothing new.
--
-- first_observed_at is never in the UPDATE list — it records first sighting.
--
-- $1 source_appointment_id  $2 patient_source_id      $3 doctor_source_id
-- $4 office_source_id       $5 profile_source_id      $6 source_created_at
-- $7 scheduled_time         $8 source_updated_at      $9 current_status
-- $10 deleted_flag          $11 archived              $12 run_id
-- $13 practice_group_id
--
-- NOTE on $9: '' and NULL are different and both are meaningful. Never
-- COALESCE this column.
--
-- WHY INSERT ... SELECT ... WHERE rather than VALUES: when a page yields no
-- appointments, n8n would skip every node downstream and the run would never
-- reach [6]/[7] — leaving the scope leased and the run stuck on 'running'. So
-- the projector always emits at least one item, and a sentinel item carries
-- $1 = NULL, which this statement turns into a genuine no-op. The chain stays
-- linear, which is also what guarantees a snapshot exists before its FK-bound
-- transitions are written.
-- ===========================================================================
INSERT INTO appointment_snapshots
  (source_appointment_id, patient_source_id, doctor_source_id, office_source_id,
   profile_source_id, source_created_at, scheduled_time, source_updated_at,
   current_status, deleted_flag, archived, last_sync_run_id, practice_group_id)
SELECT $1::text, $2::text, $3::text, $4::text, $5::text,
       $6::timestamptz, $7::timestamptz, $8::timestamptz,
       $9::text, $10::boolean, $11::boolean, $12::uuid, $13::text
 WHERE $1::text IS NOT NULL
ON CONFLICT (source_appointment_id) DO UPDATE
   SET patient_source_id = EXCLUDED.patient_source_id,
       doctor_source_id  = EXCLUDED.doctor_source_id,
       office_source_id  = EXCLUDED.office_source_id,
       profile_source_id = EXCLUDED.profile_source_id,
       source_created_at = EXCLUDED.source_created_at,
       scheduled_time    = EXCLUDED.scheduled_time,
       source_updated_at = EXCLUDED.source_updated_at,
       current_status    = EXCLUDED.current_status,
       deleted_flag      = EXCLUDED.deleted_flag,
       archived          = EXCLUDED.archived,
       practice_group_id = EXCLUDED.practice_group_id,
       last_observed_at  = now(),
       last_sync_run_id  = EXCLUDED.last_sync_run_id
 WHERE appointment_snapshots.source_updated_at IS NULL
    OR (EXCLUDED.source_updated_at IS NOT NULL
        AND EXCLUDED.source_updated_at >= appointment_snapshots.source_updated_at);


-- ===========================================================================
-- [4] UPSERT TRANSITION — replay-safe by unique (appointment, dedupe_key).
--
-- Re-observing a transition clears missing_since: it is present again, so the
-- earlier absence was a gap in a response, not a correction.
--
-- There is no UPDATE of from_status/to_status: the statuses are part of the
-- dedupe key, so a changed status is a DIFFERENT row, and both are kept.
--
-- $1 source_appointment_id  $2 source_transition_id  $3 transition_at
-- $4 from_status            $5 to_status             $6 dedupe_key  $7 run_id
-- ===========================================================================
INSERT INTO appointment_status_transitions
  (source_appointment_id, source_transition_id, transition_at,
   from_status, to_status, dedupe_key, observed_in_run_id)
SELECT $1::text, $2::text, $3::timestamptz, $4::text, $5::text, $6::text, $7::uuid
 WHERE $1::text IS NOT NULL AND $6::text IS NOT NULL
ON CONFLICT (source_appointment_id, dedupe_key) DO UPDATE
   SET last_observed_at   = now(),
       observed_in_run_id = EXCLUDED.observed_in_run_id,
       missing_since      = NULL;


-- ===========================================================================
-- [5] MARK MISSING TRANSITIONS — only when a transitions array was PRESENT.
--
-- Run this ONLY when extractTransitions() reported present === true. An
-- absent field means the response did not carry history (a non-verbose fetch),
-- which is not evidence that history was removed.
--
-- Rows are flagged, never deleted, and missing_since is set once so the first
-- disappearance is what gets recorded.
--
-- $1 source_appointment_id   $2 text[] of dedupe_keys seen in this response
-- ===========================================================================
UPDATE appointment_status_transitions
   SET missing_since = now()
 WHERE source_appointment_id = $1::text
   AND $1::text IS NOT NULL
   AND missing_since IS NULL
   AND NOT (dedupe_key = ANY ($2::text[]));


-- ===========================================================================
-- [6] FINISH RUN — record the outcome. Counters only, never a payload.
--
-- $1 run_id   $2 outcome   $3 complete   $4 coverage
-- $5 watermark_after (NULL unless the whole authorized scope finished)
-- $6 committed_generation (NULL unless complete)
-- $7..$12 counters   $13 sanitized error summary
-- ===========================================================================
UPDATE appointment_sync_runs
   SET outcome                = $2,
       finished_at            = now(),
       complete               = $3::boolean,
       coverage               = $4,
       watermark_after        = $5::timestamptz,
       committed_generation   = $6::bigint,
       requests_made          = $7::int,
       pages_fetched          = $8::int,
       appointments_seen      = $9::int,
       appointments_persisted = $10::int,
       appointments_discarded = $11::int,
       transitions_persisted  = $12::int,
       error_summary          = $13
 WHERE id = $1::uuid;


-- ===========================================================================
-- [7] RELEASE THE LEASE, AND ADVANCE THE WATERMARK ONLY IF EARNED.
--
-- Runs after [6] on EVERY path, success or not, so a failed run frees the
-- scope instead of waiting for its lease to expire.
--
-- The CASE is the whole point: the cursor moves only for a run that completed
-- its entire authorized scope AND succeeded. A failed middle page, an
-- exhausted budget or a contended lock all leave the watermark where it was,
-- so the next run re-reads that window rather than skipping it. Together with
-- the rewind in sinceWithOverlap(), a record modified at the boundary cannot
-- be lost.
--
-- `s.active_run_id = r.id` means a run whose lease already expired and was
-- taken over by another run cannot come back and clobber the newer cursor.
--
-- $1 run_id   $2 scope_key
-- ===========================================================================
UPDATE appointment_sync_state s
   SET watermark = CASE
         WHEN r.complete AND r.outcome = 'success' AND r.watermark_after IS NOT NULL
           THEN r.watermark_after
         ELSE s.watermark
       END,
       last_run_id               = r.id,
       last_committed_generation = GREATEST(s.last_committed_generation,
                                            COALESCE(r.committed_generation, 0)),
       active_run_id             = NULL,
       lease_expires_at          = NULL,
       updated_at                = now()
  FROM appointment_sync_runs r
 WHERE s.scope_key     = $2
   AND r.id            = $1::uuid
   AND s.active_run_id = r.id
RETURNING s.scope_key, s.watermark, s.last_committed_generation;


-- ===========================================================================
-- [8] NEXT GENERATION — read before finishing a run.
-- $1 scope_key
-- ===========================================================================
SELECT last_committed_generation + 1 AS next_generation,
       watermark,
       history_complete
  FROM appointment_sync_state
 WHERE scope_key = $1;


-- ===========================================================================
-- [9] QUEUE NEWLY LINKED PATIENTS — set difference, NOT submissions.updated_at.
--
-- submissions.updated_at is never bumped by the n8n bridge write-back (every
-- row has updated_at = created_at), so it cannot detect a newly linked
-- patient. This compares the linked-id view against what we already hold.
--
-- ON CONFLICT DO NOTHING means a patient who genuinely has zero appointments
-- is queued once and then left alone, rather than re-queued on every sweep.
-- ===========================================================================
INSERT INTO appointment_sync_patient_queue (patient_source_id, reason)
SELECT v.patient_source_id, 'newly_linked'
  FROM drsnip_linked_patient_ids v
 WHERE NOT EXISTS (
         SELECT 1 FROM appointment_snapshots s
          WHERE s.patient_source_id = v.patient_source_id)
ON CONFLICT (patient_source_id) DO NOTHING;


-- ===========================================================================
-- [10] CLAIM A BATCH FROM THE QUEUE.
-- $1 batch size
-- ===========================================================================
UPDATE appointment_sync_patient_queue q
   SET state = 'pending', last_attempt_at = now(), attempts = q.attempts + 1
  FROM (SELECT patient_source_id
          FROM appointment_sync_patient_queue
         WHERE state = 'pending'
         ORDER BY queued_at
         LIMIT $1::int
           FOR UPDATE SKIP LOCKED) sel
 WHERE q.patient_source_id = sel.patient_source_id
RETURNING q.patient_source_id;


-- ===========================================================================
-- [11] MARK A QUEUE ENTRY DONE.
-- $1 patient_source_id
-- ===========================================================================
UPDATE appointment_sync_patient_queue
   SET state = 'done', last_success_at = now()
 WHERE patient_source_id = $1;


-- ===========================================================================
-- [12] PLAN ONE WINDOW — idempotent, so re-planning never loses progress.
--
-- Run once per window in the plan. ON CONFLICT DO NOTHING means regenerating
-- the same plan is a no-op and an already-completed window keeps its state.
-- window_key is deterministic, so the plan is stable across sessions.
--
-- A null $1 is a no-op, so the planning step can sit in a chain that also
-- runs for the per-patient strategy without inserting nonsense.
--
-- $1 window_key   $2 range_start   $3 range_end
-- ===========================================================================
INSERT INTO appointment_sync_windows (window_key, strategy, range_start, range_end)
SELECT $1::text, 'scheduled_window', $2::date, $3::date
 WHERE $1::text IS NOT NULL
ON CONFLICT (window_key) DO NOTHING;


-- ===========================================================================
-- [13] CLAIM THE NEXT UNIT OF WORK.
--
-- Returns at most one row; ZERO rows means the strategy has nothing left and
-- the sweep is finished. FOR UPDATE SKIP LOCKED means two concurrent workers
-- take different units instead of colliding.
--
-- 'partial' and 'failed' units are re-claimed: a unit that hit its page cap
-- read only part of its window and must not be left looking like coverage.
-- A 'running' unit older than the lease is assumed crashed and retried, which
-- is why this is safe to re-run after an interrupted session.
--
-- ORDER BY window_key is chronological by construction (zero-padded keys), so
-- history loads oldest-first and an interrupted sweep resumes in order.
--
-- $1 run_id   $2 strategy   $3 stale-running lease, e.g. '30 minutes'
-- ===========================================================================
UPDATE appointment_sync_windows w
   SET state            = 'running',
       attempts         = w.attempts + 1,
       first_attempt_at = COALESCE(w.first_attempt_at, now()),
       last_run_id      = $1::uuid,
       updated_at       = now()
  FROM (
    SELECT window_key
      FROM appointment_sync_windows
     WHERE strategy = $2
       AND (state IN ('pending', 'partial', 'failed')
            OR (state = 'running' AND updated_at < now() - $3::interval))
     ORDER BY window_key
     LIMIT 1
       FOR UPDATE SKIP LOCKED
  ) s
 WHERE w.window_key = s.window_key
RETURNING w.window_key, w.strategy, w.range_start, w.range_end, w.patient_source_id, w.attempts;


-- ===========================================================================
-- [14] FINISH A UNIT.
--
-- completed_at is set ONLY for 'complete'. A truncated or failed unit keeps a
-- NULL completed_at and stays claimable, so coverage can never be computed
-- from a unit that did not finish.
--
-- $1 window_key  $2 state  $3 truncated  $4 pages  $5 seen  $6 persisted
-- $7 discarded   $8 transitions          $9 sanitized error summary
-- ===========================================================================
UPDATE appointment_sync_windows
   SET state                  = $2,
       truncated              = $3::boolean,
       pages_fetched          = $4::int,
       appointments_seen      = $5::int,
       appointments_persisted = $6::int,
       appointments_discarded = $7::int,
       transitions_persisted  = $8::int,
       completed_at           = CASE WHEN $2 = 'complete' THEN now() ELSE NULL END,
       error_summary          = $9,
       updated_at             = now()
 WHERE window_key = $1
RETURNING window_key, state, truncated;


-- ===========================================================================
-- [15] SEED PER-PATIENT HISTORY PROBES for linked patients the sweep found
--      nothing for.
--
-- This is what turns "we saw no appointment" into a defensible statement.
-- ?patient= with since=1970 returns a single patient's ENTIRE history
-- regardless of date, so a patient that comes back empty has genuinely no
-- appointment on record — not merely none inside a window we happened to sweep.
--
-- EVERY linked patient is seeded, including ones we already hold appointments
-- for. Earlier runs only ever saw a short last-modified window, which is a
-- slice of a patient's history, not the whole of it. Seeding only the
-- appointment-less patients would leave the rest permanently half-covered
-- while looking finished.
--
-- $1 guards it: the seed only happens when the run's strategy is
-- 'patient_history'. Seeding it during the scheduled sweep would queue a probe
-- for every patient the sweep simply has not reached yet.
--
-- Uses the linked-id view, never submissions, and never submissions.updated_at.
-- ===========================================================================
INSERT INTO appointment_sync_windows (window_key, strategy, patient_source_id)
SELECT 'patient:' || v.patient_source_id, 'patient_history', v.patient_source_id
  FROM drsnip_linked_patient_ids v
 WHERE $1::text = 'patient_history'          -- guard: only when asked
ON CONFLICT (window_key) DO NOTHING;


-- ===========================================================================
-- [16] COVERAGE — the honest per-patient classification.
--
-- Every linked patient lands in exactly one bucket. "has_appointment" and
-- "queried_none_found" are the only two that represent knowledge; the rest are
-- admissions of what has not been established yet.
-- ===========================================================================
WITH linked AS (SELECT patient_source_id FROM drsnip_linked_patient_ids),
probe AS (SELECT patient_source_id, state FROM appointment_sync_windows
           WHERE strategy = 'patient_history')
SELECT CASE
         WHEN EXISTS (SELECT 1 FROM appointment_snapshots s
                       WHERE s.patient_source_id = l.patient_source_id)
           THEN 'has_appointment'
         WHEN p.state = 'complete'          THEN 'queried_none_found'
         WHEN p.state IN ('failed','blocked') THEN 'blocked_or_error'
         WHEN p.state IS NOT NULL           THEN 'queued_not_yet_queried'
         ELSE 'not_yet_queried'
       END AS coverage_class,
       count(*) AS patients
  FROM linked l
  LEFT JOIN probe p ON p.patient_source_id = l.patient_source_id
 GROUP BY 1
 ORDER BY 2 DESC;
