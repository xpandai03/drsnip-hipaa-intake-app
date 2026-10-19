// POST /api/attendance-mapping/approve
//
// Publishes a clinic definition. Guarded by `requireDefinitionApprover`, NOT by
// `requireAdmin`: every account in this system is an admin by the role default,
// and approving what a clinic's records mean is a different privilege.
//
// Provenance is required in full. The authenticated approver and the clinic
// person who made the decision are DIFFERENT people and are recorded
// separately — a decision Jeff makes on a call is entered by somebody else, and
// the record has to say so or the provenance is a fiction.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireDefinitionApprover } from "../_lib/auth";
import { approveDraft, getDraft } from "../_lib/attendance-store";
import { validateProvenance } from "../../lib/metrics/attendance-contract";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireDefinitionApprover(req, res);
  if (!auth) return;

  const b = (req.body ?? {}) as Record<string, unknown>;

  const revision = Number(b.revision);
  if (!Number.isInteger(revision)) {
    return res.status(400).json({ error: "revision is required" });
  }
  const prov = validateProvenance(b.provenance);
  if (!prov.ok) return res.status(400).json({ error: prov.error });

  const note = typeof b.note === "string" && b.note.trim() !== "" ? b.note.trim() : null;

  const result = await approveDraft(revision, prov.value, note, auth.user.id);

  if (!result.ok && result.reason === "nothing_decided") {
    return res.status(400).json({
      error: "nothing_decided",
      message: "No status has been classified yet, so there is nothing to approve.",
    });
  }
  if (!result.ok) {
    // Either somebody edited the draft, or somebody approved first. Both mean
    // this approver is not approving what they previewed.
    return res.status(409).json({
      error: "stale_draft",
      message:
        "The draft changed since you previewed it. Review it again before approving.",
      current_revision: result.conflict?.revision ?? null,
    });
  }

  const row = result.row;
  return res.status(200).json({
    version: row.version,
    approved_at: row.approved_at,
    entered_by: auth.user.email,
    confirmed_by_name: row.confirmed_by_name,
    confirmed_by_role: row.confirmed_by_role,
    confirmed_via: row.confirmed_via,
    confirmed_on: row.confirmed_on,
    confirmed_scope: row.confirmed_scope,
    labels_approved: (row.labels ?? []).length,
    // A fresh draft is not created here. The next reviewer starts from the
    // approved set, which the inventory returns.
    draft_remaining: (await getDraft()) !== null,
  });
}
