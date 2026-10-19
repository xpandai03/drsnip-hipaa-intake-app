// GET /api/reports/outcomes?form=registration|insurance&from=YYYY-MM&to=YYYY-MM
//
// Monthly outcomes under the client's own definition of "converted" (Jeffrey
// Cho, 2026-09-21; outcome_status_rules v2, migration 0023). Auth-guarded,
// aggregate only, and it never touches a PHI table: it calls
// public.drsnip_conversion_monthly() and public.drsnip_conversion_rules(),
// SECURITY DEFINER functions owned by a restricted NOLOGIN role, with
// small-cell suppression applied inside that boundary.
//
// The caller chooses a form and a span of whole clinic months. It cannot
// supply statuses, profile ids or any other filter.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { firstOf, sqlState } from "../_lib/reporting";
import { CLINIC_TZ, CLINIC_TZ_LABEL } from "../_lib/clinic-time";
import {
  CONVERSION_FORMS,
  OUTCOME_BUCKETS,
  RULE_EXPLANATION,
  isConversionForm,
} from "../../lib/metrics/conversion-rules";

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const EARLIEST_MONTH = "2026-01";
export const MAX_MONTHS = 13;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Share of the covered cohort, one decimal. Null when either side is withheld. */
export function pct(n: number | null, of: number | null): number | null {
  if (n === null || of === null || of <= 0) return null;
  return Math.round((n / of) * 1000) / 10;
}

/** YYYY-MM -> months since year 0, for span arithmetic without Date parsing. */
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthFromIndex = (i: number) =>
  `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;

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
  const from = firstOf(req.query.from);
  const to = firstOf(req.query.to);
  if (!from || !to || !MONTH_RE.test(from) || !MONTH_RE.test(to)) {
    return res.status(400).json({ error: "from and to are required as whole clinic months (YYYY-MM)" });
  }
  if (monthIndex(from) < monthIndex(EARLIEST_MONTH)) {
    return res.status(400).json({ error: "from is before the earliest supported month", earliest: EARLIEST_MONTH });
  }
  if (monthIndex(to) < monthIndex(from)) return res.status(400).json({ error: "from must be <= to" });
  if (monthIndex(to) - monthIndex(from) + 1 > MAX_MONTHS) {
    return res.status(400).json({ error: "period too wide", max_months: MAX_MONTHS });
  }
  const monthFrom = `${from}-01`;
  const monthToExclusive = monthFromIndex(monthIndex(to) + 1);

  try {
    const [m, r] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        -- entry_month as text: the driver turns a SQL date into a local-midnight
        -- JS Date, which is a month early anywhere east of UTC.
        SELECT m.*, m.entry_month::text AS entry_month_text, ec.basis AS cutoff_basis
          FROM public.drsnip_conversion_monthly(${form}::text, ${monthFrom}::date, ${monthToExclusive}::date) m
          CROSS JOIN public.drsnip_evidence_cutoff() ec
      `),
      db.execute<Record<string, unknown>>(sql`SELECT * FROM public.drsnip_conversion_rules()`),
    ]);
    const rows = m.rows;
    const rule = r.rows[0];
    if (!rows.length || !rule) return res.status(500).json({ error: "metric unavailable" });

    const rawCutoff = (rows[0].evidence_cutoff as string | Date | null) ?? null;
    const cutoffMs = rawCutoff ? new Date(rawCutoff).getTime() : null;

    return res.status(200).json({
      form,
      label: CONVERSION_FORMS[form].label,
      unit: "distinct_patient_ids",
      rules: {
        version: rule.version,
        state: rule.state,
        explanation: RULE_EXPLANATION,
        source: rule.source_note,
        confirmed_by: rule.confirmed_by_name,
        confirmed_via: rule.confirmed_via,
        confirmed_on: rule.confirmed_on ? String(rule.confirmed_on).slice(0, 10) : null,
      },
      as_of: {
        evidence_cutoff: cutoffMs === null ? null : new Date(cutoffMs).toISOString(),
        basis: (rows[0].cutoff_basis as string | null) ?? null,
        evidence_age_minutes: cutoffMs === null ? null : Math.round((Date.now() - cutoffMs) / 60000),
      },
      period: { from_month: from, to_month: to, timezone: CLINIC_TZ, timezone_label: CLINIC_TZ_LABEL },
      buckets: OUTCOME_BUCKETS,
      months: rows.map((x) => {
        const covered = num(x.covered);
        const converted = num(x.converted);
        return {
          entry_month: String(x.entry_month_text).slice(0, 7),
          status: x.row_status,
          withheld: (x.withheld as string[] | null) ?? [],
          entry_period_complete: x.entry_period_complete ?? null,
          cohort: {
            total: num(x.cohort_total),
            covered,
            not_covered: num(x.not_covered),
            unlinked_submissions: num(x.unlinked_submissions),
          },
          outcomes: {
            converted,
            not_converted: num(x.not_converted),
            unclassified_only: num(x.unclassified_only),
            no_appointment: num(x.no_appointment),
          },
          converted_pct: pct(converted, covered),
          converted_before_entry: num(x.converted_before_entry),
          repeat_submitters: num(x.repeat_submitters),
        };
      }),
      suppression: {
        threshold: 5,
        note:
          "Withheld inside the database. The four outcomes partition the covered cohort, so a small " +
          "one is withheld together with at least one other.",
      },
    });
  } catch (err) {
    // Drizzle wraps the driver error; sqlState() reads `cause` too.
    const code = sqlState(err);
    if (code === "22023") return res.status(400).json({ error: "unsupported metric parameters" });
    console.error("[reports/outcomes] query failed", code ?? "unknown");
    return res.status(500).json({ error: "metric query failed" });
  }
}
