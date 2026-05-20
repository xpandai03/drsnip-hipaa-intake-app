-- Phase 2 (DrSnip) — restructure `submissions` to DrSnip's data model.
--
-- Adds a form_type discriminator (registration vs consultation), patient
-- identity + insurance-card-stub columns, and an updated_at timestamp.
-- Drops the CJC-era survey (q_*) and channel-attribution columns — DrSnip's
-- form answers live in raw_payload (jsonb).
--
-- drizzle-kit push is broken in this repo (INVESTIGATION.md RISK-3); apply
-- this migration manually:  psql "$DATABASE_URL" -f 0003_drsnip_schema.sql

BEGIN;

-- ---- New columns ----------------------------------------------------------

-- Discriminates Registration vs Consultation submissions. App layer enforces
-- the allowed value set ('registration' | 'consultation').
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS form_type text NOT NULL DEFAULT 'registration';

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS date_of_birth text;

-- Insurance-card upload is STUBBED in Phase 2 — only the filename + a flag are
-- stored. No file bytes are persisted. Real object storage (with a BAA) is a
-- later-phase decision.
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS insurance_card_front_filename text;
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS insurance_card_back_filename text;
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS has_insurance_cards boolean NOT NULL DEFAULT false;

-- Admin filters by form_type.
CREATE INDEX IF NOT EXISTS submissions_form_type_idx ON submissions (form_type);

-- ---- Relax columns DrSnip's forms may not populate ------------------------

-- DrSnip's Registration form collects a street address, not always a state.
ALTER TABLE submissions ALTER COLUMN state_residence DROP NOT NULL;

-- ---- Drop CJC-era columns -------------------------------------------------

-- Channel attribution (CJC marketing / Salesforce). Any ?source= / UTM data
-- the form still reads from the URL is preserved inside raw_payload.
ALTER TABLE submissions DROP COLUMN IF EXISTS source;
ALTER TABLE submissions DROP COLUMN IF EXISTS survey_detail;
ALTER TABLE submissions DROP COLUMN IF EXISTS lead_source;
ALTER TABLE submissions DROP COLUMN IF EXISTS campaign;
ALTER TABLE submissions DROP COLUMN IF EXISTS event;
ALTER TABLE submissions DROP COLUMN IF EXISTS utm_source;
ALTER TABLE submissions DROP COLUMN IF EXISTS utm_medium;
ALTER TABLE submissions DROP COLUMN IF EXISTS utm_campaign;

-- CJC federal-agency picklist value.
ALTER TABLE submissions DROP COLUMN IF EXISTS federal_agency;

-- CJC SOFA survey answers (q_*). DrSnip answers live in raw_payload.
ALTER TABLE submissions DROP COLUMN IF EXISTS q_speaker_rating;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_workshop_content;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_pre_retirement;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_eval_comments;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_years_to_retire;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_age;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_separating;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_marital_status;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_maxing_tsp;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_tsp_contribution_pct;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_external_investments;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_tsp_balance;
ALTER TABLE submissions DROP COLUMN IF EXISTS q_areas_of_concern;

-- The submissions_source_idx index is dropped automatically with its column.

COMMIT;
