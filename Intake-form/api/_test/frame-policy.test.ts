// Framing policy — the path→policy mapping that closes the clickjacking gap.
// Pure; no server boot required.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_ANCESTORS_EMBED,
  FRAME_ANCESTORS_NONE,
  frameAncestorsFor,
  isNoFramePath,
  xFrameOptionsFor,
} from "../_lib/frame-policy";

test("public form routes stay embeddable by the client's site only", () => {
  for (const p of ["/", "/consultation", "/insurance", "/plan/roadmap"]) {
    assert.equal(frameAncestorsFor(p), FRAME_ANCESTORS_EMBED, p);
    assert.ok(frameAncestorsFor(p).includes("https://drsnip.com"));
    assert.ok(frameAncestorsFor(p).includes("https://www.drsnip.com"));
  }
});

test("the allowlist is exactly the client's two origins — no wildcard, no http", () => {
  assert.equal(FRAME_ANCESTORS_EMBED.includes("*"), false, "no wildcard origin");
  assert.equal(/\bhttp:\/\//.test(FRAME_ANCESTORS_EMBED), false, "https only");
  // A stray extra origin here would silently re-open the gap this train closes.
  assert.equal(
    FRAME_ANCESTORS_EMBED,
    "frame-ancestors 'self' https://drsnip.com https://www.drsnip.com",
  );
});

test("api, admin and healthz are not framable by anyone", () => {
  for (const p of [
    "/api/submit",
    "/api/submissions/abc",
    "/api/internal/files/abc",
    "/api/files/abc",
    "/healthz",
    "/admin",
    "/admin/submissions",
    "/admin/links",
  ]) {
    assert.equal(isNoFramePath(p), true, p);
    assert.equal(frameAncestorsFor(p), FRAME_ANCESTORS_NONE, p);
  }
});

test("X-Frame-Options is omitted on form routes and DENY elsewhere", () => {
  // XFO cannot express a third-party allowlist; SAMEORIGIN on a form route
  // would block the live insurance embed in browsers honouring XFO over CSP.
  for (const p of ["/", "/consultation", "/insurance"]) {
    assert.equal(xFrameOptionsFor(p), null, `${p} must not send XFO`);
  }
  for (const p of ["/api/submit", "/admin/submissions", "/healthz"]) {
    assert.equal(xFrameOptionsFor(p), "DENY", p);
  }
});

test("a path merely CONTAINING /admin or /api is still a form route", () => {
  // Guards against a startsWith/includes mix-up that would silently make a
  // public route unframable (breaking the embed) or vice versa.
  assert.equal(frameAncestorsFor("/not-admin"), FRAME_ANCESTORS_EMBED);
  assert.equal(frameAncestorsFor("/insurance?next=/admin"), FRAME_ANCESTORS_EMBED);
  assert.equal(frameAncestorsFor("/apifoo"), FRAME_ANCESTORS_EMBED);
});

test("frame-ancestors is the ONLY directive — a fuller CSP is out of scope", () => {
  // script-src/style-src would break the SPA's inline styles and Google Fonts.
  for (const v of [FRAME_ANCESTORS_EMBED, FRAME_ANCESTORS_NONE]) {
    assert.equal(v.includes(";"), false, "no additional directives");
    assert.ok(v.startsWith("frame-ancestors "));
  }
});
