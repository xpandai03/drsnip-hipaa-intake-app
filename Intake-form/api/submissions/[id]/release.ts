// POST /api/submissions/[id]/release — release a single held submission
// to Salesforce. Auth-guarded. Idempotent via the held → releasing row
// transition in releaseHeldSubmission (see api/_lib/release.ts).
//
// Outcomes:
//   200 { success: true, leadId }       — released, sfStatus='sent'
//   409 { error: 'not_held' }           — row wasn't held (already released,
//                                         discarded, or never held)
//   422 { error: 'invalid_row', ... }   — row has bad data (defensive)
//   502 { error: 'sf_failed', ... }     — SF call failed; row reverted to
//                                         'held' with sfError populated

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth } from "../../_lib/auth";
import { releaseHeldSubmission } from "../../_lib/release";

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

  const outcome = await releaseHeldSubmission(id, auth.user.email);
  switch (outcome.kind) {
    case "released":
      return res.status(200).json({ success: true, leadId: outcome.sfLeadId });
    case "not_held":
      return res.status(409).json({ error: "not_held" });
    case "invalid_row":
      return res.status(422).json({ error: "invalid_row", message: outcome.message });
    case "sf_failed":
      return res.status(502).json({ error: "sf_failed", message: outcome.message });
  }
}
