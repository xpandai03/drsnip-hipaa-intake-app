-- =====================================================================
-- DrSnip Reporting — 002: action_label branches for insurance (Train C)
-- =====================================================================
--
-- WHAT THIS DOES
--   Replaces drsnip_reporting_view's definition so the derived `action_label`
--   understands insurance rows. Two new branches:
--
--     * n8n_status = 'not_applicable'  ->  'not_applicable'
--         Insurance submissions from before the insurance bridge existed. They
--         previously fell through to 'unknown', mixing a deliberate skip in
--         with genuinely unclassifiable rows.
--
--     * form_type = 'insurance'        ->  'inquiry_create' | 'inquiry_update'
--                                          | 'inquiry_unknown'
--         An insurance INQUIRY is not a patient registration. Separate labels
--         keep inquirer charts out of the new-vs-returning PATIENT counts
--         ('create'/'update'), which would otherwise be silently inflated as
--         insurance starts writing n8n_status='success' rows.
--
-- WHY A SEPARATE FILE
--   001 also creates the drsnip_reporting_ro ROLE and contains a
--   <<STRONG_PASSWORD>> placeholder, so it cannot be re-run unedited. This file
--   is view-only: no role, no password, no GRANT changes, no base-table changes.
--   The view's column list, order, and types are UNCHANGED, so CREATE OR REPLACE
--   succeeds without a DROP and the read-only role keeps its existing grant.
--
-- 001 has been updated to match, so a fresh install produces the same view.
--
-- SAFETY
--   * Read-boundary only — `submissions` is not touched.
--   * PHI posture unchanged: the same whitelisted columns, nothing added.
--   * Idempotent: safe to re-run.
--   * No app deploy depends on this; the app replicates the same CASE in
--     api/_lib/reporting.ts (keep the two in step).
--
-- HOW TO RUN (as the view's owner / the postgres superuser)
--   fly postgres connect -a drsnip-intake-db -d drsnip_intake_demo
--   then paste this file, or:
--   psql -U postgres -d drsnip_intake_demo -v ON_ERROR_STOP=1 -f 002_action_label_insurance.sql
--
-- VERIFY AFTER RUNNING
--   -- column list must be unchanged (15 columns, same order):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'drsnip_reporting_view' ORDER BY ordinal_position;
--
--   -- label distribution; insurance rows must NOT appear as create/update:
--   SELECT form_type, action_label, count(*)
--     FROM drsnip_reporting_view GROUP BY 1,2 ORDER BY 1,2;
--
--   -- pre-Train-C insurance rows should now read 'not_applicable', not 'unknown':
--   SELECT action_label, count(*) FROM drsnip_reporting_view
--    WHERE form_type = 'insurance' GROUP BY 1;
-- =====================================================================

BEGIN;

CREATE OR REPLACE VIEW drsnip_reporting_view
    WITH (security_invoker = false) AS
SELECT
    s.id,                                        -- opaque submission uuid (not a patient identifier)
    s.created_at::date      AS created_at,       -- DATE ONLY — sub-day precision dropped (tools bucket by day/week/month); removes a minor re-identification vector
    s.updated_at::date      AS updated_at,       -- DATE ONLY
    s.form_type,                                 -- 'registration' | 'consultation' | 'insurance'
    s.n8n_status,                                -- 'success' | 'manual_review' | 'failed' | 'not_applicable' | NULL(pending)
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
    -- Train C (2026-08) added two branches:
    --   * 'not_applicable' — insurance rows from before the insurance bridge
    --     existed. Previously these fell all the way through to 'unknown',
    --     mixing a deliberate skip in with genuine unclassifiable rows.
    --   * form_type='insurance' — an insurance INQUIRY is not a patient
    --     registration. Its own labels keep inquirer charts out of the
    --     new-vs-returning PATIENT counts, and stop insurance successes
    --     landing in 'unknown'. This branch MUST sit above the generic
    --     drchrono_action branches, which would otherwise claim these rows.
    CASE
        WHEN s.n8n_status = 'manual_review'  THEN 'manual_review'
        WHEN s.n8n_status = 'failed'         THEN 'failed'
        WHEN s.n8n_status = 'not_applicable' THEN 'not_applicable'   -- bridge deliberately skipped
        WHEN s.n8n_status IS NULL            THEN 'pending'
        WHEN s.form_type = 'insurance' THEN
            CASE
                WHEN lower(s.n8n_response_body -> 'response' ->> 'drchrono_action') IN ('created','create') THEN 'inquiry_create'   -- inquiry created a chart
                WHEN lower(s.n8n_response_body -> 'response' ->> 'drchrono_action') IN ('updated','update') THEN 'inquiry_update'   -- inquiry attached to an existing chart
                ELSE 'inquiry_unknown'
            END
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

COMMIT;
