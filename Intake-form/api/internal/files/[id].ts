// GET /api/internal/files/:id — stream one stored card image to the n8n
// Insurance workflow, which pipes it straight into DrChrono's /api/documents.
//
// Built in Train C, CALLED BY NOTHING until Train D. This is the single
// auditable chokepoint for card-byte egress to n8n; the alternative designs
// (base64 in the webhook payload, or a Postgres credential inside n8n) were
// both rejected in FINDINGS-bridge-insurance.md §4.3.
//
// Deliberately a near-copy of api/files/[id].ts — same query, same 404 rule for
// non-stored rows, same no-store headers — differing ONLY in the auth guard
// (service token instead of console session). Kept separate rather than
// parameterizing the existing route so that the console endpoint's auth cannot
// be weakened by a change made for n8n's benefit.
//
// HIPAA: bytes are PHI. Never logged, never cached, never in a JSON body.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, eq, submissionFiles } from "@workspace/db";
import { requireServiceToken } from "../../_lib/service-auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireServiceToken(req, res, "internal/files")) return;

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
