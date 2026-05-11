// Integration tests for the login endpoint. Exercises:
//   - 401 for unknown email (with equal timing to known-but-wrong-password)
//   - 401 for known email + wrong password
//   - 200 + Set-Cookie for known email + correct password
//   - 429 after 5 failed attempts (rate limit)
//   - 400 for malformed bodies

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { db, eq, loginAttempts } from "@workspace/db";
import loginHandler from "../auth/login";
import { SESSION_COOKIE_NAME } from "../_lib/auth";
import {
  cleanupAll,
  createTestUser,
  trackEmailForCleanup,
  uniqueEmail,
} from "./fixtures";
import { makeReq, makeRes, readSessionCookieFromRes } from "./harness";

before(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run login tests");
  }
});

describe("POST /api/auth/login", () => {
  after(cleanupAll);

  it("returns 405 for non-POST methods", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await loginHandler(req, res);
    assert.equal(res.statusCode, 405);
  });

  it("returns 400 for malformed body", async () => {
    const req = makeReq({ method: "POST", body: { email: "not-an-email" } });
    const res = makeRes();
    await loginHandler(req, res);
    assert.equal(res.statusCode, 400);
    // Message must not leak which field failed — see PR sign-off note.
    assert.deepEqual(res.jsonBody, { error: "Invalid request body" });
  });

  it("returns 401 for an unknown email", async () => {
    const email = uniqueEmail();
    trackEmailForCleanup(email);
    const req = makeReq({
      method: "POST",
      body: { email, password: "anything-here" },
    });
    const res = makeRes();
    await loginHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonBody, { error: "Invalid email or password" });
  });

  it("returns 401 for known email + wrong password", async () => {
    const { user } = await createTestUser({ password: "real-password-123" });
    const req = makeReq({
      method: "POST",
      body: { email: user.email, password: "wrong-password" },
    });
    const res = makeRes();
    await loginHandler(req, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonBody, { error: "Invalid email or password" });
  });

  it("returns 200 + Set-Cookie for correct credentials", async () => {
    const { user, plaintextPassword } = await createTestUser({
      password: "real-password-123",
      name: "Test Person",
    });
    const req = makeReq({
      method: "POST",
      body: { email: user.email, password: plaintextPassword },
    });
    const res = makeRes();
    await loginHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, { email: user.email, name: "Test Person" });
    const cookie = readSessionCookieFromRes(res, SESSION_COOKIE_NAME);
    assert.ok(cookie, "expected Set-Cookie header with session id");
    assert.ok(cookie.length >= 40, `cookie value too short: ${cookie}`);
    const setCookieHeader = res.headers["Set-Cookie"];
    const headerStr = Array.isArray(setCookieHeader)
      ? setCookieHeader[0]
      : (setCookieHeader as string);
    assert.match(headerStr, /HttpOnly/i);
    assert.match(headerStr, /SameSite=Lax/i);
    assert.match(headerStr, /Path=\//);
    assert.match(headerStr, /Max-Age=2592000/);
  });

  it("returns 429 after 5 failed attempts in the rate-limit window", async () => {
    const { user } = await createTestUser({ password: "right-pw" });
    // Hit 5 wrong-password attempts.
    for (let i = 0; i < 5; i++) {
      const req = makeReq({
        method: "POST",
        body: { email: user.email, password: `wrong-${i}` },
      });
      const res = makeRes();
      await loginHandler(req, res);
      assert.equal(res.statusCode, 401, `attempt ${i + 1} should be 401`);
    }
    // 6th — even with the CORRECT password — must be blocked.
    const req = makeReq({
      method: "POST",
      body: { email: user.email, password: "right-pw" },
    });
    const res = makeRes();
    await loginHandler(req, res);
    assert.equal(res.statusCode, 429);
    assert.ok(res.headers["Retry-After"], "expected Retry-After header");
    assert.deepEqual(res.jsonBody, {
      error: "Too many failed attempts, try again in 15 minutes",
    });
  });

  it("response time on unknown email ≈ response time on known wrong password (anti-enumeration)", async () => {
    const { user } = await createTestUser({ password: "real-password-123" });
    const knownEmail = user.email;
    const unknownEmail = uniqueEmail("timing");
    trackEmailForCleanup(unknownEmail);

    // Warm both code paths so JIT / connection-pool warmup don't skew run 1.
    await loginHandler(
      makeReq({
        method: "POST",
        body: { email: knownEmail, password: "warm" },
      }),
      makeRes(),
    );
    await loginHandler(
      makeReq({
        method: "POST",
        body: { email: unknownEmail, password: "warm" },
      }),
      makeRes(),
    );

    const knownTimes: number[] = [];
    const unknownTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await loginHandler(
        makeReq({
          method: "POST",
          body: { email: knownEmail, password: `attempt-${i}` },
        }),
        makeRes(),
      );
      knownTimes.push(performance.now() - t0);

      const t1 = performance.now();
      await loginHandler(
        makeReq({
          method: "POST",
          body: { email: unknownEmail, password: `attempt-${i}` },
        }),
        makeRes(),
      );
      unknownTimes.push(performance.now() - t1);
    }
    const avgKnown =
      knownTimes.reduce((a, b) => a + b, 0) / knownTimes.length;
    const avgUnknown =
      unknownTimes.reduce((a, b) => a + b, 0) / unknownTimes.length;
    const ratio = Math.max(avgKnown, avgUnknown) / Math.min(avgKnown, avgUnknown);
    // The point isn't sub-ms equality (Neon latency dominates). It's that
    // the dummy bcrypt keeps both paths in the same order of magnitude
    // and within 2× of each other on average. If someone deletes the
    // verifyDummyPassword call, the unknown-email path drops by ~10-50ms
    // and this ratio blows past 2.
    assert.ok(
      ratio < 2,
      `timing ratio too high: known=${avgKnown.toFixed(1)}ms unknown=${avgUnknown.toFixed(1)}ms ratio=${ratio.toFixed(2)}`,
    );
    // Cleanup the attempts we just generated.
    await db.delete(loginAttempts).where(eq(loginAttempts.email, knownEmail));
    await db.delete(loginAttempts).where(eq(loginAttempts.email, unknownEmail));
  });
});
