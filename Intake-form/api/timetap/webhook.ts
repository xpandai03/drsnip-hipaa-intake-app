// Inbound TimeTap webhook receiver. POST /api/timetap/webhook.
//
// Contract (per cjc-sf-metadata/reports/timetap-sync-feasibility.md Area 2):
// TimeTap fires ONE event type on any appointment change (create, edit,
// reschedule, cancel) carrying the current state of the appointment. We:
//
//   1. Persist the raw payload to appointment_sync_events with
//      direction='inbound', sf_status='pending' (audit trail BEFORE any
//      downstream call — survives a crash / SF outage).
//   2. Build the SF Appointment__c field shape via timeTapPayloadToSfFields().
//   3. Upsert into Salesforce by Name = calendarId.
//   4. Mark the event row sent / error with details.
//   5. Always return 200 to TimeTap (TimeTap has no documented retry
//      policy; a 5xx from us = lost webhook. Better to swallow + replay
//      from the event log than to bounce TimeTap.)
//
// Auth: Workstream D is deferred per task brief — TIMETAP_WEBHOOK_SECRET
// is read but NOT enforced. Any well-formed POST is accepted. The endpoint
// is protected by URL-secrecy for now.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  appointmentSyncEvents,
  db,
  eq,
} from "@workspace/db";
import {
  SalesforceAppointmentError,
  upsertAppointment,
} from "../_lib/sf";
import {
  timeTapPayloadToSfFields,
  type TimeTapAppointmentPayload,
} from "../_lib/timetap-mapping";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractCalendarId(payload: TimeTapAppointmentPayload): string | undefined {
  const raw = payload.calendarId ?? payload.calendarid;
  if (raw === null || raw === undefined) return undefined;
  return String(raw);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  // Body shape: TimeTap sends application/json. Vercel parses by default.
  const body: TimeTapAppointmentPayload = isObject(req.body)
    ? (req.body as TimeTapAppointmentPayload)
    : {};

  // Workstream D — secret-header validation. Stubbed: we read the env var
  // (so deploy configuration can populate it ahead of time) but do not
  // enforce. The check is intentionally commented in pseudocode for the
  // future engineer who lights this up:
  //   const expected = process.env.TIMETAP_WEBHOOK_SECRET;
  //   if (expected && req.headers["x-timetap-secret"] !== expected) return 401.
  // Not enforcing today per task brief.
  void process.env.TIMETAP_WEBHOOK_SECRET;

  const calendarId = extractCalendarId(body);
  if (!calendarId) {
    // No calendarId means we can't match on the SF side. Log loudly,
    // persist for forensics, and return 200 so TimeTap doesn't retry a
    // permanently-broken payload.
    console.error("timetap/webhook: missing calendarId", {
      keys: Object.keys(body ?? {}),
    });
    try {
      await db.insert(appointmentSyncEvents).values({
        calendarId: "<missing>",
        rawPayload: body as Record<string, unknown>,
        direction: "inbound",
        sfStatus: "error",
        error: "missing calendarId in payload",
        attempts: 0,
      });
    } catch (logErr) {
      console.error("timetap/webhook: failed to persist event log row", logErr);
    }
    return res.status(200).json({ success: true, status: "ignored" });
  }

  // ---- 1) Insert event-log row up front. -------------------------------
  let eventId: string | undefined;
  try {
    const [row] = await db
      .insert(appointmentSyncEvents)
      .values({
        calendarId,
        rawPayload: body as Record<string, unknown>,
        direction: "inbound",
        sfStatus: "pending",
        attempts: 0,
      })
      .returning({ id: appointmentSyncEvents.id });
    eventId = row.id;
  } catch (logErr) {
    // If we can't even write the event log, we definitely can't do the SF
    // call cleanly. Log and 200 so TimeTap moves on; manual replay needed.
    console.error("timetap/webhook: failed to insert event log row", logErr);
    return res.status(200).json({ success: true, status: "log_failed" });
  }

  // ---- 2) Build SF fields + upsert. ------------------------------------
  const fields = timeTapPayloadToSfFields(body);
  if (!fields) {
    // Shouldn't happen — extractCalendarId already validated. Guard rail.
    await db
      .update(appointmentSyncEvents)
      .set({
        sfStatus: "error",
        error: "mapping returned undefined (no calendarId)",
        attempts: 1,
        lastAttemptAt: new Date(),
      })
      .where(eq(appointmentSyncEvents.id, eventId));
    return res.status(200).json({ success: true, status: "ignored" });
  }

  try {
    const result = await upsertAppointment(fields);
    await db
      .update(appointmentSyncEvents)
      .set({
        sfStatus: "sent",
        sfAppointmentId: result.id,
        attempts: 1,
        lastAttemptAt: new Date(),
      })
      .where(eq(appointmentSyncEvents.id, eventId));
    console.log("timetap/webhook: SF upsert ok", {
      eventId,
      calendarId,
      sfId: result.id,
      action: result.action,
    });
    return res.status(200).json({ success: true, status: "sent", action: result.action });
  } catch (err) {
    const message =
      err instanceof SalesforceAppointmentError
        ? `sf:${err.status}:${truncate(JSON.stringify(err.errors), 200)}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error("timetap/webhook: SF upsert failed", {
      eventId,
      calendarId,
      error: message,
    });
    await db
      .update(appointmentSyncEvents)
      .set({
        sfStatus: "error",
        error: message,
        attempts: 1,
        lastAttemptAt: new Date(),
      })
      .where(eq(appointmentSyncEvents.id, eventId));
    // Always 200 — see file header. Phase 2.5 retry sweep is what handles
    // these; for now they sit in 'error' awaiting manual / cron replay.
    return res.status(200).json({ success: true, status: "error" });
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
