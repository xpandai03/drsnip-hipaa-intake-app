// GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Aggregate-only snapshot for the dashboard header: total submissions, date
// range, and counts by form_type and by n8n_status. Auth-guarded. Every grouped
// cell passes through <5 suppression. The grand total is not a grouped cell
// (it's the denominator and identifies no one), so it is returned as-is.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import {
  suppressRows,
  buildWhere,
  parseDateUtc,
  addDaysUtc,
} from "../_lib/reporting";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const from = parseDateUtc(req.query.from);
  const toDay = parseDateUtc(req.query.to);
  const toExclusive = toDay ? addDaysUtc(toDay, 1) : undefined;
  if (from && toExclusive && from.getTime() >= toExclusive.getTime()) {
    return res.status(400).json({ error: "from must be <= to" });
  }
  const where = buildWhere({ from, toExclusive });

  const [totalRow] = (
    await db.execute<{ n: number; lo: string | null; hi: string | null }>(sql`
      SELECT count(*)::int AS n,
             to_char(min(created_at), 'YYYY-MM-DD') AS lo,
             to_char(max(created_at), 'YYYY-MM-DD') AS hi
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

  const form = suppressRows(byForm.rows);
  const status = suppressRows(byStatus.rows);

  return res.status(200).json({
    total_submissions: Number(totalRow?.n ?? 0),
    date_range: { from: totalRow?.lo ?? null, to: totalRow?.hi ?? null },
    by_form_type: form.rows,
    by_n8n_status: status.rows,
    suppressed_cells: form.suppressed_cells + status.suppressed_cells,
  });
}
