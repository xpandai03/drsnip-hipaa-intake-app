// Unclassified-appointment export (2026-10-19).
//
// The clinic needs the appointments whose status is blank, or any other status
// outside its converted / not-converted lists, so its staff can decide what
// they mean. Admin-only, IDs only: an appointment id, a chart id, a date, the
// status label, the patient's cohort form and month, whether the chart has any
// OTHER converted appointment, and a DrChrono link. No name, DOB, phone, email,
// notes or appointment reason exists anywhere in this module, and a test pins
// the column list.
//
// Classification is the same rule set Monthly outcomes uses
// (drsnip_conversion_rules / drsnip_conversion_status_class, migration 0023),
// classified once per distinct label, so the export can never disagree with the
// numbers on the page. Deleted appointments are not on the chart and are not
// listed.
//
// Two clock notes: `scheduled_time` is stored as DrChrono's Pacific wall-clock
// time labelled UTC, so its UTC wall-clock IS the clinic date; and a patient
// with both forms is listed under registration (their registration cohort),
// with the month of their first registration.

export const UNCLASSIFIED_COLUMNS = [
  "appointment_id",
  "chart_id",
  "appointment_date",
  "appointment_status",
  "form_type",
  "form_month",
  "patient_has_other_converted_appt",
  "drchrono_link",
] as const;

export type UnclassifiedRow = {
  appointment_id: string;
  chart_id: string;
  appointment_date: string | null;
  appointment_status: string;
  form_type: "registration" | "insurance" | "none" | string;
  form_month: string;
  patient_has_other_converted_appt: "yes" | "no" | string;
};

/**
 * DrChrono's appointment page. Verified 2026-10-19 that /appointments/{id}/ is
 * a real route (it redirects to sign-in, as /chart/{id}/ does; unknown routes
 * 404). Opening it needs a DrChrono login.
 */
export function drchronoAppointmentLink(appointmentId: string): string {
  return `https://app.drchrono.com/appointments/${encodeURIComponent(appointmentId)}/`;
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Pure. Header row + one line per appointment, in UNCLASSIFIED_COLUMNS order. */
export function buildUnclassifiedCsv(rows: UnclassifiedRow[]): string {
  const lines = [UNCLASSIFIED_COLUMNS.join(",")];
  for (const r of rows) {
    const cells = [
      r.appointment_id,
      r.chart_id,
      r.appointment_date ?? "",
      r.appointment_status,
      r.form_type,
      r.form_month ?? "",
      r.patient_has_other_converted_appt,
      drchronoAppointmentLink(r.appointment_id),
    ].map((v) => csvEscape(String(v ?? "")));
    lines.push(cells.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * The rows, sorted with the ones that move the numbers first: no other
 * converted appointment ("no"), then by appointment date. Plan cost on
 * production 2,488; about 95 ms (2026-10-19). Run through reportQuery().
 */
export const UNCLASSIFIED_SQL = `
WITH rl AS (SELECT (SELECT r.rules FROM public.drsnip_conversion_rules() r) AS rules),
lc AS (
  SELECT l.st, public.drsnip_conversion_status_class(l.st, rl.rules) AS cls
    FROM (SELECT DISTINCT s.current_status AS st FROM public.appointment_snapshots s) l CROSS JOIN rl
),
live AS (
  SELECT s.source_appointment_id, s.patient_source_id, s.scheduled_time, s.current_status, lc.cls
    FROM public.appointment_snapshots s JOIN lc ON lc.st IS NOT DISTINCT FROM s.current_status
   WHERE s.deleted_flag IS NOT TRUE
),
conv AS (SELECT DISTINCT live.patient_source_id FROM live WHERE live.cls = 'converted'),
forms AS (
  SELECT s.n8n_patient_id::text AS pid,
         min(s.created_at) FILTER (WHERE s.form_type = 'registration') AS reg_at,
         min(s.created_at) FILTER (WHERE s.form_type = 'insurance')    AS ins_at
    FROM public.submissions s
   WHERE s.n8n_patient_id IS NOT NULL AND s.form_type IN ('registration', 'insurance')
   GROUP BY 1
)
SELECT u.source_appointment_id AS appointment_id,
       u.patient_source_id     AS chart_id,
       to_char(u.scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS appointment_date,
       CASE WHEN coalesce(btrim(u.current_status), '') = '' THEN 'blank' ELSE u.current_status END AS appointment_status,
       CASE WHEN f.reg_at IS NOT NULL THEN 'registration'
            WHEN f.ins_at IS NOT NULL THEN 'insurance' ELSE 'none' END AS form_type,
       coalesce(to_char(coalesce(f.reg_at, f.ins_at) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM'), '') AS form_month,
       CASE WHEN c.patient_source_id IS NULL THEN 'no' ELSE 'yes' END AS patient_has_other_converted_appt
  FROM live u
  LEFT JOIN conv  c ON c.patient_source_id = u.patient_source_id
  LEFT JOIN forms f ON f.pid = u.patient_source_id
 WHERE u.cls = 'unclassified'
 ORDER BY (c.patient_source_id IS NOT NULL), u.scheduled_time NULLS LAST, u.source_appointment_id
`;

export const UNCLASSIFIED_COUNT_SQL = `
WITH x AS (${UNCLASSIFIED_SQL})
SELECT count(*)::int AS rows,
       count(*) FILTER (WHERE x.patient_has_other_converted_appt = 'no')::int AS no_other_converted
  FROM x
`;
