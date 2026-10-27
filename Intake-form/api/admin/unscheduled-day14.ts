// GET /api/admin/unscheduled-day14 — admin only. Counts only.
//
// Registrations with nothing booked 14 days after first registering, by
// registration month, what happened to them afterwards, and the last 30 days
// right now. See api/_lib/unscheduled-day14.ts for the definitions. Every query
// runs through reportQuery(): 5s statement timeout, JIT off.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@workspace/db";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import {
  DAY14_AS_OF_SQL,
  DAY14_MONTHS_SQL,
  DAY14_RIGHT_NOW_SQL,
  shapeDay14,
} from "../_lib/unscheduled-day14";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  try {
    const [m, now, asOf] = await Promise.all([
      reportQuery(sql.raw(DAY14_MONTHS_SQL)),
      reportQuery(sql.raw(DAY14_RIGHT_NOW_SQL)),
      reportQuery(sql.raw(DAY14_AS_OF_SQL)),
    ]);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(shapeDay14(m.rows, now.rows[0], asOf.rows[0]?.as_of ?? null));
  } catch (err) {
    console.error("[admin/unscheduled-day14] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "report failed" });
  }
}
