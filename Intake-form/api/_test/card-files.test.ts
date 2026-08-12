// Card image storage (Insurance Cards train). DB-FREE where possible:
// exercises the pure classifier, the never-block guarantee on empty bodies,
// and the /api/files/:id auth/method guards (which short-circuit before any DB
// query). Cascade delete + real byte round-trips are proven by the live smoke,
// not here — this suite has no Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCardBytes,
  storeSubmissionFiles,
  ALLOWED_MIME,
  RENDERABLE_MIME,
  MAX_BYTES,
} from "../_lib/card-files";
import fileHandler from "../files/[id]";
import { makeReq, makeRes } from "./harness";

// ---- classifyCardBytes: the single source of truth for what gets stored ----

test("classifyCardBytes: a valid small jpeg is stored WITH bytes", () => {
  const r = classifyCardBytes(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg");
  assert.equal(r.status, "stored");
  assert.equal(r.keepBytes, true);
});

test("classifyCardBytes: every allowed mime is accepted", () => {
  for (const mime of ALLOWED_MIME) {
    const r = classifyCardBytes(Buffer.from([1, 2, 3]), mime);
    assert.equal(r.status, "stored", `${mime} should be stored`);
  }
});

test("classifyCardBytes: mime is matched case-insensitively", () => {
  const r = classifyCardBytes(Buffer.from([1]), "IMAGE/JPEG");
  assert.equal(r.status, "stored");
});

test("classifyCardBytes: an over-cap file is too_large and keeps NO bytes", () => {
  const buf = Buffer.alloc(MAX_BYTES + 1);
  const r = classifyCardBytes(buf, "image/jpeg");
  assert.equal(r.status, "too_large");
  assert.equal(r.keepBytes, false);
});

test("classifyCardBytes: a disallowed mime is rejected and keeps NO bytes", () => {
  for (const mime of ["image/gif", "application/zip", "text/html", ""]) {
    const r = classifyCardBytes(Buffer.from([1, 2, 3]), mime);
    assert.equal(r.status, "rejected", `${mime || "(empty)"} should be rejected`);
    assert.equal(r.keepBytes, false);
  }
});

test("classifyCardBytes: null / empty bytes are failed, never stored", () => {
  assert.deepEqual(classifyCardBytes(null, "image/jpeg"), {
    status: "failed",
    keepBytes: false,
  });
  assert.deepEqual(classifyCardBytes(Buffer.alloc(0), "image/jpeg"), {
    status: "failed",
    keepBytes: false,
  });
});

test("classifyCardBytes: bytes are kept ONLY for the stored status (PHI guard)", () => {
  // Whatever the inputs, a non-stored classification never carries bytes.
  const cases: Array<[Buffer | null, string | null]> = [
    [null, "image/jpeg"],
    [Buffer.alloc(0), "image/png"],
    [Buffer.alloc(MAX_BYTES + 1), "image/jpeg"],
    [Buffer.from([1]), "application/zip"],
    [Buffer.from([1]), null],
  ];
  for (const [buf, mime] of cases) {
    const r = classifyCardBytes(buf, mime);
    assert.notEqual(r.status, "stored");
    assert.equal(r.keepBytes, false);
  }
});

// ---- Renderability: heic/pdf are stored but not <img>-renderable ----------

test("RENDERABLE_MIME: browser-renderable images only; heic/pdf excluded", () => {
  for (const m of ["image/jpeg", "image/png", "image/webp"]) {
    assert.ok(RENDERABLE_MIME.has(m), `${m} should be renderable`);
  }
  for (const m of ["image/heic", "image/heif", "application/pdf"]) {
    assert.ok(!RENDERABLE_MIME.has(m), `${m} must NOT be inline-rendered`);
  }
});

// ---- Never-block: fire-and-forget storage must not throw on empty input ----

test("storeSubmissionFiles: no cards on the body → resolves, no throw", async () => {
  await assert.doesNotReject(() =>
    storeSubmissionFiles("00000000-0000-0000-0000-000000000000", {
      formType: "registration",
      firstName: "Test",
    }),
  );
});

test("storeSubmissionFiles: undefined/null body → resolves, no throw", async () => {
  await assert.doesNotReject(() =>
    storeSubmissionFiles("00000000-0000-0000-0000-000000000000", undefined),
  );
  await assert.doesNotReject(() =>
    storeSubmissionFiles("00000000-0000-0000-0000-000000000000", null),
  );
});

test("storeSubmissionFiles: a card slot with no base64Data is skipped (no throw)", async () => {
  // Historical shape — filename/metadata but no bytes. Must not attempt an
  // insert (and thus must not require a DB) and must not throw.
  await assert.doesNotReject(() =>
    storeSubmissionFiles("00000000-0000-0000-0000-000000000000", {
      insuranceCardFront: { filename: "front.jpg", contentType: "image/jpeg" },
    }),
  );
});

// ---- /api/files/:id guards (short-circuit before any DB query) ------------

test("GET /api/files/:id: non-GET method → 405 with Allow header", async () => {
  const res = makeRes();
  await fileHandler(makeReq({ method: "POST", query: { id: "x" } }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.getHeader("Allow"), "GET");
});

test("GET /api/files/:id: no session cookie → 401 (never reaches DB)", async () => {
  const res = makeRes();
  await fileHandler(
    makeReq({
      method: "GET",
      query: { id: "11111111-1111-1111-1111-111111111111" },
    }),
    res,
  );
  assert.equal(res.statusCode, 401);
  // The bytes column must never be served to an unauthenticated caller.
  assert.notEqual(res.statusCode, 200);
});
