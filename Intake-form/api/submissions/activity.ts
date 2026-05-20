// GET /api/submissions/activity — aggregated daily counts for the heatmap.
//
// Auth-guarded. Returns daily totals plus a per-source breakdown inside the
// requested date window. Defaults to the last 90 days (matches the heatmap
// default).
//
// Phase 1 (DrSnip): the per-rank breakdown and the sent/errored summary tiles
// were removed along with the scoring + Salesforce subsystems. The summary now
// carries the window total only.
//
// Single aggregation query — buckets by DATE(created_at AT TIME ZONE 'UTC')
// so day boundaries line up with the SVG heatmap regardless of where the
// requester is.
//
// Days with zero submissions are returned with explicit zero rows so the
// UI doesn't have to backfill gaps.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";

function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] as string | undefined;
  if (typeof value === "string") return value;
  return undefined;
}

function parseDateUtc(value: unknown): Date | undefined {
  const v = firstOf(value);
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0));
}

function toIsoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysUtc(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

type DayBucket = {
  date: string;
  total: number;
  by_source: { federal: number; internal: number; fnn: number };
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const todayUtc = new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
      0, 0, 0, 0,
    ),
  );

  const endDate = parseDateUtc(req.query.end_date) ?? todayUtc;
  const defaultStart = addDaysUtc(endDate, -89); // 90-day window inclusive
  const startDate = parseDateUtc(req.query.start_date) ?? defaultStart;

  if (startDate.getTime() > endDate.getTime()) {
    return res
      .status(400)
      .json({ error: "start_date must be <= end_date" });
  }

  // End boundary is exclusive: the next UTC day after `endDate`.
  const endExclusive = addDaysUtc(endDate, 1);

  // Single aggregation: one row per (day, source) tuple. We then fold these
  // into per-day buckets in JS.
  const dailyResult = await db.execute<{
    day: string;
    source: string;
    total: string;
  }>(sql`
    SELECT
      TO_CHAR(DATE_TRUNC('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      source,
      COUNT(*)::text AS total
    FROM submissions
    WHERE created_at >= ${startDate}
      AND created_at < ${endExclusive}
    GROUP BY 1, 2
    ORDER BY 1
  `);

  // Build a date-keyed bucket map seeded with every day in the range so
  // the response includes zeros for empty days.
  const buckets = new Map<string, DayBucket>();
  for (
    let d = new Date(startDate.getTime());
    d.getTime() <= endDate.getTime();
    d = addDaysUtc(d, 1)
  ) {
    const key = toIsoDay(d);
    buckets.set(key, {
      date: key,
      total: 0,
      by_source: { federal: 0, internal: 0, fnn: 0 },
    });
  }

  for (const row of dailyResult.rows) {
    const bucket = buckets.get(row.day);
    if (!bucket) continue;
    const n = Number(row.total) || 0;
    bucket.total += n;
    if (row.source === "federal") bucket.by_source.federal += n;
    else if (row.source === "internal") bucket.by_source.internal += n;
    else if (row.source === "fnn") bucket.by_source.fnn += n;
  }

  // Summary tile: total submissions over the whole window.
  const summaryResult = await db.execute<{ total: string }>(sql`
    SELECT COUNT(*)::text AS total
    FROM submissions
    WHERE created_at >= ${startDate}
      AND created_at < ${endExclusive}
  `);
  const totalAll = Number(summaryResult.rows[0]?.total ?? 0);

  return res.status(200).json({
    start_date: toIsoDay(startDate),
    end_date: toIsoDay(endDate),
    daily_counts: Array.from(buckets.values()),
    summary: {
      total: totalAll,
    },
  });
}
