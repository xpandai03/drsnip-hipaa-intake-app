import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import pg from "pg";
import { z } from "zod/v4";
// .js extensions on relative imports are required for TypeScript's
// node16/nodenext module-resolution mode, which Vercel's function-compile
// pipeline uses. TypeScript resolves .js back to the corresponding .ts
// source at compile time. Apply to ALL new relative imports in workspace
// packages with `composite: true`.
//
// Star-import the OTHER schema files into a single namespace so Drizzle's
// query-builder can resolve every table. The auth schema is inlined below
// (see comment above the `users` table) — DO NOT add it to this import block.
import * as linksSchema from "./schema/links.js";
import * as scoringSchema from "./schema/scoring.js";
import * as settingsSchema from "./schema/settings.js";
import * as submissionsSchema from "./schema/submissions.js";

// ---------------------------------------------------------------------------
// INLINED: auth schema lives here directly rather than in ./schema/auth
// because Vercel's function-compile pipeline can't resolve re-exports from
// ./schema/* files for reasons we haven't diagnosed (every other schema
// file works fine via the same `export * from "./schema/x"` pattern — but
// only auth's exports come back as TS2305 "no exported member"). This is a
// temporary workaround. TODO: revisit when we understand Vercel's
// function-compile resolution model, or after a future infra change makes
// it moot. Other schema files (submissions, scoring, settings, links)
// are NOT affected and stay in their own files.
// ---------------------------------------------------------------------------

// Admin accounts. No public signup — populated by the seed-admin-users
// script. Password resets are handled manually by Raunek for v1.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // bcryptjs hash, cost factor 10. Plaintext never touches the DB or logs.
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

// Opaque session ids stored server-side. Cookie holds the id only; user
// identity is dereferenced via the userId FK on each request.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

// Per-email rate limiting state. 5 failed attempts within 15 min → 429.
// Per-email (not per-IP) on purpose: per-IP is trivially bypassed and lets
// attackers combine enumeration with brute force across rotating IPs.
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    ipAddress: text("ip_address"),
    succeeded: boolean("succeeded").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("login_attempts_email_attempted_at_idx").on(
      table.email,
      table.attemptedAt,
    ),
  ],
);

export const insertUserSchema = createInsertSchema(users);
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const insertSessionSchema = createInsertSchema(sessions);
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

export const insertLoginAttemptSchema = createInsertSchema(loginAttempts);
export type InsertLoginAttempt = z.infer<typeof insertLoginAttemptSchema>;
export type LoginAttempt = typeof loginAttempts.$inferSelect;

// ---------------------------------------------------------------------------
// End inlined auth schema.
// ---------------------------------------------------------------------------

const authSchema = {
  users,
  sessions,
  loginAttempts,
};

const schema = {
  ...authSchema,
  ...linksSchema,
  ...scoringSchema,
  ...settingsSchema,
  ...submissionsSchema,
};

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

// Re-export the other schema files directly (file-path imports). These
// continue to work through the standard re-export path.
export * from "./schema/links.js";
export * from "./schema/scoring.js";
export * from "./schema/settings.js";
export * from "./schema/submissions.js";

// Re-export the drizzle query-builder helpers we use across the app.
// API code (Intake-form/api/*) imports these from @workspace/db so there's
// only ONE drizzle-orm module identity in the type graph — avoids pnpm's
// nested-install "type X is not assignable to type X" identity issues when
// drizzle-orm is referenced from two different node_modules paths.
export {
  and,
  count,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";
