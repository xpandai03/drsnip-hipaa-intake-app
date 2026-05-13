// POST /api/submissions/[id]/discard — mark a held submission as discarded.
// Auth-guarded. No Salesforce call; row stays in the DB for audit.
//
// Outcomes:
//   200 { success: true }         — discarded
//   409 { error: 'not_held' }     — row wasn't held

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth } from "../../_lib/auth";
import { discardHeldSubmission } from "../../_lib/release";

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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = firstOf(req.query.id);
  if (!id || !UUID_PATTERN.test(id)) {
    return res.status(400).json({ error: "Invalid submission id" });
  }

  const outcome = await discardHeldSubmission(id, auth.user.email);
  if (outcome.kind === "not_held") {
    return res.status(409).json({ error: "not_held" });
  }
  return res.status(200).json({ success: true });
}
