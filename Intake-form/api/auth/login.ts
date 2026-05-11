import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import {
  createSession,
  findActiveUserByEmail,
  recordSuccessfulLogin,
  setSessionCookie,
  verifyDummyPassword,
  verifyPassword,
} from "../_lib/auth";
import {
  checkLoginRateLimit,
  clientIpFromRequest,
  recordLoginAttempt,
} from "../_lib/rate-limit";

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

// Single error message for every failure mode where a real user might be
// brute-forcing or enumerating accounts. Phrasing avoids hinting at which
// of "email" / "password" was wrong.
const GENERIC_AUTH_ERROR = "Invalid email or password";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    // Returning 400 here would let an attacker distinguish "malformed
    // body" from "wrong credentials" — but malformed JSON only happens
    // through client bugs, not adversarial probing. Safe to be specific.
    return res
      .status(400)
      .json({ error: "Invalid request body" });
  }

  const { email, password } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();
  const ip = clientIpFromRequest(req);

  // Rate-limit gate. Per-email — see comment in rate-limit.ts.
  const gate = await checkLoginRateLimit(normalizedEmail);
  if (!gate.allowed) {
    res.setHeader("Retry-After", String(gate.retryAfterSeconds));
    return res.status(429).json({
      error: "Too many failed attempts, try again in 15 minutes",
    });
  }

  const user = await findActiveUserByEmail(normalizedEmail);

  if (!user) {
    // Run bcrypt against a dummy hash so this branch costs the same as a
    // real verifyPassword call. Without this, an attacker can detect
    // "email is registered" by measuring response latency.
    await verifyDummyPassword(password);
    await recordLoginAttempt(normalizedEmail, ip, false);
    return res.status(401).json({ error: GENERIC_AUTH_ERROR });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    await recordLoginAttempt(normalizedEmail, ip, false);
    return res.status(401).json({ error: GENERIC_AUTH_ERROR });
  }

  // Success. Record attempt, create session, set cookie, stamp last_login.
  await recordLoginAttempt(normalizedEmail, ip, true);
  const sessionId = await createSession(user.id);
  setSessionCookie(res, sessionId);
  await recordSuccessfulLogin(user.id);

  return res.status(200).json({ email: user.email, name: user.name });
}
