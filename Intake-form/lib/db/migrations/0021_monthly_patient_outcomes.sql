-- 0021_monthly_patient_outcomes.sql — where each entry month's patients stand now.
--
-- Apply by hand, after 0020. NOT registered in migrate.ts: like 0014–0020 it
-- grants to drsnip_metrics_fn, which 0012a/0014 create.
--
-- ============================ THE QUESTION =================================
-- "For everyone who submitted a registration or insurance inquiry in a selected
-- month, how many have completed an appointment or still have one scheduled?"
--
-- A CURRENT-POSITION measure across each patient's relevant appointments, as at
-- the appointment evidence cutoff. It is NOT the booking metric (record created
-- within N days) and it does not replace it.
--
-- ============================ THREE SEPARATE DECISIONS =====================
--   1. What a profile IS CALLED      -> appointment_profile_catalog
--   2. What statuses MEAN            -> outcome_status_rules
--   3. Which profiles a report COUNTS -> outcome_reporting_scopes
-- Numeric profile ids appear in exactly one place per decision, never inside a
-- query. Changing an inclusion decision is a new scope version, not an edit to
-- SQL.
--
-- ============================ WHAT IT IS NOT ===============================
-- It approves nothing. The one scope seeded here is state 'provisional' — an
-- engineering preview with no clinic confirmer — and the status rules are
-- provisional too. Neither can become 'approved' without full provenance (a
-- CHECK, as in 0020). The attendance mapping is not read or touched.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Profile identity — metadata, not patient data.
--
--    Where a name came from is part of the name. These were read off DrChrono's
--    Custom Appointment Profiles settings page by a person; the API route to the
--    same data (/api/appointment_profiles) is still 403 on this credential
--    (DRSNIP_APPOINTMENT_TYPE_LOOKUP.md). A later API read would be a new row
--    source, not a silent overwrite.
--
--    Names are stored EXACTLY as displayed, including the source's own spelling
--    ("Special Accomodations").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_profile_catalog (
  profile_source_id text PRIMARY KEY,
  exact_name        text NOT NULL CHECK (btrim(exact_name) <> ''),
  name_source       text NOT NULL CHECK (name_source IN ('drchrono_settings_ui', 'drchrono_api')),
  source_detail     text NOT NULL,
  observed_on       date NOT NULL,
  recorded_by       text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO appointment_profile_catalog
  (profile_source_id, exact_name, name_source, source_detail, observed_on, recorded_by)
VALUES
  ('585137', 'Consultation with Vasectomy',                'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('874151', 'Auction Winner Consultation with Vasectomy', 'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('503309', 'Consultation Only',                          'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('585138', 'Vasectomy Only',                             'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('594436', 'Repeat DrSnip',                              'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('594437', 'Repeat Outside Provider',                    'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('594438', 'Prior Reversal Vasectomy',                   'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('886171', 'Partial Vasectomy with Consultation',        'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('503310', 'Follow Up Visit',                            'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('665139', 'Home Visit',                                 'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('866117', 'Light Duty Slip Only',                       'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('873325', 'DrSnip Lab Only',                            'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('874156', 'Outside Lab Only',                           'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('875741', 'PVST Mail Order',                            'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap'),
  ('989114', 'Special Accomodations',                      'drchrono_settings_ui', 'Custom Appointment Profiles page', DATE '2026-09-23', 'Raunek Pratap')
ON CONFLICT (profile_source_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Status rules — what a CURRENT status establishes about one appointment.
--
--    Every recognised label sits in exactly one class. Anything else — blank,
--    NULL, an in-clinic status such as 'Checked In', or a label never seen
--    before — is 'unresolved': it establishes neither a positive nor a negative.
--
--    Source for each class is recorded in `source_note`, and the one class that
--    rests on engineering inference rather than the clinic's words is named.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_status_rules (
  version           text PRIMARY KEY,
  state             text NOT NULL CHECK (state IN ('provisional', 'approved', 'superseded')),
  rules             jsonb NOT NULL,
  source_note       text NOT NULL,
  confirmed_by_name text,
  confirmed_by_role text,
  confirmed_via     text CHECK (confirmed_via IS NULL
                                OR confirmed_via IN ('call', 'video_call', 'email', 'in_person', 'written')),
  confirmed_on      date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcome_status_rules_provenance_check CHECK (
    state <> 'approved' OR (
      confirmed_by_name IS NOT NULL AND btrim(confirmed_by_name) <> '' AND
      confirmed_by_role IS NOT NULL AND btrim(confirmed_by_role) <> '' AND
      confirmed_via IS NOT NULL AND confirmed_on IS NOT NULL))
);

INSERT INTO outcome_status_rules (version, state, rules, source_note)
VALUES ('1', 'provisional', jsonb_build_object(
    'completion',                 jsonb_build_array('Complete', 'Signed No Review'),
    'completion_review_withheld', jsonb_build_array('Signed No Review'),
    'procedure_not_performed',    jsonb_build_array('Procedure Not Performed'),
    'active_if_future',           jsonb_build_array('Scheduled', 'Confirmed'),
    'ended_not_active',           jsonb_build_array('Cancelled', 'Late Cancel within 48 hrs'),
    'replaced',                   jsonb_build_array('Rescheduled')),
  'Call with Jeff Cho, 2026-09-21 (jeff-meet-transcript.md): Complete = the appointment was '
  || 'completed, not proof of a procedure (T:55); Signed No Review = completed, review outreach '
  || 'withheld (T:66-71); Procedure Not Performed = consultation happened, procedure did not '
  || '(T:73) — kept in its OWN class and not counted as completion; Confirmed = an appointment '
  || 'already scheduled, being confirmed (T:59); Cancelled and Late Cancel within 48 hrs end that '
  || 'record (T:60-62, T:278-280); Rescheduled = that record was replaced, "almost always" '
  || '(T:276-287) — the remaining records are evaluated, a replacement is never assumed. '
  || 'No Show is DELIBERATELY UNCLASSIFIED: Jeff named it without defining it (T:66), so it '
  || 'establishes nothing — a patient whose only relevant record is a No Show is Unknown, not '
  || 'Neither — and it never outweighs a completion or an active booking elsewhere.')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Reporting scopes — which profiles a report counts.
--
--    Roles, one per listed profile:
--      qualifying          counts toward Completed / Scheduled
--      comparison          reported beside the buckets, never inside them
--      excluded_known      a KNOWN non-acquisition type; cannot change the answer
--      inclusion_undecided a named type whose inclusion is an open clinic decision;
--                          a positive record on one makes the patient Unknown
--    A profile id the scope does not list — including a NULL profile or an id
--    that appears after this row was written — is 'unknown_profile', which is
--    NOT the same as excluded: unknown meaning stays unknown.
--
--    One non-superseded version per scope key (partial unique index). An
--    approved row needs full provenance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_reporting_scopes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key            text NOT NULL CHECK (scope_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  version              integer NOT NULL,
  state                text NOT NULL CHECK (state IN ('provisional', 'approved', 'superseded')),
  label                text NOT NULL,
  description          text NOT NULL,
  status_rules_version text NOT NULL REFERENCES outcome_status_rules (version),
  profile_roles        jsonb NOT NULL,
  confirmed_by_name    text,
  confirmed_by_role    text,
  confirmed_via        text CHECK (confirmed_via IS NULL
                                   OR confirmed_via IN ('call', 'video_call', 'email', 'in_person', 'written')),
  confirmed_on         date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_key, version),
  CONSTRAINT outcome_reporting_scopes_provenance_check CHECK (
    state <> 'approved' OR (
      confirmed_by_name IS NOT NULL AND btrim(confirmed_by_name) <> '' AND
      confirmed_by_role IS NOT NULL AND btrim(confirmed_by_role) <> '' AND
      confirmed_via IS NOT NULL AND confirmed_on IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS outcome_reporting_scopes_one_live_idx
  ON outcome_reporting_scopes (scope_key) WHERE state <> 'superseded';

INSERT INTO outcome_reporting_scopes
  (scope_key, version, state, label, description, status_rules_version, profile_roles)
SELECT 'selected_procedure_types', 1, 'provisional',
  'Selected procedure appointment types — provisional',
  'Engineering preview, not the clinic''s approved definition. Counts Consultation with '
  || 'Vasectomy, Auction Winner Consultation with Vasectomy and Vasectomy Only. Consultation Only '
  || 'is reported beside the buckets for comparison. Follow-up, lab, PVST mail-order and '
  || 'light-duty-slip records never count. Repeat, prior-reversal, partial, home-visit and '
  || 'special-accommodations types are open inclusion decisions.',
  '1',
  jsonb_build_array(
    jsonb_build_object('profile_source_id', '585137', 'role', 'qualifying'),
    jsonb_build_object('profile_source_id', '874151', 'role', 'qualifying'),
    jsonb_build_object('profile_source_id', '585138', 'role', 'qualifying'),
    jsonb_build_object('profile_source_id', '503309', 'role', 'comparison'),
    jsonb_build_object('profile_source_id', '503310', 'role', 'excluded_known'),
    jsonb_build_object('profile_source_id', '873325', 'role', 'excluded_known'),
    jsonb_build_object('profile_source_id', '874156', 'role', 'excluded_known'),
    jsonb_build_object('profile_source_id', '875741', 'role', 'excluded_known'),
    jsonb_build_object('profile_source_id', '866117', 'role', 'excluded_known'),
    jsonb_build_object('profile_source_id', '594436', 'role', 'inclusion_undecided'),
    jsonb_build_object('profile_source_id', '594437', 'role', 'inclusion_undecided'),
    jsonb_build_object('profile_source_id', '594438', 'role', 'inclusion_undecided'),
    jsonb_build_object('profile_source_id', '886171', 'role', 'inclusion_undecided'),
    jsonb_build_object('profile_source_id', '665139', 'role', 'inclusion_undecided'),
    jsonb_build_object('profile_source_id', '989114', 'role', 'inclusion_undecided'))
WHERE NOT EXISTS (SELECT 1 FROM outcome_reporting_scopes
                   WHERE scope_key = 'selected_procedure_types' AND version = 1);

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------------
-- 4. THE ONE CLASSIFICATION — one row per cohort patient.
--
--    INTERNAL. Returns patient identifiers, so it is granted to NOBODY; only the
--    published wrapper below (same owner) calls it. Roles and rules come in as
--    arguments so the wrapper is the single place that resolves them from the
--    tables — a caller can never supply its own.
--
--    PRECEDENCE, per patient, over non-deleted appointments scheduled on or
--    after the entry CLINIC day:
--      not covered  history never retrieved              -> outside the buckets
--      completed    a qualifying record in a completion status
--      scheduled    a qualifying Scheduled/Confirmed record dated after the cutoff
--      unknown      no positive, and a RELEVANT ambiguity (below)
--      neither      no positive, and nothing that could change that
--
--    A RELEVANT ambiguity is one that could turn the answer positive under the
--    stated scope:
--      * a qualifying record whose date has passed while still Scheduled/Confirmed
--      * a qualifying record with an unresolved status (blank, NULL, in-clinic, new)
--      * a qualifying Rescheduled record with no later-created record that could
--        be its replacement (qualifying, undecided or unknown profile)
--      * a qualifying record whose history reached a completion status that its
--        current status no longer shows
--      * a qualifying record in a completion status that has been DELETED
--      * an undecided-inclusion or unknown profile record that is completed, due,
--        or unresolved
--    Ambiguity on comparison or excluded_known records is IRRELEVANT: they can
--    never make the answer positive, so a blank PVST record changes nothing.
--
--    Everything between the two marker lines is the calculation. The production
--    reconciliation script runs that exact text read-only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_outcome_classify(
  p_roles jsonb, p_rules jsonb, p_form text, p_month_from date, p_month_to date
)
RETURNS TABLE (
  entry_month                     date,
  pid                             text,
  is_covered                      boolean,
  bucket                          text,
  neither_reason                  text,
  r_past_dated_open               boolean,
  r_status_unresolved             boolean,
  r_rescheduled_no_replacement    boolean,
  r_conflicting_history           boolean,
  r_deleted_completion            boolean,
  r_undecided_profile             boolean,
  r_unknown_profile               boolean,
  a_completed_with_future_booking boolean,
  a_completed_review_withheld_only boolean,
  a_procedure_not_performed       boolean,
  a_comparison_completed          boolean,
  a_comparison_scheduled          boolean,
  a_positive_booked_before_entry  boolean,
  a_prior_completion_before_entry boolean,
  a_registered_before_inquiry     boolean,
  a_repeat_submitter              boolean,
  evidence_cutoff                 timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $classify$
-- >>> OUTCOME CLASSIFY BODY >>>
WITH
rules AS (
  SELECT
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'completion'))                 AS completion,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'completion_review_withheld')) AS review_withheld,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'procedure_not_performed'))    AS pnp,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'active_if_future'))           AS active,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'ended_not_active'))           AS ended,
    ARRAY(SELECT jsonb_array_elements_text(p_rules -> 'replaced'))                   AS replaced
),
roles AS (
  SELECT x.profile_source_id, x.role
    FROM jsonb_to_recordset(p_roles) AS x(profile_source_id text, role text)
),
-- The instant appointment data is complete to. Same rule as booking (0019) and
-- attendance (0020). "Future" is judged against THIS, never against now().
cutoff AS (
  SELECT greatest(
           (SELECT max(w.completed_at) FROM public.appointment_sync_windows w
             WHERE w.strategy = 'patient_history' AND w.state = 'complete'),
           (SELECT st.watermark FROM public.appointment_sync_state st
             WHERE st.scope_key = 'practice_incremental')) AS c
),
covered AS (
  SELECT DISTINCT w.patient_source_id AS pid
    FROM public.appointment_sync_windows w
   WHERE w.strategy = 'patient_history' AND w.state = 'complete' AND w.patient_source_id IS NOT NULL
),
-- One row per linked chart at its FIRST submission of this form ever. A repeat
-- submission never creates a second entry; it is flagged.
fe AS (
  SELECT s.n8n_patient_id AS pid_n, min(s.created_at) AS entry_at, count(*) AS n_subs
    FROM public.submissions s
   WHERE s.n8n_patient_id IS NOT NULL AND s.form_type = p_form
   GROUP BY 1
),
e AS (
  SELECT fe.pid_n::text AS pid, fe.entry_at, fe.n_subs,
         (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date                    AS entry_day,
         date_trunc('month', fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date AS entry_month,
         EXISTS (SELECT 1 FROM covered c WHERE c.pid = fe.pid_n::text)              AS is_covered,
         -- Insurance only: a registration already on file BEFORE the inquiry.
         (p_form = 'insurance' AND EXISTS (
            SELECT 1 FROM public.submissions r
             WHERE r.n8n_patient_id = fe.pid_n AND r.form_type = 'registration'
               AND r.created_at < fe.entry_at))                                    AS registered_before
    FROM fe
   WHERE (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date >= p_month_from
     AND (fe.entry_at AT TIME ZONE 'America/Los_Angeles')::date <  p_month_to
),
a AS (
  SELECT e.pid, s.source_appointment_id AS aid, s.source_created_at, s.current_status,
         s.deleted_flag,
         coalesce(ro.role, 'unknown_profile') AS role,
         CASE
           WHEN s.current_status = ANY (rl.completion) THEN 'completion'
           WHEN s.current_status = ANY (rl.pnp)        THEN 'pnp'
           WHEN s.current_status = ANY (rl.active)
                AND s.scheduled_time > (SELECT c FROM cutoff) THEN 'active'
           WHEN s.current_status = ANY (rl.active)     THEN 'past_open'
           WHEN s.current_status = ANY (rl.ended)      THEN 'ended'
           WHEN s.current_status = ANY (rl.replaced)   THEN 'replaced'
           ELSE 'unresolved_status'   -- blank, NULL, in-clinic, or never seen before
         END AS sclass,
         coalesce(s.current_status = ANY (rl.review_withheld), false) AS review_withheld,
         -- Relevant from the entry CLINIC day. An undated record cannot be
         -- placed before entry, so it is not discarded as pre-entry.
         coalesce((s.scheduled_time AT TIME ZONE 'America/Los_Angeles')::date >= e.entry_day, true) AS after_entry,
         coalesce(s.source_created_at < e.entry_at, false) AS created_before_entry,
         EXISTS (SELECT 1 FROM public.appointment_status_transitions t
                  WHERE t.source_appointment_id = s.source_appointment_id
                    AND t.missing_since IS NULL
                    AND t.to_status = ANY (rl.completion)) AS history_completion
    FROM e
    JOIN public.appointment_snapshots s ON s.patient_source_id = e.pid
    CROSS JOIN rules rl
    LEFT JOIN roles ro ON ro.profile_source_id = s.profile_source_id
),
ax AS (
  SELECT a.*,
         (NOT a.deleted_flag AND a.after_entry)      AS live,
         (a.role = 'qualifying')                     AS q,
         -- A later-created record that COULD be a replacement. Existence only:
         -- no pairing by time proximity, no claim that it IS the replacement.
         EXISTS (SELECT 1 FROM a b
                  WHERE b.pid = a.pid AND b.aid <> a.aid AND NOT b.deleted_flag
                    AND b.role IN ('qualifying', 'inclusion_undecided', 'unknown_profile')
                    AND b.source_created_at > a.source_created_at) AS has_later_record
    FROM a
),
pp AS (
  SELECT e.entry_month, e.pid, e.is_covered, e.n_subs, e.registered_before,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'completion'), false) AS q_completed,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'active'), false)     AS q_active,
    coalesce(bool_or(ax.live AND ax.q), false)                              AS q_any,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'completion' AND NOT ax.review_withheld), false) AS q_completed_with_review,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'past_open'), false)          AS r_past_dated_open,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'unresolved_status'), false)  AS r_status_unresolved,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'replaced' AND NOT ax.has_later_record), false) AS r_rescheduled_no_replacement,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass <> 'completion' AND ax.history_completion), false) AS r_conflicting_history,
    coalesce(bool_or(ax.deleted_flag AND ax.after_entry AND ax.q AND ax.sclass = 'completion'), false) AS r_deleted_completion,
    coalesce(bool_or(ax.live AND ax.role = 'inclusion_undecided'
                     AND ax.sclass IN ('completion', 'active', 'past_open', 'unresolved_status')), false) AS r_undecided_profile,
    coalesce(bool_or(ax.live AND ax.role = 'unknown_profile'
                     AND ax.sclass IN ('completion', 'active', 'past_open', 'unresolved_status')), false) AS r_unknown_profile,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass = 'pnp'), false)                AS a_pnp,
    coalesce(bool_or(ax.live AND ax.role = 'comparison' AND ax.sclass IN ('completion', 'pnp')), false) AS a_cmp_completed,
    coalesce(bool_or(ax.live AND ax.role = 'comparison' AND ax.sclass = 'active'), false) AS a_cmp_active,
    coalesce(bool_or(ax.live AND ax.q AND ax.sclass IN ('completion', 'active') AND ax.created_before_entry), false) AS a_booked_before,
    coalesce(bool_or(NOT ax.deleted_flag AND NOT ax.after_entry AND ax.q AND ax.sclass = 'completion'), false) AS a_prior_completion
    FROM e LEFT JOIN ax ON ax.pid = e.pid
   GROUP BY e.entry_month, e.pid, e.is_covered, e.n_subs, e.registered_before
),
cls AS (
  SELECT pp.*,
         CASE
           WHEN NOT pp.is_covered THEN 'not_covered'
           WHEN pp.q_completed    THEN 'completed'
           WHEN pp.q_active       THEN 'scheduled'
           WHEN pp.r_past_dated_open OR pp.r_status_unresolved OR pp.r_rescheduled_no_replacement
             OR pp.r_conflicting_history OR pp.r_deleted_completion
             OR pp.r_undecided_profile OR pp.r_unknown_profile THEN 'unknown'
           ELSE 'neither'
         END AS bucket
    FROM pp
)
SELECT cls.entry_month, cls.pid, cls.is_covered, cls.bucket,
       CASE WHEN cls.bucket <> 'neither' THEN NULL
            WHEN cls.q_any THEN 'had_qualifying_record'
            ELSE 'no_qualifying_record' END,
       cls.r_past_dated_open, cls.r_status_unresolved, cls.r_rescheduled_no_replacement,
       cls.r_conflicting_history, cls.r_deleted_completion, cls.r_undecided_profile, cls.r_unknown_profile,
       (cls.q_completed AND cls.q_active),
       (cls.q_completed AND NOT cls.q_completed_with_review),
       cls.a_pnp, cls.a_cmp_completed, cls.a_cmp_active, cls.a_booked_before, cls.a_prior_completion,
       cls.registered_before, (cls.n_subs > 1),
       (SELECT c FROM cutoff)
  FROM cls
