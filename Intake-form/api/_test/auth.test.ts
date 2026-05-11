// Unit tests for the auth + session helpers and the requireAuth guard.
//
// Run from Intake-form/ with DATABASE_URL set:
//   pnpm run test
//
// Tests create throwaway users (test+sprint1-*@xpand.test) and clean up
// after each test. Hits the real Neon DB on purpose — mocking the DB
// would let drift creep in between schema and query shape.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { db, eq, sessions, users } from "@workspace/db";
import {
  SESSION_COOKIE_NAME,
  getSessionFromCookie,
  requireAuth,
  verifyDummyPassword,
  verifyPassword,
} from "../_lib/auth";
import { cleanupAll, createTestUser, makeSessionFor } from "./fixtures";
import { makeReq, makeRes } from "./harness";

describe("verifyPassword", () => {
  after(cleanupAll);

  it("accepts a correct password", async () => {
    const { user, plaintextPassword } = await createTestUser({
      password: "correct-horse-battery-staple",
    });
    const ok = await verifyPassword(plaintextPassword, user.passwordHash);
    assert.equal(ok, true);
  });

  it("rejects a wrong password", async () => {
    const { user } = await createTestUser({
      password: "correct-horse-battery-staple",
    });
    const ok = await verifyPassword("not-the-password", user.passwordHash);
    assert.equal(ok, false);
  });

  it("verifyDummyPassword always returns false and takes non-trivial time", async () => {
    const start = Date.now();
    const result = await verifyDummyPassword("anything");
    const elapsed = Date.now() - start;
    assert.equal(result, false);
    // Cost-10 bcrypt is ~5-50ms depending on hardware. The point is it
    // actually ran bcrypt, not that it short-circuited.
    assert.ok(elapsed > 1, `expected non-trivial elapsed, got ${elapsed}ms`);
  });
});

describe("requireAuth + getSessionFromCookie", () => {
  after(cleanupAll);

  it("returns null and writes 401 for missing cookie", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const auth = await requireAuth(req, res);
    assert.equal(auth, null);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonBody, { error: "Unauthorized" });
  });

  it("returns the session for a valid cookie", async () => {
    const { user } = await createTestUser();
    const sessionId = await makeSessionFor(user.id);
    const req = makeReq({
      method: "GET",
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
    });
    const res = makeRes();
    const auth = await requireAuth(req, res);
    assert.ok(auth, "expected an authed session");
    assert.equal(auth.user.email, user.email);
    assert.equal(auth.user.name, user.name);
    assert.equal(auth.user.id, user.id);
    // requireAuth should NOT have written a response on success.
    assert.equal(res.statusCode, 0);
  });

  it("returns null for an expired session and lazily deletes the row", async () => {
    const { user } = await createTestUser();
    const sessionId = await makeSessionFor(user.id, {
      expiresAt: new Date(Date.now() - 60_000), // expired 1 minute ago
    });
    const req = makeReq({
      method: "GET",
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
    });
    const result = await getSessionFromCookie(req);
    assert.equal(result, null);
    // The stale row should now be gone.
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    assert.equal(rows.length, 0, "expired session row should have been purged");
  });

  it("returns null and purges the row when the user is deactivated", async () => {
    const { user } = await createTestUser({ isActive: true });
    const sessionId = await makeSessionFor(user.id);
    // Flip isActive off in-place.
    await db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, user.id));
    const req = makeReq({
      method: "GET",
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
    });
    const result = await getSessionFromCookie(req);
    assert.equal(result, null);
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    assert.equal(rows.length, 0, "inactive-user session should be purged");
  });
});

before(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run auth tests");
  }
});
