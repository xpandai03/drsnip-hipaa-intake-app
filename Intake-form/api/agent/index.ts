// READ-ONLY AGENT API — /api/agent/*
//
// What Xpand's clinic agents (the xpand-drsnip-agents app) read from the console,
// and nothing more. See docs/AGENT_API.md for every endpoint, its fields and
// limits.
//
// The guarantees, each enforced here rather than by convention:
//
//   * Its own service token (AGENT_API_TOKEN). Not the console session, not
//     N8N_SERVICE_TOKEN: no other credential opens it, and it opens nothing
//     else. FAIL CLOSED: unset, every route answers 503.
//   * GET only. Any other method, OPTIONS included, gets 405 before anything
//     else runs.
//   * Every query runs in a READ ONLY transaction with statement_timeout 2s and
//     jit off, set per transaction before the query starts (the 2026-10-19
//     outage: see ../_lib/report-query.ts). A write is impossible even by
//     mistake, and a slow query fails fast instead of holding the database.
//   * At most 2 agent queries at a time; more get 429.
//   * The minimum fields, a hard LIMIT in every query, no SELECT *. Never a
//     submission's raw payload, n8n response body, email, phone, date of birth,
//     address, insurance or clinical field, and never submission_files (card
//     bytes). Names and dates only, like the console's own patient lists.
//   * Ids go in the query string, never the path. HIPAA: this module logs the
//     endpoint and the Postgres error code only — never a parameter or a value.

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { NOT_BOOKED_CTE } from "../_lib/not-booked";
import { RESOLVED_LOCATION_SQL } from "../_lib/location";

/** The patient's name as the console's lists show it (first registration's, or the form's own). */
const NAME = `btrim(coalesce(submissions.first_name, '') || ' ' || coalesce(submissions.last_name, ''))`;

/**
 * Every query the agent API runs, by endpoint. Constants, so the tests can read
 * them (api/_test/agent-api.test.ts): each has a LIMIT, none selects a payload,
 * a response body, a contact or clinical field, or a file, and none writes.
 * Parameters are $1.. placeholders, bound by the driver.
 */
export const AGENT_QUERIES = {
  health: `SELECT 1 AS ok LIMIT 1`,
  submissions: `
    SELECT submissions.id::text AS submission_id, submissions.created_at, submissions.form_type, submissions.n8n_status,
           ${NAME} AS name, ${RESOLVED_LOCATION_SQL} AS location
      FROM public.submissions
     WHERE submissions.created_at >= now() - make_interval(days => $1::int)
     ORDER BY submissions.created_at DESC
     LIMIT 51`,
  submission: `
    SELECT submissions.id::text AS submission_id, submissions.created_at, submissions.form_type, submissions.n8n_status,
           ${NAME} AS name, ${RESOLVED_LOCATION_SQL} AS location,
           submissions.n8n_patient_id::text AS chart_id,
           floor(extract(epoch FROM now() - submissions.created_at) / 86400)::int AS days_since
      FROM public.submissions
     WHERE submissions.id = $1::uuid
     LIMIT 1`,
  manualReview: `
    SELECT submissions.id::text AS submission_id, submissions.created_at, submissions.form_type,
           ${NAME} AS name, ${RESOLVED_LOCATION_SQL} AS location,
           floor(extract(epoch FROM now() - submissions.created_at) / 86400)::int AS days_waiting
      FROM public.submissions
     WHERE submissions.n8n_status = 'manual_review'
     ORDER BY submissions.created_at DESC
     LIMIT 51`,
  // The console's own "Not booked: right now" list (NOT_BOOKED_CTE): registered in the last 30 days, nothing
  // booked as of today. Same fields as its drill-down (../_lib/not-booked-list.ts). The path keeps its old name.
  unscheduled: `${NOT_BOOKED_CTE},
sel AS (
  SELECT b.pid, b.entry_at FROM b WHERE b.right_now_not_booked
),
fs AS (
  SELECT DISTINCT ON (s.n8n_patient_id) s.n8n_patient_id::text AS pid, s.first_name, s.last_name
    FROM public.submissions s JOIN sel ON sel.pid = s.n8n_patient_id::text
   WHERE s.form_type = 'registration'
   ORDER BY s.n8n_patient_id, s.created_at, s.id
),
la AS (
  SELECT DISTINCT ON (a.patient_source_id) a.patient_source_id AS pid, a.current_status, a.scheduled_time
    FROM public.appointment_snapshots a JOIN sel ON sel.pid = a.patient_source_id
   WHERE a.deleted_flag IS NOT TRUE
   ORDER BY a.patient_source_id, a.scheduled_time DESC NULLS LAST, a.source_appointment_id DESC
)
SELECT sel.pid AS chart_id,
       btrim(coalesce(fs.first_name, '') || ' ' || coalesce(fs.last_name, '')) AS name,
       to_char(sel.entry_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS registered_on,
       floor(extract(epoch FROM now() - sel.entry_at) / 86400)::int AS days_since,
       (la.pid IS NOT NULL) AS has_appointment,
       nullif(la.current_status, '') AS latest_status,
       to_char(la.scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS latest_date
  FROM sel
  LEFT JOIN fs ON fs.pid = sel.pid
  LEFT JOIN la ON la.pid = sel.pid
 ORDER BY sel.entry_at, sel.pid
 LIMIT 101`,
  appointments: `
    SELECT to_char(a.scheduled_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
           to_char(a.scheduled_time AT TIME ZONE 'UTC', 'HH24:MI') AS time,
           nullif(a.current_status, '') AS status, a.profile_source_id AS type_id
      FROM public.appointment_snapshots a
     WHERE a.patient_source_id = $1::text AND a.deleted_flag IS NOT TRUE
     ORDER BY a.scheduled_time DESC NULLS LAST, a.source_appointment_id DESC
     LIMIT 21`,
  // The console's own conversion-by-cohort aggregate (0024): counts only, small cells withheld by the function.
  cohorts: `
    SELECT c.period_start, c.period_end, c.row_status, c.period_complete, c.forms, c.not_covered, c.converted_now,
           c.fill_p0, c.fill_p1, c.fill_p2, c.fill_p3, c.fill_later, c.withheld
      FROM public.drsnip_conversion_cohorts('registration'::text, $1::text) c
     LIMIT 120`,
} as const;

