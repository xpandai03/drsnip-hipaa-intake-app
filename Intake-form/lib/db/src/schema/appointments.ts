import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Durable event log for the TimeTap ↔ Salesforce sync (Workstream A,
// Path B in cjc-sf-metadata/reports/timetap-sync-feasibility.md).
//
// One row per sync attempt — inbound (TimeTap webhook → SF Appointment__c)
// or outbound (SF change → TimeTap update). The row is written BEFORE the
// SF/TimeTap call so a crash or 5xx still leaves an audit trail; sf_status
// is then advanced to 'sent' or 'error' once the downstream write returns.
//
// Mirrors the pattern in submissions.ts (raw_payload + sf_* status fields).
export const appointmentSyncEvents = pgTable(
  "appointment_sync_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // TimeTap's stable numeric appointment id, stringified. Matches the
    // Appointment__c.Name column on the Salesforce side.
    calendarId: text("calendar_id").notNull(),
    // Inbound: the TimeTap webhook body verbatim.
    // Outbound: the SF Appointment__c row JSON we're pushing to TimeTap.
    rawPayload: jsonb("raw_payload").notNull(),
    direction: text("direction").notNull(),
    // pending | sent | error. Lifecycle mirrors submissions.sfStatus.
    sfStatus: text("sf_status").notNull().default("pending"),
    // SF record id once we have one. Null for outbound rows where we
    // already know the id (it goes in raw_payload instead).
    sfAppointmentId: text("sf_appointment_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("appointment_sync_events_calendar_id_idx").on(table.calendarId),
    index("appointment_sync_events_created_at_idx").on(table.createdAt),
    index("appointment_sync_events_sf_status_idx").on(table.sfStatus),
    index("appointment_sync_events_direction_idx").on(table.direction),
  ],
);

export const insertAppointmentSyncEventSchema = createInsertSchema(
  appointmentSyncEvents,
);
export type InsertAppointmentSyncEvent = z.infer<
  typeof insertAppointmentSyncEventSchema
>;
export type AppointmentSyncEvent = typeof appointmentSyncEvents.$inferSelect;
