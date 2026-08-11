-- 0009_registration_partials.sql — drop-off capture for the REGISTRATION form
-- (Train 2). A partial is created only once a visitor has entered contact info
-- and advanced past the contact step; it records who started and how far they
-- got, so a human can decide whether to reach out. No outreach is automated.
--
-- PRIVACY (locked): the column set below is the EXHAUSTIVE whitelist. There is
-- deliberately NO raw_payload and NO medical/insurance/step-answer column — a
-- partial carrying a medical answer is impossible by construction, because the
-- table has nowhere to put one. Retention: rows are hard-deleted at 30 days
-- (lazy purge); conversion (a completed registration) hard-deletes the twin.
--
-- Idempotent (IF NOT EXISTS) — safe to re-run.

CREATE TABLE IF NOT EXISTS registration_partials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-generated per-session id (sessionStorage). Upsert key + the primary
  -- match for conversion-delete. Unique so a session owns exactly one partial.
  partial_id          text NOT NULL UNIQUE,

  -- Contact (present by the time the beacon first fires) --------------------
  first_name          text,
  last_name           text,
  email               text,
  phone               text,
  office_location     text,

  -- Progress marker (number + label only; never step ANSWERS) ---------------
  furthest_step       integer,
  furthest_step_label text,

  -- Attribution the form already captures ------------------------------------
  source              text,
  utm_source          text,
  utm_medium          text,
  utm_campaign        text,
  utm_term            text,
  utm_content         text,
  click_id            text,
  click_id_type       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_partials_email_idx
  ON registration_partials (lower(email));
CREATE INDEX IF NOT EXISTS registration_partials_updated_at_idx
  ON registration_partials (updated_at);
