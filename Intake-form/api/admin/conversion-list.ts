// GET /api/admin/conversion/list?form=&grain=&period=&bucket=[&page=]  — admin only.
//
// The patients behind one count on "Conversion by cohort", 100 per page, oldest
// first, with the total. Membership: api/_lib/conversion-list.ts (the cohort
// table's own classifier and period index). Each call writes one access row
// (kind list_conversion): user id, bucket, cohort, row count, page.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@workspace/db";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import { record as recordNotification } from "../../lib/notifications/ledger";
import { PAGE_SIZE } from "../_lib/unscheduled-list";
import { DAY14_AS_OF_SQL } from "../_lib/unscheduled-day14";
import {
  conversionCohortKey,
  conversionCountQuery,
  conversionListQuery,
  conversionTitle,
  parseConversionListParams,
} from "../_lib/conversion-list";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const p = parseConversionListParams((req.query ?? {}) as Record<string, unknown>);
  if ("error" in p) return res.status(400).json({ error: p.error });

  try {
    const [count, rows, asOf] = await Promise.all([
      reportQuery<{ total: number }>(conversionCountQuery(p)),
      reportQuery(conversionListQuery(p)),
      reportQuery(sql.raw(DAY14_AS_OF_SQL)),
    ]);
    const total = Number(count.rows[0]?.total ?? 0);
    await recordNotification({
      channel: "access",
      kind: "list_conversion",
      recipientClass: "staff",
      outcome: "sent",
      detail: `user=${auth.user.id} bucket=${p.bucket} cohort=${conversionCohortKey(p)} rows=${total} page=${p.page}`,
    });
    const rawAsOf = asOf.rows[0]?.as_of as string | Date | null | undefined;
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      bucket: p.bucket,
      title: conversionTitle(p, total),
      form: p.form,
      grain: p.grain,
      period: p.period,
      total,
      page: p.page,
      page_size: PAGE_SIZE,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      data_as_of: rawAsOf ? new Date(rawAsOf).toISOString() : null,
      rows: rows.rows.map((r) => ({
        chart_id: (r.chart_id as string | null) ?? null,
        submission_id: (r.submission_id as string | null) ?? null,
        name: String(r.name ?? ""),
        registered_on: String(r.registered_on),
        days_since: Number(r.days_since),
        has_appointment: Boolean(r.has_appointment),
        latest_status: r.has_appointment ? (String(r.latest_status ?? "").trim() || null) : null,
        latest_date: (r.latest_date as string | null) ?? null,
        converted_on: (r.converted_on as string | null) ?? null,
      })),
    });
  } catch (err) {
    console.error("[admin/conversion-list] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "list failed" });
  }
}
