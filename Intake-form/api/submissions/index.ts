// GET /api/submissions — paginated list of submissions for the admin tab.
//
// Auth-guarded via requireAuth. Returns ONLY the lean columns needed for the
// table view; raw_payload lives on the detail endpoint instead. Pagination is
// always bounded — no unbounded SELECT.
//
// Phase 2 (DrSnip): filters by `form_type` (registration | consultation)
// instead of the removed CJC `source`.
//
// Query params (all optional):
//   page        default 1
//   limit       default 50, max 100
//   form_type   "registration" | "consultation"
//   start_date  YYYY-MM-DD inclusive
//   end_date    YYYY-MM-DD inclusive (treated as end-of-day)
//   search      free-text — case-insensitive substring across email,
//                 first_name, last_name
//
// Response:
//   {
//     submissions: [{ id, createdAt, formType, firstName, lastName, email }],
//     total, page, hasMore
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
  submissions,
} from "@workspace/db";
import { requireAuth } from "../_lib/auth";

const ALLOWED_FORM_TYPES = new Set(["registration", "consultation"]);

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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0));
}

function parseDateEndExclusive(value: unknown): Date | undefined {
  const v = firstOf(value);
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
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

  const formTypeParam = firstOf(q.form_type);
  const search = firstOf(q.search);
  const startDate = parseDateStart(q.start_date);
  const endDateExclusive = parseDateEndExclusive(q.end_date);

  const filters: Array<ReturnType<typeof eq> | ReturnType<typeof and>> = [];
  if (formTypeParam && ALLOWED_FORM_TYPES.has(formTypeParam)) {
    filters.push(eq(submissions.formType, formTypeParam));
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
        formType: submissions.formType,
        firstName: submissions.firstName,
        lastName: submissions.lastName,
        email: submissions.email,
        // n8n outcome surfaces as a badge on the list view (Phase 3 bridge).
        n8nStatus: submissions.n8nStatus,
        n8nPatientId: submissions.n8nPatientId,
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
