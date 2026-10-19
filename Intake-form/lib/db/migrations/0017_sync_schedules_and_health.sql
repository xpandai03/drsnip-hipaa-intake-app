-- 0017_sync_schedules_and_health.sql — recurring appointment sync: the durable
-- schedule registry, the shared request budget, and the health view the console
-- reads.
--
-- APPLY ORDER. Like 0012a, 0014, 0015 and 0016 this file is NOT registered in
-- migrate.ts (it redefines a function 0014 creates and grants to a role 0012a
-- creates). Apply by hand, in numeric order, after 0014/0015/0016.
--
-- WHY A SCHEDULE TABLE. Recurring sync runs in n8n, outside this app. Two
-- things follow:
--
--   * The console must not claim "updates automatically" because a developer
--     believes a schedule exists. `drsnip_sync_health()` answers from EVIDENCE
--     — the last run that actually finished — never from configuration.
--   * There has to be a stop switch that does not require the app, and one
--     that does not require the n8n editor either. `enabled` is checked by the
--     workflow itself on every run: flipping it to false ends recurring work at
--     the next tick without touching a deployment. Deactivating the workflow in
--     n8n remains the other, independent switch.
--
-- WHY A BUDGET FUNCTION. DrChrono allows 500 requests/hour and 290 per rolling
-- ten minutes for this practice, and FIVE live intake workflows share that
-- allowance with sync. A per-workflow cap cannot protect a shared limit — two
-- schedules each obeying their own cap still add up. `drsnip_sync_budget()`
-- reads the one table every sync run writes to, so every scheduled scope sees
-- the same number and reserves headroom for the intake workflows that patients
-- are waiting on.
--
-- PRIVACY. Nothing here reads a name, a contact detail or an appointment
-- reason. The only patient-linked quantity is a COUNT of linked ids that have
-- no completed history unit. Patient ids plus appointment coverage remain
-- sensitive health data; no id leaves the boundary.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The schedule registry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_sync_schedules (
  schedule_key   text PRIMARY KEY,
  -- The appointment_sync_state row this schedule claims. Two schedules must
  -- never share a scope_key, or one would steal the other's lease.
  scope_key      text        NOT NULL REFERENCES appointment_sync_state (scope_key),

  -- THE STOP SWITCH. Read by the workflow at the start of every run, before
  -- any DrChrono request. False = the run records itself as skipped and exits.
  enabled        boolean     NOT NULL DEFAULT false,

  -- Human description of the cadence, e.g. 'hourly at :05, clinic time'.
  cadence        text        NOT NULL,
  -- How long may pass between successful runs before the cadence is late.
  -- Used by drsnip_sync_health(); it is NOT a timeout on a run.
  expected_interval_minutes integer NOT NULL,

  -- Per-run request cap, and the share of the shared hourly allowance this
  -- schedule may consume. Declared here so the numbers are auditable in one
  -- place rather than inferred from workflow JSON.
  max_requests_per_run      integer NOT NULL DEFAULT 12,

  n8n_workflow_id text,
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS appointment_sync_schedules_scope_idx
  ON appointment_sync_schedules (scope_key);

-- ---------------------------------------------------------------------------
-- 2. The shared request budget.
--
--    Sustained and burst are DIFFERENT limits and are enforced separately: a
--    schedule that is comfortably inside its hourly share can still blow the
--    ten-minute ceiling, which is how the backfill hit ~840/hour.
--
--    RESERVED FOR INTAKE. The caps below are deliberately a fraction of the
--    real limits. Registration, Consultation and Insurance call DrChrono while
--    a patient is waiting on a form; sync never gets to be the reason one of
--    those is rate-limited.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_sync_budget()
RETURNS TABLE (
  hour_used        integer,
  hour_cap         integer,
  hour_remaining   integer,
  burst_used       integer,
  burst_cap        integer,
  burst_remaining  integer,
  in_flight_runs   integer,
  may_run          boolean,
  reason           text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'
AS $$
  WITH live AS (
    -- A run that has not finished has not yet written requests_made, so its
    -- declared per-run cap is reserved in full. Pessimistic on purpose.
    SELECT count(*)::int AS n,
           coalesce(sum(coalesce(s.max_requests_per_run, 12)), 0)::int AS reserved
      FROM public.appointment_sync_runs r
      LEFT JOIN public.appointment_sync_schedules s ON s.scope_key = r.scope_key
     WHERE r.outcome = 'running'
       AND r.started_at > now() - interval '60 minutes'
  ),
  hr AS (
    SELECT coalesce(sum(r.requests_made), 0)::int AS n
      FROM public.appointment_sync_runs r
     WHERE r.started_at > now() - interval '60 minutes'
       AND r.outcome <> 'running'
  ),
  bt AS (
    SELECT coalesce(sum(r.requests_made), 0)::int AS n
      FROM public.appointment_sync_runs r
     WHERE r.started_at > now() - interval '10 minutes'
       AND r.outcome <> 'running'
  )
  SELECT
    hr.n + live.reserved,
    150,
    greatest(0, 150 - (hr.n + live.reserved)),
    bt.n + live.reserved,
    60,
    greatest(0, 60 - (bt.n + live.reserved)),
    live.n,
    (hr.n + live.reserved) < 150 AND (bt.n + live.reserved) < 60,
    CASE
      WHEN (hr.n + live.reserved) >= 150 THEN 'sustained budget exhausted (150/hour reserved for sync; the rest is held for live intake)'
      WHEN (bt.n + live.reserved) >= 60  THEN 'burst budget exhausted (60 per 10 minutes)'
      ELSE 'within budget'
    END
  FROM hr, bt, live;
$$;

-- ---------------------------------------------------------------------------
-- 3. Sync health — what the console shows, and nothing more.
--
--    `recurring_active` is EVIDENCE, not configuration: a schedule row can say
--    enabled while n8n is down. It is true only when a scheduled run actually
--    succeeded inside its own expected interval, doubled to tolerate one
--    missed tick.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drsnip_sync_health()
RETURNS TABLE (
  schedule_key            text,
  scope_key               text,
  enabled                 boolean,
  cadence                 text,
  expected_interval_minutes integer,
  last_attempt_at         timestamptz,
  last_success_at         timestamptz,
  last_outcome            text,
  run_state               text,
  watermark               timestamptz,
  cursor_lag_seconds      integer,
  runs_failed_24h         integer,
  runs_partial_24h        integer,
  recurring_active        boolean
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'
AS $$
  SELECT
    sc.schedule_key,
    sc.scope_key,
    sc.enabled,
    sc.cadence,
    sc.expected_interval_minutes,
    (SELECT max(r.started_at)  FROM public.appointment_sync_runs r
      WHERE r.scope_key = sc.scope_key),
    (SELECT max(r.finished_at) FROM public.appointment_sync_runs r
      WHERE r.scope_key = sc.scope_key AND r.outcome = 'success'),
    (SELECT r.outcome FROM public.appointment_sync_runs r
      WHERE r.scope_key = sc.scope_key ORDER BY r.started_at DESC LIMIT 1),
    CASE
      -- A held, unexpired lease means a run is genuinely in progress.
      WHEN st.active_run_id IS NOT NULL AND st.lease_expires_at > now() THEN 'running'
      -- A lease that outlived its holder. Someone has to look; the next run
      -- will take the scope anyway once the lease expires.
      WHEN st.active_run_id IS NOT NULL THEN 'stalled'
      ELSE 'idle'
    END,
    st.watermark,
    CASE WHEN st.watermark IS NULL THEN NULL
         ELSE extract(epoch FROM (now() - st.watermark))::int END,
    (SELECT count(*)::int FROM public.appointment_sync_runs r
      WHERE r.scope_key = sc.scope_key AND r.outcome = 'failed'
        AND r.started_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM public.appointment_sync_runs r
      WHERE r.scope_key = sc.scope_key AND r.outcome IN ('partial', 'budget_exhausted')
        AND r.started_at > now() - interval '24 hours'),
    sc.enabled AND EXISTS (
      SELECT 1 FROM public.appointment_sync_runs r
       WHERE r.scope_key = sc.scope_key
         AND r.outcome = 'success'
         AND r.finished_at > now() - make_interval(mins => sc.expected_interval_minutes * 2)
    )
  FROM public.appointment_sync_schedules sc
  JOIN public.appointment_sync_state st ON st.scope_key = sc.scope_key
  ORDER BY sc.schedule_key;
$$;

-- ---------------------------------------------------------------------------
-- 4. Freshness, restated.
--
--    0014 hard-coded appointment_sync_active = false, correctly: no schedule
--    existed. Now that one can exist the flag has to be earned. It is true only
--    when the incremental schedule is enabled AND a run of it succeeded inside
--    twice its expected interval. If n8n stops, the badge stops claiming.
--
--    `awaiting_catchup` is the count of linked patient ids with no completed
--    history unit — patients who registered after the backfill. A COUNT only.
-- ---------------------------------------------------------------------------
-- The signature gains columns, and Postgres will not REPLACE a function whose
-- OUT parameters changed. Dropping and recreating inside this transaction is
-- atomic: a concurrent call blocks for the length of the transaction and then
-- sees the new definition. It never sees a missing function.
--
-- Consequence for replay: re-running 0014 after this file would restore the
-- five-column version and the console would lose its sync fields. Apply these
-- files in numeric order.
DROP FUNCTION IF EXISTS public.drsnip_journey_freshness();

CREATE OR REPLACE FUNCTION public.drsnip_journey_freshness()
RETURNS TABLE (
  intake_latest_at          timestamptz,
  appointments_synced_at    timestamptz,
  appointment_sync_active   boolean,
  history_complete_patients integer,
  linked_patients           integer,
  awaiting_catchup          integer,
  sync_last_success_at      timestamptz,
  sync_last_attempt_at      timestamptz,
  sync_run_state            text,
  sync_cursor_lag_seconds   integer,
  sync_expected_interval_minutes integer,
  sync_schedule_enabled     boolean,
  sync_failed_runs_24h      integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'
AS $$
  WITH inc AS (
    SELECT * FROM public.drsnip_sync_health() WHERE scope_key = 'practice_incremental'
  )
  SELECT
    (SELECT max(s.created_at) FROM public.submissions s),
    -- The instant appointment data is current to. Once incremental sync is
    -- running this is its watermark; before that it is the last completed
    -- backfill unit. coalesce, so a paused schedule never blanks the page.
    coalesce(
      (SELECT i.watermark FROM inc i),
      (SELECT max(w.completed_at) FROM public.appointment_sync_windows w WHERE w.state = 'complete')
    ),
    coalesce((SELECT i.recurring_active FROM inc i), false),
    (SELECT count(*)::int FROM public.appointment_sync_windows w
      WHERE w.strategy = 'patient_history' AND w.state = 'complete'),
    (SELECT count(DISTINCT s.n8n_patient_id)::int FROM public.submissions s
      WHERE s.n8n_patient_id IS NOT NULL),
    (SELECT count(*)::int FROM (
        SELECT DISTINCT s.n8n_patient_id::text AS pid FROM public.submissions s
         WHERE s.n8n_patient_id IS NOT NULL
      ) l
      WHERE NOT EXISTS (
        SELECT 1 FROM public.appointment_sync_windows w
         WHERE w.strategy = 'patient_history' AND w.state = 'complete'
           AND w.patient_source_id = l.pid)),
    (SELECT i.last_success_at FROM inc i),
    (SELECT i.last_attempt_at FROM inc i),
    coalesce((SELECT i.run_state FROM inc i), 'not_scheduled'),
    (SELECT i.cursor_lag_seconds FROM inc i),
    (SELECT i.expected_interval_minutes FROM inc i),
    coalesce((SELECT i.enabled FROM inc i), false),
    coalesce((SELECT i.runs_failed_24h FROM inc i), 0);
$$;

-- ---------------------------------------------------------------------------
-- 5. Privileges. Same boundary as 0014: the functions are owned by the
--    restricted role, PUBLIC cannot execute them, and only the app and the
--    reporting role are granted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON TABLE public.appointment_sync_schedules TO drsnip_metrics_fn;
GRANT SELECT ON TABLE public.appointment_sync_runs      TO drsnip_metrics_fn;

ALTER FUNCTION public.drsnip_sync_health()          OWNER TO drsnip_metrics_fn;
ALTER FUNCTION public.drsnip_journey_freshness()    OWNER TO drsnip_metrics_fn;

REVOKE ALL ON FUNCTION public.drsnip_sync_health()       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drsnip_journey_freshness() FROM PUBLIC;
-- drsnip_sync_budget is NOT security definer and NOT for the console: the sync
-- workflow calls it with its own writer role, which already reads these tables.
REVOKE ALL ON FUNCTION public.drsnip_sync_budget()       FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['drsnip_reporting_ro', 'drsnip_intake_demo'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.drsnip_sync_health() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.drsnip_journey_freshness() TO %I', r);
    END IF;
  END LOOP;

  -- The sync writer needs the schedule row (the stop switch) and the budget.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_sync_rw') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.appointment_sync_schedules TO drsnip_sync_rw';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.drsnip_sync_budget() TO drsnip_sync_rw';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Assert the boundary held.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF has_function_privilege('public', 'public.drsnip_sync_health()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute drsnip_sync_health';
  END IF;
  IF has_function_privilege('public', 'public.drsnip_journey_freshness()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute drsnip_journey_freshness';
  END IF;
  IF has_table_privilege('drsnip_metrics_fn', 'public.users', 'SELECT')
     OR has_table_privilege('drsnip_metrics_fn', 'public.submission_files', 'SELECT') THEN
    RAISE EXCEPTION 'drsnip_metrics_fn reads more than it needs';
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'drsnip_metrics_fn') THEN
    RAISE EXCEPTION 'the function owner must not be a superuser';
  END IF;
  RAISE NOTICE 'sync schedule registry, budget and health installed';
END $$;

COMMIT;
