import type { VercelRequest, VercelResponse } from "@vercel/node";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
// Drizzle helpers imported via @workspace/db (single module identity) — see
// the re-export block in lib/db/src/index.ts for why.
import {
  and,
  db,
  eq,
  lt,
  sessions,
  users,
  type Session,
  type User,
} from "@workspace/db";

export const SESSION_COOKIE_NAME = "cjc_admin_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const SESSION_SLIDING_RENEWAL_SECONDS = 60 * 60 * 24; // renew if >24h old

// Pre-computed bcrypt hash with cost factor 10. Used as a stand-in target
// for bcrypt.compare() when an unknown email is supplied to /api/auth/login,
// so that the hash-comparison branch runs at the same cost regardless of
// whether the email exists in the DB. Without this, a faster response on
// unknown emails would leak the existence of registered emails to anyone
// probing the login endpoint (user-enumeration via timing).
//
// The hash is not a real account password and is safe to commit.
const DUMMY_BCRYPT_HASH =
  "$2a$10$ns7KqTuqwH97Q6KsTrxKlONPzAHYQrbW8GD3IjCXn/hiLjbBqhVEW";

export const BCRYPT_COST = 10;

/** Constant-time password verification via bcrypt.compare. */
export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Run a bcrypt.compare against a throwaway hash so that timing matches the
 * verifyPassword path. Always returns false. Call this when no user is
 * found for the requested email.
 */
export async function verifyDummyPassword(plaintext: string): Promise<false> {
  await bcrypt.compare(plaintext, DUMMY_BCRYPT_HASH);
  return false;
}

/** 32 random bytes -> 43-char base64url string. Cryptographically secure. */
export function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Parse the Cookie header into a key->value map. Returns an empty object
 * when the header is missing or malformed.
 */
function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export type AuthedSession = {
  session: Session;
  user: Pick<User, "id" | "email" | "name" | "isActive">;
};

/**
 * Look up the current session+user from the cookie. Returns null when:
 *   - no cookie present
 *   - session row missing
 *   - session expired (also deletes the stale row lazily)
 *   - user inactive
 *
 * On success, slides the session expiry forward when the session is older
 * than SESSION_SLIDING_RENEWAL_SECONDS (avoids hammering the DB on every
 * request).
 */
export async function getSessionFromCookie(
  req: VercelRequest,
): Promise<AuthedSession | null> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;

  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      email: users.email,
      name: users.name,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const now = new Date();
  if (row.expiresAt <= now) {
    // Stale — purge and treat as logged out.
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }
  if (!row.isActive) {
    // Deactivated mid-session — kill it.
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }

  // Sliding renewal: only update if the session has been around a while,
  // otherwise we'd write on every request.
  const sessionAgeSeconds = (now.getTime() - row.createdAt.getTime()) / 1000;
  if (sessionAgeSeconds > SESSION_SLIDING_RENEWAL_SECONDS) {
    const newExpiry = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    await db
      .update(sessions)
      .set({ expiresAt: newExpiry })
      .where(eq(sessions.id, sessionId));
    row.expiresAt = newExpiry;
  }

  return {
    session: {
      id: row.sessionId,
      userId: row.userId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    },
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      isActive: row.isActive,
    },
  };
}

/** Create a new session row and return its id. */
export async function createSession(userId: string): Promise<string> {
  const id = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({ id, userId, expiresAt });
  return id;
}

/** Delete a session row (logout). Returns true if a row was removed. */
export async function destroySession(sessionId: string): Promise<boolean> {
  const result = await db.delete(sessions).where(eq(sessions.id, sessionId));
  return (result.rowCount ?? 0) > 0;
}

/** Best-effort purge of expired sessions. Called occasionally by /api/auth/me. */
export async function purgeExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

function isProd(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

/** Serialize a Set-Cookie header value. Manual to avoid pulling a dep. */
function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; httpOnly: boolean; secure: boolean; sameSite: "Lax" | "Strict" | "None"; path: string },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(res: VercelResponse, sessionId: string): void {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE_NAME, sessionId, {
      maxAge: SESSION_TTL_SECONDS,
      httpOnly: true,
      // Secure only in prod (HTTP localhost wouldn't send the cookie back).
      secure: isProd(),
      sameSite: "Lax",
      path: "/",
    }),
  );
}

export function clearSessionCookie(res: VercelResponse): void {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE_NAME, "", {
      maxAge: 0,
      httpOnly: true,
      secure: isProd(),
      sameSite: "Lax",
      path: "/",
    }),
  );
}

/**
 * Convenience guard for protected handlers. On success returns the
 * AuthedSession. On failure writes a 401 to res and returns null — handler
 * must early-return when it gets null.
 */
export async function requireAuth(
  req: VercelRequest,
  res: VercelResponse,
): Promise<AuthedSession | null> {
  const auth = await getSessionFromCookie(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return auth;
}

/** Find an active user by email, or null. Email is lowercased. */
export async function findActiveUserByEmail(email: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email.trim().toLowerCase()), eq(users.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

/** Stamp users.last_login_at after a successful login. */
export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, userId));
}

