-- Admin-editable marketing source catalog for the Custom Link tool.
-- Replaces the hardcoded {fnn, internal, federal} trio in
-- artifacts/intake-form/src/pages/LinkGenerator.tsx so marketing can
-- self-serve new channels without a deploy.
--
-- drizzle-kit push is broken in this repo; this migration is intended to
-- be run manually with psql against $DATABASE_URL.

BEGIN;

CREATE TABLE IF NOT EXISTS marketing_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key text NOT NULL UNIQUE,
    display_name text NOT NULL,
    lead_source text NOT NULL,
    default_medium text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_sources_is_active_idx
    ON marketing_sources (is_active);

CREATE INDEX IF NOT EXISTS marketing_sources_display_name_idx
    ON marketing_sources (display_name);

-- Seed: 3 legacy webinar sources (preserve existing Salesforce attribution)
-- + 7 marketing channels. ON CONFLICT (source_key) DO NOTHING makes this
-- migration idempotent — safe to re-run.
INSERT INTO marketing_sources (source_key, display_name, lead_source, default_medium) VALUES
    ('fnn', 'FNN: Webinar', 'FNN: Webinar', NULL),
    ('internal', 'Internal: Webinar', 'Internal: Webinar', NULL),
    ('federal', 'Federal: SOFA Webinar', 'SOFA: Webinar', NULL),
    ('facebook', 'Facebook', 'Facebook Ads', 'cpc'),
    ('instagram', 'Instagram', 'Instagram Ads', 'cpc'),
    ('youtube', 'YouTube', 'YouTube', 'cpc'),
    ('linkedin', 'LinkedIn', 'LinkedIn Ads', 'cpc'),
    ('google', 'Google', 'Google Ads', 'cpc'),
    ('email', 'Email', 'Email Campaign', 'email'),
    ('organic-social', 'Organic Social', 'Organic Social', 'social')
ON CONFLICT (source_key) DO NOTHING;

COMMIT;
