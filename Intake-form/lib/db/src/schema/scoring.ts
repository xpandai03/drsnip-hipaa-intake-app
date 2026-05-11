import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ruleSetStatusEnum = pgEnum("rule_set_status", [
  "draft",
  "published",
  "archived",
]);

export const scoringRuleSets = pgTable(
  "scoring_rule_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    status: ruleSetStatusEnum("status").notNull().default("draft"),
    // Full RuleSet JSON shape lives in @workspace/scoring; this column stores it verbatim.
    rules: jsonb("rules").notNull(),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    // At most one published RuleSet at any time.
    uniqueIndex("scoring_rule_sets_one_published")
      .on(table.status)
      .where(sql`${table.status} = 'published'`),
    index("scoring_rule_sets_status_idx").on(table.status),
    index("scoring_rule_sets_created_at_idx").on(table.createdAt),
  ],
);

export const scoringRuleChanges = pgTable(
  "scoring_rule_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => scoringRuleSets.id),
    action: text("action").notNull(),
    diff: jsonb("diff"),
    note: text("note"),
    actorEmail: text("actor_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("scoring_rule_changes_rule_set_idx").on(
      table.ruleSetId,
      table.createdAt,
    ),
  ],
);

export const insertScoringRuleSetSchema = createInsertSchema(scoringRuleSets);
export type InsertScoringRuleSet = z.infer<typeof insertScoringRuleSetSchema>;
export type ScoringRuleSet = typeof scoringRuleSets.$inferSelect;

export const insertScoringRuleChangeSchema =
  createInsertSchema(scoringRuleChanges);
export type InsertScoringRuleChange = z.infer<
  typeof insertScoringRuleChangeSchema
>;
export type ScoringRuleChange = typeof scoringRuleChanges.$inferSelect;
