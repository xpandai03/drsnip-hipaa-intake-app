// GET /api/reports/freshness
//
// The one cheap call the console makes FIRST, so a page can say how current its
// data is before any metric has finished loading.
//
// WHY IT EXISTS. The journey page used to get its freshness by asking for a
// full journey metric and reading the `freshness` block off the side of it.
// That call took six seconds, so for six seconds the page rendered
// "Appointment snapshot — last refreshed unknown" — a sentence that is not true
// and that a reader has no way to tell apart from a genuinely missing
// timestamp. This route calls drsnip_journey_freshness() and nothing else; it
// returns in single-digit milliseconds.
//
// NO PHI. Aggregate timestamps, counts and run state. The function is the same
// SECURITY DEFINER boundary every other reporting route goes through.
//
// NOT CACHED, deliberately, and marked no-store: freshness that is itself stale
// is worse than no freshness at all.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";

type FreshRow = {
  intake_latest_at: string | null;
  appointments_synced_at: string | null;
  appointment_sync_active: boolean;
  history_complete_patients: number | null;
  linked_patients: number | null;
  awaiting_catchup: number | null;
  sync_last_success_at: string | null;
  sync_last_attempt_at: string | null;
  sync_run_state: string;
  sync_cursor_lag_seconds: number | null;
  sync_expected_interval_minutes: number | null;
  sync_schedule_enabled: boolean;
  sync_failed_runs_24h: number | null;
};

type HealthRow = {
  schedule_key: string;
  scope_key: string;
  enabled: boolean;
  cadence: string;
  expected_interval_minutes: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_outcome: string | null;
  run_state: string;
  watermark: string | null;
  cursor_lag_seconds: number | null;
  runs_failed_24h: number;
  runs_partial_24h: number;
  recurring_active: boolean;
};

/**
 * How the appointment snapshot should be described, in one word the UI can
 * branch on without re-deriving the rules.
 *
 *   live    — a scheduled run succeeded inside its expected cadence.
 *   late    — sync is switched on but the last success is older than that.
 *   paused  — the schedule exists and is switched off.
 *   manual  — no schedule at all; the data is a hand-refreshed snapshot.
 *   never   — nothing has ever been synced.
 *
 * "late" is NOT an error. The numbers on the page are still real; they are
 * simply as at an older instant, which is exactly what the timestamp says.
 */
function classify(f: FreshRow): "live" | "late" | "paused" | "manual" | "never" {
  if (!f.appointments_synced_at) return "never";
  if (f.sync_run_state === "not_scheduled") return "manual";
  if (!f.sync_schedule_enabled) return "paused";
  return f.appointment_sync_active ? "live" : "late";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const [fresh, health] = await Promise.all([
      // One statement, so the timestamp and the basis it came from agree (0022).
      db.execute<FreshRow & { cutoff_basis: string | null }>(
        sql`SELECT f.*, ec.basis AS cutoff_basis FROM public.drsnip_journey_freshness() f CROSS JOIN public.drsnip_evidence_cutoff() ec`),
      db.execute<HealthRow>(sql`SELECT * FROM public.drsnip_sync_health()`),
    ]);
    const f = fresh.rows[0];
    if (!f) return res.status(500).json({ error: "freshness unavailable" });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      as_of: new Date().toISOString(),
      intake: {
        // Intake is written by the live forms, so it is current by construction.
        latest_submission_at: f.intake_latest_at,
        note: "Submissions are written as forms arrive. This is the newest one.",
      },
      appointments: {
        // The instant appointment data is COMPLETE to. Not the instant the last
        // request was made: a run that read a window advances the cursor only
        // when it read the whole window.
        complete_as_of: f.appointments_synced_at,
        // 'incremental_watermark' (normal), 'history_baseline' (no hourly sync
        // has ever completed: the earliest full-history read) or 'unavailable'.
        // The SAME source every appointment calculation uses (0022).
        complete_basis: (f as { cutoff_basis?: string | null }).cutoff_basis ?? null,
        state: classify(f),
        update_mode: f.sync_run_state === "not_scheduled" ? "manual" : "scheduled",
        linked_patients: f.linked_patients,
        history_complete_patients: f.history_complete_patients,
        // Patients who registered after the historical backfill and have not had
        // their history read yet. A count, never an id.
        //
        // NOT SUBJECT TO SMALL-CELL SUPPRESSION, deliberately. Suppression
        // exists so a small group cannot be tied to a clinical attribute; this
        // is the depth of a job queue and carries no attribute beyond "is a
        // patient of this clinic", which every viewer of this page can already
        // read off the submissions list. Withholding it below five would hide
        // exactly the case that needs looking at — a catch-up queue that has
        // stopped draining — and would protect nothing.
        awaiting_catchup: f.awaiting_catchup,
      },
      sync: {
        schedule_enabled: f.sync_schedule_enabled,
        run_state: f.sync_run_state,
        last_attempt_at: f.sync_last_attempt_at,
        last_success_at: f.sync_last_success_at,
        cursor_lag_seconds: f.sync_cursor_lag_seconds,
        expected_interval_minutes: f.sync_expected_interval_minutes,
        failed_runs_24h: f.sync_failed_runs_24h,
        schedules: health.rows.map((h) => ({
          key: h.schedule_key,
          scope: h.scope_key,
          enabled: h.enabled,
          cadence: h.cadence,
          expected_interval_minutes: h.expected_interval_minutes,
          last_attempt_at: h.last_attempt_at,
          last_success_at: h.last_success_at,
          last_outcome: h.last_outcome,
          run_state: h.run_state,
          cursor_lag_seconds: h.cursor_lag_seconds,
          failed_runs_24h: h.runs_failed_24h,
          partial_runs_24h: h.runs_partial_24h,
          // Evidence, not configuration: a schedule can be enabled while n8n is
          // down, and this stays false until a run actually succeeds.
          recurring_active: h.recurring_active,
        })),
      },
    });
  } catch (err) {
    console.error("[reports/freshness] query failed", (err as { code?: string })?.code ?? "unknown");
    return res.status(500).json({ error: "freshness query failed" });
  }
}
