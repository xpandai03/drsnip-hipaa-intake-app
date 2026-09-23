// GET /api/reports/outcomes?metric=outcome_registration|outcome_insurance
//                           &from=YYYY-MM&to=YYYY-MM[&scope=selected_procedure_types]
//
// Where each entry month's patients stand NOW. Auth-guarded, aggregate only,
// and — like /journey and /booking — it never touches a PHI table: it calls
// public.drsnip_outcome_metric() and public.drsnip_outcome_definition(),
// SECURITY DEFINER functions owned by a restricted NOLOGIN role, with
// suppression applied inside that boundary.
//
// The scope and status rules are resolved in the database from an allow-list.
// A caller can name a registered scope; it cannot supply profile ids, statuses
// or any other filter.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { firstOf, sqlState } from "../_lib/reporting";
import { CLINIC_TZ, CLINIC_TZ_LABEL } from "../_lib/clinic-time";
import {
  OUTCOME_METRICS,
  isOutcomeMetric,
  DEFAULT_OUTCOME_SCOPE,
  SCOPE_KEY_RE,
  MONTH_RE,
  EARLIEST_MONTH,
  MAX_MONTHS,
  BUCKETS,
  ROLE_LABELS,
  STATUS_EXPLANATIONS,
  UNKNOWN_REASONS,
  ANNOTATIONS,
  NO_COMBINED_MEASURE,
} from "../../lib/metrics/outcomes";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

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

  const metric = firstOf(req.query.metric);
  if (!isOutcomeMetric(metric)) {
    return res.status(400).json({ error: "invalid metric", allowed: Object.keys(OUTCOME_METRICS) });
  }
  const spec = OUTCOME_METRICS[metric];

  const scope = firstOf(req.query.scope) ?? DEFAULT_OUTCOME_SCOPE;
  if (!SCOPE_KEY_RE.test(scope)) return res.status(400).json({ error: "invalid scope" });

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
    const [m, d] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        -- entry_month as text: the driver turns a SQL date into a local-midnight
        -- JS Date, which is a month early anywhere east of UTC.
        SELECT m.*, m.entry_month::text AS entry_month_text, ec.basis AS cutoff_basis
          FROM public.drsnip_outcome_metric(
            ${spec.fnName}::text, ${scope}::text, ${monthFrom}::date, ${monthToExclusive}::date) m
          CROSS JOIN public.drsnip_evidence_cutoff() ec
      `),
      db.execute<Record<string, unknown>>(sql`
        SELECT * FROM public.drsnip_outcome_definition(${scope}::text)
      `),
    ]);
    const rows = m.rows;
    const defRows = d.rows;
    if (!rows.length || !defRows.length) return res.status(500).json({ error: "metric unavailable" });

    const head = defRows[0];
    const rawCutoff = (rows[0].evidence_cutoff as string | Date | null) ?? null;
    const cutoffMs = rawCutoff ? new Date(rawCutoff).getTime() : null;
    const cutoff = cutoffMs === null ? null : new Date(cutoffMs).toISOString();
    const profiles = defRows.map((r) => ({
      profile_source_id: (r.profile_source_id as string | null) ?? null,
      exact_name: (r.exact_name as string | null) ?? null,
      name_source: (r.name_source as string | null) ?? null,
      name_observed_on: r.name_observed_on ?? null,
      role: r.role as string,
      is_stored: Boolean(r.is_stored),
      stored_appointments: num(r.stored_appointments),
    }));
    const stored = profiles.filter((p) => p.is_stored);

    return res.status(200).json({
      metric,
      metric_version: spec.version,
      label: spec.label,
      counts_what: spec.countsWhat,
      cohort_note: spec.cohortNote,
      unit: "distinct_patient_ids",
      definition: {
        scope_key: head.scope_key,
        scope_version: num(head.scope_version),
        state: head.scope_state,
        // Anything short of an approved scope is a preview, and says so.
        engineering_preview: head.scope_state !== "approved",
        label: head.scope_label,
        description: head.scope_description,
        status_rules: {
          version: head.status_rules_version,
          state: head.status_rules_state,
          rules: head.status_rules,
          source: head.status_rules_source,
        },
        profiles,
        profile_coverage: {
          stored_profile_ids: stored.length,
          stored_with_verified_name: stored.filter((p) => p.exact_name !== null).length,
          stored_unknown_meaning: stored.filter((p) => p.role === "unknown_profile").length,
          note:
            "Names were read from DrChrono's Custom Appointment Profiles settings page on the date shown; " +
            "they are metadata, not an approved reporting definition. A profile the scope does not list " +
            "is 'unknown_profile' — unknown, not excluded.",
        },
      },
      as_of: {
        evidence_cutoff: cutoff,
        // Same source as the freshness badge (0022): the practice-wide hourly
        // sync's watermark, never one patient's catch-up read.
        basis: (rows[0].cutoff_basis as string | null) ?? null,
        evidence_age_minutes: cutoffMs === null ? null : Math.round((Date.now() - cutoffMs) / 60000),
        note:
          "Appointment data is complete to at least this instant for every patient counted. Some " +
          "records may already include later changes. 'Currently scheduled' means booked for after it.",
      },
      period: { from_month: from, to_month: to, timezone: CLINIC_TZ, timezone_label: CLINIC_TZ_LABEL },
      buckets: BUCKETS,
      role_labels: ROLE_LABELS,
      status_explanations: STATUS_EXPLANATIONS,
      unknown_reasons: UNKNOWN_REASONS,
      annotations: ANNOTATIONS,
      no_combined_measure: NO_COMBINED_MEASURE,
      months: rows.map((r) => ({
        entry_month: String(r.entry_month_text).slice(0, 7),
        status: r.row_status,
        withheld: (r.withheld as string[] | null) ?? [],
        observation: {
          entry_period_complete: r.entry_period_complete ?? null,
          days_observed_min: num(r.days_observed_min),
          days_observed_max: num(r.days_observed_max),
          note:
            "How long the youngest and oldest possible entrant has been observed. Recent months are " +
            "not yet comparable with older ones.",
        },
        cohort: {
          total: num(r.cohort_total),
          covered: num(r.covered),
          not_covered: num(r.not_covered),
          unlinked_submissions: num(r.unlinked_submissions),
        },
        outcomes: {
          completed: num(r.completed),
          scheduled: num(r.scheduled),
          unknown: num(r.unknown),
          neither: num(r.neither),
        },
        neither_breakdown: {
          no_qualifying_record: num(r.neither_no_qualifying_record),
          had_qualifying_record: num(r.neither_had_qualifying_record),
        },
        unknown_reasons: {
          past_dated_open: num(r.unknown_past_dated_open),
          status_unresolved: num(r.unknown_status_unresolved),
          rescheduled_no_replacement: num(r.unknown_rescheduled_no_replacement),
          conflicting_history: num(r.unknown_conflicting_history),
          deleted_completion: num(r.unknown_deleted_completion),
          undecided_profile: num(r.unknown_undecided_profile),
          unknown_profile: num(r.unknown_unknown_profile),
          overlapping: true,
        },
        annotations: {
          completed_with_future_booking: num(r.completed_with_future_booking),
          completed_review_withheld_only: num(r.completed_review_withheld_only),
          procedure_not_performed: num(r.procedure_not_performed),
          comparison_completed: num(r.comparison_completed),
          comparison_scheduled: num(r.comparison_scheduled),
          positive_booked_before_entry: num(r.positive_booked_before_entry),
          prior_completion_before_entry: num(r.prior_completion_before_entry),
          registered_before_inquiry: metric === "outcome_insurance" ? num(r.registered_before_inquiry) : null,
          repeat_submitters: num(r.repeat_submitters),
          overlapping: true,
        },
      })),
      suppression: {
        threshold: 5,
        note:
          "Withheld inside the database. The four outcomes partition the covered cohort, so a small " +
          "one is withheld with at least one other; when that happens every outcome annotation in " +
          "the month is withheld too. Months are whole clinic months so two requests cannot be " +
          "subtracted to isolate a day.",
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
