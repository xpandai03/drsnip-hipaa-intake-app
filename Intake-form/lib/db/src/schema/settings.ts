import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Key/value model — each toggle is one row. Lets us add new toggles
// later without migrations. Known keys (v1): a7_valve, kill_switch,
// channel_federal_paused, channel_internal_paused, channel_fnn_paused.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

export const settingsAudit = pgTable(
  "settings_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value").notNull(),
    actorEmail: text("actor_email").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("settings_audit_key_idx").on(table.key, table.createdAt),
  ],
);

export const insertSettingSchema = createInsertSchema(settings);
export type InsertSetting = z.infer<typeof insertSettingSchema>;
export type Setting = typeof settings.$inferSelect;

export const insertSettingsAuditSchema = createInsertSchema(settingsAudit);
export type InsertSettingsAudit = z.infer<typeof insertSettingsAuditSchema>;
export type SettingsAudit = typeof settingsAudit.$inferSelect;
