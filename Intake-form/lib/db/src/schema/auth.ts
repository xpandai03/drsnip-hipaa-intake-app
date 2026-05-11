import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Opaque session ids stored server-side. Cookie holds the id only; full
// user details (name, picture) are derived from the Google OAuth response
// and refreshed on each /api/auth/callback.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    pictureUrl: text("picture_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("sessions_email_idx").on(table.email),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const insertSessionSchema = createInsertSchema(sessions);
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;
