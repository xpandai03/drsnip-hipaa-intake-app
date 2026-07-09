-- =====================================================================
-- DrSnip Reporting MCP — PHI-free VIEW + read-only role (SECURITY BOUNDARY)
-- =====================================================================
--
-- WHAT THIS IS
--   The reporting MCP must be *physically incapable* of returning PHI. This
--   migration creates that guarantee at the DATABASE layer, not in app code:
--
--     1. A VIEW (drsnip_reporting_view) over `submissions` that selects ONLY
--        PHI-free / non-identifying columns + a few whitelisted categoricals
--        extracted from raw_payload. No names, DOB, email, phone, address,
--        medical answers, insurance IDs, DrChrono patient id, or raw_payload
--        in full ever appear in the view.
--
--     2. A LOGIN role (drsnip_reporting_ro) granted SELECT on the VIEW ONLY.
--        It has NO privilege on `submissions` or any other table (users,
--        sessions — which hold password hashes — appointments, etc.). Because
--        a standard Postgres view reads its base table with the VIEW OWNER's
--        rights, this role can read the view WITHOUT any grant on submissions,
--        and it has no way to reach submissions directly. `SELECT * FROM
--        submissions` as this role fails with "permission denied".
--
--   The MCP connects using ONLY drsnip_reporting_ro's connection string
--   (env DRSNIP_INTAKE_DATABASE_URL). Even a bug, a crafted query, or a future
--   tool cannot emit PHI, because the role cannot read any PHI column.
--
-- ENVIRONMENT: Fly.io Postgres (app `drsnip-intake-db`, org it-snip, region LAX),
--   database `drsnip_intake_demo`, Postgres 17. NOT publicly reachable — it is on
--   Fly's private network (Flycast/6PN). Standard Postgres SQL below; no
--   provider-specific extensions used.
--
-- HOW TO RUN (as the `postgres` superuser on the Fly PG machine)
--   1. Replace <<STRONG_PASSWORD>> with a strong secret. (<<APP_DB>> is already
--      set to drsnip_intake_demo below.)
--   2. Apply against the app DB, e.g.:
--        echo '<this file>' | base64 | ... | \
--        PGPASSWORD=$OPERATOR_PASSWORD psql -U postgres -h localhost \
--          -d drsnip_intake_demo -v ON_ERROR_STOP=1
--      (via `fly ssh console -a drsnip-intake-db`), or `fly postgres connect
--       -a drsnip-intake-db -d drsnip_intake_demo` then \i.
--   3. Run the verification block at the bottom; then use the drsnip_reporting_ro
--      Flycast connection string as DRSNIP_INTAKE_DATABASE_URL for the MCP.
--
-- REACHABILITY: because Fly PG is private, the MCP must be deployed ON Fly (same
-- 6PN as drsnip-intake-db) and connect via the .flycast/.internal address — a
-- Vercel deploy could NOT reach this DB without a public proxy.
--
-- IDEMPOTENCY: safe to re-run (uses OR REPLACE / IF NOT EXISTS patterns).
-- This migration is READ-boundary only — it does not alter `submissions`.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) PHI-FREE REPORTING VIEW
-- ---------------------------------------------------------------------
-- EXCLUDED ON PURPOSE (never selected): first_name, last_name, email, phone,
-- date_of_birth, state_residence, insurance_card_front/back_filename,
-- mh_mental_illness, n8n_patient_id, and raw_payload as a whole. Only the
-- explicitly named non-identifying categoricals below are extracted.

-- STANDARD view (security_invoker = false): the view reads `submissions` with
-- the VIEW OWNER's rights, so drsnip_reporting_ro needs SELECT on the view only
-- and gets NO ability to read the base table. Set explicitly to be unambiguous
-- and future-proof against a default change (requires PG15+, which this DB is).
-- Verification check C is the real proof; this option documents the intent.
CREATE OR REPLACE VIEW drsnip_reporting_view
    WITH (security_invoker = false) AS
