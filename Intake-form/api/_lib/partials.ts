// Shared helpers for registration drop-off partials (Train 2).

import { db, lt, registrationPartials, sql } from "@workspace/db";

export const PARTIAL_RETENTION_DAYS = 30; // hard-delete older than this
export const PARTIAL_GRACE_HOURS = 24; // hide from the list this recently active

// Origin allowlist for the public beacon (authenticated-by-origin). The form is
// public, so this is a light guard against arbitrary external writes, not auth.
const ALLOWED_ORIGINS = new Set([
  "https://intake.drsnip.com",
  "https://intake.doctorsnip.com",
  "https://drsnip-intake-demo.fly.dev",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:8080",
]);

/** True if the request origin is allowed. Absent origin (same-origin / curl) is
 *  permitted; a present cross-origin value is rejected. */
export function originAllowed(origin: unknown): boolean {
  if (typeof origin !== "string" || origin === "") return true;
  return ALLOWED_ORIGINS.has(origin);
}

/** Hard-delete partials older than the retention window. Best-effort: never throws. */
export async function purgeExpiredPartials(): Promise<void> {
  try {
    await db
      .delete(registrationPartials)
      .where(lt(registrationPartials.updatedAt, sql`now() - interval '30 days'`));
  } catch (err) {
    console.error(
      "partials: purge failed",
      err instanceof Error ? err.name : "UnknownError",
    );
  }
}
