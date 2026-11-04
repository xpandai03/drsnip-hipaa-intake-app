// GET /api/admin/comeback-window — admin only, read-only, counts only.
//
// The comeback window (J5): of drop-offs who later completed registration in
// a DIFFERENT session (match_type 'email'), the hours between the partial
// first being seen and the registration, at the 50th / 80th / 90th
// percentile, with n. Same-session completions are counted separately and
// never enter the percentiles. Data starts when 0026 shipped; until then the
// partial's start time was deleted on conversion and never recorded.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@workspace/db";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import { COMEBACK_WINDOW_SQL } from "../_lib/partials";

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  try {
    const r = (await reportQuery(sql.raw(COMEBACK_WINDOW_SQL))).rows[0] ?? {};
    const since = r.since ? new Date(r.since as string).toISOString() : null;
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      n: Number(r.n ?? 0),
      n_same_session: Number(r.n_same_session ?? 0),
      since,
      p50_hours: num(r.p50_hours),
      p80_hours: num(r.p80_hours),
      p90_hours: num(r.p90_hours),
      basis: "Hours from a drop-off partial first being seen to the registration that cleared it, comebacks only (a different session, matched on email).",
    });
  } catch (err) {
    console.error("[admin/comeback-window] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "report failed" });
  }
}
