// Curated, AGGREGATE-ONLY reporting tools over the DrSnip intake data.
//
// PHI POSTURE (locked): these tools query the PHI-free `drsnip_reporting_view`
// via the read-only `drsnip_reporting_ro` role, which has NO access to the base
// `submissions` table. There is deliberately NO record-level tool, NO free-form
// SQL escape hatch, and NO include_pii flag. Every result is a COUNT or a ratio.
// No individual patient's name, DOB, contact info, medical answer, address, or
// insurance id can be returned — the database itself cannot hand them to us.
//
// Additional guardrails here:
//   • Grouping dimensions come from a fixed allow-list (never user SQL).
//   • Filters are bound as parameters ($1,$2…), never concatenated.
//   • Minimum-cell suppression: any group count < 5 renders as "<5".
//   • Every tool call is audit-logged (tool + args + timestamp; args are
//     dimension/filter labels only — never PHI, since none is reachable).
import { readQuery } from "./db.js";

const VIEW = "drsnip_reporting_view";
const SUPPRESS_BELOW = 5;

// ── Allow-listed grouping dimensions → safe SQL expressions over the view ────
// `how_heard` is handled specially (jsonb array unnest) in drsnip_counts.
const DIMENSIONS = {
  form_type: "form_type",
  n8n_status: "coalesce(n8n_status, 'pending')",
  office_location: "office_location",
  insurance_coverage: "insurance_coverage",
  action_label: "action_label",
  day: "date_trunc('day', created_at)::date",
  week: "date_trunc('week', created_at)::date",
  month: "date_trunc('month', created_at)::date",
};

