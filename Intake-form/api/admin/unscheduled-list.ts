// GET /api/admin/unscheduled/list?bucket=&month=YYYY-MM | &range=YYYY-MM..YYYY-MM [&page=N]
//
// Admin only. The patients behind one count on "Unscheduled at day 14", 100 per
// page, oldest registration first, with the total. Same bucket CTE as the
// counts (api/_lib/unscheduled-day14.ts), so the total equals the cell.
//
// HIPAA: every successful call writes one access row to notification_events
// (channel 'access', kind 'list_unscheduled'): user id, bucket, cohort, total
// rows and page. No patient identifier is ever written to the log.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import { record as recordNotification } from "../../lib/notifications/ledger";
import {
  BUCKET_LABELS,
  PAGE_SIZE,
  cohortKey,
  countQuery,
  listQuery,
  parseListParams,
} from "../_lib/unscheduled-list";
import { DAY14_AS_OF_SQL } from "../_lib/unscheduled-day14";
import { sql } from "@workspace/db";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const p = parseListParams((req.query ?? {}) as Record<string, unknown>);
  if ("error" in p) return res.status(400).json({ error: p.error });

  try {
    const [count, rows, asOf] = await Promise.all([
      reportQuery<{ total: number }>(countQuery(p)),
      reportQuery(listQuery(p)),
      reportQuery(sql.raw(DAY14_AS_OF_SQL)),
    ]);
    const total = Number(count.rows[0]?.total ?? 0);
    await recordNotification({
      channel: "access",
      kind: "list_unscheduled",
      recipientClass: "staff",
      outcome: "sent",
      detail: `user=${auth.user.id} bucket=${p.bucket} cohort=${cohortKey(p.cohort)} rows=${total} page=${p.page}`,
    });
    const rawAsOf = asOf.rows[0]?.as_of as string | Date | null | undefined;
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      bucket: p.bucket,
      bucket_label: BUCKET_LABELS[p.bucket],
      cohort: p.cohort,
      total,
      page: p.page,
      page_size: PAGE_SIZE,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      data_as_of: rawAsOf ? new Date(rawAsOf).toISOString() : null,
      rows: rows.rows.map((r) => ({
        chart_id: String(r.chart_id),
        submission_id: (r.submission_id as string | null) ?? null,
        name: String(r.name ?? ""),
        registered_on: String(r.registered_on),
        days_since: Number(r.days_since),
        has_appointment: Boolean(r.has_appointment),
        latest_status: r.has_appointment ? (String(r.latest_status ?? "").trim() || null) : null,
        latest_date: (r.latest_date as string | null) ?? null,
      })),
    });
  } catch (err) {
    console.error("[admin/unscheduled-list] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "list failed" });
  }
}
