import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { submissions } from "./submissions";

// Postgres bytea ↔ Node Buffer (node-postgres returns bytea as Buffer).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Card image storage (migration 0010). BAA-covered Fly Postgres. Bytes are
// served ONLY through the authed file endpoint — never in JSON/raw_payload/logs.
export const submissionFiles = pgTable(
  "submission_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    // insurance_front | insurance_back | partner_front | partner_back
    kind: text("kind").notNull(),
    filename: text("filename"),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    // stored | too_large | rejected | failed. Bytes present only when 'stored'.
    status: text("status").notNull().default("stored"),
    bytes: bytea("bytes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("submission_files_submission_id_idx").on(table.submissionId)],
);

export type SubmissionFile = typeof submissionFiles.$inferSelect;
