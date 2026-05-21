// GET /api/submissions/[id]/pdf — generate + stream a submission's PDF.
//
// Auth-guarded. Generates the PDF on-demand, in-memory (no storage, no disk).
// Phase 3 — see PHASE_3_PLAN.md §6.
//
// HIPAA: logs the submission id + outcome only — never PHI or PDF content.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, eq, submissions } from "@workspace/db";
import { requireAuth } from "../../_lib/auth";
import { generateSubmissionPdf } from "../../../lib/pdf/generator";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] as string | undefined;
  if (typeof value === "string") return value;
  return undefined;
}

/** Lowercase, alphanumeric-only — safe for a Content-Disposition filename. */
function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "") || "patient";
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

  try {
    const bytes = await generateSubmissionPdf(row);
    const filename = `drsnip-${safeSlug(row.lastName)}-${row.id.slice(0, 8)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    console.log("submissions/pdf: generated", id);
    return res.send(bytes);
  } catch (err) {
    console.error(
      "submissions/pdf: generation failed",
      id,
      err instanceof Error ? err.name : "UnknownError",
    );
    return res.status(500).json({ error: "PDF generation failed" });
  }
}
