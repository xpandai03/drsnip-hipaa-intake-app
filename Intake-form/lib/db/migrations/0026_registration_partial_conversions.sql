-- 0026_registration_partial_conversions.sql — the comeback window (J5,
-- 2026-10-27 call: "the time frame for 80% of the folks that do come back").
--
-- A completed registration hard-deletes its drop-off partial (submit.ts,
-- clearRegistrationPartial), and nothing used to record when that partial was
-- first seen, so the delay between dropping off and coming back could never
-- be measured. Since this migration, the delete RETURNs the partial's two
-- timestamps and one row lands here.
--
-- PRIVACY (locked): timestamps and a match type only. No name, email, phone,
-- partial id, submission id or any other identifier has a column here, so
-- this table can never be joined back to a person. Not PHI; no retention cap.
--
-- match_type: 'session' = same browser session (partial id matched; usually a
-- straight-through completion, NOT a comeback); 'email' = a different session
-- matched on email (a comeback). Only 'email' rows feed the comeback window.
--
-- Registered in migrate.ts (applied by the release command). Idempotent.

CREATE TABLE IF NOT EXISTS registration_partial_conversions (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partial_created_at     timestamptz NOT NULL,
  partial_updated_at     timestamptz,
  submission_created_at  timestamptz NOT NULL DEFAULT now(),
  match_type             text NOT NULL CHECK (match_type IN ('session', 'email'))
);

CREATE INDEX IF NOT EXISTS registration_partial_conversions_match_idx
  ON registration_partial_conversions (match_type, submission_created_at);
