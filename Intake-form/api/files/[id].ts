// GET /api/files/:id — stream one stored card image to an authed console user.
//
// Auth-guarded (requireAuth, per console convention). Bytes are served ONLY
// here: private + no-store, inline disposition, no public URL, no signed link,
// and the bytes never appear in any JSON payload or log. Non-stored rows
// (too_large / rejected / failed / historical) 404 — nothing to serve.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, eq, submissionFiles } from "@workspace/db";
import { requireAuth } from "../_lib/auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const [row] = await db
    .select({
      bytes: submissionFiles.bytes,
      mime: submissionFiles.mime,
      status: submissionFiles.status,
      filename: submissionFiles.filename,
    })
    .from(submissionFiles)
    .where(eq(submissionFiles.id, id))
    .limit(1);

  if (!row || row.status !== "stored" || !row.bytes) {
    return res.status(404).json({ error: "Not found" });
  }

  res.setHeader("Content-Type", row.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${(row.filename || "card").replace(/["\r\n]/g, "")}"`,
  );
  return res.status(200).send(row.bytes as unknown as Uint8Array);
}
