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
  firstOf,
} from "../_lib/reporting";
import { isAllowedLocation } from "../_lib/location";
import { CLINIC_TZ, CLINIC_TZ_LABEL, resolveClinicWindow } from "../_lib/clinic-time";

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

  // CLINIC days (Pacific), matching the exports. These were UTC days.
  const window = resolveClinicWindow(firstOf(req.query.from), firstOf(req.query.to));
  if (window.invalid) {
    return res.status(400).json({ error: "from must be <= to" });
  }
  const from = window.from;
  const toExclusive = window.toExclusive;

  const locationParam = firstOf(req.query.location);
  const location = isAllowedLocation(locationParam) ? locationParam : undefined;

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
    const where = buildWhere({
      formType: "consultation",
      from,
      toExclusive,
      location,
    });
    // The table MUST stay UNALIASED: the location filter inside buildWhere
    // embeds RESOLVED_LOCATION_SQL, whose correlation is written with literal
    // `submissions.<col>` qualifiers (see the note in api/_lib/location.ts).
    // Aliasing this to `v` — as it was — makes those qualifiers unresolvable.
    const result = await db.execute<{ value: string | null; count: number }>(sql`
      SELECT elem AS value, count(*)::int AS count
      FROM submissions
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(submissions.raw_payload->'howHeard') = 'array'
             THEN submissions.raw_payload->'howHeard' ELSE '[]'::jsonb END
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
      scope: {
        form_type: "consultation",
        from: window.fromDay ?? null,
        to: window.toDay ?? null,
        location: location ?? null,
        timezone: CLINIC_TZ,
        timezone_label: CLINIC_TZ_LABEL,
        unit: "selections",
      },
      note: "Consultation form only. Multi-select: channel counts can exceed submission counts.",
    });
  }

  // ── standard dimension (trusted expression from the allow-list) ──────────
  const expr = DIMENSION_EXPR[dimension];
  const where = buildWhere({
    formType: formTypeParam,
    from,
    toExclusive,
    location,
  });
  const result = await db.execute<{ value: string | null; count: number }>(sql`
    SELECT (${sql.raw(expr)})::text AS value, count(*)::int AS count
    FROM submissions
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
    scope: {
      form_type: formTypeParam ?? null,
      from: window.fromDay ?? null,
      to: window.toDay ?? null,
      location: location ?? null,
      timezone: CLINIC_TZ,
      timezone_label: CLINIC_TZ_LABEL,
      unit: "submissions",
    },
  });
}
