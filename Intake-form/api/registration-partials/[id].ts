// DELETE /api/registration-partials/:id — remove one drop-off (admin only).
// Hard delete (no soft-delete/flagging).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, eq, registrationPartials } from "@workspace/db";
import { requireAdmin } from "../_lib/auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  await db.delete(registrationPartials).where(eq(registrationPartials.id, id));
  return res.status(200).json({ ok: true });
}