-- <<< OUTCOME CLASSIFY BODY <<<
$classify$;

-- ---------------------------------------------------------------------------
-- 5. PUBLISHED monthly outcomes. Resolves scope and rules SERVER-SIDE.
--
--    WHOLE CLINIC MONTHS ONLY. An arbitrary day range lets two calls differing
--    by one day be subtracted to read the outcome of the few patients who
--    entered on that day. Month granularity removes that lever.
--
--    SUPPRESSION, per month row, inside this boundary:
--      * covered 1–4: the whole row's patient counts are withheld.
--      * the four buckets are a PARTITION of `covered` and get the same
--        withhold-until-two rule as suppressPartition() in contract.ts.
--      * if ANY bucket is withheld, every OUTCOME annotation in that row is
--        withheld too: a subset count bounds its parent, and a lower bound on a
--        withheld partner narrows the small cell it is protecting.
--      * the two Neither sub-reasons are a partition of Neither.
--      * everything else is per-cell (0 is publishable; 1–4 is not).
--    No rate and no completed+scheduled total is returned, by design.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_outcome_metric(
  p_metric text, p_scope text, p_month_from date, p_month_to date
)
RETURNS TABLE (
  entry_month                      date,
  row_status                       text,
  entry_period_complete            boolean,
  days_observed_min                numeric,
  days_observed_max                numeric,
  cohort_total                     integer,
  covered                          integer,
  not_covered                      integer,
  unlinked_submissions             integer,
  completed                        integer,
  scheduled                        integer,
  unknown                          integer,
  neither                          integer,
  neither_no_qualifying_record     integer,
  neither_had_qualifying_record    integer,
  unknown_past_dated_open          integer,
  unknown_status_unresolved        integer,
  unknown_rescheduled_no_replacement integer,
  unknown_conflicting_history      integer,
  unknown_deleted_completion       integer,
  unknown_undecided_profile        integer,
  unknown_unknown_profile          integer,
  completed_with_future_booking    integer,
  completed_review_withheld_only   integer,
  procedure_not_performed          integer,
  comparison_completed             integer,
  comparison_scheduled             integer,
  positive_booked_before_entry     integer,
  prior_completion_before_entry    integer,
  registered_before_inquiry        integer,
  repeat_submitters                integer,
  withheld                         text[],
  scope_key                        text,
  scope_version                    integer,
  scope_state                      text,
  status_rules_version             text,
  evidence_cutoff                  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '20s'
AS $fn$
DECLARE
  k        constant integer := 5;
  form     text;
  sc       record;
  rl       record;
  cut      timestamptz;
  m        date;
  m_start  timestamptz;
  m_end    timestamptz;
  c        record;
  v        integer[];
  hide     boolean[];
  n_hidden integer;
  smallest integer;
  i        integer;
  part_hidden boolean;
  cell     integer;
BEGIN
  IF p_metric IS NULL OR p_metric NOT IN ('outcome_registration', 'outcome_insurance') THEN
    RAISE EXCEPTION 'unsupported metric' USING ERRCODE = '22023';
  END IF;
  IF p_month_from IS NULL OR p_month_to IS NULL
     OR p_month_from <> date_trunc('month', p_month_from)::date
     OR p_month_to   <> date_trunc('month', p_month_to)::date
     OR p_month_to <= p_month_from
     OR p_month_from < DATE '2026-01-01'
     OR p_month_to > (p_month_from + interval '13 months')::date THEN
    RAISE EXCEPTION 'invalid entry period' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO sc FROM public.outcome_reporting_scopes s
   WHERE s.scope_key = p_scope AND s.state <> 'superseded';
  IF sc IS NULL THEN
    RAISE EXCEPTION 'unsupported scope' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO rl FROM public.outcome_status_rules r WHERE r.version = sc.status_rules_version;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(sc.profile_roles) AS x(profile_source_id text, role text)
              WHERE x.role NOT IN ('qualifying', 'comparison', 'excluded_known', 'inclusion_undecided')
                 OR x.profile_source_id IS NULL) THEN
    RAISE EXCEPTION 'malformed scope' USING ERRCODE = '22023';
  END IF;

  form := CASE WHEN p_metric = 'outcome_registration' THEN 'registration' ELSE 'insurance' END;

  SELECT greatest(
           (SELECT max(w.completed_at) FROM public.appointment_sync_windows w
             WHERE w.strategy = 'patient_history' AND w.state = 'complete'),
           (SELECT st.watermark FROM public.appointment_sync_state st
             WHERE st.scope_key = 'practice_incremental'))
    INTO cut;

  FOR c IN
    WITH cl AS (
      SELECT * FROM public.drsnip_outcome_classify(
        sc.profile_roles, rl.rules, form, p_month_from, p_month_to)
    ),
    agg AS (
      SELECT cl.entry_month AS em,
        count(*)::int                                                         AS n_total,
        count(*) FILTER (WHERE cl.is_covered)::int                            AS n_cov,
        count(*) FILTER (WHERE NOT cl.is_covered)::int                        AS n_notcov,
        count(*) FILTER (WHERE cl.bucket = 'completed')::int                  AS n_comp,
        count(*) FILTER (WHERE cl.bucket = 'scheduled')::int                  AS n_sched,
        count(*) FILTER (WHERE cl.bucket = 'unknown')::int                    AS n_unk,
        count(*) FILTER (WHERE cl.bucket = 'neither')::int                    AS n_nei,
        count(*) FILTER (WHERE cl.neither_reason = 'no_qualifying_record')::int  AS n_nei_none,
        count(*) FILTER (WHERE cl.neither_reason = 'had_qualifying_record')::int AS n_nei_had,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_past_dated_open)::int            AS u1,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_status_unresolved)::int          AS u2,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_rescheduled_no_replacement)::int AS u3,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_conflicting_history)::int        AS u4,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_deleted_completion)::int         AS u5,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_undecided_profile)::int          AS u6,
        count(*) FILTER (WHERE cl.bucket = 'unknown' AND cl.r_unknown_profile)::int            AS u7,
        count(*) FILTER (WHERE cl.bucket = 'completed' AND cl.a_completed_with_future_booking)::int  AS a1,
        count(*) FILTER (WHERE cl.bucket = 'completed' AND cl.a_completed_review_withheld_only)::int AS a2,
        count(*) FILTER (WHERE cl.is_covered AND cl.bucket <> 'completed' AND cl.a_procedure_not_performed)::int AS a3,
        count(*) FILTER (WHERE cl.is_covered AND cl.bucket <> 'completed' AND cl.a_comparison_completed)::int    AS a4,
        count(*) FILTER (WHERE cl.is_covered AND cl.bucket NOT IN ('completed', 'scheduled') AND cl.a_comparison_scheduled)::int AS a5,
        count(*) FILTER (WHERE cl.bucket IN ('completed', 'scheduled') AND cl.a_positive_booked_before_entry)::int AS a6,
        count(*) FILTER (WHERE cl.is_covered AND cl.a_prior_completion_before_entry)::int AS a7,
        count(*) FILTER (WHERE cl.a_registered_before_inquiry)::int           AS a8,
        count(*) FILTER (WHERE cl.a_repeat_submitter)::int                    AS a9
        FROM cl GROUP BY 1
    ),
    -- Submissions no chart was ever linked to. SUBMISSIONS, not people: two of
    -- them may be the same person, and nobody is deduplicated by assumption.
    unl AS (
      SELECT date_trunc('month', s.created_at AT TIME ZONE 'America/Los_Angeles')::date AS em,
             count(*)::int AS n
        FROM public.submissions s
       WHERE s.n8n_patient_id IS NULL AND s.form_type = form
         AND (s.created_at AT TIME ZONE 'America/Los_Angeles')::date >= p_month_from
         AND (s.created_at AT TIME ZONE 'America/Los_Angeles')::date <  p_month_to
       GROUP BY 1
    ),
    months AS (
      SELECT g::date AS em FROM generate_series(p_month_from, p_month_to - 1, interval '1 month') g
    )
    SELECT months.em, agg.*, coalesce(unl.n, 0) AS n_unl
      FROM months
      LEFT JOIN agg ON agg.em = months.em
      LEFT JOIN unl ON unl.em = months.em
     ORDER BY months.em
  LOOP
    m := c.em;
    -- Month boundaries as instants on the clinic calendar (DST-correct).
    m_start := m::timestamp AT TIME ZONE 'America/Los_Angeles';
    m_end   := (m + interval '1 month')::timestamp AT TIME ZONE 'America/Los_Angeles';

    entry_month := m;
    entry_period_complete := (m_end <= cut);
    -- How long the YOUNGEST and OLDEST possible entrant has been observed. A
    -- month still open has a youngest entrant observed for no time at all.
    days_observed_min := round(greatest(0, extract(epoch FROM (cut - least(m_end, cut))) / 86400.0)::numeric, 1);
    days_observed_max := round(greatest(0, extract(epoch FROM (cut - m_start)) / 86400.0)::numeric, 1);
    scope_key := sc.scope_key; scope_version := sc.version; scope_state := sc.state;
    status_rules_version := sc.status_rules_version; evidence_cutoff := cut;
    withheld := ARRAY[]::text[];

    unlinked_submissions := CASE WHEN c.n_unl BETWEEN 1 AND k - 1 THEN NULL ELSE c.n_unl END;
    IF unlinked_submissions IS NULL THEN withheld := array_append(withheld, 'unlinked_submissions_small'); END IF;

    cohort_total := coalesce(c.n_total, 0); covered := coalesce(c.n_cov, 0); not_covered := coalesce(c.n_notcov, 0);
    completed := coalesce(c.n_comp, 0); scheduled := coalesce(c.n_sched, 0);
    unknown := coalesce(c.n_unk, 0); neither := coalesce(c.n_nei, 0);
    neither_no_qualifying_record := coalesce(c.n_nei_none, 0);
    neither_had_qualifying_record := coalesce(c.n_nei_had, 0);
    unknown_past_dated_open := coalesce(c.u1, 0); unknown_status_unresolved := coalesce(c.u2, 0);
    unknown_rescheduled_no_replacement := coalesce(c.u3, 0); unknown_conflicting_history := coalesce(c.u4, 0);
    unknown_deleted_completion := coalesce(c.u5, 0); unknown_undecided_profile := coalesce(c.u6, 0);
    unknown_unknown_profile := coalesce(c.u7, 0);
    completed_with_future_booking := coalesce(c.a1, 0); completed_review_withheld_only := coalesce(c.a2, 0);
    procedure_not_performed := coalesce(c.a3, 0); comparison_completed := coalesce(c.a4, 0);
    comparison_scheduled := coalesce(c.a5, 0); positive_booked_before_entry := coalesce(c.a6, 0);
    prior_completion_before_entry := coalesce(c.a7, 0);
    registered_before_inquiry := coalesce(c.a8, 0); repeat_submitters := coalesce(c.a9, 0);

    IF m_start > cut THEN
      row_status := 'not_started';
    ELSIF cohort_total = 0 THEN
      row_status := 'empty';
    ELSIF covered BETWEEN 1 AND k - 1 THEN
      -- Too few people to say anything about outcomes at all.
      row_status := 'suppressed';
      withheld := array_append(withheld, 'covered_cohort_small');
      cohort_total := NULL; covered := NULL; not_covered := NULL;
      completed := NULL; scheduled := NULL; unknown := NULL; neither := NULL;
      neither_no_qualifying_record := NULL; neither_had_qualifying_record := NULL;
      unknown_past_dated_open := NULL; unknown_status_unresolved := NULL;
      unknown_rescheduled_no_replacement := NULL; unknown_conflicting_history := NULL;
      unknown_deleted_completion := NULL; unknown_undecided_profile := NULL; unknown_unknown_profile := NULL;
      completed_with_future_booking := NULL; completed_review_withheld_only := NULL;
      procedure_not_performed := NULL; comparison_completed := NULL; comparison_scheduled := NULL;
      positive_booked_before_entry := NULL; prior_completion_before_entry := NULL;
      registered_before_inquiry := NULL; repeat_submitters := NULL;
    ELSE
      row_status := 'ok';

      -- Coverage. A small uncovered count is withheld with the total it would
      -- be recovered from; `covered` — the bucket denominator — stays.
      IF not_covered BETWEEN 1 AND k - 1 THEN
        not_covered := NULL; cohort_total := NULL;
        withheld := array_append(withheld, 'not_covered_small');
      END IF;

      -- The partition. Identical algorithm to suppressPartition() and to 0020.
      v := ARRAY[completed, scheduled, unknown, neither];
      hide := ARRAY[false, false, false, false];
      FOR i IN 1..4 LOOP IF v[i] BETWEEN 1 AND k - 1 THEN hide[i] := true; END IF; END LOOP;
      n_hidden := 0;
      FOR i IN 1..4 LOOP IF hide[i] THEN n_hidden := n_hidden + 1; END IF; END LOOP;
      IF n_hidden > 0 THEN
        WHILE n_hidden < 2 LOOP
          smallest := NULL;
          FOR i IN 1..4 LOOP
            IF NOT hide[i] AND (smallest IS NULL OR v[i] < v[smallest]) THEN smallest := i; END IF;
          END LOOP;
          EXIT WHEN smallest IS NULL;
          hide[smallest] := true; n_hidden := n_hidden + 1;
        END LOOP;
        IF n_hidden < 2 THEN hide := ARRAY[true, true, true, true]; END IF;
      END IF;
      part_hidden := hide[1] OR hide[2] OR hide[3] OR hide[4];
      IF hide[1] THEN completed := NULL; END IF;
      IF hide[2] THEN scheduled := NULL; END IF;
      IF hide[3] THEN unknown   := NULL; END IF;
      IF hide[4] THEN neither   := NULL; END IF;

      IF part_hidden THEN
        -- Every outcome annotation bounds some bucket; withhold them all.
        withheld := array_append(withheld, 'partition_small_cell');
        neither_no_qualifying_record := NULL; neither_had_qualifying_record := NULL;
        unknown_past_dated_open := NULL; unknown_status_unresolved := NULL;
        unknown_rescheduled_no_replacement := NULL; unknown_conflicting_history := NULL;
        unknown_deleted_completion := NULL; unknown_undecided_profile := NULL; unknown_unknown_profile := NULL;
        completed_with_future_booking := NULL; completed_review_withheld_only := NULL;
        procedure_not_performed := NULL; comparison_completed := NULL; comparison_scheduled := NULL;
        positive_booked_before_entry := NULL; prior_completion_before_entry := NULL;
      ELSE
        -- Neither's two sub-reasons partition it: one small one hides both.
        IF neither_no_qualifying_record BETWEEN 1 AND k - 1
           OR neither_had_qualifying_record BETWEEN 1 AND k - 1 THEN
          neither_no_qualifying_record := NULL; neither_had_qualifying_record := NULL;
          withheld := array_append(withheld, 'neither_breakdown_small');
        END IF;
        -- Overlapping annotations: plain per-cell suppression.
        IF unknown_past_dated_open BETWEEN 1 AND k - 1 THEN unknown_past_dated_open := NULL; END IF;
        IF unknown_status_unresolved BETWEEN 1 AND k - 1 THEN unknown_status_unresolved := NULL; END IF;
        IF unknown_rescheduled_no_replacement BETWEEN 1 AND k - 1 THEN unknown_rescheduled_no_replacement := NULL; END IF;
        IF unknown_conflicting_history BETWEEN 1 AND k - 1 THEN unknown_conflicting_history := NULL; END IF;
        IF unknown_deleted_completion BETWEEN 1 AND k - 1 THEN unknown_deleted_completion := NULL; END IF;
        IF unknown_undecided_profile BETWEEN 1 AND k - 1 THEN unknown_undecided_profile := NULL; END IF;
        IF unknown_unknown_profile BETWEEN 1 AND k - 1 THEN unknown_unknown_profile := NULL; END IF;
        IF completed_with_future_booking BETWEEN 1 AND k - 1 THEN completed_with_future_booking := NULL; END IF;
        IF completed_review_withheld_only BETWEEN 1 AND k - 1 THEN completed_review_withheld_only := NULL; END IF;
        IF procedure_not_performed BETWEEN 1 AND k - 1 THEN procedure_not_performed := NULL; END IF;
        IF comparison_completed BETWEEN 1 AND k - 1 THEN comparison_completed := NULL; END IF;
        IF comparison_scheduled BETWEEN 1 AND k - 1 THEN comparison_scheduled := NULL; END IF;
        IF positive_booked_before_entry BETWEEN 1 AND k - 1 THEN positive_booked_before_entry := NULL; END IF;
        IF prior_completion_before_entry BETWEEN 1 AND k - 1 THEN prior_completion_before_entry := NULL; END IF;
      END IF;

      -- Cohort facts, not outcomes: they bound no bucket.
      IF registered_before_inquiry BETWEEN 1 AND k - 1 THEN registered_before_inquiry := NULL; END IF;
      IF repeat_submitters BETWEEN 1 AND k - 1 THEN repeat_submitters := NULL; END IF;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. The definition, read out: what the scope counts and where every stored
