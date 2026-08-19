// GET /api/internal/insurance-pdf/:submissionId — generate + stream the
// Insurance Inquiry summary PDF for the n8n Insurance workflow to upload to the
// patient's DrChrono chart (Train D).
//
// WHY THE APP GENERATES THIS, not an n8n Code node: Registration v2 builds its
// chart PDF inside a ~400-line hand-rolled Code node (no deps are installable
// there). lib/pdf/generator.ts already exists, is typechecked, unit-tested, and
// its own header names this exact use case — "a future n8n -> DrChrono webhook
// handler can call the exact same function". Reusing it keeps one PDF codebase
// instead of a second untestable copy inside a workflow.
//
// Auth: service token only (X-DrSnip-Service-Token), same guard as the card
// endpoints. No session fallback — the console has its own PDF route.
//
// Restricted to form_type='insurance' on purpose: this endpoint exists to serve
// the insurance document branch, and narrowing it means a leaked/misused token
// cannot pull registration or consultation PDFs (which carry full medical
// history) through a route built for benefits data.
//
// HIPAA: the PDF is PHI. Generated in-memory, never written to disk, never
// cached, never logged. Logs carry the submission id + byte length only.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, eq, submissions } from "@workspace/db";
import { requireServiceToken } from "../../_lib/service-auth";
import { generateSubmissionPdf } from "../../../lib/pdf/generator";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireServiceToken(req, res, "internal/insurance-pdf")) return;

  const raw = req.query.submissionId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid submissionId" });
  }

  const [row] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.formType !== "insurance") {
    // Not 403: the caller should treat this the same as "nothing to upload".
    return res.status(404).json({ error: "Not an insurance submission" });
  }

  try {
    const bytes = await generateSubmissionPdf(row);
    console.log(
      "[internal-insurance-pdf] generated " +
        JSON.stringify({
          ts: new Date().toISOString(),
          submission_id: id,
          bytes: bytes.length,
        }),
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="insurance-inquiry-${id.slice(0, 8)}.pdf"`,
    );
    return res.send(Buffer.from(bytes));
  } catch (err) {
    // Never surface PDF internals. The workflow treats a non-200 as "summary
    // unavailable" and continues — the chart is already created.
    console.error(
      "[internal-insurance-pdf] generation failed",
      id,
      err instanceof Error ? err.name : "UnknownError",
    );
    return res.status(500).json({ error: "PDF generation failed" });
  }
}
