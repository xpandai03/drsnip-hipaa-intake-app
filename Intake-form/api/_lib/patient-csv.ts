// CSV export of a patient list (admin only). Same columns as the list on
// screen, nothing else:
//   Patient, First registered, Days since, Most recent appointment,
//   Submission URL, DrChrono chart ID, DrChrono chart URL
//
// Safety: RFC 4180 quoting; any cell starting with = + - @ TAB or CR is
// prefixed with a single quote so a spreadsheet never evaluates it; UTF-8
// with a BOM so Excel reads names correctly. Built in memory and sent in one
// response; never written to disk.

export const PATIENT_CSV_COLUMNS = [
  "Patient",
  "First registered",
  "Days since",
  "Most recent appointment",
  "Submission URL",
  "DrChrono chart ID",
  "DrChrono chart URL",
] as const;

export type PatientListRow = {
  chart_id: string | null;
  submission_id: string | null;
  name: string;
  registered_on: string;
  days_since: number;
  has_appointment: boolean;
  latest_status: string | null;
  latest_date: string | null;
};

/** Neutralise spreadsheet formulas, then quote per RFC 4180. */
export function csvCell(value: unknown): string {
  let v = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Same text as the list page's "Most recent appointment" cell. */
export function appointmentText(r: Pick<PatientListRow, "has_appointment" | "latest_status" | "latest_date">): string {
  if (!r.has_appointment) return "No appointment";
  const status = r.latest_status && r.latest_status.trim() ? r.latest_status.trim() : "No status";
  return r.latest_date ? `${status} · ${r.latest_date}` : status;
}

/** The DrChrono chart URL: the exact pattern of SubmissionDetailModal.tsx:461. */
export function chartUrl(chartId: string | null): string {
  return chartId ? `https://app.drchrono.com/chart/${chartId}/documents` : "";
}

export function consoleBaseUrl(): string {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  return (raw && raw.length > 0 ? raw : "https://intake.drsnip.com").replace(/\/+$/, "");
}

export function buildPatientListCsv(rows: PatientListRow[], base: string = consoleBaseUrl()): string {
  const lines = [PATIENT_CSV_COLUMNS.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([
      r.name,
      r.registered_on,
      r.days_since,
      appointmentText(r),
      r.submission_id ? `${base}/admin/submissions/${r.submission_id}` : "",
      r.chart_id ?? "",
      chartUrl(r.chart_id),
    ].map(csvCell).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** drsnip-<bucket>-<cohort>-<YYYYMMDD-HHmm>.csv — no patient data, Pacific time. */
export function csvFilename(bucket: string, cohort: string, now: Date = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const safe = (s: string) => s.replace(/\.\./g, "-to-").replace(/[^A-Za-z0-9_-]/g, "-");
  return `drsnip-${safe(bucket)}-${safe(cohort)}-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}.csv`;
}
