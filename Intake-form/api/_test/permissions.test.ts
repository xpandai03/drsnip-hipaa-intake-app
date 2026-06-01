// Phase 4 Block D — permission model unit tests. DB-FREE: exercises the pure
// predicates and the enforceAdmin HTTP gate with a mock response, so "viewer
// blocked / admin allowed / unauth rejected" is proven without a live DB.
//
// (Importing ../_lib/auth pulls in @workspace/db, which constructs a lazy pg
// Pool but opens no connection until a query runs — enforceAdmin never queries.)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canDeleteSubmission,
  canExportSubmissions,
  canGenerateLinks,
  isAdmin,
  normalizeRole,
} from "../_lib/permissions";
import { enforceAdmin, type AuthedSession } from "../_lib/auth";
import { makeRes } from "./harness";

function authWithRole(role: "admin" | "viewer"): AuthedSession {
  return {
    session: {
      id: "s1",
      userId: "u1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    },
    user: {
      id: "u1",
      email: `${role}@drsnip.test`,
      name: role,
      isActive: true,
      role,
    },
  };
}

// ---- normalizeRole: default-to-admin, only explicit 'viewer' restricts ----

test("normalizeRole resolves only 'viewer' to viewer; everything else admin", () => {
  assert.equal(normalizeRole("viewer"), "viewer");
  assert.equal(normalizeRole("admin"), "admin");
  // Rollout safety: null/unknown/legacy → admin (nobody loses access).
  assert.equal(normalizeRole(null), "admin");
  assert.equal(normalizeRole(undefined), "admin");
  assert.equal(normalizeRole(""), "admin");
  assert.equal(normalizeRole("superuser"), "admin");
});

// ---- predicates: every privileged action is admin-only --------------------

test("privileged-action predicates are admin-only", () => {
  assert.equal(isAdmin("admin"), true);
  assert.equal(isAdmin("viewer"), false);
  for (const can of [canDeleteSubmission, canExportSubmissions, canGenerateLinks]) {
    assert.equal(can("admin"), true);
    assert.equal(can("viewer"), false);
  }
});

// ---- enforceAdmin: the HTTP gate (no DB) ----------------------------------

test("enforceAdmin: admin passes, no error written", () => {
  const res = makeRes();
  const ok = enforceAdmin(authWithRole("admin"), res);
  assert.equal(ok, true);
  assert.equal(res.statusCode, 0); // untouched — handler proceeds
});

test("enforceAdmin: viewer is blocked with 403 Forbidden", () => {
  const res = makeRes();
  const ok = enforceAdmin(authWithRole("viewer"), res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.jsonBody, { error: "Forbidden" });
});

test("enforceAdmin: no session is rejected with 401 Unauthorized", () => {
  const res = makeRes();
  const ok = enforceAdmin(null, res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.jsonBody, { error: "Unauthorized" });
});
