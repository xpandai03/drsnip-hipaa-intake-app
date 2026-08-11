import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Drop-off capture for the REGISTRATION form (Train 2, migration 0009).
//
// PRIVACY (locked): this column set is the EXHAUSTIVE whitelist. There is NO
// raw_payload and NO medical/insurance/step-answer column — storing a medical
// answer on a partial is impossible by construction. See migration 0009.
export const registrationPartials = pgTable(
  "registration_partials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Client-generated per-session id (sessionStorage). Upsert key + primary
    // match for conversion-delete.
    partialId: text("partial_id").notNull().unique(),

    // Contact (present once the beacon first fires).
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    officeLocation: text("office_location"),

    // Progress marker — number + label ONLY, never step answers.
    furthestStep: integer("furthest_step"),
    furthestStepLabel: text("furthest_step_label"),

    // Attribution the form already captures.
    source: text("source"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    clickId: text("click_id"),
    clickIdType: text("click_id_type"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("registration_partials_email_idx").on(table.email),
    index("registration_partials_updated_at_idx").on(table.updatedAt),
  ],
);

export type RegistrationPartial = typeof registrationPartials.$inferSelect;
