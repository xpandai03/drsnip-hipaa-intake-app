// GET /api/admin/not-booked — admin only. Counts only.
//
// Registrations whose patient has nothing booked as of today, by registration
// month, split into canceled or no show / no appointment, and the last 30 days
// right now. See api/_lib/not-booked.ts for the definitions. Every query runs
// through reportQuery(): 5s statement timeout, JIT off.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@workspace/db";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import {
  NOT_BOOKED_AS_OF_SQL,
  NOT_BOOKED_MONTHS_SQL,
  NOT_BOOKED_RIGHT_NOW_SQL,
  shapeNotBooked,
} from "../_lib/not-booked";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  try {
    const [m, now, asOf] = await Promise.all([
      reportQuery(sql.raw(NOT_BOOKED_MONTHS_SQL)),
      reportQuery(sql.raw(NOT_BOOKED_RIGHT_NOW_SQL)),
      reportQuery(sql.raw(NOT_BOOKED_AS_OF_SQL)),
    ]);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(shapeNotBooked(m.rows, now.rows[0], asOf.rows[0]?.as_of ?? null));
  } catch (err) {
    console.error("[admin/not-booked] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "report failed" });
  }
}
