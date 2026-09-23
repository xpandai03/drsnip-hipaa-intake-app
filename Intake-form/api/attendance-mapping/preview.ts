// POST /api/attendance-mapping/preview — what a draft would produce.
//
// SAME CALCULATION as the published figure. Both call
// `drsnip_attendance_evidence()` (migration 0020); this route reaches it
// through `drsnip_attendance_preview()`, which differs only in taking the label
// set as a parameter and in how it protects the answer.
//
// THE ANSWER IS BANDED, AND THAT IS THE WHOLE POINT.
// An exact preview is a probe: classify one label, preview, unclassify it,
// preview again, and the difference of two totals is a protected group.
// Withholding deltas does not help — the caller holds both numbers. Auditing
// records the attack rather than preventing it. So the preview returns the band
// each count falls in, never the count. The difference of two bands is not the
// difference of two counts.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { canPreviewDefinitions } from "../_lib/permissions";
import { audit, getDraft } from "../_lib/attendance-store";
import { validateLabelSet } from "../../lib/metrics/attendance-contract";
import { sqlState } from "../_lib/reporting";

const METRICS = ["attendance_registration", "attendance_insurance"];
const WINDOWS = [7, 14, 30];

type Row = {
  status: string;
  eligible: number; immature: number; cohort_total: number; band_width: number;
  in_window_low: number | null; in_window_high: number | null;
  untimed_low: number | null; untimed_high: number | null;
  outside_low: number | null; outside_high: number | null;
  not_established_low: number | null; not_established_high: number | null;
  remote_only_low: number | null; remote_only_high: number | null;
  evidence_as_of: string | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!canPreviewDefinitions(auth.user.role)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const parsed = validateLabelSet(b.labels);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const metric = String(b.metric ?? "");
  if (!METRICS.includes(metric)) return res.status(400).json({ error: "invalid metric" });
  const windowDays = Number(b.window ?? 14);
  if (!WINDOWS.includes(windowDays)) return res.status(400).json({ error: "invalid window" });
  const from = String(b.from ?? "");
  const to = String(b.to ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
  }
  const toExclusive = new Date(Date.UTC(
    Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)) + 1,
  )).toISOString().slice(0, 10);

  try {
    const r = await db.execute<Row>(sql`
      SELECT * FROM public.drsnip_attendance_preview(
        ${JSON.stringify(parsed.labels)}::jsonb, ${metric}::text,
        ${from}::date, ${toExclusive}::date, ${windowDays}::int)`);
    const row = r.rows[0];
    if (!row) return res.status(500).json({ error: "preview unavailable" });

    const draft = await getDraft();
    await audit("preview", auth.user.id, draft?.id ?? null, draft?.revision ?? null, {
      metric, window_days: windowDays, status: row.status,
    });

    const band = (lo: number | null, hi: number | null) =>
      lo === null || hi === null ? null : { low: lo, high: hi };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      metric,
      unit: "distinct_patient_ids",
      status: row.status,
      // Echoed so approval can assert it is approving the revision that was
      // previewed, and the exact evidence instant it was previewed against.
      previewed_revision: draft?.revision ?? null,
      evidence_as_of: row.evidence_as_of,
      cohort: { total: row.cohort_total, eligible: row.eligible, immature: row.immature },
      bands: {
        width: row.band_width,
        evidenced_in_window: band(row.in_window_low, row.in_window_high),
        evidenced_untimed: band(row.untimed_low, row.untimed_high),
        evidenced_outside_window: band(row.outside_low, row.outside_high),
        not_established: band(row.not_established_low, row.not_established_high),
        remote_only: band(row.remote_only_low, row.remote_only_high),
      },
      notes: {
        banded:
          "Preview figures are shown as ranges, not exact counts. Exact previews across " +
          "slightly different answers would reveal small groups by subtraction.",
        withheld:
          row.status === "withheld_small_cohort"
            ? "This period has too few eligible patients to preview safely. Widen the period."
            : null,
        untimed:
          "Evidence with no usable arrival time is counted on its own, never inside the window.",
        movement:
          "Confirming more statuses can move patients out of “not established”. Revisions and " +
          "corrections at the source can move figures in either direction.",
      },
      published_unchanged: true,
    });
  } catch (err) {
    const code = sqlState(err);
    if (code === "22023") return res.status(400).json({ error: "unsupported parameters" });
    console.error("[attendance-mapping/preview] failed", code ?? "unknown");
    return res.status(500).json({ error: "preview failed" });
  }
}
