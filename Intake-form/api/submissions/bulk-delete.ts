// POST /api/submissions/bulk-delete — permanently delete a SPECIFIC, explicit
// set of submissions by id (PHI). Used by the admin Submissions console's
// multi-select "Delete selected" action to remove leftover test rows from a
// live table that also holds real patient data.
//
// SAFETY (by design):
//   - Deletes EXACTLY the ids passed in the body — via `inArray(id, ids)`.
//     There is no "delete all" / wildcard / unbounded path anywhere.
//   - Requires a NON-EMPTY array of valid UUIDs; rejects empty/invalid (400).
//   - Capped at MAX_BULK_DELETE per request (400 if exceeded).
//   - ADMIN ONLY, enforced server-side via requireAdmin — the viewer role gets
//     403 (same gate as the single-row DELETE in [id].ts).
//   - `submissions` has no dependent FK rows (nothing references it), so this is
//     a plain row delete with no cascade and no orphans — mirrors single-delete.
//
// HIPAA: audit logs ids + counts + actor only — never any PHI field value.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, inArray, submissions } from "@workspace/db";
import { requireAdmin } from "../_lib/auth";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BULK_DELETE = 200;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Admin-only — viewers get 403 even though the UI hides the control.
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  // Body may arrive parsed (object) or as a raw string depending on the adapter.
  let body: unknown = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }
  const rawIds = (body as { ids?: unknown } | null | undefined)?.ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return res
      .status(400)
      .json({ error: "Provide a non-empty 'ids' array of submission IDs" });
  }

  // Validate + dedupe. Every id must be a UUID; one bad id fails the whole
  // request (no silent partial on malformed input).
  const ids = Array.from(new Set(rawIds));
  if (!ids.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
    return res.status(400).json({ error: "All ids must be valid submission UUIDs" });
  }
  if (ids.length > MAX_BULK_DELETE) {
    return res
      .status(400)
      .json({ error: `Too many ids (max ${MAX_BULK_DELETE} per request)` });
  }

  // Delete EXACTLY these ids. inArray bounds the statement to the provided set —
  // there is no code path that deletes more than what was passed.
  const deleted = await db
    .delete(submissions)
    .where(inArray(submissions.id, ids as string[]))
    .returning({ id: submissions.id });

  // HIPAA: ids + counts + actor only — never PHI.
  console.log(
    "[admin] submissions_bulk_deleted " +
      JSON.stringify({
        ts: new Date().toISOString(),
        actor_email: auth.user.email,
        requested_count: ids.length,
        deleted_count: deleted.length,
        ids,
      }),
  );

  return res.status(200).json({
    success: true,
    requested: ids.length,
    deleted: deleted.length,
    ids: deleted.map((r) => r.id),
  });
}
