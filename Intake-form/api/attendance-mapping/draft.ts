// GET/PUT /api/attendance-mapping/draft — the working classification set.
//
// A draft has NO effect on any published figure. The published path resolves
// `state = 'approved'` inside the database, so a draft is invisible to it by
// construction rather than by a flag somebody could forget to check.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth } from "../_lib/auth";
import { canEditDefinitionDraft } from "../_lib/permissions";
import { getDraft, saveDraft } from "../_lib/attendance-store";
import { validateLabelSet, summariseLabels } from "../../lib/metrics/attendance-contract";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (req.method === "GET") {
    const draft = await getDraft();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft: draft
        ? { revision: draft.revision, labels: draft.labels, updated_at: draft.updated_at }
        : null,
      can_edit: canEditDefinitionDraft(auth.user.role),
    });
  }

  if (req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Server-side gate. UI hiding is convenience; this is the boundary.
  if (!canEditDefinitionDraft(auth.user.role)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = (req.body ?? {}) as { labels?: unknown; revision?: unknown };
  const parsed = validateLabelSet(body.labels);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const revision =
    body.revision === null || body.revision === undefined ? null : Number(body.revision);
  if (revision !== null && !Number.isInteger(revision)) {
    return res.status(400).json({ error: "revision must be an integer or null" });
  }

  const result = await saveDraft(parsed.labels, revision, auth.user.id);
  if (!result.ok) {
    // Somebody else edited. Refusing is right: merging two people's opinions
    // about what a status means produces a mapping neither of them agreed to.
    return res.status(409).json({
      error: "stale_draft",
      message: "Someone else changed this draft while you were editing.",
      current_revision: result.conflict.revision,
      current_labels: result.conflict.labels,
    });
  }
  return res.status(200).json({
    revision: result.row.revision,
    updated_at: result.row.updated_at,
    summary: summariseLabels(parsed.labels),
    published_unchanged: true,
  });
}