--    profile id stands. Metadata only — appointment counts per profile are
--    per-cell suppressed, and no patient is involved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_outcome_definition(p_scope text)
RETURNS TABLE (
  scope_key            text,
  scope_version        integer,
  scope_state          text,
  scope_label          text,
  scope_description    text,
  status_rules_version text,
  status_rules_state   text,
  status_rules         jsonb,
  status_rules_source  text,
  profile_source_id    text,
  exact_name           text,
  name_source          text,
  name_observed_on     date,
  role                 text,
  stored_appointments  integer,
  is_stored            boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '15s'
AS $fn$
DECLARE
  sc record;
  rl record;
BEGIN
  SELECT * INTO sc FROM public.outcome_reporting_scopes s
   WHERE s.scope_key = p_scope AND s.state <> 'superseded';
  IF sc IS NULL THEN
    RAISE EXCEPTION 'unsupported scope' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO rl FROM public.outcome_status_rules r WHERE r.version = sc.status_rules_version;

  RETURN QUERY
  WITH roles AS (
    SELECT x.profile_source_id AS pid, x.role
      FROM jsonb_to_recordset(sc.profile_roles) AS x(profile_source_id text, role text)
  ),
  stored AS (
    SELECT a.profile_source_id AS pid, count(*)::int AS n
      FROM public.appointment_snapshots a GROUP BY 1
  ),
  ids AS (
    SELECT c.profile_source_id AS pid FROM public.appointment_profile_catalog c
    UNION SELECT roles.pid FROM roles
    UNION SELECT stored.pid FROM stored
  )
  SELECT sc.scope_key, sc.version, sc.state, sc.label, sc.description,
         rl.version, rl.state, rl.rules, rl.source_note,
         ids.pid, cat.exact_name, cat.name_source, cat.observed_on,
         coalesce(roles.role, 'unknown_profile'),
         CASE WHEN st.n IS NULL THEN 0 WHEN st.n < 5 THEN NULL ELSE st.n END,
         (st.n IS NOT NULL)
    FROM ids
    LEFT JOIN public.appointment_profile_catalog cat ON cat.profile_source_id = ids.pid
    LEFT JOIN roles ON roles.pid = ids.pid
    LEFT JOIN stored st ON st.pid IS NOT DISTINCT FROM ids.pid
   ORDER BY (ids.pid IS NULL), ids.pid;
END;
$fn$;

COMMIT;

BEGIN;

-- ---------------------------------------------------------------------------
-- 7. Privileges. Same boundary as 0014–0020.
-- ---------------------------------------------------------------------------
GRANT SELECT ON TABLE public.appointment_profile_catalog TO drsnip_metrics_fn;
GRANT SELECT ON TABLE public.outcome_status_rules        TO drsnip_metrics_fn;
GRANT SELECT ON TABLE public.outcome_reporting_scopes    TO drsnip_metrics_fn;

-- Owned by the application role like every table beside them (see f39a4b6).
DO $own$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo') THEN
    EXECUTE 'ALTER TABLE public.appointment_profile_catalog OWNER TO drsnip_intake_demo';
    EXECUTE 'ALTER TABLE public.outcome_status_rules        OWNER TO drsnip_intake_demo';
    EXECUTE 'ALTER TABLE public.outcome_reporting_scopes    OWNER TO drsnip_intake_demo';
  END IF;
END $own$;

ALTER FUNCTION public.drsnip_outcome_classify(jsonb, jsonb, text, date, date) OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_outcome_metric(text, text, date, date)          OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_outcome_definition(text)                        OWNER TO drsnip_metrics_fn;

REVOKE ALL ON FUNCTION public.drsnip_outcome_classify(jsonb, jsonb, text, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_outcome_metric(text, text, date, date)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_outcome_definition(text)                        FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_outcome_metric(text,text,date,date) TO drsnip_intake_demo';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_outcome_definition(text) TO drsnip_intake_demo';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_outcome_metric(text,text,date,date) TO drsnip_reporting_ro';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_outcome_definition(text) TO drsnip_reporting_ro';
  END IF;
END $$;

-- Self-checks. A failure here aborts the migration rather than shipping a leak.
DO $$
BEGIN
  IF has_function_privilege('public', 'public.drsnip_outcome_classify(jsonb,jsonb,text,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute the patient-level classifier';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro')
     AND has_function_privilege('drsnip_reporting_ro',
           'public.drsnip_outcome_classify(jsonb,jsonb,text,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the reporting role can reach patient-level rows';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = 'drsnip_intake_demo')
     AND has_function_privilege('drsnip_intake_demo',
           'public.drsnip_outcome_classify(jsonb,jsonb,text,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the application role can reach patient-level rows';
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'drsnip_metrics_fn') THEN
    RAISE EXCEPTION 'the function owner must not be a superuser';
  END IF;
  IF EXISTS (SELECT 1 FROM public.outcome_reporting_scopes WHERE state = 'approved') THEN
    RAISE NOTICE 'an approved outcome scope exists';
  ELSE
    RAISE NOTICE 'monthly outcome objects installed; no scope approved';
  END IF;
END $$;

COMMIT;
