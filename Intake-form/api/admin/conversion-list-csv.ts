// GET /api/admin/conversion/list.csv?form=&grain=&period=&bucket=  — admin only.
//
// Every row of one "Conversion by cohort" list: the same query as the list,
// without the page window. Same CSV rules as the day-14 export, plus
// "Converted on". One export row per download (kind export_patient_list).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import { record as recordNotification } from "../../lib/notifications/ledger";
import { conversionCohortKey, conversionListQuery, parseConversionListParams } from "../_lib/conversion-list";
import { buildPatientListCsv, csvFilename, type PatientListRow } from "../_lib/patient-csv";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const p = parseConversionListParams((req.query ?? {}) as Record<string, unknown>);
  if ("error" in p) return res.status(400).json({ error: p.error });

  let rows: PatientListRow[];
  try {
    rows = (await reportQuery(conversionListQuery(p, { all: true }))).rows.map((r) => ({
      chart_id: (r.chart_id as string | null) ?? null,
      submission_id: (r.submission_id as string | null) ?? null,
      name: String(r.name ?? ""),
      registered_on: String(r.registered_on),
      days_since: Number(r.days_since),
      has_appointment: Boolean(r.has_appointment),
      latest_status: (r.latest_status as string | null) ?? null,
      latest_date: (r.latest_date as string | null) ?? null,
      converted_on: (r.converted_on as string | null) ?? null,
    }));
  } catch (err) {
    console.error("[admin/conversion-list-csv] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "export failed" });
  }

  const cohort = conversionCohortKey(p);
  await recordNotification({
    channel: "export",
    kind: "export_patient_list",
    recipientClass: "staff",
    outcome: "sent",
    detail: `user=${auth.user.id} bucket=${p.bucket} cohort=${cohort} rows=${rows.length}`,
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${csvFilename(p.bucket, `${p.form}-${p.grain}-${p.period}`)}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(buildPatientListCsv(rows, undefined, {
    convertedOn: true,
    firstLabel: p.form === "insurance" ? "First inquiry" : undefined,
  }));
}
