// GET /api/attendance-mapping/history — every version, and who confirmed it.
//
// Readable by anyone signed in: a figure on the dashboard is produced by a
// definition, and being able to see which one, and who stood behind it, is part
// of being able to trust the figure. Superseded versions keep their full label
// set and are never mutated.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth } from "../_lib/auth";
import { history } from "../_lib/attendance-store";
import { displayLabel } from "../../lib/metrics/attendance-contract";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const rows = await history();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    versions: rows.map((r, i) => {
      const prev = rows[i + 1];
      // What moved between this version and the one before it, so "how has this
      // changed" is answerable without diffing two blobs by eye.
      const before = new Map(
        (prev?.labels ?? []).map((l) => [`${l.source_column}|${l.raw_label ?? "\u0001null"}`, l.classification]),
      );
      const changed = (r.labels ?? [])
        .filter((l) => before.get(`${l.source_column}|${l.raw_label ?? "\u0001null"}`) !== l.classification)
        .map((l) => ({
          display: displayLabel(l.raw_label),
          source_column: l.source_column,
          from: before.get(`${l.source_column}|${l.raw_label ?? "\u0001null"}`) ?? "undecided",
          to: l.classification,
        }));
      return {
        version: r.version,
        state: r.state,
        confirmed_by_name: r.confirmed_by_name,
        confirmed_by_role: r.confirmed_by_role,
        confirmed_via: r.confirmed_via,
        confirmed_on: r.confirmed_on,
        confirmed_scope: r.confirmed_scope,
        approved_at: r.approved_at,
        withdrawn_reason: r.withdrawn_reason,
        note: r.note,
        labels_count: (r.labels ?? []).length,
        changed_from_previous: changed,
      };
    }),
  });
}
