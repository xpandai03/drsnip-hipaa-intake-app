// The Not booked report used to live at /admin/unscheduled. Old bookmarks of
// the page, a list, or a list's CSV are redirected (302) to the same view
// under /admin/not-booked, query preserved and old bucket names mapped
// (legacyListSearch). Nothing is read and nothing is served here; the target
// does its own admin check.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { legacyListSearch } from "../_lib/not-booked-list";

export type LegacyKind = "page" | "list" | "api-list" | "csv";

export function legacyTarget(kind: LegacyKind, query: Record<string, unknown>): string {
  switch (kind) {
    case "page": return "/admin/not-booked";
    case "list": return `/admin/not-booked/list?${legacyListSearch(query)}`;
    case "api-list": return `/api/admin/not-booked/list?${legacyListSearch(query)}`;
    case "csv": return `/api/admin/not-booked/list.csv?${legacyListSearch(query)}`;
  }
}

export function legacyRedirect(kind: LegacyKind) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader("Location", legacyTarget(kind, (req.query ?? {}) as Record<string, unknown>));
    res.setHeader("Cache-Control", "no-store");
    return res.status(302).end();
  };
}
