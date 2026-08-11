// GET /api/registration-partials — registration drop-offs for the admin page.
//
// Auth-guarded (viewers may read, per the Submissions convention). Excludes rows
// active within the grace window (they may still be mid-completion) unless
// ?include_recent=1. Lazy-purges rows past the 30-day retention window on every
// access. Optional whitelisted location filter (Train 1).
//
// Only the whitelist columns exist on this table, so the full row is safe to
// return — there are no medical/step-answer fields to leak.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  and,
  count,
  db,
  desc,
  eq,
  lte,
  registrationPartials,
  sql,
} from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { isAllowedLocation } from "../_lib/location";
import { purgeExpiredPartials } from "../_lib/partials";

function firstOf(v: unknown): string | undefined {
  if (Array.isArray(v)) return v[0] as string | undefined;
  if (typeof v === "string") return v;
  return undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  await purgeExpiredPartials(); // lazy retention on reads

  const includeRecent = firstOf(req.query.include_recent) === "1";
  const locationParam = firstOf(req.query.location);

  const filters = [];
  if (!includeRecent) {
    // Grace period: hide rows touched within the last 24h.
    filters.push(lte(registrationPartials.updatedAt, sql`now() - interval '24 hours'`));
  }
  if (isAllowedLocation(locationParam)) {
    filters.push(eq(registrationPartials.officeLocation, locationParam));
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(registrationPartials)
      .where(where)
      .orderBy(desc(registrationPartials.updatedAt))
      .limit(500),
    db.select({ value: count() }).from(registrationPartials).where(where),
  ]);

  return res.status(200).json({
    partials: rows,
    total: Number(totalRow[0]?.value ?? 0),
  });
}
