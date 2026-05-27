import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 2 (DrSnip): the `submissions` table holds intake submissions from both
// DrSnip forms. `form_type` discriminates Registration vs Consultation. Patient
// identity + insurance-card-stub fields are dedicated columns; every form
// answer is also kept verbatim in `raw_payload` (jsonb) — the admin detail
// view renders from there. The CJC survey (q_*) and channel-attribution
// columns were dropped — see migrations/0003_drsnip_schema.sql.
export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // 'registration' | 'consultation' — allowed set enforced in the app layer.
    formType: text("form_type").notNull().default("registration"),

    // Patient identity.
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    dateOfBirth: text("date_of_birth"),
    stateResidence: text("state_residence"),

    // Insurance card upload — STUBBED (see components/ui/FileUploadStub.tsx and
    // PHASE_2_NOTES.md). Only the filename + a flag are stored; no file bytes
    // are ever persisted. Real object storage with a BAA is a later phase.
    insuranceCardFrontFilename: text("insurance_card_front_filename"),
    insuranceCardBackFilename: text("insurance_card_back_filename"),
    hasInsuranceCards: boolean("has_insurance_cards").notNull().default(false),

    // Dedicated column for the Registration-form Mental Illness screening
    // question (Jeff feedback, 2026-05). Per-question "Yes" explanations
    // continue to live inside raw_payload.medicalDetails.
    mhMentalIllness: text("mh_mental_illness"),

    // ----- n8n bridge outcome (migration 0006) -----------------------------
    // After the submission row commits, an async bridge call fires the
    // payload at the v2 n8n webhook. When n8n responds (or the call fails),
    // these columns are UPDATEd. NULL means the bridge hasn't reported yet.
    //
    // Values:
    //   'success'         200 + success: true
    //   'manual_review'   200 + manual_review_required
    //   'failed'          non-200 / network error / timeout
    n8nStatus: text("n8n_status"),
    // DrChrono patient id returned by n8n on success. Bigint because DrChrono
    // ids exceed 2^31.
    n8nPatientId: bigint("n8n_patient_id", { mode: "number" }),
    n8nResponseAt: timestamp("n8n_response_at", { withTimezone: true }),
    // Full JSON response from n8n, kept verbatim for debugging.
    n8nResponseBody: jsonb("n8n_response_body"),

    // Full submission JSON — every form answer lives here.
    rawPayload: jsonb("raw_payload").notNull(),
  },
  (table) => [
    index("submissions_created_at_idx").on(table.createdAt),
    index("submissions_email_idx").on(table.email),
    index("submissions_form_type_idx").on(table.formType),
  ],
);

export const insertSubmissionSchema = createInsertSchema(submissions);
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissions.$inferSelect;
