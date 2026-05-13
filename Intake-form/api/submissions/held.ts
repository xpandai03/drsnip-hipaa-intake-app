// GET /api/submissions/held — list of submissions currently in 'held' status.
//
// Auth-guarded. No pagination — the held queue is meant to stay small and
// admins review it manually. If the queue ever exceeds a few hundred rows
// we'd add pagination, but ordering by createdAt DESC so the freshest
// holds appear first.
//
// Query params:
//   countOnly=1   returns only `{ count }`, used by the nav badge.
//
// Response (full):
//   {
//     submissions: [{ id, createdAt, source, firstName, lastName, email,
//                     rank, leadScore, sfStatus, federalAgency,
//                     sfLastAttemptAt, sfError }],
//     count: number
//   }

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { count, db, desc, eq, submissions } from "@workspace/db";
import { requireAuth } from "../_lib/auth";

function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] as string | undefined;
  if (typeof value === "string") return value;
  return undefined;
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

  const countOnly = firstOf(req.query.countOnly) === "1";

  if (countOnly) {
    const totalRow = await db
      .select({ value: count() })
      .from(submissions)
      .where(eq(submissions.sfStatus, "held"));
    return res.status(200).json({ count: Number(totalRow[0]?.value ?? 0) });
  }

  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: submissions.id,
        createdAt: submissions.createdAt,
        source: submissions.source,
        firstName: submissions.firstName,
        lastName: submissions.lastName,
        email: submissions.email,
        federalAgency: submissions.federalAgency,
        rank: submissions.rank,
        leadScore: submissions.leadScore,
        sfStatus: submissions.sfStatus,
        sfLastAttemptAt: submissions.sfLastAttemptAt,
        sfError: submissions.sfError,
      })
      .from(submissions)
      .where(eq(submissions.sfStatus, "held"))
      .orderBy(desc(submissions.createdAt)),
    db
      .select({ value: count() })
      .from(submissions)
      .where(eq(submissions.sfStatus, "held")),
  ]);

  return res.status(200).json({
    submissions: rows,
    count: Number(totalRow[0]?.value ?? 0),
  });
}