/** How many rows each list returns at most (its query fetches one more, to say it was cut). */
const CAPS: Record<string, number> = { submissions: 50, manualReview: 50, unscheduled: 100, appointments: 20, cohorts: 120 };

/** Route path → query. No path takes an id: ids are query parameters. */
export const AGENT_ROUTES = {
  health: "health",
  submissions: "submissions",
  submission: "submission",
  "manual-review": "manualReview",
  unscheduled: "unscheduled",
  appointments: "appointments",
  cohorts: "cohorts",
} as const satisfies Record<string, keyof typeof AGENT_QUERIES>;

/* ---------------- The gate ---------------- */

export function agentTokenOk(header: string | undefined, expected: string | undefined = process.env.AGENT_API_TOKEN): boolean {
  const want = expected ?? "";
  const got = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  if (!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(want, "utf8"));
}

/* ---------------- Reading ---------------- */

let inFlight = 0;
const MAX_IN_FLIGHT = 2;
class Busy extends Error {}

/** One query in a READ ONLY transaction, 2 s, jit off. The db module loads only here (so the tests need none). */
async function readOnly(text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  if (inFlight >= MAX_IN_FLIGHT) throw new Busy();
  inFlight++;
  try {
    const { db, sql } = await import("@workspace/db");
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL jit = off"));
      // Bind $1.. in order: the text is a constant from AGENT_QUERIES, the values are validated below.
      const parts = text.split(/\$(\d+)(::[a-z]+)?/);
      const chunks: ReturnType<typeof sql>[] = [];
      for (let i = 0; i < parts.length; i += 3) {
        chunks.push(sql.raw(parts[i]));
        if (i + 1 < parts.length) chunks.push(sql`${params[Number(parts[i + 1]) - 1]}${sql.raw(parts[i + 2] ?? "")}`);
      }
      const res = await tx.execute(sql.join(chunks, sql.raw("")));
      return (res as unknown as { rows: Record<string, unknown>[] }).rows;
    });
  } finally {
    inFlight--;
  }
}

const intParam = (v: string | undefined, lo: number, hi: number, dflt: number) => {
  const n = v && /^\d{1,4}$/.test(v) ? Number(v) : dflt;
  return Math.min(hi, Math.max(lo, n));
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The params for each endpoint, validated; a string is a 400. */
function paramsFor(name: keyof typeof AGENT_QUERIES, q: (k: string) => string | undefined): unknown[] | string {
  switch (name) {
    case "submissions":
      return [intParam(q("days"), 1, 60, 14)];
    case "submission":
      return UUID.test(q("id") ?? "") ? [q("id")] : "id must be a submission id";
    case "appointments":
      return /^\d{1,20}$/.test(q("chart_id") ?? "") ? [q("chart_id")] : "chart_id must be a chart id";
    case "cohorts": {
      const grain = q("grain") ?? "month";
      return grain === "month" || grain === "week" ? [grain] : "grain must be month or week";
    }
    default:
      return [];
  }
}

/** The agent API, mounted at /api/agent in api-server/index.ts before the /api/* 404. */
export const agentApi = new Hono();

agentApi.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET") {
    c.header("Allow", "GET");
    return c.json({ error: "Method not allowed" }, 405);
  }
  if (!process.env.AGENT_API_TOKEN) return c.json({ error: "Agent API not configured" }, 503);
  if (!agentTokenOk(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

for (const [path, name] of Object.entries(AGENT_ROUTES)) {
  agentApi.get(`/${path}`, async (c) => {
    const t0 = Date.now();
    const params = paramsFor(name, (k) => c.req.query(k));
    if (typeof params === "string") return c.json({ error: params }, 400);
    try {
      const rows = await readOnly(AGENT_QUERIES[name], params);
      const cap = CAPS[name];
      const out = cap ? rows.slice(0, cap) : rows;
      return c.json({ rows: out, count: out.length, truncated: cap ? rows.length > cap : false, ms: Date.now() - t0 });
    } catch (err) {
      if (err instanceof Busy) return c.json({ error: "Busy, try again shortly" }, 429);
      const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code ?? "unknown";
      console.error(`[agent-api] ${name} failed`, code);
      return c.json({ error: code === "57014" ? "The query took too long" : "The console couldn't answer" }, code === "57014" ? 504 : 500);
    }
  });
}

agentApi.get("*", (c) => c.json({ error: "No such agent endpoint" }, 404));
