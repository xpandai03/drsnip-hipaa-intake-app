// Service-to-service auth for the internal endpoints n8n calls (Train C,
// consumed in Train D). This is deliberately NOT the console session auth:
// n8n has no session, and giving it one would mean minting a long-lived admin
// cookie for a machine.
//
// SEPARATE SECRET (FINDINGS-bridge-insurance.md guardrail B6): the token lives
// in N8N_SERVICE_TOKEN, distinct from N8N_WEBHOOK_SECRET. A problem on the
// card-fetch path therefore cannot 401 the bridge webhooks, and rotating one
// does not rotate the other.
//
// FAIL CLOSED: if the token is not configured, every request is rejected. An
// unset env var must never mean "no auth required" on an endpoint that streams
// PHI bytes.
//
// HIPAA: this module logs the outcome and the reason only — never the presented
// token, never the expected token, never any request body.

import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const SERVICE_TOKEN_HEADER = "x-drsnip-service-token";

function expectedToken(): string {
  return process.env.N8N_SERVICE_TOKEN ?? "";
}

/** Whether a service token is configured at all. Exported for diagnostics and
 *  tests; callers should use requireServiceToken, which fails closed. */
export function serviceTokenConfigured(): boolean {
  return expectedToken().length > 0;
}

/**
 * Constant-time token comparison. Pure + exported so the auth rule is testable
 * without a live request. Returns false for a missing/blank/oversized token and
 * for any non-string input — there is no code path where those succeed.
 *
 * Length is compared first (and non-secretly): timingSafeEqual throws on a
 * length mismatch, and the length of a rejected guess is not the secret.
 */
export function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string") return false;
  if (expected.length === 0) return false;
  if (presented.length !== expected.length) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Multi-byte UTF-8 could still diverge in byte length after the char check.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function headerValue(req: VercelRequest): unknown {
  const v = req.headers[SERVICE_TOKEN_HEADER];
  return Array.isArray(v) ? v[0] : v;
}

function audit(event: string, fields: Record<string, unknown>): void {
  console.log(
    `[service-auth] ${event} ` +
      JSON.stringify({ ts: new Date().toISOString(), ...fields }),
  );
}

/**
 * Guard for the internal endpoints. Returns true when the caller is
 * authenticated; otherwise it has ALREADY sent a 401 and the handler must
 * return immediately.
 *
 * Mirrors the requireAuth(req, res) contract used by the console routes so the
 * call sites read the same way.
 */
export function requireServiceToken(
  req: VercelRequest,
  res: VercelResponse,
  route: string,
): boolean {
  const expected = expectedToken();
  if (expected.length === 0) {
    audit("denied", { route, reason: "token_not_configured" });
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (!tokenMatches(headerValue(req), expected)) {
    audit("denied", { route, reason: "token_mismatch" });
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}
