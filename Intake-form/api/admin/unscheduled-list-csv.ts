// GET /api/admin/unscheduled/list.csv?bucket=&month=|range= — admin only.
//
// Every row of one "Unscheduled at day 14" list as CSV (not just a page). The
// SAME list query as the on-screen list, without the page window, through
// reportQuery() (5s timeout, JIT off). Each export writes one access row
// (kind export_patient_list): user id, bucket, cohort, row count. No patient
// identifier is logged; the filename carries none.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import { record as recordNotification } from "../../lib/notifications/ledger";
import { cohortKey, listQuery, parseListParams } from "../_lib/unscheduled-list";
import { buildPatientListCsv, csvFilename, type PatientListRow } from "../_lib/patient-csv";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const p = parseListParams((req.query ?? {}) as Record<string, unknown>);
  if ("error" in p) return res.status(400).json({ error: p.error });

  let rows: PatientListRow[];
  try {
    rows = (await reportQuery(listQuery(p, { all: true }))).rows.map((r) => ({
      chart_id: (r.chart_id as string | null) ?? null,
      submission_id: (r.submission_id as string | null) ?? null,
      name: String(r.name ?? ""),
      registered_on: String(r.registered_on),
      days_since: Number(r.days_since),
      has_appointment: Boolean(r.has_appointment),
      latest_status: (r.latest_status as string | null) ?? null,
      latest_date: (r.latest_date as string | null) ?? null,
    }));
  } catch (err) {
    console.error("[admin/unscheduled-list-csv] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "export failed" });
  }

  const cohort = cohortKey(p.cohort);
  await recordNotification({
    channel: "export",
    kind: "export_patient_list",
    recipientClass: "staff",
    outcome: "sent",
    detail: `user=${auth.user.id} bucket=${p.bucket} cohort=${cohort} rows=${rows.length}`,
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${csvFilename(p.bucket, cohort)}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(buildPatientListCsv(rows));
}
