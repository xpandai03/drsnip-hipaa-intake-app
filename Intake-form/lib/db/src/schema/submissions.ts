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

// Phase 1 (DrSnip adaptation): the lead-scoring, Salesforce-push, and
// hold-valve column groups were removed along with their subsystems. The
// channel-attribution and `q_*` survey columns are retained as-is for now —
// Phase 2 replaces them with DrSnip's patient-intake fields. `raw_payload`
// always holds the full submission regardless.

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

    // Raw payload — full submission JSON, retained for audit/forensics.
    rawPayload: jsonb("raw_payload").notNull(),
  },
  (table) => [
    index("submissions_created_at_idx").on(table.createdAt),
    index("submissions_email_idx").on(table.email),
    index("submissions_source_idx").on(table.source),
  ],
);

export const insertSubmissionSchema = createInsertSchema(submissions);
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissions.$inferSelect;
