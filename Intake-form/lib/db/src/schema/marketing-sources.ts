import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Admin-editable catalog of marketing source channels. Replaces the
// previously-hardcoded { fnn, internal, federal } trio in
// artifacts/intake-form/src/pages/LinkGenerator.tsx so marketing can
// self-serve new channels (TikTok, paid LinkedIn, etc.) without a deploy.
//
// Each row drives:
//   - The Source dropdown in the admin Custom Link tool
//   - The ?source=<source_key> param appended to generated URLs
//     (Salesforce attribution depends on this — DO NOT rename source_key
//     for the three legacy rows: fnn / internal / federal)
//   - The default value of the Medium dropdown when a source is selected
//
// Soft-delete via is_active=false: an inactive source disappears from the
// admin dropdown but its source_key remains valid forever for any URLs
// already live in the wild (printed flyers, scheduled emails, etc).
export const marketingSources = pgTable(
  "marketing_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKey: text("source_key").notNull().unique(),
    displayName: text("display_name").notNull(),
    leadSource: text("lead_source").notNull(),
    defaultMedium: text("default_medium"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("marketing_sources_is_active_idx").on(table.isActive),
    index("marketing_sources_display_name_idx").on(table.displayName),
  ],
);

export const insertMarketingSourceSchema = createInsertSchema(marketingSources);
export type InsertMarketingSource = z.infer<typeof insertMarketingSourceSchema>;
export type MarketingSource = typeof marketingSources.$inferSelect;
