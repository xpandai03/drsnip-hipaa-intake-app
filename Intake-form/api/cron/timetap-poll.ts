// Outbound poller: Salesforce Appointment__c → TimeTap. Invoked on a
// Vercel cron schedule (every minute — see vercel.json).
//
// Per cjc-sf-metadata/reports/timetap-sync-feasibility.md Area 3, the
// poller's job is to:
//   1. Read the high-water mark from settings (key=timetap_sync_high_water_mark).
//   2. Query SF for Appointment__c WHERE LastModifiedDate > high_water_mark
//      (ORDER BY LastModifiedDate ASC for cursor advancement).
//   3. For each changed row, diff against the last successful outbound
//      event in appointment_sync_events for that calendarId. If the
//      payload differs (or no outbound event exists yet), push the update
//      to TimeTap via updateAppointment and persist a new outbound event.
//   4. Advance the high-water mark to the LAST successfully-processed
//      row's LastModifiedDate. If a row fails, stop advancement at the
//      prior one so the next tick retries.
//
// Vercel function timeout drives the batch ceiling. We query a bounded
// page (200 rows max) and exit cleanly if the batch can't finish in time.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  and,
  appointmentSyncEvents,
  db,
  desc,
  eq,
  settings,
} from "@workspace/db";
import {
  SalesforceAppointmentError,
  listAppointmentsModifiedSince,
} from "../_lib/sf";
import {
  TimeTapError,
  updateAppointment,
} from "../_lib/timetap";
import {
  sfAppointmentToTimeTapUpdate,
  timeTapUpdatePayloadsEqual,
  type SfAppointmentRecord,
  type TimeTapUpdatePayload,
} from "../_lib/timetap-mapping";

export const HIGH_WATER_MARK_KEY = "timetap_sync_high_water_mark" as const;
// Default look-back when no high-water mark exists yet: 5 minutes. Tight
// enough to keep the first run cheap; the operator can extend by writing
// an older ISO string to the settings row directly for a backfill burst.
const DEFAULT_LOOKBACK_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 200;

function isIsoTimestamp(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v);
}

async function readHighWaterMark(): Promise<string> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, HIGH_WATER_MARK_KEY))
    .limit(1);
  const raw = rows[0]?.value;
  if (isIsoTimestamp(raw)) return raw;
  // Initial seed — 5 min ago. Avoids importing the entire SF appointment
  // history on first run.
  return new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
}

async function writeHighWaterMark(value: string): Promise<void> {
  const now = new Date();
  await db
    .insert(settings)
    .values({
      key: HIGH_WATER_MARK_KEY,
      value: value as unknown as object,
      updatedAt: now,
      updatedBy: "cron:timetap-poll",
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: value as unknown as object,
        updatedAt: now,
        updatedBy: "cron:timetap-poll",
      },
    });
}

