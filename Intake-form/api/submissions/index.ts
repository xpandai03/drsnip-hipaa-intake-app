// GET /api/submissions — paginated list of submissions for the admin tab.
//
// Auth-guarded via requireAuth. Returns ONLY the lean columns needed for the
// table view; raw_payload + scoring_trace are heavy and live on the detail
// endpoint instead. Pagination is always bounded — no unbounded SELECT.
//
// Query params (all optional):
//   page        default 1
//   limit       default 50, max 100
//   source      "federal" | "internal" | "fnn"
//   sf_status   "pending" | "sent" | "error" | "skipped" | "held" | "discarded"
//   rank        "A" | "B+" | "B" | "C" | "N/A" | "unscored"
//                 unscored ⇒ rank IS NULL
//   start_date  YYYY-MM-DD inclusive
//   end_date    YYYY-MM-DD inclusive (treated as end-of-day)
//   search      free-text — case-insensitive substring across email,
//                 first_name, last_name
//
// Response:
//   {
//     submissions: [{ id, createdAt, source, firstName, lastName, email,
//                     rank, leadScore, sfLeadId, sfStatus }],
//     total: number,
//     page: number,
//     hasMore: boolean
//   }

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  and,
  count,
  db,
  desc,
  eq,
  gte,
  ilike,
  lte,
  or,
  sql,
  submissions,
} from "@workspace/db";
import { requireAuth } from "../_lib/auth";

const ALLOWED_SOURCES = new Set(["federal", "internal", "fnn"]);
const ALLOWED_SF_STATUSES = new Set([
  "pending",
  "sent",
  "error",
  "skipped",
  "held",
  "discarded",
]);
const ALLOWED_RANKS = new Set(["A", "B+", "B", "C", "N/A", "unscored"]);

function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] as string | undefined;
  if (typeof value === "string") return value;
  return undefined;
}

function parseInt1(value: unknown, fallback: number): number {
  const v = firstOf(value);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseDateStart(value: unknown): Date | undefined {
  const v = firstOf(value);
  if (!v) return undefined;
  // Anchor at UTC start-of-day so cross-timezone behavior is predictable.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0));
}

function parseDateEndExclusive(value: unknown): Date | undefined {
  const v = firstOf(value);
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  // End-of-day exclusive: take the next day at 00:00:00 UTC.
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 0, 0, 0, 0));
}

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

  const q = req.query;
  const page = parseInt1(q.page, 1);
  const requestedLimit = parseInt1(q.limit, 50);
  const limit = Math.min(requestedLimit, 100);
  const offset = (page - 1) * limit;

  const sourceParam = firstOf(q.source);
  const sfStatusParam = firstOf(q.sf_status);
  const rankParam = firstOf(q.rank);
  const search = firstOf(q.search);
  const startDate = parseDateStart(q.start_date);
  const endDateExclusive = parseDateEndExclusive(q.end_date);

  const filters: Array<ReturnType<typeof eq> | ReturnType<typeof and>> = [];
  if (sourceParam && ALLOWED_SOURCES.has(sourceParam)) {
    filters.push(eq(submissions.source, sourceParam));
  }
  if (sfStatusParam && ALLOWED_SF_STATUSES.has(sfStatusParam)) {
    filters.push(eq(submissions.sfStatus, sfStatusParam));
  }
  if (rankParam && ALLOWED_RANKS.has(rankParam)) {
    if (rankParam === "unscored") {
      filters.push(sql`${submissions.rank} IS NULL`);
    } else {
      filters.push(eq(submissions.rank, rankParam));
    }
  }
  if (startDate) filters.push(gte(submissions.createdAt, startDate));
  if (endDateExclusive) filters.push(lte(submissions.createdAt, endDateExclusive));
  if (search && search.trim().length > 0) {
    const pattern = `%${search.trim()}%`;
    const searchClause = or(
      ilike(submissions.email, pattern),
      ilike(submissions.firstName, pattern),
      ilike(submissions.lastName, pattern),
    );
    if (searchClause) filters.push(searchClause);
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: submissions.id,
        createdAt: submissions.createdAt,
        source: submissions.source,
        firstName: submissions.firstName,
        lastName: submissions.lastName,
        email: submissions.email,
        rank: submissions.rank,
        leadScore: submissions.leadScore,
        sfLeadId: submissions.sfLeadId,
        sfStatus: submissions.sfStatus,
      })
      .from(submissions)
      .where(whereClause)
      .orderBy(desc(submissions.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ value: count() })
      .from(submissions)
      .where(whereClause),
  ]);

  const total = Number(totalRow[0]?.value ?? 0);
  const hasMore = page * limit < total;

  return res.status(200).json({
    submissions: rows,
    total,
    page,
    hasMore,
  });
}
