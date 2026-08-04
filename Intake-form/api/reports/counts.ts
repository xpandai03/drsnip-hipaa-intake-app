// GET /api/reports/counts?dimension=<dim>&from=YYYY-MM-DD&to=YYYY-MM-DD&form_type=<ft>
//
// Aggregate-only. Counts submissions grouped by ONE allow-listed dimension.
// Auth-guarded. Every returned group cell passes through <5 suppression.
//
// dimension ∈ {form_type, n8n_status, office_location, insurance_coverage,
//              action_label, how_heard, day, week, month}
// how_heard is consultation-only (jsonb array unnest; multi-select, so channel
// counts can exceed submission counts).
//
// PHI: selects only non-identifying categoricals + counts (see api/_lib/reporting.ts).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import {
  DIMENSION_EXPR,
  ALLOWED_FORM_TYPES,
  isAllowedDimension,
  suppressRows,
  buildWhere,
  parseDateUtc,
  addDaysUtc,
  firstOf,
} from "../_lib/reporting";

const LIMIT = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const dimension = firstOf(req.query.dimension);
  if (!isAllowedDimension(dimension)) {
    return res.status(400).json({
      error: "invalid dimension",
      allowed: [...Object.keys(DIMENSION_EXPR), "how_heard"],
    });
  }

  const formTypeParam = firstOf(req.query.form_type);
  if (formTypeParam && !ALLOWED_FORM_TYPES.includes(formTypeParam)) {
    return res.status(400).json({ error: "invalid form_type" });
  }

  const from = parseDateUtc(req.query.from);
  const toDay = parseDateUtc(req.query.to);
  const toExclusive = toDay ? addDaysUtc(toDay, 1) : undefined; // inclusive day
  if (from && toExclusive && from.getTime() >= toExclusive.getTime()) {
    return res.status(400).json({ error: "from must be <= to" });
  }

  // ── how_heard: consultation-only jsonb array unnest ──────────────────────
  if (dimension === "how_heard") {
    if (formTypeParam && formTypeParam !== "consultation") {
      return res.status(200).json({
        dimension,
        rows: [],
        suppressed_cells: 0,
        note: "how_heard is collected on the consultation form only; no rows for the requested form_type.",
      });
    }
    const where = buildWhere({ formType: "consultation", from, toExclusive });
    const result = await db.execute<{ value: string | null; count: number }>(sql`
      SELECT elem AS value, count(*)::int AS count
      FROM submissions v
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(v.raw_payload->'howHeard') = 'array'
             THEN v.raw_payload->'howHeard' ELSE '[]'::jsonb END
      ) AS elem
      ${where}
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
      LIMIT ${LIMIT}
    `);
    const { rows, suppressed_cells } = suppressRows(result.rows);
    return res.status(200).json({
      dimension,
      rows,
      suppressed_cells,
      note: "Consultation form only. Multi-select: channel counts can exceed submission counts.",
    });
  }

  // ── standard dimension (trusted expression from the allow-list) ──────────
  const expr = DIMENSION_EXPR[dimension];
  const where = buildWhere({ formType: formTypeParam, from, toExclusive });
  const result = await db.execute<{ value: string | null; count: number }>(sql`
    SELECT (${sql.raw(expr)})::text AS value, count(*)::int AS count
    FROM submissions
    ${where}
    GROUP BY 1
    ORDER BY 2 DESC, 1 ASC
    LIMIT ${LIMIT}
  `);
  const { rows, suppressed_cells } = suppressRows(result.rows);
  return res.status(200).json({ dimension, rows, suppressed_cells });
}