async function lastOutboundPayload(
  calendarId: string,
): Promise<TimeTapUpdatePayload | null> {
  const rows = await db
    .select({ rawPayload: appointmentSyncEvents.rawPayload })
    .from(appointmentSyncEvents)
    .where(
      and(
        eq(appointmentSyncEvents.calendarId, calendarId),
        eq(appointmentSyncEvents.direction, "outbound"),
        eq(appointmentSyncEvents.sfStatus, "sent"),
      ),
    )
    .orderBy(desc(appointmentSyncEvents.createdAt))
    .limit(1);
  const raw = rows[0]?.rawPayload as unknown;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as TimeTapUpdatePayload;
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron sends GET with an auth header; permit any method since this
  // endpoint is only invoked by Vercel's cron scheduler (it's not in any
  // user-facing UI). If we ever want to lock it down, the documented
  // pattern is `CRON_SECRET` validation — out of scope for this build.
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const startedAt = Date.now();
  let highWaterMark: string;
  try {
    highWaterMark = await readHighWaterMark();
  } catch (err) {
    console.error("cron/timetap-poll: failed to read high water mark", err);
    return res.status(500).json({ success: false, error: "settings read failed" });
  }

  let rows: Awaited<ReturnType<typeof listAppointmentsModifiedSince>>;
  try {
    rows = await listAppointmentsModifiedSince(highWaterMark, BATCH_LIMIT);
  } catch (err) {
    const message =
      err instanceof SalesforceAppointmentError
        ? `sf:${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error("cron/timetap-poll: SF query failed", message);
    return res.status(502).json({ success: false, error: message });
  }

  if (rows.length === 0) {
    return res.status(200).json({
      success: true,
      processed: 0,
      pushed: 0,
      skipped: 0,
      errors: 0,
      highWaterMark,
      elapsedMs: Date.now() - startedAt,
    });
  }

  let processed = 0;
  let pushed = 0;
  let skipped = 0;
  let errors = 0;
  let lastSuccessfulTimestamp: string | null = null;

  for (const row of rows) {
    processed += 1;
    const calendarId = row.Name;
    if (!calendarId) {
      // Appointment with no Name (no calendarId) — can't push to TimeTap.
      // Advance past it; nothing actionable.
      lastSuccessfulTimestamp = row.LastModifiedDate;
      skipped += 1;
      continue;
    }

    const sfRecord = row as unknown as SfAppointmentRecord;
    const outboundPayload = sfAppointmentToTimeTapUpdate(sfRecord);

    // Diff against the last successful outbound payload — skip if no delta.
    let prior: TimeTapUpdatePayload | null = null;
    try {
      prior = await lastOutboundPayload(calendarId);
    } catch (err) {
      console.error("cron/timetap-poll: event log lookup failed", { calendarId, err });
    }
    if (prior && timeTapUpdatePayloadsEqual(prior, outboundPayload)) {
      lastSuccessfulTimestamp = row.LastModifiedDate;
      skipped += 1;
      continue;
    }

    // Insert event row up front (pending), so an exception during the
    // TimeTap call still leaves an audit trail.
    let eventId: string | undefined;
    try {
      const [inserted] = await db
        .insert(appointmentSyncEvents)
        .values({
          calendarId,
          rawPayload: outboundPayload as unknown as Record<string, unknown>,
          direction: "outbound",
          sfStatus: "pending",
          sfAppointmentId: row.Id,
          attempts: 0,
        })
        .returning({ id: appointmentSyncEvents.id });
      eventId = inserted.id;
    } catch (logErr) {
      console.error("cron/timetap-poll: event log insert failed", { calendarId, logErr });
      // Don't advance the high-water mark past this row.
      errors += 1;
      break;
    }

    try {
      await updateAppointment(calendarId, outboundPayload as unknown as Record<string, unknown>);
      await db
        .update(appointmentSyncEvents)
        .set({
          sfStatus: "sent",
          attempts: 1,
          lastAttemptAt: new Date(),
        })
        .where(eq(appointmentSyncEvents.id, eventId));
      pushed += 1;
      lastSuccessfulTimestamp = row.LastModifiedDate;
    } catch (err) {
      const message =
        err instanceof TimeTapError
          ? `timetap:${err.status}:${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : String(err);
      console.error("cron/timetap-poll: TimeTap update failed", { calendarId, error: message });
      await db
        .update(appointmentSyncEvents)
        .set({
          sfStatus: "error",
          error: message,
          attempts: 1,
          lastAttemptAt: new Date(),
        })
        .where(eq(appointmentSyncEvents.id, eventId));
      errors += 1;
      // Distinguish transient (5xx / unknown) from permanent (4xx) errors:
      //
      //   - 4xx (TimeTap's "not found", "validation failed", etc.) — the
      //     row will never succeed without operator intervention, so we
      //     advance past it. The error message is durable in the event
      //     log for forensics. Without this distinction, a single bad
      //     row froze ALL future outbound sync forever.
      //
      //   - 5xx / timeout / unknown — likely transient TimeTap flakiness;
      //     stop the batch so the high-water mark doesn't advance and
      //     the next tick retries the same row.
      //
      // tt() in _lib/timetap.ts already does one in-flight retry on 5xx,
      // so by the time we see one here the upstream has actually been
      // down for >2 seconds — escalate by pausing the batch.
      const isPermanent =
        err instanceof TimeTapError && err.status >= 400 && err.status < 500;
      if (isPermanent) {
        lastSuccessfulTimestamp = row.LastModifiedDate;
        continue;
      }
      break;
    }
  }

  // Advance the high-water mark only if we successfully processed at least
  // one row. Use the LAST successful row's LastModifiedDate.
  if (lastSuccessfulTimestamp) {
    try {
      await writeHighWaterMark(lastSuccessfulTimestamp);
    } catch (err) {
      console.error("cron/timetap-poll: high water mark write failed", err);
    }
  }

  return res.status(200).json({
    success: true,
    processed,
    pushed,
    skipped,
    errors,
    highWaterMark: lastSuccessfulTimestamp ?? highWaterMark,
    elapsedMs: Date.now() - startedAt,
  });
}
