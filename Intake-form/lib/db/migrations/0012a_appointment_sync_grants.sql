-- 0012a_appointment_sync_grants.sql — the sync writer role and its privileges.
--
-- NOT REGISTERED in api-server/migrate.ts, on purpose.
--
--   migrate.ts keeps no ledger: it replays every registered step on every Fly
--   deploy, so a registered step must be safe to run forever. CREATE ROLE
--   requires CREATEROLE or superuser.
--
--   The app's role (drsnip_intake_demo) does hold superuser today, so this
--   would have run inside the migration. It is kept out anyway: a deploy-path
--   migration should not quietly depend on the app being a superuser, or
--   de-escalating that role later would start failing every deploy.
--
-- Run AFTER 0012_appointment_sync.sql has created the tables:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 0012a_appointment_sync_grants.sql
--
-- Then set the password out-of-band (never in this file, never in git, never
-- in workflow JSON):
--
--   ALTER ROLE drsnip_sync_rw PASSWORD '<generated>';
--
-- and store it only in the n8n Postgres credential.
--
-- PRIVACY: the writer is not a reporting role and not an admin role. It can
-- write the five sync tables and read exactly ONE column of intake — the set
-- of DrChrono patient ids that are linked — through a view. It has no
-- privilege on submissions, users, sessions, submission_files or
-- registration_partials, which is asserted explicitly at the bottom.

-- ---------------------------------------------------------------------------
-- 1. The role. No password here.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_sync_rw') THEN
    EXECUTE 'CREATE ROLE drsnip_sync_rw LOGIN';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The ONLY thing the writer may learn about intake: which DrChrono patient
--    ids are linked to a submission. No name, email, phone, DOB, form content
--    or submission id. security_invoker stays OFF so the view runs as its
--    owner and the writer never needs a privilege on `submissions` itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW drsnip_linked_patient_ids
  WITH (security_invoker = false) AS
SELECT DISTINCT n8n_patient_id::text AS patient_source_id
FROM submissions
WHERE n8n_patient_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Grants. Start from nothing, then add back the minimum.
--    The database name is read from current_database() rather than hard-coded,
--    so this file cannot silently grant against the wrong database.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  db text := quote_ident(current_database());
  t  text;
BEGIN
  EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM drsnip_sync_rw';

  -- Revoking CREATE from the ROLE is not enough, and on this database it was a
  -- no-op: the privilege is held by PUBLIC, so every non-superuser role has it.
  -- PostgreSQL 15 made "no CREATE for PUBLIC on schema public" the default;
  -- this database predates that and never had it applied, which is why a
  -- freshly initdb'd test cluster does NOT reproduce the problem.
  --
  -- So revoke it at the source, and hand the application role the privilege
  -- back EXPLICITLY. Today drsnip_intake_demo is a superuser and would not
  -- notice either way, but its migrations must not silently depend on that.
  -- Net effect: strictly fewer privileges for everyone except the app, which
  -- keeps exactly what it needs by name instead of by accident.
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM drsnip_sync_rw';
  -- Guarded: the application role is named per environment, and a disposable
  -- test database will not have it. Failing here would make this file
  -- unrunnable exactly where it most needs to be verified first.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo') THEN
    EXECUTE 'GRANT CREATE ON SCHEMA public TO drsnip_intake_demo';
  ELSE
    RAISE NOTICE 'role drsnip_intake_demo absent; skipping its CREATE grant';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %s TO drsnip_sync_rw', db);
  EXECUTE 'GRANT USAGE ON SCHEMA public TO drsnip_sync_rw';

  -- THE LIST IS DEFINED ONCE, HERE, AND ASSERTED AGAINST BELOW.
  --
  -- This block starts with REVOKE ALL, so any sync table missing from this list
  -- silently ends up unwritable. That already happened once: migration 0013
  -- added appointment_sync_windows and granted it, and a later re-run of this
  -- file revoked that grant again, so the backfill failed at its first write.
  -- The assertion at the bottom now makes that failure impossible to ship.
  --
  -- appointment_sync_events is deliberately ABSENT: it is the unrelated legacy
  -- TimeTap/Salesforce table from migration 0001, not part of this sync.
  --
  -- No DELETE anywhere except the scratch queue: ingestion preserves evidence.
  FOREACH t IN ARRAY ARRAY[
    'appointment_snapshots',
    'appointment_status_transitions',
    'appointment_sync_runs',
    'appointment_sync_state',
    'appointment_sync_windows'
  ]
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO drsnip_sync_rw', t);
  END LOOP;

  -- The queue is scratch, so DELETE is allowed there and only there.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE appointment_sync_patient_queue TO drsnip_sync_rw';

  EXECUTE 'GRANT SELECT ON drsnip_linked_patient_ids TO drsnip_sync_rw';

  -- Explicitly denied: the intake tables themselves.
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE submissions           FROM drsnip_sync_rw';
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE users                 FROM drsnip_sync_rw';
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE sessions              FROM drsnip_sync_rw';
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE submission_files      FROM drsnip_sync_rw';
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE registration_partials FROM drsnip_sync_rw';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Assert the boundary held. Raises rather than reporting a false success.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['submissions','users','sessions','submission_files','registration_partials']
  LOOP
    IF has_table_privilege('drsnip_sync_rw', t, 'SELECT')
       OR has_table_privilege('drsnip_sync_rw', t, 'INSERT')
       OR has_table_privilege('drsnip_sync_rw', t, 'UPDATE')
       OR has_table_privilege('drsnip_sync_rw', t, 'DELETE') THEN
      RAISE EXCEPTION 'drsnip_sync_rw still holds a privilege on %', t;
    END IF;
  END LOOP;

  -- Every table the sync writes must actually be writable. This is the check
  -- that would have caught the appointment_sync_windows grant being revoked.
  FOREACH t IN ARRAY ARRAY[
    'appointment_snapshots',
    'appointment_status_transitions',
    'appointment_sync_runs',
    'appointment_sync_state',
    'appointment_sync_windows',
    'appointment_sync_patient_queue'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'sync table % does not exist; run the table migrations first', t;
    END IF;
    IF NOT has_table_privilege('drsnip_sync_rw', t, 'INSERT') THEN
      RAISE EXCEPTION 'drsnip_sync_rw cannot write %', t;
    END IF;
  END LOOP;
  IF has_table_privilege('drsnip_sync_rw', 'appointment_snapshots', 'DELETE') THEN
    RAISE EXCEPTION 'drsnip_sync_rw must not be able to delete appointment evidence';
  END IF;

  -- This check was added after the first production run of this file, where
  -- the writer turned out to be able to CREATE TABLE in public. The earlier
  -- version asserted only table privileges and missed it.
  IF has_schema_privilege('drsnip_sync_rw', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'drsnip_sync_rw can still create objects in schema public';
  END IF;
  IF NOT has_schema_privilege('drsnip_sync_rw', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'drsnip_sync_rw cannot use schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_intake_demo')
     AND NOT has_schema_privilege('drsnip_intake_demo', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the application role lost CREATE on schema public';
  END IF;

  RAISE NOTICE 'drsnip_sync_rw privilege boundary verified';
END $$;
