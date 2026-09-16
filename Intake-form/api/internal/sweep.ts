import type { VercelRequest, VercelResponse } from "@vercel/node";
import { pool } from "@workspace/db";
import { requireServiceToken } from "../_lib/service-auth";
import { record as recordNotification } from "../../lib/notifications/ledger";
import { renderDigest, type DigestData } from "../../lib/notifications/digest";

// ---------------------------------------------------------------------------
// GET /api/internal/sweep — Train 3.
//
// Every alert in this system fires once, synchronously, at the moment of the
// event, or never; nothing re-reads a row (FINDINGS-submission-health.md §4.2).
// This is the thing that re-reads rows. It is the ONLY periodic job in the app.
//
// It REPORTS. It never acts. No retry, no replay, no outreach — the n8n webhook
// is not idempotent and a replay can duplicate a chart. It changes no row's
// status, ever.
//
// Auth: the existing N8N_SERVICE_TOKEN (fail-closed), same as the card-file
// endpoints. `?send=1` additionally delivers the digest and writes the ledger
// row; without it the endpoint is a pure read and can be curled safely.
//
// HIPAA: the response and the digest carry counts, submission IDs and console
// links only. renderDigest() is pure and cannot reach a name, DOB, phone or
// email — see lib/notifications/digest.ts and its test.
// ---------------------------------------------------------------------------

/** A submission is "stuck" once the bridge has had longer than any plausible
 *  run. Observed n8n stalls have reached 269 s, so a row a few minutes old is
 *  legitimately in flight and must NOT be reported. */
const STUCK_AFTER_MINUTES = 10;

function consoleBaseUrl(): string {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  return (raw && raw.length > 0 ? raw : "https://intake.drsnip.com").replace(
    /\/+$/,
    "",
  );
}

async function collect(): Promise<DigestData> {
  // Stuck: no status AND no response timestamp. `updated_at` is deliberately
  // NOT used — the bridge UPDATE never bumps it, so every row in the table has
  // updated_at = created_at (Train 2 report).
  //
  // The `n8n_status IS NULL` clause is what excludes insurance's deliberate
  // 'not_applicable' rows: those carry a terminal status and a response body,
  // so they are not stuck, they are done.
  const stuck = await pool.query(
    `SELECT id, form_type,
            floor(EXTRACT(epoch FROM (now() - created_at)) / 60)::int AS age_minutes
       FROM submissions
      WHERE n8n_status IS NULL
        AND n8n_response_at IS NULL
        AND form_type IN ('registration', 'consultation')
        AND created_at < now() - ($1 || ' minutes')::interval
      ORDER BY created_at`,
    [String(STUCK_AFTER_MINUTES)],
  );

  const failed = await pool.query(
    `SELECT COALESCE(n8n_response_body->>'error_message', 'unclassified') AS error_message,
            count(*)::int AS count,
            array_agg(id::text ORDER BY created_at) AS ids
       FROM submissions
      WHERE n8n_status = 'failed'
        AND created_at > now() - interval '24 hours'
      GROUP BY 1
      ORDER BY 2 DESC`,
  );

  const mr = await pool.query(
    `SELECT count(*)::int AS open,
            floor(EXTRACT(epoch FROM (now() - min(created_at))) / 86400)::int AS oldest_days,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS added_24h
       FROM submissions
      WHERE n8n_status = 'manual_review'`,
  );

  const problems = await pool.query(
    `SELECT channel, outcome, detail, count(*)::int AS count
       FROM notification_events
      WHERE outcome <> 'sent'
        AND created_at > now() - interval '24 hours'
      GROUP BY 1, 2, 3
      ORDER BY 4 DESC`,
  );

  return {
    generatedAt: new Date(),
    consoleBaseUrl: consoleBaseUrl(),
    stuck: stuck.rows.map((r) => ({
      id: String(r.id),
      formType: String(r.form_type),
      ageMinutes: Number(r.age_minutes),
    })),
    failed24h: failed.rows.map((r) => ({
      errorMessage: String(r.error_message),
      count: Number(r.count),
      ids: (r.ids as string[]) ?? [],
    })),
    manualReview: {
      open: Number(mr.rows[0]?.open ?? 0),
      oldestDays:
        mr.rows[0]?.oldest_days === null || mr.rows[0]?.oldest_days === undefined
          ? null
          : Number(mr.rows[0].oldest_days),
      added24h: Number(mr.rows[0]?.added_24h ?? 0),
    },
    notificationProblems24h: problems.rows.map((r) => ({
      channel: String(r.channel),
      outcome: String(r.outcome),
      detail: r.detail === null ? null : String(r.detail),
      count: Number(r.count),
    })),
  };
}

/**
 * Deliver the digest. Mirrors lib/n8n/insurance-notify.ts exactly: POST a
 * subject/body pair to an n8n webhook whose Gmail node does the sending, using
 * the SAME X-DrSnip-Token secret. No new credential and no new email provider.
 *
 * A missing URL is a clean skip, not an error, so this deploys inert before the
 * receiving workflow exists — the same deploy-before-secret property the
 * doorbell has.
 */
async function deliver(
  subject: string,
  body: string,
): Promise<{ outcome: "sent" | "skipped" | "error"; detail: string | null }> {
  const url = process.env.N8N_WEBHOOK_DIGEST_URL ?? "";
  if (!url) return { outcome: "skipped", detail: "no_url" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DrSnip-Token": process.env.N8N_WEBHOOK_SECRET ?? "",
      },
      body: JSON.stringify({ kind: "digest", subject, body }),
      signal: controller.signal,
    });
    if (!res.ok) return { outcome: "error", detail: `HTTP ${res.status}` };
    return { outcome: "sent", detail: null };
  } catch (err) {
    return {
      outcome: "error",
      detail: err instanceof Error ? err.name : "UnknownError",
    };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!requireServiceToken(req, res, "sweep")) return;

  let data: DigestData;
  try {
    data = await collect();
  } catch (err) {
    console.error(
      "[sweep] collect failed",
      err instanceof Error ? err.name : "UnknownError",
    );
    res.status(500).json({ error: "Sweep failed" });
    return;
  }

  const digest = renderDigest(data);
  const send = String(req.query?.send ?? "") === "1";

  let delivery: { outcome: "sent" | "skipped" | "error"; detail: string | null } = {
    outcome: "skipped",
    detail: "not_requested",
  };

  if (send) {
    delivery = await deliver(digest.subject, digest.body);
    // The tick itself is ledgered even when the digest is empty, so silence is
    // distinguishable from "the sweep is not running".
    await recordNotification({
      channel: "digest",
      kind: "sweep_digest",
      recipientClass: "operator",
      outcome: delivery.outcome,
      detail: delivery.detail ?? (digest.quiet ? "empty" : null),
    });
  }

  console.log(
    "[sweep] " +
      JSON.stringify({
        ts: new Date().toISOString(),
        stuck: data.stuck.length,
        failed_24h: data.failed24h.reduce((a, g) => a + g.count, 0),
        manual_review_open: data.manualReview.open,
        notification_problems_24h: data.notificationProblems24h.length,
        sent: send,
        delivery: delivery.outcome,
      }),
  );

  res.status(200).json({
    generatedAt: data.generatedAt.toISOString(),
    stuck: data.stuck,
    failed24h: data.failed24h,
    manualReview: data.manualReview,
    notificationProblems24h: data.notificationProblems24h,
    quiet: digest.quiet,
    subject: digest.subject,
    body: digest.body,
    delivery,
  });
}
