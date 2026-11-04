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

// ---- Comeback window (J5, 2026-10-27) -------------------------------------
// When a completed registration clears its drop-off partial, record WHEN that
// partial was first and last seen, and how it was matched, so the delay
// between dropping off and coming back can be measured. Timestamps and a
// match type only: no identifier of any kind (migration 0026).

export type ClearedPartial = { partialId: string | null; createdAt: Date | string | null; updatedAt: Date | string | null };
export type PartialConversionRow = { partialCreatedAt: Date; partialUpdatedAt: Date | null; matchType: "session" | "email" };

const asDate = (v: Date | string | null): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Pure. One row per cleared partial. 'session' when the submission carried
 * that partial's own session id (a straight-through completion); 'email' when
 * it matched only on email (a different session: a comeback). A partial with
 * no usable created_at is skipped, never thrown on.
 */
export function partialConversionRows(cleared: ClearedPartial[], sessionPartialId: string | null): PartialConversionRow[] {
  const out: PartialConversionRow[] = [];
  for (const c of cleared) {
    const created = asDate(c.createdAt);
    if (!created) continue;
    out.push({
      partialCreatedAt: created,
      partialUpdatedAt: asDate(c.updatedAt),
      matchType: sessionPartialId !== null && c.partialId === sessionPartialId ? "session" : "email",
    });
  }
  return out;
}

/** Best-effort: never throws. Its own statement, so the delete it follows stands even if this fails. */
export async function recordPartialConversions(cleared: ClearedPartial[], sessionPartialId: string | null): Promise<void> {
  try {
    for (const r of partialConversionRows(cleared, sessionPartialId)) {
      await db.execute(sql`
        INSERT INTO registration_partial_conversions (partial_created_at, partial_updated_at, match_type)
        VALUES (${r.partialCreatedAt.toISOString()}::timestamptz, ${r.partialUpdatedAt ? r.partialUpdatedAt.toISOString() : null}::timestamptz, ${r.matchType})`);
    }
  } catch (err) {
    console.error(
      "partials: conversion timing insert failed",
      err instanceof Error ? err.name : "UnknownError",
    );
  }
}

// The comeback window: hours from a partial first being seen to the
// registration that cleared it, for comebacks only (match_type 'email').
export const COMEBACK_WINDOW_SQL = `
SELECT count(*) FILTER (WHERE x.match_type = 'email')::int   AS n,
       count(*) FILTER (WHERE x.match_type = 'session')::int AS n_same_session,
       min(x.submission_created_at)                          AS since,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY x.h) FILTER (WHERE x.match_type = 'email'))::numeric, 1) AS p50_hours,
       round((percentile_cont(0.8) WITHIN GROUP (ORDER BY x.h) FILTER (WHERE x.match_type = 'email'))::numeric, 1) AS p80_hours,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY x.h) FILTER (WHERE x.match_type = 'email'))::numeric, 1) AS p90_hours
  FROM (SELECT c.match_type, c.submission_created_at,
               extract(epoch FROM c.submission_created_at - c.partial_created_at) / 3600.0 AS h
          FROM public.registration_partial_conversions c) x
`;
