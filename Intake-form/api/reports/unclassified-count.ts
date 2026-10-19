// GET /api/reports/unclassified-count — admin only. The row count shown beside
// the "Download unclassified appointments (CSV)" link. Counts only; same query
// as the file, so the page and the download cannot disagree.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@workspace/db";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import { UNCLASSIFIED_COUNT_SQL } from "../_lib/unclassified-export";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  try {
    const r = await reportQuery<{ rows: number; no_other_converted: number }>(sql.raw(UNCLASSIFIED_COUNT_SQL));
    const row = r.rows[0] ?? { rows: 0, no_other_converted: 0 };
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ rows: Number(row.rows), no_other_converted: Number(row.no_other_converted) });
  } catch (err) {
    console.error("[reports/unclassified-count] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "count failed" });
  }
}
