// POST /api/submissions/release-all — bulk release of currently-held
// submissions to Salesforce.
//
// Sequential — calls releaseHeldSubmission() one at a time to avoid
// hammering SF. Capped at MAX_BULK_BATCH per call; if there are more held
// rows, the admin re-issues the call. Each lead's outcome is reported
// independently — a single SF failure does NOT abort the rest.
//
// Response:
//   200 {
//     processed: number,           // how many were attempted
//     results: [{ id, outcome, leadId?, message? }]
//   }

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, desc, eq, submissions } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { releaseHeldSubmission } from "../_lib/release";

const MAX_BULK_BATCH = 50;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  // Snapshot the held queue at the start. We process from this list;
  // anything added after this query lands in the queue for next time.
  const heldIds = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.sfStatus, "held"))
    .orderBy(desc(submissions.createdAt))
    .limit(MAX_BULK_BATCH);

  const results: Array<{
    id: string;
    outcome: "released" | "not_held" | "invalid_row" | "sf_failed";
    leadId?: string;
    message?: string;
  }> = [];

  // SEQUENTIAL — for...of with await. Do not parallelize; we don't want to
  // burst against Salesforce or against our pooled DB connection.
  for (const { id } of heldIds) {
    const outcome = await releaseHeldSubmission(id, auth.user.email);
    if (outcome.kind === "released") {
      results.push({ id, outcome: "released", leadId: outcome.sfLeadId });
    } else if (outcome.kind === "not_held") {
      results.push({ id, outcome: "not_held" });
    } else if (outcome.kind === "invalid_row") {
      results.push({
        id,
        outcome: "invalid_row",
        message: outcome.message,
      });
    } else {
      results.push({
        id,
        outcome: "sf_failed",
        message: outcome.message,
      });
    }
  }

  return res.status(200).json({
    processed: results.length,
    results,
  });
}
