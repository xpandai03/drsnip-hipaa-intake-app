// GET /api/submissions/[id] — full detail for a single submission.
//
// Auth-guarded. Returns every column on the row including the heavy
// raw_payload blob.
//
// Phase 1 (DrSnip): the scoring_rule_sets LEFT JOIN was removed along with
// the scoring subsystem — the response no longer includes a `ruleSet` field.
//
// 404 when the id doesn't match a submission. 400 when the id isn't a valid
// UUID — keeps the DB from running a useless cast.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, eq, submissions } from "@workspace/db";
import { requireAuth, requireAdmin } from "../_lib/auth";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] as string | undefined;
  if (typeof value === "string") return value;
  return undefined;
}

// GET  — full detail (any authenticated admin OR viewer).
// DELETE — permanently remove the submission row (PHI). ADMIN ONLY (D.1),
//          enforced server-side via requireAdmin; the UI confirm modal is
//          convenience, not the gate.
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "DELETE") return handleDelete(req, res);
  res.setHeader("Allow", "GET, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = firstOf(req.query.id);
  if (!id || !UUID_PATTERN.test(id)) {
    return res.status(400).json({ error: "Invalid submission id" });
  }

  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return res.status(404).json({ error: "Submission not found" });
  }

  return res.status(200).json({ submission: row });
}

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  // Admin-only — viewers get 403 here even though the UI hides the control.
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const id = firstOf(req.query.id);
  if (!id || !UUID_PATTERN.test(id)) {
    return res.status(400).json({ error: "Invalid submission id" });
  }

  const result = await db
    .delete(submissions)
    .where(eq(submissions.id, id))
    .returning({ id: submissions.id });

  if (result.length === 0) {
    return res.status(404).json({ error: "Submission not found" });
  }

  // HIPAA: audit the deletion with IDs + actor only — never PHI field values.
  console.log(
    "[admin] submission_deleted " +
      JSON.stringify({
        ts: new Date().toISOString(),
        submission_id: id,
        actor_email: auth.user.email,
      }),
  );

  return res.status(200).json({ success: true, id });
}