// ── Parameterized filters (all bound; nothing concatenated) ─────────────────
function buildFilters(args, startIndex = 1) {
  const clauses = [];
  const params = [];
  let i = startIndex;
  if (args.form_type) {
    clauses.push(`form_type = $${i++}`);
    params.push(args.form_type);
  }
  if (args.n8n_status) {
    clauses.push(`coalesce(n8n_status,'pending') = $${i++}`);
    params.push(args.n8n_status);
  }
  if (args.office_location) {
    clauses.push(`office_location = $${i++}`);
    params.push(args.office_location);
  }
  if (args.insurance_coverage) {
    clauses.push(`insurance_coverage = $${i++}`);
    params.push(args.insurance_coverage);
  }
  if (args.action_label) {
    clauses.push(`action_label = $${i++}`);
    params.push(args.action_label);
  }
  if (args.date_from) {
    clauses.push(`created_at >= $${i++}`);
    params.push(args.date_from);
  }
  if (args.date_to) {
    // created_at is a DATE in the view; treat date_to as inclusive.
    clauses.push(`created_at <= $${i++}`);
    params.push(args.date_to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params, nextIndex: i };
}

// ── Minimum-cell suppression ────────────────────────────────────────────────
// Any count below the threshold is rendered as "<5" so a rare combination can
// never be pinned to a small number of individuals. Applied to every count
// value that leaves a tool.
function suppress(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return n;
  return v > 0 && v < SUPPRESS_BELOW ? `<${SUPPRESS_BELOW}` : v;
}
function suppressRows(rows, countKeys = ["n"]) {
  return rows.map((r) => {
    const out = { ...r };
    for (const k of countKeys) if (k in out) out[k] = suppress(out[k]);
    return out;
  });
}

// ── Audit log (no PHI — args are labels/filters over a PHI-free view) ───────
function audit(tool, args) {
  try {
    process.stderr.write(
      `[drsnip-reporting][audit] ${JSON.stringify({
        ts: new Date().toISOString(),
        tool,
        args: args ?? {},
      })}\n`,
    );
  } catch {
    /* never let logging break a tool */
  }
}

const POSTURE_NOTE =
  "AGGREGATE-ONLY. This connector can return counts and ratios only. It queries a " +
  "PHI-free database view through a read-only role that cannot read patient names, " +
  "DOB, contact info, addresses, insurance IDs, medical answers, or the DrChrono " +
  "patient id. Group counts below 5 are shown as '<5'.";

const FILTER_PROPS = {
  form_type: { type: "string", enum: ["registration", "consultation"] },
  n8n_status: { type: "string", enum: ["success", "manual_review", "failed", "pending"] },
  office_location: { type: "string", description: "e.g. 'Seattle, WA' (registration only)" },
  insurance_coverage: { type: "string", description: "Own | Partner's | Both | No Insurance (registration only)" },
  action_label: {
    type: "string",
    enum: ["create", "update", "matched", "manual_review", "failed", "pending", "unknown"],
    description: "new=create; returning=update (reg) or matched (consultation)",
  },
  date_from: { type: "string", description: "YYYY-MM-DD inclusive" },
  date_to: { type: "string", description: "YYYY-MM-DD inclusive" },
};

// ───────────────────────────── tools ──────────────────────────────────────

export const drsnipTools = [
  {
    name: "drsnip_data_notes",
    description:
      "Read this FIRST. Explains the DrSnip intake data model available to this connector, the AGGREGATE-ONLY / PHI-free posture, the meaning of the new-vs-returning action label, and reporting caveats. No arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      audit("drsnip_data_notes", {});
      return {
        source:
          "DrSnip patient-intake application database (Fly Postgres), projected through a PHI-free reporting view.",
        grain: "One row per intake form submission (registration or consultation).",
        posture: POSTURE_NOTE,
        available_fields: {
          form_type: "'registration' | 'consultation'",
          n8n_status: "'success' | 'manual_review' | 'failed' | 'pending'(not yet reported)",
          action_label:
            "new-vs-returning label: 'create' (new patient), 'update' (returning registration), 'matched' (returning consultation), 'manual_review', 'failed', 'pending'.",
          office_location: "Seattle,WA | Portland,OR | Plano,TX — registration only",
          insurance_coverage: "Own | Partner's | Both | No Insurance — registration only",
          how_heard: "marketing/how-heard channel labels — consultation only (array)",
          created_at: "submission DATE (day precision; sub-day dropped)",
          latency: "observed_latency_seconds / bridge_elapsed_ms — pipeline timing",
          failure_mode: "diag_kind ('http'|'fetch'|'config') + diag_http_status",
        },
        caveats: {
          counts_are_submissions:
            "Counts are of SUBMISSIONS, not unique people. A returning patient can appear more than once.",
          cell_suppression: "Any group count below 5 is shown as '<5'.",
          registration_vs_consultation:
            "office_location & insurance_coverage exist only on registration rows; how_heard only on consultation rows.",
          no_marketing_on_registration:
            "Registration has no how-heard field; its channel attribution is external (link ?source=) and not in this dataset.",
          returning_definition:
            "Consultations always attach to an existing chart, so a consultation success = returning ('matched'). Registration create=new, update=returning.",
        },
      };
    },
  },

  {
    name: "drsnip_overview",
    description:
      "High-level snapshot: total submissions, date range, and breakdowns by form type, sync status, and new-vs-returning action label. Good first call for 'how are we doing overall'. Optional filters. Aggregates only.",
    inputSchema: {
      type: "object",
      properties: {
        form_type: FILTER_PROPS.form_type,
        date_from: FILTER_PROPS.date_from,
        date_to: FILTER_PROPS.date_to,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      audit("drsnip_overview", args);
      const f = buildFilters(args);
      const [tot] = await readQuery(
        `SELECT count(*)::int n, min(created_at) lo, max(created_at) hi FROM ${VIEW} ${f.where}`,
        f.params,
      );
      const byForm = await readQuery(
        `SELECT form_type, count(*)::int n FROM ${VIEW} ${f.where} GROUP BY 1 ORDER BY 2 DESC`,
        f.params,
      );
      const byStatus = await readQuery(
        `SELECT coalesce(n8n_status,'pending') n8n_status, count(*)::int n FROM ${VIEW} ${f.where} GROUP BY 1 ORDER BY 2 DESC`,
        f.params,
      );
      const byAction = await readQuery(
        `SELECT action_label, count(*)::int n FROM ${VIEW} ${f.where} GROUP BY 1 ORDER BY 2 DESC`,
        f.params,
      );
      return {
        total_submissions: suppress(tot.n),
        date_range: { from: tot.lo, to: tot.hi },
        by_form_type: suppressRows(byForm),
        by_sync_status: suppressRows(byStatus),
        by_action_label: suppressRows(byAction),
        note: POSTURE_NOTE,
      };
    },
  },

  {
    name: "drsnip_counts",
    description:
      "Count submissions grouped by ONE allow-listed dimension, with optional filters. dimension ∈ {form_type, n8n_status, office_location, insurance_coverage, action_label, how_heard, day, week, month}. Use for 'submissions per week', 'by office', 'how-heard breakdown', 'new vs returning'. Aggregates only; counts <5 shown as '<5'.",
    inputSchema: {
      type: "object",
      properties: {
        dimension: {
          type: "string",
          enum: [...Object.keys(DIMENSIONS), "how_heard"],
        },
        ...FILTER_PROPS,
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["dimension"],
      additionalProperties: false,
    },
    handler: async (args) => {
      audit("drsnip_counts", args);
      const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
      const f = buildFilters(args);

      if (args.dimension === "how_heard") {
        // Consultation-only jsonb array → unnest safely (guard non-arrays).
        const rows = await readQuery(
          `SELECT elem AS how_heard, count(*)::int n
             FROM ${VIEW} v
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(v.how_heard)='array' THEN v.how_heard ELSE '[]'::jsonb END
             ) AS elem
           ${f.where}
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${limit}`,
          f.params,
        );
        return {
          dimension: "how_heard",
          rows: suppressRows(rows),
          note: "Consultation-only. One row per selected channel; a patient can pick several, so channel counts can exceed submissions.",
        };
      }

      const expr = DIMENSIONS[args.dimension];
      if (!expr) throw new Error(`unknown dimension: ${args.dimension}`);
      const rows = await readQuery(
        `SELECT (${expr})::text AS ${args.dimension}, count(*)::int n
           FROM ${VIEW} ${f.where}
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${limit}`,
        f.params,
      );
      return { dimension: args.dimension, rows: suppressRows(rows), note: POSTURE_NOTE };
    },
  },

  {
    name: "drsnip_outcomes",
    description:
      "Pipeline outcome health: success / manual-review / failed / pending counts + rates, and a failure-mode breakdown (by transport kind + HTTP status). Answers 'what's our manual-review rate' and 'why are submissions failing'. Optional filters. Aggregates only.",
    inputSchema: {
      type: "object",
      properties: {
        form_type: FILTER_PROPS.form_type,
        date_from: FILTER_PROPS.date_from,
        date_to: FILTER_PROPS.date_to,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      audit("drsnip_outcomes", args);
      const f = buildFilters(args);
      const [row] = await readQuery(
        `SELECT
            count(*)::int total,
            count(*) FILTER (WHERE n8n_status = 'success')::int success,
            count(*) FILTER (WHERE n8n_status = 'manual_review')::int manual_review,
            count(*) FILTER (WHERE n8n_status = 'failed')::int failed,
            count(*) FILTER (WHERE n8n_status IS NULL)::int pending
         FROM ${VIEW} ${f.where}`,
        f.params,
      );
      const total = row.total || 0;
      const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
      const failModes = await readQuery(
        `SELECT coalesce(diag_kind,'(none)') diag_kind, coalesce(diag_http_status,'(none)') http_status, count(*)::int n
           FROM ${VIEW} ${f.where ? f.where + " AND" : "WHERE"} n8n_status = 'failed'
           GROUP BY 1,2 ORDER BY 3 DESC`,
        f.params,
      );
      return {
        total_submissions: suppress(total),
        outcomes: {
          success: { count: suppress(row.success), rate_pct: pct(row.success) },
          manual_review: { count: suppress(row.manual_review), rate_pct: pct(row.manual_review) },
          failed: { count: suppress(row.failed), rate_pct: pct(row.failed) },
          pending: { count: suppress(row.pending), rate_pct: pct(row.pending) },
        },
        failure_modes: suppressRows(failModes),
        note: "Rates are % of total in the filtered window. " + POSTURE_NOTE,
      };
    },
  },

  {
    name: "drsnip_returning",
    description:
      "New vs returning patients, from the action label. new = create; returning = update (registration) or matched (consultation). Optionally split by form type. Answers 'how many returning patients this week'. Aggregates only.",
    inputSchema: {
      type: "object",
      properties: {
        split_by_form: { type: "boolean", description: "break new/returning down by form type" },
        form_type: FILTER_PROPS.form_type,
        date_from: FILTER_PROPS.date_from,
        date_to: FILTER_PROPS.date_to,
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      audit("drsnip_returning", args);
      const f = buildFilters(args);
      const grp = args.split_by_form ? "form_type," : "";
      const rows = await readQuery(
        `SELECT ${grp}
            count(*) FILTER (WHERE action_label = 'create')::int new_patients,
            count(*) FILTER (WHERE action_label IN ('update','matched'))::int returning_patients,
            count(*) FILTER (WHERE action_label = 'manual_review')::int manual_review,
            count(*) FILTER (WHERE action_label = 'failed')::int failed,
            count(*) FILTER (WHERE action_label = 'pending')::int pending
         FROM ${VIEW} ${f.where} ${args.split_by_form ? "GROUP BY 1 ORDER BY 1" : ""}`,
        f.params,
      );
      const keys = ["new_patients", "returning_patients", "manual_review", "failed", "pending"];
      return {
        split_by_form: !!args.split_by_form,
        rows: suppressRows(rows, keys),
        note: "Returning = update (registration) + matched (consultation). " + POSTURE_NOTE,
      };
    },
  },

  {
    name: "drsnip_marketing",
    description:
      "How-heard / marketing-channel breakdown from the consultation form (the only form that asks). Answers 'where are consultation patients coming from'. A patient can select multiple channels. Aggregates only; counts <5 shown as '<5'.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: FILTER_PROPS.date_from,
        date_to: FILTER_PROPS.date_to,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      audit("drsnip_marketing", args);
      const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
      // Force consultation form (only form with how_heard).
      const f = buildFilters({ ...args, form_type: "consultation" });
      const rows = await readQuery(
        `SELECT elem AS channel, count(*)::int n
           FROM ${VIEW} v
           CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(v.how_heard)='array' THEN v.how_heard ELSE '[]'::jsonb END
           ) AS elem
         ${f.where}
         GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${limit}`,
        f.params,
      );
      return {
        channels: suppressRows(rows),
        note:
          "Consultation form only. Channel counts can exceed submission counts (multi-select). " +
          POSTURE_NOTE,
      };
    },
  },
];
