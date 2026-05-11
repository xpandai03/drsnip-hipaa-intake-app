import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { db, eq, sessions } from "@workspace/db";
import logoutHandler from "../auth/logout";
import { SESSION_COOKIE_NAME } from "../_lib/auth";
import { cleanupAll, createTestUser, makeSessionFor } from "./fixtures";
import { makeReq, makeRes } from "./harness";

before(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run logout tests");
  }
});

describe("POST /api/auth/logout", () => {
  after(cleanupAll);

  it("clears the cookie and deletes the session row", async () => {
    const { user } = await createTestUser();
    const sessionId = await makeSessionFor(user.id);

    const req = makeReq({
      method: "POST",
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
    });
    const res = makeRes();
    await logoutHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, { ok: true });
    const cookie = res.headers["Set-Cookie"];
    const cookieStr = Array.isArray(cookie) ? cookie[0] : (cookie as string);
    assert.match(cookieStr, /Max-Age=0/);

    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    assert.equal(rows.length, 0, "session row should have been deleted");
  });

  it("is idempotent when no cookie is present", async () => {
    const req = makeReq({ method: "POST" });
    const res = makeRes();
    await logoutHandler(req, res);
    assert.equal(res.statusCode, 200);
    // Still clears the cookie on the client.
    const cookie = res.headers["Set-Cookie"];
    const cookieStr = Array.isArray(cookie) ? cookie[0] : (cookie as string);
    assert.match(cookieStr, /Max-Age=0/);
  });

  it("rejects non-POST methods", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await logoutHandler(req, res);
    assert.equal(res.statusCode, 405);
  });
});
