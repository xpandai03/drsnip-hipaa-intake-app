// GET /api/submissions/activity — aggregated daily counts for the heatmap.
//
// Auth-guarded. Returns daily totals plus a per-form-type breakdown inside the
// requested date window. Defaults to the last 90 days.
//
// Phase 2 (DrSnip): aggregates by `form_type` (registration | consultation)
// instead of the removed CJC `source`; the per-rank breakdown and the
// sent/errored summary tiles were dropped with the scoring + Salesforce
// subsystems.

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
  by_form_type: { registration: number; consultation: number };
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

  const endExclusive = addDaysUtc(endDate, 1);

  // One row per (day, form_type) tuple.
  const dailyResult = await db.execute<{
    day: string;
    form_type: string;
    total: string;
  }>(sql`
    SELECT
      TO_CHAR(DATE_TRUNC('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      form_type,
      COUNT(*)::text AS total
    FROM submissions
    WHERE created_at >= ${startDate}
      AND created_at < ${endExclusive}
    GROUP BY 1, 2
    ORDER BY 1
  `);

  // Seed every day in the range so empty days return explicit zeros.
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
      by_form_type: { registration: 0, consultation: 0 },
    });
  }

  for (const row of dailyResult.rows) {
    const bucket = buckets.get(row.day);
    if (!bucket) continue;
    const n = Number(row.total) || 0;
    bucket.total += n;
    if (row.form_type === "registration") {
      bucket.by_form_type.registration += n;
    } else if (row.form_type === "consultation") {
      bucket.by_form_type.consultation += n;
    }
  }

  // Window summary — total + per-form-type.
  const summaryResult = await db.execute<{
    total: string;
    registration: string;
    consultation: string;
  }>(sql`
    SELECT
      COUNT(*)::text AS total,
      SUM(CASE WHEN form_type = 'registration' THEN 1 ELSE 0 END)::text AS registration,
      SUM(CASE WHEN form_type = 'consultation' THEN 1 ELSE 0 END)::text AS consultation
    FROM submissions
    WHERE created_at >= ${startDate}
      AND created_at < ${endExclusive}
  `);
  const sRow = summaryResult.rows[0];

  return res.status(200).json({
    start_date: toIsoDay(startDate),
    end_date: toIsoDay(endDate),
    daily_counts: Array.from(buckets.values()),
    summary: {
      total: Number(sRow?.total ?? 0),
      registration: Number(sRow?.registration ?? 0),
      consultation: Number(sRow?.consultation ?? 0),
    },
  });
}
