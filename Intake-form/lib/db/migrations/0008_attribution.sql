-- 0008_attribution.sql — marketing attribution capture (Phase 2).
--
-- Re-adds a PROJECTED, INDEXED attribution column set to `submissions`. These
-- were dropped in 0003 (CJC-era channel columns); this is the DrSnip shape,
-- populated ONLY for NEW submissions arriving via a tagged URL. All columns are
-- nullable with NO default and NO backfill: historical rows and direct/untagged
-- traffic keep NULLs. Attribution is passive metadata — it never blocks intake.
--
-- The same values also continue into raw_payload (like every other form answer);
-- these columns are the queryable/indexed projection for the dashboard.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) — safe to
-- re-run. `patient_id` is NOT here and is never stored as attribution.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS source          text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS utm_source      text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS utm_medium      text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS utm_campaign    text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS utm_term        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS utm_content     text;
-- Primary click identifier + its platform. gclid (Google) takes precedence over
-- fbclid (Meta) when both are present; both raw values also live in raw_payload.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS click_id        text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS click_id_type   text;   -- 'gclid' | 'fbclid'
-- NULL when no source was supplied; true = source matched an active
-- marketing_sources catalog key; false = source present but unrecognized
-- (stored anyway, never rejected).
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS source_validated boolean;

CREATE INDEX IF NOT EXISTS submissions_source_idx ON submissions (source);
