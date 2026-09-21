// POST /api/attendance-mapping/withdraw
//
// Takes attendance off the dashboard again. The reason is required and is shown
// on the page: "unavailable" without a reason is the state this whole feature
// was built to replace.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireDefinitionApprover } from "../_lib/auth";
import { withdrawApproved } from "../_lib/attendance-store";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireDefinitionApprover(req, res);
  if (!auth) return;

  const reason = (req.body as { reason?: unknown } | undefined)?.reason;
  if (typeof reason !== "string" || reason.trim().length < 5) {
    return res.status(400).json({
      error: "reason_required",
      message: "Say why this definition is being withdrawn. It is shown on the dashboard.",
    });
  }

  const row = await withdrawApproved(reason.trim(), auth.user.id);
  if (!row) return res.status(404).json({ error: "no approved definition to withdraw" });

  return res.status(200).json({
    withdrawn_version: row.version,
    reason: row.withdrawn_reason,
    withdrawn_by: auth.user.email,
  });
}
