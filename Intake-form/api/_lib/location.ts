// Location filtering + the consultation location join.
//
// The consultation form deliberately does not ask for a clinic location, so a
// consultation's location is DERIVED at query time from the same patient's
// registration. This is display/export-only — it is NEVER written to the
// consultation row, raw_payload, or any schema.
//
// Derivation rules (see resolvedLocationSql):
//   • registration / insurance → their own raw_payload.officeLocation.
//   • consultation → the officeLocation of the MOST RECENT registration for the
//     same patient, matched by:
//       - n8n_patient_id when the consultation has one (primary), else
//       - normalized (lower+trim) email (single conservative fallback).
//     A patient id that resolves no registration stays blank — we do NOT fall
//     back to email in that case (trust the patient id). Blank is truthful.

import { sql, submissions } from "@workspace/db";

// The clinic values, matching the registration form's officeLocation literals
// (Home.tsx OFFICE_LOCATIONS) character-for-character. Guarded against drift by
// api/_test/location.test.ts. Filtering on a variant spelling would fork data.
export const OFFICE_LOCATIONS = ["Seattle, WA", "Portland, OR", "Plano, TX"];

export function isAllowedLocation(value: unknown): value is string {
  return typeof value === "string" && OFFICE_LOCATIONS.includes(value);
}

/**
 * SQL expression for a submission's resolved clinic location. Used in the list
 * SELECT + WHERE (filter), the detail SELECT, and the export SELECT — one source
 * of truth. The correlated subquery only runs for consultation rows (the CASE
 * gates it), so registration/insurance filtering stays a cheap jsonb read.
 */
export function resolvedLocationSql() {
  return sql<string | null>`
    CASE
      WHEN ${submissions.formType} IN ('registration','insurance')
        THEN NULLIF(TRIM(${submissions.rawPayload} ->> 'officeLocation'), '')
      WHEN ${submissions.formType} = 'consultation' THEN (
        SELECT NULLIF(TRIM(r.raw_payload ->> 'officeLocation'), '')
        FROM ${submissions} r
        WHERE r.form_type = 'registration'
          AND NULLIF(TRIM(r.raw_payload ->> 'officeLocation'), '') IS NOT NULL
          AND (
            CASE
              WHEN ${submissions.n8nPatientId} IS NOT NULL
                THEN r.n8n_patient_id = ${submissions.n8nPatientId}
              ELSE LOWER(TRIM(r.email)) = LOWER(TRIM(${submissions.email}))
            END
          )
        ORDER BY r.created_at DESC
        LIMIT 1
      )
      ELSE NULL
    END
  `;
}
