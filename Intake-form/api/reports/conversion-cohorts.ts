// GET /api/reports/conversion-cohorts?form=registration|insurance&grain=month|week
//
// Conversion by entry cohort, with a cumulative fill: of the patients whose
// first form came in during period P, the share converted by the end of P,
// P+1, P+2, P+3, and by today. Same read path and auth as Monthly outcomes:
// one SECURITY DEFINER aggregate (public.drsnip_conversion_cohorts, 0024) with
// small-cell suppression inside the database. No patient row leaves it.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "@workspace/db";
import { reportQuery } from "../_lib/report-query";
import { requireAuth } from "../_lib/auth";
import { firstOf, sqlState } from "../_lib/reporting";
import { CLINIC_TZ, CLINIC_TZ_LABEL } from "../_lib/clinic-time";
import {
  CONVERSION_FORMS,
  RULE_EXPLANATION,
  isConversionForm,
} from "../../lib/metrics/conversion-rules";
import { pct } from "./outcomes";

export const GRAINS = ["month", "week"] as const;
export type Grain = (typeof GRAINS)[number];
export const isGrain = (v: unknown): v is Grain => v === "month" || v === "week";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** One fill cell: blank until its period has ended; withheld when small. */
export function fillCell(count: number | null, ended: boolean, of: number | null) {
  if (!ended) return { state: "not_ended" as const, count: null, pct: null };
  if (count === null) return { state: "withheld" as const, count: null, pct: null };
  return { state: "value" as const, count, pct: pct(count, of) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const form = firstOf(req.query.form);
  if (!isConversionForm(form)) {
    return res.status(400).json({ error: "invalid form", allowed: Object.keys(CONVERSION_FORMS) });
  }
  const grain = firstOf(req.query.grain) ?? "month";
  if (!isGrain(grain)) return res.status(400).json({ error: "invalid grain", allowed: GRAINS });

  const started = Date.now();
  try {
    const [m, r] = await Promise.all([
      reportQuery<Record<string, unknown>>(sql`
        SELECT c.*, c.period_start::text AS ps, c.period_end::text AS pe, ec.basis AS cutoff_basis
          FROM public.drsnip_conversion_cohorts(${form}::text, ${grain}::text) c
          CROSS JOIN public.drsnip_evidence_cutoff() ec
      `),
      reportQuery<Record<string, unknown>>(sql`SELECT version, confirmed_by_name, confirmed_on FROM public.drsnip_conversion_rules()`),
    ]);
    const rows = m.rows;
    const rule = r.rows[0];
    if (!rule) return res.status(500).json({ error: "metric unavailable" });
    const rawCutoff = (rows[0]?.evidence_cutoff as string | Date | null) ?? null;
    const cutoffMs = rawCutoff ? new Date(rawCutoff).getTime() : null;

    return res.status(200).json({
      form,
      grain,
      label: CONVERSION_FORMS[form].label,
      unit: "distinct_patient_ids",
      rules: {
        version: rule.version,
        explanation: RULE_EXPLANATION,
        confirmed_by: rule.confirmed_by_name,
        confirmed_on: rule.confirmed_on ? String(rule.confirmed_on).slice(0, 10) : null,
      },
      as_of: {
        evidence_cutoff: cutoffMs === null ? null : new Date(cutoffMs).toISOString(),
        basis: (rows[0]?.cutoff_basis as string | null) ?? null,
        evidence_age_minutes: cutoffMs === null ? null : Math.round((Date.now() - cutoffMs) / 60000),
      },
      timezone: CLINIC_TZ,
      timezone_label: CLINIC_TZ_LABEL,
      columns: ["P+0", "P+1", "P+2", "P+3", "Later"],
      // Newest first, back to the earliest submission of this form.
      periods: rows.map((x) => {
        const forms = num(x.forms);
        const conv = num(x.converted_now);
        return {
          period_start: String(x.ps),
          period_end: String(x.pe),
          status: x.row_status,
          period_complete: x.period_complete ?? null,
          withheld: (x.withheld as string[] | null) ?? [],
          forms,
          not_covered: num(x.not_covered),
          unlinked_submissions: num(x.unlinked_submissions),
          converted_now: { count: conv, pct: pct(conv, forms) },
          fill: [
            fillCell(num(x.fill_p0), Boolean(x.ended_p0), forms),
            fillCell(num(x.fill_p1), Boolean(x.ended_p1), forms),
            fillCell(num(x.fill_p2), Boolean(x.ended_p2), forms),
            fillCell(num(x.fill_p3), Boolean(x.ended_p3), forms),
            fillCell(num(x.fill_later), Boolean(x.ended_p3), forms),
          ],
          converted_before_entry: num(x.converted_before_entry),
        };
      }),
      query_ms: Date.now() - started,
      suppression: { threshold: 5 },
    });
  } catch (err) {
    const code = sqlState(err);
    if (code === "22023") return res.status(400).json({ error: "unsupported metric parameters" });
    console.error("[reports/conversion-cohorts] query failed", code ?? "unknown");
    return res.status(500).json({ error: "metric query failed" });
  }
}
