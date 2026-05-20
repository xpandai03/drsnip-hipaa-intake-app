import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const linkGenerations = pgTable(
  "link_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(),
    source: text("source").notNull(),
    campaign: text("campaign"),
    event: text("event"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    generatedUrl: text("generated_url").notNull(),
    // Phase 2 polish — DrSnip link generator (migration 0004).
    formType: text("form_type"),
    notes: text("notes"),
  },
  (table) => [
    index("link_generations_created_at_idx").on(table.createdAt),
    index("link_generations_created_by_idx").on(
      table.createdBy,
      table.createdAt,
    ),
  ],
);

export const insertLinkGenerationSchema = createInsertSchema(linkGenerations);
export type InsertLinkGeneration = z.infer<typeof insertLinkGenerationSchema>;
export type LinkGeneration = typeof linkGenerations.$inferSelect;
