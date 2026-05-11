import {
  boolean,
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
import { scoringRuleSets } from "./scoring.js";

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Channel attribution
    source: text("source").notNull(),
    surveyDetail: text("survey_detail").notNull(),
    leadSource: text("lead_source").notNull(),
    campaign: text("campaign"),
    event: text("event"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),

    // Lead identity
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    stateResidence: text("state_residence").notNull(),
    federalAgency: text("federal_agency").notNull(),

    // Survey answers (mirror SF Sofa_Consultation_Survey_Q* fields)
    qSpeakerRating: text("q_speaker_rating"),
    qWorkshopContent: text("q_workshop_content"),
    qPreRetirement: text("q_pre_retirement").notNull(),
    qEvalComments: text("q_eval_comments"),
    qYearsToRetire: text("q_years_to_retire"),
    qAge: text("q_age"),
    qSeparating: text("q_separating"),
    qMaritalStatus: text("q_marital_status"),
    qMaxingTsp: text("q_maxing_tsp"),
    qTspContributionPct: text("q_tsp_contribution_pct"),
    qExternalInvestments: text("q_external_investments"),
    qTspBalance: text("q_tsp_balance"),
    qAreasOfConcern: text("q_areas_of_concern"),

    // Scoring outputs
    scoringRuleSetId: uuid("scoring_rule_set_id").references(
      () => scoringRuleSets.id,
    ),
    rank: text("rank"),
    leadScore: text("lead_score"),
    scoringTrace: jsonb("scoring_trace"),
    autoScheduleHold: boolean("auto_schedule_hold").notNull().default(false),

    // Salesforce push
    sfLeadId: text("sf_lead_id"),
    sfStatus: text("sf_status").notNull().default("pending"),
    sfError: text("sf_error"),
    sfAttempts: integer("sf_attempts").notNull().default(0),
    sfLastAttemptAt: timestamp("sf_last_attempt_at", { withTimezone: true }),

    // Raw payload for forensics
    rawPayload: jsonb("raw_payload").notNull(),
  },
  (table) => [
    index("submissions_created_at_idx").on(table.createdAt),
    index("submissions_email_idx").on(table.email),
    index("submissions_source_idx").on(table.source),
    index("submissions_sf_status_idx").on(table.sfStatus),
  ],
);

export const insertSubmissionSchema = createInsertSchema(submissions);
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissions.$inferSelect;
