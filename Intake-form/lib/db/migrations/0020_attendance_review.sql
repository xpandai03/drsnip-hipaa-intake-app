-- 0020_attendance_review.sql — the attendance status review, approval record
-- and the calculation it unlocks.
--
-- Apply by hand, after 0019. NOT registered in migrate.ts: it grants to
-- drsnip_metrics_fn, which 0012a creates.
--
-- ============================ WHAT THIS IS =================================
-- Today attendance is blocked by a boolean compiled into the bundle. This turns
-- it into data: a versioned, per-label decision with a named clinic confirmer,
-- an audit trail, and — the part that did not exist anywhere — an actual
-- calculation.
--
-- ============================ WHAT IT IS NOT ===============================
-- It approves nothing. Every label starts `undecided`, and no row here asserts
-- what any clinic status means.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The observed label inventory.
--
--    IDENTITY IS THE WHOLE PROBLEM HERE.
--
--    * NULL and '' are DIFFERENT statuses and must stay different. The sync
--      projector preserves the distinction deliberately ("the difference is
--      load-bearing"); throwing it away at the review layer would undo that.
--      A UNIQUE constraint treats NULLs as distinct from each other, so a
--      nullable raw_label cannot be the key.
--    * So identity is `label_key`, a generated column that maps NULL to a
--      sentinel and prefixes every real value. The prefix is what stops a
--      clinic status literally spelled "(null)" colliding with the sentinel.
--    * Case and whitespace are NOT normalised away. `normalized_key` exists
--      only to SURFACE near-duplicates to a human. Two labels differing by a
--      space may be two different front-desk habits and are classified
--      separately.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_status_labels (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- 'current_status' | 'transition'. The two are separate inventories: nine
  -- labels in this practice occur ONLY in transition history.
  source_column  text NOT NULL CHECK (source_column IN ('current_status', 'transition')),

  -- Exactly as the source sent it. NULL is a real, distinct value.
  raw_label      text,

  -- Durable identity. NULL-safe by construction.
  label_key      text GENERATED ALWAYS AS (
                   CASE WHEN raw_label IS NULL THEN E'\\x01null' ELSE 'v:' || raw_label END
                 ) STORED,

  -- Lower-cased, trimmed, internal whitespace collapsed. GROUPING ONLY.
  normalized_key text GENERATED ALWAYS AS (
                   CASE WHEN raw_label IS NULL THEN E'\\x01null'
                        ELSE lower(regexp_replace(btrim(raw_label), '\s+', ' ', 'g')) END
                 ) STORED,

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_status_labels_identity_idx
  ON attendance_status_labels (source_column, label_key);
CREATE INDEX IF NOT EXISTS attendance_status_labels_normalized_idx
  ON attendance_status_labels (normalized_key);

-- ---------------------------------------------------------------------------
-- 2. Versioned mappings.
--
--    One row per version. `labels` is copied in full and frozen on approval, so
--    a later draft edit cannot rewrite what was approved.
--
--    THE TWO PEOPLE ARE DIFFERENT PEOPLE. `approved_by_user_id` is the
--    authenticated account that pressed the button. `confirmed_by_*` is the
--    clinic person whose decision it was. A decision Jeff makes on a call is
--    entered by somebody else, and the record has to say so or the provenance
--    is a fiction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_mappings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  scope              text NOT NULL DEFAULT 'practice',
  state              text NOT NULL CHECK (state IN ('draft', 'approved', 'superseded')),

  -- Monotonic per scope, assigned on approval. NULL while draft.
  version            integer,

  -- Bumped on every draft save. The client echoes it back; a mismatch is 409.
  revision           integer NOT NULL DEFAULT 1,

  -- [{ source_column, raw_label | null, classification, procedure_signal }]
  labels             jsonb   NOT NULL DEFAULT '[]'::jsonb,

  -- Who pressed the button.
  approved_by_user_id uuid REFERENCES users (id),
  approved_at        timestamptz,

  -- Who actually decided, and how. All required at approval; see the trigger.
  confirmed_by_name  text,
  confirmed_by_role  text,
  confirmed_via      text CHECK (confirmed_via IS NULL
                                 OR confirmed_via IN ('call', 'video_call', 'email', 'in_person', 'written')),
  confirmed_on       date,
  confirmed_scope    text,
  note               text,

  -- The appointment cursor the approval was made against.
  evidence_as_of     timestamptz,

  -- Required when withdrawing.
  withdrawn_reason   text,

  created_by_user_id uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- At most one ACTIVE approved mapping per scope, and at most one draft.
-- Enforced by the database, not by application code.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_mappings_one_approved_idx
  ON attendance_mappings (scope) WHERE state = 'approved';
CREATE UNIQUE INDEX IF NOT EXISTS attendance_mappings_one_draft_idx
  ON attendance_mappings (scope) WHERE state = 'draft';
CREATE INDEX IF NOT EXISTS attendance_mappings_state_idx ON attendance_mappings (state, scope);

-- Provenance cannot be optional. An approved row without a named confirmer is
-- exactly the `provenance: null` this feature exists to replace, and a CHECK is
-- the only place that cannot be forgotten.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_mappings_provenance_check') THEN
    ALTER TABLE attendance_mappings ADD CONSTRAINT attendance_mappings_provenance_check CHECK (
      state <> 'approved' OR (
        version            IS NOT NULL AND
        approved_by_user_id IS NOT NULL AND
        approved_at        IS NOT NULL AND
        confirmed_by_name  IS NOT NULL AND btrim(confirmed_by_name) <> '' AND
        confirmed_by_role  IS NOT NULL AND btrim(confirmed_by_role) <> '' AND
        confirmed_via      IS NOT NULL AND
        confirmed_on       IS NOT NULL AND
        confirmed_scope    IS NOT NULL AND btrim(confirmed_scope) <> ''
      )
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Append-only audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_review_audit (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  event        text NOT NULL CHECK (event IN ('draft_saved', 'preview', 'approved', 'withdrawn')),
  actor_user_id uuid REFERENCES users (id),
  mapping_id   uuid REFERENCES attendance_mappings (id),
  revision     integer,
  -- Counters and states only. Never a patient id, never a payload.
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS attendance_review_audit_at_idx ON attendance_review_audit (at DESC);

-- ---------------------------------------------------------------------------
-- 4. The approval capability.
--
--    NOT a third role. `normalizeRole()` resolves anything that is not
--    literally 'viewer' to 'admin', so every developer account is an admin —
--    approving what a clinic's records mean is not the same privilege as
--    exporting a CSV. A default-false column is additive, cannot widen access
--    by accident, and fails closed for a malformed or unknown role.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_approve_definitions boolean NOT NULL DEFAULT false;

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------------
-- 5. THE ONE CALCULATION.
--
--    Published reporting and draft preview both call this. There is no second
--    implementation to drift. The public entry points differ only in where the
--    label set comes from and how the result is protected.
--
--    p_labels is [{source_column, raw_label, classification, procedure_signal}].
--    Only 'physically_present' and 'remote_presence' are read here; the other
--    classifications establish nothing and are deliberately inert.
--
--    WHAT IT WILL NOT DO
--      * It never turns 'no arrival information' into non-attendance.
--      * It never counts a remote label toward physical arrival.
--      * It never invents an arrival time. Evidence without a usable timestamp
--        is reported in its OWN bucket, not folded into the windowed count.
--      * It never publishes a patient-level "did not attend".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_attendance_evidence(
  p_labels     jsonb,
  p_metric     text,
  p_entry_from date,
  p_entry_to   date,
  p_window_days integer
)
RETURNS TABLE (
  cohort_total        integer,
  cohort_covered      integer,
  eligible            integer,
  immature            integer,
  arrived_in_window   integer,
  arrived_untimed     integer,
  arrived_outside     integer,
  not_established     integer,
  remote_only         integer,
  in_window_deleted_only integer,
  evidence_as_of      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  form   text;
  w_iv   interval;
  cutoff timestamptz;
BEGIN
  IF p_metric IS NULL OR p_metric NOT IN ('attendance_registration', 'attendance_insurance') THEN
    RAISE EXCEPTION 'unsupported metric' USING ERRCODE = '22023';
  END IF;
  IF p_window_days IS NULL OR p_window_days NOT IN (7, 14, 30) THEN
    RAISE EXCEPTION 'unsupported window' USING ERRCODE = '22023';
  END IF;
  IF p_entry_from IS NULL OR p_entry_to IS NULL OR p_entry_to <= p_entry_from
     OR p_entry_from < DATE '2026-01-01' OR (p_entry_to - p_entry_from) > 400 THEN
    RAISE EXCEPTION 'invalid entry period' USING ERRCODE = '22023';
  END IF;

  form := CASE WHEN p_metric = 'attendance_registration' THEN 'registration' ELSE 'insurance' END;
  -- Elapsed hours, never calendar days: a DST boundary makes `interval 'N days'`
  -- 169 hours and silently gives one cohort extra time.
  w_iv := ((p_window_days * 24) || ' hours')::interval;

  -- The instant appointment data is COMPLETE to. Same rule as booking (0019):
  -- the later of the backfill's completion and the incremental cursor. Maturity
  -- is measured against this, never against now().
  SELECT greatest(
           (SELECT max(w.completed_at) FROM public.appointment_sync_windows w
             WHERE w.strategy = 'patient_history' AND w.state = 'complete'),
           (SELECT st.watermark FROM public.appointment_sync_state st
             WHERE st.scope_key = 'practice_incremental'))
    INTO cutoff;

  RETURN QUERY
  WITH lbl AS (
    SELECT x.source_column, x.raw_label, x.classification
      FROM jsonb_to_recordset(coalesce(p_labels, '[]'::jsonb))
        AS x(source_column text, raw_label text, classification text)
     WHERE x.classification IN ('physically_present', 'remote_presence')
  ),
  covered AS (
    SELECT w.patient_source_id FROM public.appointment_sync_windows w
     WHERE w.strategy = 'patient_history' AND w.state = 'complete'
       AND w.patient_source_id IS NOT NULL
  ),
  first_entry AS (
    SELECT s.n8n_patient_id::text AS pid, min(s.created_at) AS entry_at
      FROM public.submissions s
     WHERE s.n8n_patient_id IS NOT NULL AND s.form_type = form
     GROUP BY 1
  ),
  e AS (
    SELECT fe.pid, fe.entry_at,
           (fe.pid IN (SELECT patient_source_id FROM covered)) AS is_covered,
           (fe.entry_at + w_iv <= cutoff)                      AS matured
      FROM first_entry fe
     WHERE (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= p_entry_from
       AND (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  p_entry_to
  ),
  -- Per appointment: the earliest TIMED physical arrival, whether any physical
  -- evidence exists at all, and whether any of it is remote.
  appt AS (
    SELECT a.source_appointment_id AS aid,
           a.patient_source_id     AS pid,
           a.deleted_flag,
           -- Timed: a transition to a physically-present label with a usable
           -- timestamp. This is the ONLY thing that can be placed in a window.
           min(t.transition_at) FILTER (
             WHERE t.transition_at IS NOT NULL
               AND EXISTS (SELECT 1 FROM lbl l
                            WHERE l.source_column = 'transition'
                              AND l.classification = 'physically_present'
                              AND l.raw_label IS NOT DISTINCT FROM t.to_status)
           ) AS timed_arrival_at,
           -- Untimed: a physically-present transition with no timestamp.
           coalesce(bool_or(
             t.transition_at IS NULL
             AND EXISTS (SELECT 1 FROM lbl l
                          WHERE l.source_column = 'transition'
                            AND l.classification = 'physically_present'
                            AND l.raw_label IS NOT DISTINCT FROM t.to_status)
           ), false) AS untimed_transition,
           -- Current status is evidence of the same vocabulary, but it carries
           -- no arrival time. source_updated_at is the row's last touch, not an
           -- arrival, and must never be used as one.
           EXISTS (SELECT 1 FROM lbl l
                    WHERE l.source_column = 'current_status'
                      AND l.classification = 'physically_present'
                      AND l.raw_label IS NOT DISTINCT FROM a.current_status) AS current_physical,
           (EXISTS (SELECT 1 FROM lbl l
                     WHERE l.source_column = 'current_status'
                       AND l.classification = 'remote_presence'
                       AND l.raw_label IS NOT DISTINCT FROM a.current_status)
            OR coalesce(bool_or(
                 EXISTS (SELECT 1 FROM lbl l
                          WHERE l.source_column = 'transition'
                            AND l.classification = 'remote_presence'
                            AND l.raw_label IS NOT DISTINCT FROM t.to_status)
               ), false)) AS remote_evidence
      FROM public.appointment_snapshots a
      LEFT JOIN public.appointment_status_transitions t
        ON t.source_appointment_id = a.source_appointment_id AND t.missing_since IS NULL
     GROUP BY 1, 2, 3, a.current_status
  ),
  -- Per patient, against their own entry instant and window.
  pp AS (
    SELECT e.pid, e.entry_at, e.is_covered, e.matured,
           -- Deletion at source does not erase the observation that was made.
           -- Booking excludes deleted records from its counts; attendance keeps
           -- their evidence and reports separately how much rests on one.
           coalesce(bool_or(ap.timed_arrival_at >  e.entry_at
                        AND ap.timed_arrival_at <= e.entry_at + w_iv), false) AS in_window,
           coalesce(bool_or(ap.timed_arrival_at >  e.entry_at
                        AND ap.timed_arrival_at <= e.entry_at + w_iv
                        AND ap.deleted_flag), false)                          AS in_window_deleted,
           coalesce(bool_or(ap.timed_arrival_at >  e.entry_at
                        AND ap.timed_arrival_at <= e.entry_at + w_iv
                        AND NOT ap.deleted_flag), false)                      AS in_window_live,
           coalesce(bool_or(ap.untimed_transition OR ap.current_physical), false) AS untimed,
           coalesce(bool_or(ap.timed_arrival_at IS NOT NULL), false)          AS any_timed,
           coalesce(bool_or(ap.remote_evidence), false)                       AS remote
      FROM e LEFT JOIN appt ap ON ap.pid = e.pid
     GROUP BY 1, 2, 3, 4
  ),
  -- Mutually exclusive, in this order. A patient counts ONCE however many
  -- appointments they have: "did they come" is a question about the person.
  cls AS (
    SELECT pp.*,
           CASE
             WHEN in_window                THEN 'in_window'
             -- Untimed evidence MIGHT be inside the window; we cannot say. It
             -- gets its own bucket rather than being guessed either way.
             WHEN untimed                  THEN 'untimed'
             WHEN any_timed                THEN 'outside'
             ELSE 'none'
           END AS bucket
      FROM pp
  )
  SELECT
    count(*)::int                                                        AS cohort_total,
    count(*) FILTER (WHERE is_covered)::int                              AS cohort_covered,
    count(*) FILTER (WHERE is_covered AND matured)::int                  AS eligible,
    count(*) FILTER (WHERE is_covered AND NOT matured)::int              AS immature,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'in_window')::int AS arrived_in_window,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'untimed')::int   AS arrived_untimed,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'outside')::int   AS arrived_outside,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'none')::int      AS not_established,
    count(*) FILTER (WHERE is_covered AND matured AND bucket <> 'in_window'
                       AND bucket <> 'untimed' AND remote)::int          AS remote_only,
    count(*) FILTER (WHERE is_covered AND matured AND bucket = 'in_window'
                       AND in_window_deleted AND NOT in_window_live)::int AS in_window_deleted_only,
    cutoff
  FROM cls;
END;
$fn$;

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------------
-- 6. PUBLISHED attendance. Resolves the approved mapping SERVER-SIDE.
--
--    An ordinary caller cannot supply classifications. That is the point: if
--    the API could pass a label set, "approved" would be advisory.
--
--    Suppression is the pair rule, applied here rather than in the browser: if
--    either the arrived count or its complement within the eligible cohort is
--    small, BOTH are withheld, because publishing one with the denominator
--    recovers the other.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_attendance_metric(
  p_metric text, p_entry_from date, p_entry_to date, p_window_days integer
)
RETURNS TABLE (
  status              text,
  definition_version  integer,
  confirmed_on        date,
  confirmed_by_name   text,
  confirmed_by_role   text,
  confirmed_via       text,
  confirmed_scope     text,
  cohort_total        integer,
  eligible            integer,
  immature            integer,
  arrived_in_window   integer,
  arrived_untimed     integer,
  arrived_outside     integer,
  not_established     integer,
  remote_only         integer,
  in_window_deleted_only integer,
  undecided_labels    integer,
  new_labels_since_approval integer,
  evidence_as_of      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  m   record;
  w   record;
  r   record;
  n_undecided integer;
  n_new       integer;
  v           integer[];
  hide        boolean[];
  n_hidden    integer;
  smallest    integer;
  i           integer;
BEGIN
  SELECT * INTO m FROM public.attendance_mappings
   WHERE state = 'approved' AND scope = 'practice' LIMIT 1;

  IF m IS NULL THEN
    -- No active definition. If the last one was WITHDRAWN, say so and say why:
    -- "unavailable" with no reason is precisely the state this feature replaces.
    SELECT * INTO w FROM public.attendance_mappings
     WHERE state = 'superseded' AND scope = 'practice' AND withdrawn_reason IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1;

    RETURN QUERY SELECT
      CASE WHEN w IS NULL THEN 'unapproved' ELSE 'withdrawn' END::text,
      CASE WHEN w IS NULL THEN NULL ELSE w.version END,
      CASE WHEN w IS NULL THEN NULL ELSE w.confirmed_on END,
      CASE WHEN w IS NULL THEN NULL ELSE w.confirmed_by_name END,
      CASE WHEN w IS NULL THEN NULL ELSE w.confirmed_by_role END,
      CASE WHEN w IS NULL THEN NULL ELSE w.confirmed_via END,
      CASE WHEN w IS NULL THEN NULL ELSE w.withdrawn_reason END,
      NULL::integer, NULL::integer, NULL::integer,
      NULL::integer, NULL::integer, NULL::integer, NULL::integer, NULL::integer,
      NULL::integer, NULL::integer, NULL::integer,
      CASE WHEN w IS NULL THEN NULL ELSE w.updated_at END;
    RETURN;
  END IF;

  SELECT * INTO r FROM public.drsnip_attendance_evidence(
    m.labels, p_metric, p_entry_from, p_entry_to, p_window_days);

  -- How much of the vocabulary is still unanswered, and what has appeared since
  -- the approval. Silence here is the failure mode: reporting would drift down
  -- as the clinic adopted new words for things.
  SELECT count(*)::int INTO n_undecided
    FROM public.attendance_status_labels sl
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_to_recordset(m.labels) AS x(source_column text, raw_label text, classification text)
      WHERE x.source_column = sl.source_column
        AND x.raw_label IS NOT DISTINCT FROM sl.raw_label
        AND x.classification <> 'undecided');

  SELECT count(*)::int INTO n_new
    FROM public.attendance_status_labels sl
   WHERE sl.first_seen_at > m.approved_at;

  -- ------------------------------------------------------------------------
  -- SUPPRESSION: the four buckets are a PARTITION and must be treated as one.
  --
  -- in_window + untimed + outside + not_established = eligible, exactly. So
  -- withholding a single small cell protects nothing: subtract the other three
  -- from the published cohort and it comes straight back. This is the mirror
  -- image of the status inventory, whose rows OVERLAP and therefore must NOT
  -- get partition treatment.
  --
  -- Same algorithm as suppressPartition() in lib/metrics/contract.ts: withhold
  -- every small cell, then keep withholding the next-smallest until at least
  -- two are unknown, and if two cannot be reached, withhold the lot.
  -- ------------------------------------------------------------------------
  v := ARRAY[r.arrived_in_window, r.arrived_untimed, r.arrived_outside, r.not_established];
  hide := ARRAY[false, false, false, false];

  FOR i IN 1..4 LOOP
    IF v[i] > 0 AND v[i] < 5 THEN hide[i] := true; END IF;
  END LOOP;

  n_hidden := 0;
  FOR i IN 1..4 LOOP IF hide[i] THEN n_hidden := n_hidden + 1; END IF; END LOOP;

  IF n_hidden > 0 THEN
    WHILE n_hidden < 2 LOOP
      smallest := NULL;
      FOR i IN 1..4 LOOP
        IF NOT hide[i] AND (smallest IS NULL OR v[i] < v[smallest]) THEN smallest := i; END IF;
      END LOOP;
      EXIT WHEN smallest IS NULL;
      hide[smallest] := true;
      n_hidden := n_hidden + 1;
    END LOOP;
    IF n_hidden < 2 THEN hide := ARRAY[true, true, true, true]; END IF;
  END IF;

  -- A cohort small enough to identify someone publishes no breakdown at all.
  IF r.eligible > 0 AND r.eligible < 5 THEN
    hide := ARRAY[true, true, true, true];
  END IF;

  RETURN QUERY SELECT
    'ok'::text, m.version, m.confirmed_on, m.confirmed_by_name, m.confirmed_by_role,
    m.confirmed_via, m.confirmed_scope,
    r.cohort_total, r.eligible, r.immature,
    CASE WHEN hide[1] THEN NULL ELSE v[1] END,
    CASE WHEN hide[2] THEN NULL ELSE v[2] END,
    CASE WHEN hide[3] THEN NULL ELSE v[3] END,
    CASE WHEN hide[4] THEN NULL ELSE v[4] END,
    -- Overlapping annotations, not members of the partition: they are subsets
    -- of buckets above and nothing else can be recovered from them, so plain
    -- per-cell suppression is the right primitive here.
    CASE WHEN r.remote_only = 0 THEN 0 WHEN r.remote_only < 5 THEN NULL ELSE r.remote_only END,
    CASE WHEN r.in_window_deleted_only = 0 THEN 0
         WHEN r.in_window_deleted_only < 5 THEN NULL ELSE r.in_window_deleted_only END,
    n_undecided, n_new, r.evidence_as_of;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. DRAFT PREVIEW — a separately protected path, and a BANDED answer.
--
--    THE DIFFERENCING PROBLEM, AND WHY BANDS AND NOT ROUNDING-PLUS-AUDIT.
--    A reviewer can classify one label, preview, unclassify it, preview again,
--    and read a protected group out of the difference of two exact totals.
--    Hiding deltas does not help: the caller has both numbers. Auditing does
--    not help: it records the attack, it does not prevent it.
--
--    So the preview does not return exact totals at all. It returns the BAND
--    each count falls in (width 10, floored). The difference of two bands is
--    not the difference of two counts, so a single-patient change is invisible
--    unless it happens to straddle a boundary — and then it reveals only that
--    the true value is somewhere in a run of ten.
--
--    This is a mitigation, not a proof: a determined reviewer could still
--    binary-search a boundary across many previews. It is proportionate because
--    the population is a handful of named accounts, previews are audited, and
--    the alternative — exact previews — is trivially exploitable.
--
--    A cohort too small to band safely is withheld outright.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_attendance_preview(
  p_labels jsonb, p_metric text, p_entry_from date, p_entry_to date, p_window_days integer
)
RETURNS TABLE (
  status            text,
  eligible          integer,
  immature          integer,
  cohort_total      integer,
  band_width        integer,
  in_window_low     integer,
  in_window_high    integer,
  untimed_low       integer,
  untimed_high      integer,
  outside_low       integer,
  outside_high      integer,
  not_established_low  integer,
  not_established_high integer,
  remote_only_low   integer,
  remote_only_high  integer,
  evidence_as_of    timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  r record;
  band constant integer := 10;
  lo  integer;
BEGIN
  SELECT * INTO r FROM public.drsnip_attendance_evidence(
    p_labels, p_metric, p_entry_from, p_entry_to, p_window_days);

  -- Below two bands there is not enough cohort for banding to hide anything.
  IF r.eligible < 2 * band THEN
    RETURN QUERY SELECT 'withheld_small_cohort'::text, r.eligible, r.immature, r.cohort_total,
      band, NULL::integer, NULL::integer, NULL::integer, NULL::integer, NULL::integer,
      NULL::integer, NULL::integer, NULL::integer, NULL::integer, NULL::integer, r.evidence_as_of;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'banded'::text, r.eligible, r.immature, r.cohort_total, band,
    (r.arrived_in_window / band) * band, (r.arrived_in_window / band) * band + band - 1,
    (r.arrived_untimed   / band) * band, (r.arrived_untimed   / band) * band + band - 1,
    (r.arrived_outside   / band) * band, (r.arrived_outside   / band) * band + band - 1,
    (r.not_established   / band) * band, (r.not_established   / band) * band + band - 1,
    (r.remote_only       / band) * band, (r.remote_only       / band) * band + band - 1,
    r.evidence_as_of;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Status inventory — BOTH sources, kept apart.
--
--    NOT A PARTITION. One appointment passes through several statuses, so these
--    rows overlap and do not sum to anything. suppressPartition's
--    withhold-the-next-smallest rule assumes a total that can be subtracted
--    from; applying it here would be security theatre dressed as rigour. Plain
--    per-cell suppression is the correct primitive, plus a refusal to publish
--    any total the rows could be differenced against.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_status_inventory()
RETURNS TABLE (
  source_column   text,
  raw_label       text,
  is_null_label   boolean,
  normalized_key  text,
  appointments    integer,
  transitions     integer,
  offices         integer,
  providers       integer,
  first_seen_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '15s'
AS $$
  WITH cur AS (
    SELECT 'current_status'::text AS src, a.current_status AS lab,
           count(*)::int AS appts, NULL::int AS trans,
           count(DISTINCT a.office_source_id)::int AS offices,
           count(DISTINCT a.doctor_source_id)::int AS providers
      FROM public.appointment_snapshots a GROUP BY 2
  ),
  tr AS (
    SELECT 'transition'::text AS src, t.to_status AS lab,
           count(DISTINCT t.source_appointment_id)::int AS appts,
           count(*)::int AS trans,
           count(DISTINCT a.office_source_id)::int AS offices,
           count(DISTINCT a.doctor_source_id)::int AS providers
      FROM public.appointment_status_transitions t
      JOIN public.appointment_snapshots a ON a.source_appointment_id = t.source_appointment_id
     WHERE t.missing_since IS NULL GROUP BY 2
  ),
  u AS (SELECT * FROM cur UNION ALL SELECT * FROM tr)
  SELECT u.src,
         u.lab,
         (u.lab IS NULL),
         CASE WHEN u.lab IS NULL THEN NULL
              ELSE lower(regexp_replace(btrim(u.lab), '\s+', ' ', 'g')) END,
         -- Per-cell suppression only. Zero is publishable; a small cell is not.
         CASE WHEN u.appts >= 5 THEN u.appts ELSE NULL END,
         CASE WHEN u.trans IS NULL THEN NULL
              WHEN u.appts >= 5 THEN u.trans ELSE NULL END,
         -- Office/provider breadth is a structural fact about the practice, not
         -- about a person, but it is withheld alongside a withheld count so the
         -- row gives nothing away at all.
         CASE WHEN u.appts >= 5 THEN u.offices ELSE NULL END,
         CASE WHEN u.appts >= 5 THEN u.providers ELSE NULL END,
         (SELECT sl.first_seen_at FROM public.attendance_status_labels sl
           WHERE sl.source_column = u.src AND sl.raw_label IS NOT DISTINCT FROM u.lab)
    FROM u
   ORDER BY u.src, u.appts DESC NULLS LAST;
$$;

-- ---------------------------------------------------------------------------
-- 9. Refresh the observed inventory. Additive; never deletes a label that has
--    been seen, because a label that stops occurring is still one the clinic
--    once used and may have classified.
-- ---------------------------------------------------------------------------
--    DELIBERATELY NOT `SECURITY DEFINER`. It is the one function here that
--    WRITES, and making the restricted metrics role its owner would mean
--    granting that role INSERT and UPDATE — widening a role whose whole purpose
--    is to read four tables and nothing else. It runs as the caller instead:
--    the application role, which already owns these tables.
CREATE OR REPLACE FUNCTION public.drsnip_refresh_status_labels()
RETURNS integer
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  WITH seen AS (
    SELECT 'current_status'::text AS src, a.current_status AS lab
      FROM public.appointment_snapshots a GROUP BY 2
    UNION ALL
    SELECT 'transition'::text, t.to_status
      FROM public.appointment_status_transitions t WHERE t.missing_since IS NULL GROUP BY 2
  ),
  ins AS (
    INSERT INTO public.attendance_status_labels (source_column, raw_label)
    SELECT s.src, s.lab FROM seen s
     WHERE NOT EXISTS (
       SELECT 1 FROM public.attendance_status_labels sl
        WHERE sl.source_column = s.src AND sl.raw_label IS NOT DISTINCT FROM s.lab)
    RETURNING 1
  ),
  upd AS (
    UPDATE public.attendance_status_labels sl SET last_seen_at = now()
      FROM seen s
     WHERE sl.source_column = s.src AND sl.raw_label IS NOT DISTINCT FROM s.lab
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins)::int;
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges. Same boundary as 0014–0019.
-- ---------------------------------------------------------------------------
GRANT SELECT ON TABLE public.attendance_mappings        TO drsnip_metrics_fn;
GRANT SELECT ON TABLE public.attendance_status_labels   TO drsnip_metrics_fn;

ALTER FUNCTION public.drsnip_attendance_evidence(jsonb, text, date, date, integer) OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_attendance_metric(text, date, date, integer)          OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_attendance_preview(jsonb, text, date, date, integer)  OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_status_inventory()                                    OWNER TO drsnip_metrics_fn;

REVOKE ALL ON FUNCTION public.drsnip_attendance_evidence(jsonb, text, date, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_attendance_metric(text, date, date, integer)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_attendance_preview(jsonb, text, date, date, integer)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_status_inventory()                                    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_refresh_status_labels()                               FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  -- The app role gets the published metric, the inventory and the refresh.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_attendance_metric(text,date,date,integer) TO drsnip_intake_demo';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_status_inventory() TO drsnip_intake_demo';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_refresh_status_labels() TO drsnip_intake_demo';
    -- The PREVIEW is granted too, because the application is the only caller
    -- and it guards the route to an admin. It is listed separately so the
    -- asymmetry is visible in this file rather than implied.
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_attendance_preview(jsonb,text,date,date,integer) TO drsnip_intake_demo';
  END IF;

  -- The read-only reporting role gets the PUBLISHED metric and the inventory,
  -- and NOT the preview or the raw evidence function: a report consumer must
  -- not be able to compute against a mapping nobody approved.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_attendance_metric(text,date,date,integer) TO drsnip_reporting_ro';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_status_inventory() TO drsnip_reporting_ro';
  END IF;
END $$;

DO $$
BEGIN
  IF has_function_privilege('public', 'public.drsnip_attendance_preview(jsonb,text,date,date,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute the preview function';
  END IF;
  IF has_function_privilege('public', 'public.drsnip_attendance_evidence(jsonb,text,date,date,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute the raw evidence function';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro')
     AND has_function_privilege('drsnip_reporting_ro',
           'public.drsnip_attendance_preview(jsonb,text,date,date,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the reporting role can compute against an unapproved mapping';
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'drsnip_metrics_fn') THEN
    RAISE EXCEPTION 'the function owner must not be a superuser';
  END IF;
  RAISE NOTICE 'attendance review objects installed; no mapping approved';
END $$;

COMMIT;
