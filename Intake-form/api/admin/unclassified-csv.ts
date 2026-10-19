// GET /admin/conversion/unclassified.csv — admin only.
//
// Every live DrChrono appointment whose status is blank or otherwise
// Unclassified under the clinic's rules, as a CSV of IDs (see
// api/_lib/unclassified-export.ts). Signed out: 401. Viewer: 403. Each download
// is ledgered (notification_events, kind export_unclassified) with the user id
// and the row count — never any content.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@workspace/db";
import { requireAdmin } from "../_lib/auth";
import { sqlState } from "../_lib/reporting";
import { reportQuery } from "../_lib/report-query";
import {
  UNCLASSIFIED_SQL,
  buildUnclassifiedCsv,
  type UnclassifiedRow,
} from "../_lib/unclassified-export";
import { record as recordNotification } from "../../lib/notifications/ledger";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  let rows: UnclassifiedRow[];
  try {
    const r = await reportQuery<UnclassifiedRow>(sql.raw(UNCLASSIFIED_SQL));
    rows = r.rows;
  } catch (err) {
    console.error("[admin/unclassified-csv] query failed", sqlState(err) ?? "unknown");
    return res.status(500).json({ error: "export failed" });
  }

  const csv = buildUnclassifiedCsv(rows);
  await recordNotification({
    channel: "export",
    kind: "export_unclassified",
    recipientClass: "staff",
    outcome: "sent",
    detail: `user=${auth.user.id} rows=${rows.length}`,
  });

  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="drsnip-unclassified-appointments-${day}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(csv);
}
