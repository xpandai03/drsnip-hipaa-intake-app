// DB fixture helpers for tests. Every test creates throwaway users +
// sessions using unique email addresses so concurrent test runs don't
// collide. All fixtures register themselves with cleanupAll() so tests
// can purge state in afterEach / after hooks.

import bcrypt from "bcryptjs";
import {
  db,
  eq,
  inArray,
  loginAttempts,
  sessions,
  users,
  type User,
} from "@workspace/db";
import { randomBytes } from "node:crypto";
import { createSession } from "../_lib/auth";

const createdUserIds = new Set<string>();
const createdEmails = new Set<string>();

export function uniqueEmail(prefix: string = "sprint1"): string {
  // test+ prefix matches the existing convention in PLAN_SF_DIRECT_PUSH.md.
  return `test+${prefix}-${randomBytes(6).toString("hex")}@xpand.test`;
}

export async function createTestUser(opts?: {
  email?: string;
  password?: string;
  name?: string;
  isActive?: boolean;
}): Promise<{ user: User; plaintextPassword: string }> {
  const email = (opts?.email ?? uniqueEmail()).toLowerCase();
  const plaintextPassword = opts?.password ?? "test-password-123!";
  const passwordHash = await bcrypt.hash(plaintextPassword, 10);
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name: opts?.name ?? "Test User",
      isActive: opts?.isActive ?? true,
    })
    .returning();
  createdUserIds.add(user.id);
  createdEmails.add(email);
  return { user, plaintextPassword };
}

export async function makeSessionFor(
  userId: string,
  opts?: { expiresAt?: Date; createdAt?: Date },
): Promise<string> {
  if (opts?.expiresAt || opts?.createdAt) {
    // Bypass createSession() helper so we can set bespoke timestamps for
    // expiry / sliding-window tests.
    const id = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({
      id,
      userId,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      expiresAt:
        opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 24 * 1000),
    });
    return id;
  }
  return createSession(userId);
}

export async function cleanupAll(): Promise<void> {
  if (createdEmails.size > 0) {
    await db
      .delete(loginAttempts)
      .where(inArray(loginAttempts.email, Array.from(createdEmails)));
  }
  for (const id of createdUserIds) {
    // sessions cascade via FK ON DELETE CASCADE.
    await db.delete(users).where(eq(users.id, id));
  }
  createdUserIds.clear();
  createdEmails.clear();
}

export function trackEmailForCleanup(email: string): void {
  createdEmails.add(email.toLowerCase());
}
