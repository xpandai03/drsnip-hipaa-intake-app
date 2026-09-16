import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { submissions } from "./submissions";

// Durable notification ledger (migration 0011, Train 3).
//
// One row per APP-SIDE send attempt, including deliberate skips — a skip that
// leaves no trace is exactly how `patientmail` went unnoticed for three months.
// n8n-side Gmail sends are NOT here; capturing those needs a write-back
// endpoint from the workflows and is a separate train.
//
// PHI: impossible by construction. No name/DOB/phone/email/subject/body column
// exists, `recipientClass` is a role rather than an address, and `detail` holds
// a short machine reason only.
export const notificationEvents = pgTable(
  "notification_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null for a digest, which covers many submissions and belongs to none.
    submissionId: uuid("submission_id").references(() => submissions.id, {
      onDelete: "cascade",
    }),
    // insurance_notify | fallback_doorbell | patientmail | digest
    channel: text("channel").notNull(),
    // chart_created | failed | sweep_digest | insurance_arrived | ...
    kind: text("kind").notNull(),
    // 'staff' | 'operator' — a role, never a raw address.
    recipientClass: text("recipient_class").notNull(),
    // sent | skipped | error
    outcome: text("outcome").notNull(),
    // Short machine reason: no_recipient, no_url, HTTP 500, empty ...
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notification_events_submission_id_idx").on(t.submissionId),
    index("notification_events_created_at_idx").on(t.createdAt),
  ],
);

export type NotificationEvent = typeof notificationEvents.$inferSelect;
