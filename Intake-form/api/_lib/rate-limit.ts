import type { VercelRequest } from "@vercel/node";
// Drizzle helpers imported via @workspace/db (single module identity) — see
// the re-export block in lib/db/src/index.ts for why.
import { and, count, db, eq, gte, loginAttempts } from "@workspace/db";

export const MAX_FAILED_ATTEMPTS = 5;
export const WINDOW_MINUTES = 15;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Returns { allowed: false } when the email has accrued >= 5 failed
 * attempts in the last 15 minutes. Per-email (not per-IP) on purpose:
 * per-IP is trivially bypassed and lets a brute-force + enumeration combo
 * across rotating IPs.
 *
 * Successful attempts do NOT reset the counter (they don't move into the
 * failure count either) — but a successful login indicates the rate limit
 * isn't being hit anyway. Counter naturally drains as old attempts fall
 * out of the 15-minute window.
 */
export async function checkLoginRateLimit(
  email: string,
): Promise<RateLimitResult> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);
  const normalized = email.trim().toLowerCase();
  const rows = await db
    .select({ count: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, normalized),
        eq(loginAttempts.succeeded, false),
        gte(loginAttempts.attemptedAt, since),
      ),
    );
  const failures = rows[0]?.count ?? 0;
  if (failures < MAX_FAILED_ATTEMPTS) {
    return { allowed: true };
  }
  // Find the OLDEST failure inside the window — the user can retry once
  // it falls out. Conservative: full WINDOW_MINUTES from the oldest is the
  // worst case, so we just return that to keep the math simple.
  return { allowed: false, retryAfterSeconds: WINDOW_MINUTES * 60 };
}

export async function recordLoginAttempt(
  email: string,
  ipAddress: string | null,
  succeeded: boolean,
): Promise<void> {
  await db.insert(loginAttempts).values({
    email: email.trim().toLowerCase(),
    ipAddress,
    succeeded,
  });
}

/**
 * Extract a single client IP from common proxy headers. Vercel sets
 * `x-forwarded-for` to a comma-separated chain; the first entry is the
 * original client. Returns null when no IP can be derived (don't fail the
 * request — just store NULL in login_attempts.ip_address).
 */
export function clientIpFromRequest(req: VercelRequest): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0].split(",")[0].trim();
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real;
  return null;
}
