// GET /api/internal/submission-files/:submissionId — list the stored card files
// for one submission, for the n8n Insurance workflow.
//
// Built in Train C, CALLED BY NOTHING until Train D wires the DrChrono document
// uploads. It exists now because the card-transport decision determines the
// Train C payload contract: the insurance payload carries no card bytes
// precisely because n8n can dereference them here instead
// (FINDINGS-bridge-insurance.md §4 option C).
//
// Auth: service token only (X-DrSnip-Service-Token). No session fallback — a
// console user has /api/submissions/:id for the same metadata.
//
// HIPAA: returns METADATA only (id, kind, filename, mime, size, status). Bytes
// are never in this response; they stream one-at-a-time from
// /api/internal/files/:id. Logs carry the submission id + counts only — never
// filenames, which can carry identifiers.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, desc, eq, submissionFiles } from "@workspace/db";
import { requireServiceToken } from "../../_lib/service-auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireServiceToken(req, res, "internal/submission-files")) return;

  const raw = req.query.submissionId;
  const submissionId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof submissionId !== "string" || !UUID_RE.test(submissionId)) {
    return res.status(400).json({ error: "Invalid submissionId" });
  }

  const rows = await db
    .select({
      id: submissionFiles.id,
      kind: submissionFiles.kind,
      filename: submissionFiles.filename,
      mime: submissionFiles.mime,
      sizeBytes: submissionFiles.sizeBytes,
      status: submissionFiles.status,
    })
    .from(submissionFiles)
    .where(eq(submissionFiles.submissionId, submissionId))
    .orderBy(desc(submissionFiles.createdAt));

  // Only 'stored' rows have bytes behind them; the rest are honest markers for
  // files that were too large / rejected / undecodable. n8n should upload the
  // stored ones and ignore the others, so hand it both the full list and a
  // ready-made filtered view rather than making a Code node do it.
  const stored = rows.filter((r) => r.status === "stored");

  console.log(
    "[internal-files] list " +
      JSON.stringify({
        ts: new Date().toISOString(),
        submission_id: submissionId,
        total: rows.length,
        stored: stored.length,
      }),
  );

  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({
    submissionId,
    hasCards: stored.length > 0,
    storedCount: stored.length,
    files: stored,
    // Non-uploadable rows, surfaced so the workflow can report an honest
    // "card present but not transferable" state instead of silently dropping.
    skipped: rows
      .filter((r) => r.status !== "stored")
      .map((r) => ({ id: r.id, kind: r.kind, status: r.status })),
  });
}