SELECT
    s.id,                                        -- opaque submission uuid (not a patient identifier)
    s.created_at::date      AS created_at,       -- DATE ONLY — sub-day precision dropped (tools bucket by day/week/month); removes a minor re-identification vector
    s.updated_at::date      AS updated_at,       -- DATE ONLY
    s.form_type,                                 -- 'registration' | 'consultation'
    s.n8n_status,                                -- 'success' | 'manual_review' | 'failed' | NULL(pending)
    s.n8n_response_at::date AS n8n_response_at,   -- DATE ONLY
    s.has_insurance_cards,                        -- boolean flag only

    -- Non-identifying categoricals extracted from raw_payload (whitelist only).
    -- Registration-only fields are NULL on consultation rows and vice-versa.
    (s.raw_payload ->> 'officeLocation')     AS office_location,     -- Seattle,WA | Portland,OR | Plano,TX
    (s.raw_payload ->> 'insuranceCoverage')  AS insurance_coverage,  -- Own | Partner's | Both | No Insurance
    -- how_heard is a small categorical ARRAY (consultation only). Exposed as
    -- jsonb so the MCP can UNNEST + count; it contains only channel labels
    -- (Google, Facebook, Referral, ...) — no free text beyond the picklist.
    -- NOTE: howHeardOther free-text is intentionally NOT exposed.
    (s.raw_payload -> 'howHeard')            AS how_heard,

    -- Derived NEW-vs-RETURNING action LABEL only (never the patient id).
    -- VERIFIED against live data (40-record sample, both forms, all outcomes):
    --   * registration success response DOES carry drchrono_action
    --     ('created'|'updated'). The app doesn't compute it, but the n8n
    --     Respond node writes it and the app stores response verbatim, so it is
    --     present at n8n_response_body->'response'->>'drchrono_action'.
    --   * consultation success has NO drchrono_action (only patient_id) and
    --     always matches an existing chart -> label 'matched' (returning).
    --   * manual_review / failed / pending are handled by n8n_status first.
    -- Mapping: new = 'create'; returning = 'update' (reg) or 'matched' (cons).
    CASE
        WHEN s.n8n_status = 'manual_review' THEN 'manual_review'
        WHEN s.n8n_status = 'failed'        THEN 'failed'
        WHEN s.n8n_status IS NULL           THEN 'pending'
        WHEN s.form_type = 'consultation'   THEN 'matched'          -- returning (consultations attach to an existing chart)
        WHEN lower(s.n8n_response_body -> 'response' ->> 'drchrono_action') IN ('created','create') THEN 'create'  -- new patient
        WHEN lower(s.n8n_response_body -> 'response' ->> 'drchrono_action') IN ('updated','update') THEN 'update'  -- returning patient
        ELSE 'unknown'
    END AS action_label,

    -- Bridge latency for ops reporting (no PHI).
    -- App-observed latency (row commit -> n8n response recorded):
    EXTRACT(EPOCH FROM (s.n8n_response_at - s.created_at))::double precision AS observed_latency_seconds,
    -- n8n-reported elapsed (from the non-PHI diagnostic block):
    NULLIF(s.n8n_response_body -> 'diagnostic' ->> 'elapsedMs', '')::bigint   AS bridge_elapsed_ms,

    -- Failure-mode dimensions (from the deliberately-non-PHI diagnostic block).
    (s.n8n_response_body -> 'diagnostic' ->> 'kind')       AS diag_kind,        -- 'http' | 'fetch' | 'config'
    (s.n8n_response_body -> 'diagnostic' ->> 'httpStatus') AS diag_http_status  -- e.g. '500', '400'
FROM submissions s;

COMMENT ON VIEW drsnip_reporting_view IS
    'PHI-free reporting projection of submissions for the DrSnip reporting MCP. '
    'Contains NO patient identifiers or medical answers — only counts-friendly '
    'operational metadata + whitelisted non-identifying categoricals. The read-only '
    'role drsnip_reporting_ro is granted SELECT on THIS VIEW ONLY (no base-table access).';

-- ---------------------------------------------------------------------
-- 2) READ-ONLY ROLE — SELECT on the VIEW only
-- ---------------------------------------------------------------------
-- Create the login role if it doesn't already exist.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drsnip_reporting_ro') THEN
        CREATE ROLE drsnip_reporting_ro LOGIN PASSWORD '<<STRONG_PASSWORD>>';
    END IF;
END
$$;

-- Defensive: ensure this role has NO ambient privileges from PUBLIC grants or
-- prior state. It should be able to do exactly one thing: SELECT the view.
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public FROM drsnip_reporting_ro;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM drsnip_reporting_ro;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM drsnip_reporting_ro;
REVOKE CREATE ON SCHEMA public FROM drsnip_reporting_ro;

-- Minimum needed to connect + resolve the view:
GRANT CONNECT ON DATABASE "drsnip_intake_demo" TO drsnip_reporting_ro;
GRANT USAGE   ON SCHEMA public         TO drsnip_reporting_ro;

-- The ONLY data grant. No GRANT on `submissions` (or anything else) anywhere.
GRANT SELECT ON drsnip_reporting_view TO drsnip_reporting_ro;

-- Belt-and-suspenders: explicitly make sure base-table access is NOT present.
REVOKE ALL PRIVILEGES ON TABLE submissions FROM drsnip_reporting_ro;

COMMIT;

-- =====================================================================
-- VERIFICATION (run these after; hand off the role only if all pass)
-- =====================================================================
-- A) The view exists and is PHI-free (should list ONLY the whitelisted columns):
--      SELECT column_name FROM information_schema.columns
--      WHERE table_name = 'drsnip_reporting_view' ORDER BY ordinal_position;
--    Expect: id, created_at, updated_at, form_type, n8n_status, n8n_response_at,
--            has_insurance_cards, office_location, insurance_coverage, how_heard,
--            action_label, observed_latency_seconds, bridge_elapsed_ms,
--            diag_kind, diag_http_status   (and NOTHING else)
--
-- B) The role can read the view:
--      SET ROLE drsnip_reporting_ro;  SELECT count(*) FROM drsnip_reporting_view;  RESET ROLE;
--
-- C) The role CANNOT read PHI (each of these MUST fail with "permission denied"):
--      SET ROLE drsnip_reporting_ro;
--        SELECT first_name FROM submissions LIMIT 1;        -- expect: permission denied
--        SELECT raw_payload FROM submissions LIMIT 1;       -- expect: permission denied
--        SELECT * FROM users LIMIT 1;                       -- expect: permission denied
--      RESET ROLE;
--
-- D) Connection string for the MCP (DRSNIP_INTAKE_DATABASE_URL). Fly private
--    network — use the Flycast address (works from any app in the it-snip org):
--      postgres://drsnip_reporting_ro:<<STRONG_PASSWORD>>@drsnip-intake-db.flycast:5432/drsnip_intake_demo
--    (From ON the DB machine / same 6PN, the .internal host also works. Not
--     reachable from the public internet — deploy the MCP on Fly.)
-- =====================================================================
