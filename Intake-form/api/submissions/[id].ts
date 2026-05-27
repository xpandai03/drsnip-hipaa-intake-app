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
import { requireAuth } from "../_lib/auth";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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

  // Compute the n8n UI deep-link server-side so the env var stays out of the
  // SPA build. NULL when either id is missing OR the bridge call failed at
  // the transport layer (no execution to link to). The workflow URL (no
  // execution suffix) is still useful when only workflowId is known.
  const n8nBase = (
    process.env.N8N_BASE_URL ?? "https://n8n-drsnip.fly.dev"
  ).replace(/\/+$/, "");
  let n8nExecutionUrl: string | null = null;
  let n8nWorkflowUrl: string | null = null;
  if (row.n8nWorkflowId) {
    n8nWorkflowUrl = `${n8nBase}/workflow/${row.n8nWorkflowId}`;
    if (row.n8nExecutionId) {
      n8nExecutionUrl = `${n8nWorkflowUrl}/executions/${row.n8nExecutionId}`;
    }
  }

  return res.status(200).json({
    submission: { ...row, n8nExecutionUrl, n8nWorkflowUrl },
  });
}
