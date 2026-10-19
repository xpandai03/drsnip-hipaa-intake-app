// GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&location=<clinic>
//
// Aggregate-only snapshot for the dashboard header: total submissions, date
// range, counts by form_type and by n8n_status, plus the EHR write-back
// outcome. Auth-guarded. Every GROUPED cell passes through <5 suppression.
//
// Two figures are deliberately NOT suppressed, because neither is a grouped
// cell and neither identifies anyone:
//   • total_submissions — the denominator (unchanged behaviour).
//   • ehr_writeback.resolved / .succeeded / .rate_pct — see the long note on
//     writebackOutcome() in api/_lib/reporting.ts. The rate MUST be computed
//     from true counts; deriving it from suppressed cells is what made the old
//     "92% success rate" tile wrong.
//
// Dates are CLINIC days (Pacific), matching the exports. They used to be UTC
// here and Pacific in the CSV, so the same submission had two dates.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import {
  suppressRows,
  buildWhere,
  writebackOutcome,
  firstOf,
  type WritebackStatusCounts,
} from "../_lib/reporting";
import { isAllowedLocation } from "../_lib/location";
import {
  CLINIC_TZ,
  CLINIC_TZ_LABEL,
  resolveClinicWindow,
} from "../_lib/clinic-time";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const window = resolveClinicWindow(firstOf(req.query.from), firstOf(req.query.to));
  if (window.invalid) {
    return res.status(400).json({ error: "from must be <= to" });
  }

  const locationParam = firstOf(req.query.location);
  const location = isAllowedLocation(locationParam) ? locationParam : undefined;

  const where = buildWhere({
    from: window.from,
    toExclusive: window.toExclusive,
    location,
  });

  // min/max rendered as the CLINIC day so the reported range matches the
  // buckets and the CSV, not the UTC day.
  const [totalRow] = (
    await db.execute<{ n: number; lo: string | null; hi: string | null }>(sql`
      SELECT count(*)::int AS n,
             to_char(min(created_at) AT TIME ZONE ${CLINIC_TZ}, 'YYYY-MM-DD') AS lo,
             to_char(max(created_at) AT TIME ZONE ${CLINIC_TZ}, 'YYYY-MM-DD') AS hi
      FROM submissions ${where}
    `)
  ).rows;

  const byForm = await db.execute<{ value: string | null; count: number }>(sql`
    SELECT form_type AS value, count(*)::int AS count
    FROM submissions ${where}
    GROUP BY 1 ORDER BY 2 DESC, 1 ASC
  `);

  const byStatus = await db.execute<{ value: string | null; count: number }>(sql`
    SELECT coalesce(n8n_status, 'pending') AS value, count(*)::int AS count
    FROM submissions ${where}
    GROUP BY 1 ORDER BY 2 DESC, 1 ASC
  `);

  // TRUE counts, before suppression, for the write-back arithmetic.
  const rawStatus: Partial<WritebackStatusCounts> = {};
  for (const row of byStatus.rows) {
    const key = (row.value ?? "pending") as keyof WritebackStatusCounts;
    rawStatus[key] = Number(row.count) || 0;
  }

  const form = suppressRows(byForm.rows);
  const status = suppressRows(byStatus.rows);

  return res.status(200).json({
    total_submissions: Number(totalRow?.n ?? 0),
    date_range: { from: totalRow?.lo ?? null, to: totalRow?.hi ?? null },
    requested_range: { from: window.fromDay ?? null, to: window.toDay ?? null },
    timezone: CLINIC_TZ,
    timezone_label: CLINIC_TZ_LABEL,
    location: location ?? null,
    by_form_type: form.rows,
    by_n8n_status: status.rows,
    ehr_writeback: writebackOutcome(rawStatus),
    suppressed_cells: form.suppressed_cells + status.suppressed_cells,
  });
}
