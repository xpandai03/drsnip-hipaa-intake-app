// The agency analytics tag — and, mostly, proof that it cannot reach /admin/*.
//
// The console holds patient names, DOBs, insurance details and card images. The
// SPA serves one index.html shell for every route, so "form pages only" is a
// property of the SERVER's path check, not of the client-side router. These
// tests pin that check hard: the admin cases below are the deliverable.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ANALYTICS_ROUTES,
  analyticsEnabled,
  analyticsSnippet,
  analyticsSrc,
  injectAnalytics,
  isAnalyticsRoute,
} from "../_lib/analytics";
import { EMBED_FORMS } from "../../artifacts/intake-form/src/lib/embed";

const SRC = "https://tracking.intrepy.com/js/container_ExuDe77v.js";
const SHELL =
  '<!DOCTYPE html><html lang="en"><head><title>DrSnip Patient Intake</title>' +
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
  "</head><body><div id=\"root\"></div></body></html>";

// Every admin route App.tsx declares, plus the shapes a typo or a future route
// could take. If any of these ever injects, PHI is exposed to a container we do
// not control.
const ADMIN_PATHS = [
  "/admin",
  "/admin/",
  "/admin/signin",
  "/admin/links",
  "/admin/dashboard",
  "/admin/activity",
  "/admin/dropoffs",
  "/admin/ask-ai",
  "/admin/sources",
  "/admin/submissions",
  "/admin/submissions/0a2c417f-1111-2222-3333-444455556666",
  "/admin/submissions/abc?tab=insurance",
  "/ADMIN/links",
  "/admin/anything/added/later",
];

describe("the admin console never gets the tag", () => {
  it("no admin path is an analytics route", () => {
    for (const p of ADMIN_PATHS) {
      assert.equal(isAnalyticsRoute(p), false, p);
    }
  });

  it("injectAnalytics refuses admin paths even when enabled and configured", () => {
    // This is the belt-and-braces: even if someone later wires the handler to a
    // wildcard Hono route, the function itself still returns null here.
    for (const p of ADMIN_PATHS) {
      assert.equal(injectAnalytics(p, SHELL, SRC), null, p);
    }
  });

  it("the shell an admin path would receive is byte-identical to the build output", () => {
    for (const p of ADMIN_PATHS) {
      const out = injectAnalytics(p, SHELL, SRC);
      // null means "serve the file unchanged" — the server calls next() and
      // serveStatic streams the untouched file. Nothing is rewritten.
      assert.equal(out, null, p);
    }
    assert.equal(SHELL.includes("intrepy"), false);
  });

  it("neither is any other non-form route", () => {
    for (const p of [
      "/plan",
      "/plan/roadmap",
      "/integration",
      "/internal-tools-x9k2",
      "/healthz",
      "/api/submissions",
      "/api/internal/files/abc",
      "/favicon.svg",
      "/assets/index-abc.js",
      "",
      "//",
      "/consultation/extra",
      "/insurance/",
    ]) {
      assert.equal(isAnalyticsRoute(p), false, JSON.stringify(p));
      assert.equal(injectAnalytics(p, SHELL, SRC), null, JSON.stringify(p));
    }
  });
});

describe("the allowlist is exactly the three public forms", () => {
  it("matches EMBED_FORMS, so a new form cannot silently drift out", () => {
    assert.deepEqual([...ANALYTICS_ROUTES].sort(), EMBED_FORMS.map((f) => f.path).sort());
  });

  it("contains no wildcard, prefix or pattern character", () => {
    assert.deepEqual([...ANALYTICS_ROUTES], ["/", "/consultation", "/insurance"]);
    for (const r of ANALYTICS_ROUTES) {
      assert.equal(/[*:?()\[\]]/.test(r), false, r);
    }
  });

  it("isAnalyticsRoute matches exactly — no startsWith, no regex", () => {
    // A prefix match would make "/insurance-old" or a future "/admin-report"
    // question of luck rather than policy. Read the function body and pin it.
    const src = readFileSync(new URL("../_lib/analytics.ts", import.meta.url), "utf8");
    const body = src.split("export function isAnalyticsRoute")[1]?.split("}")[0] ?? "";
    assert.ok(body.includes("ANALYTICS_ROUTES.includes(path)"), "exact membership test");
    for (const loose of ["startsWith", "endsWith", "indexOf", "RegExp", "match("]) {
      assert.equal(body.includes(loose), false, loose);
    }
  });
});

describe("form routes do get it, exactly once", () => {
  for (const p of ["/", "/consultation", "/insurance"]) {
    it(`injects into ${p}`, () => {
      const out = injectAnalytics(p, SHELL, SRC);
      assert.ok(out, "expected injection");
      assert.equal(out!.split(SRC).length - 1, 1, "exactly one tag");
      assert.ok(out!.indexOf(SRC) < out!.indexOf("</head>"), "inside <head>");
      assert.ok(out!.includes("<div id=\"root\"></div>"), "app shell intact");
      // Everything that was in the shell is still in the shell.
      assert.equal(out!.replace(analyticsSnippet(SRC), ""), SHELL);
    });
  }

  it("injects nothing when the shell has no </head>", () => {
    assert.equal(injectAnalytics("/", "<html><body>hi</body></html>", SRC), null);
  });
});

describe("the tag is loaded and handed nothing", () => {
  const snippet = analyticsSnippet(SRC);

  it("is a plain external script — no proxy, no eval, no document.write", () => {
    assert.ok(snippet.includes(`<script async src="${SRC}"></script>`));
    for (const banned of [
      "eval(",
      "document.write",
      "Function(",
      "innerHTML",
      "googletagmanager",
      "dataLayer",
      "<noscript",
      "<iframe",
    ]) {
      assert.equal(snippet.includes(banned), false, banned);
    }
  });

  it("carries no data of ours — the only inline statement is the vendor's queue", () => {
    // If this ever grows a push of form values, patient fields or URL params,
    // this assertion is the thing that fails.
    const inline = snippet.slice(snippet.indexOf("<script>") + 8, snippet.indexOf("</script>"));
    assert.equal(
      inline,
      'window._mtm=window._mtm||[];window._mtm.push({"mtm.startTime":(new Date().getTime()),"event":"mtm.Start"});',
    );
    for (const phi of [
      "email", "phone", "dob", "birth", "name", "insurance", "member",
      "patient", "gclid", "fbclid", "utm_", "location.search", "referrer",
    ]) {
      assert.equal(snippet.toLowerCase().includes(phi), false, phi);
    }
  });

  it("references exactly one URL: the configured container", () => {
    const urls = [...snippet.matchAll(/https?:\/\/[^"'\s]+/g)].map((m) => m[0]);
    assert.deepEqual(urls, [SRC]);
  });
});

describe("the src is validated as untrusted config", () => {
  it("accepts the agency container", () => {
    assert.equal(analyticsSrc(SRC), SRC);
    assert.equal(analyticsSrc(`  ${SRC}  `), SRC);
  });

  it("rejects anything that is not a plain https URL", () => {
    for (const bad of [
      undefined,
      "",
      "   ",
      "http://tracking.intrepy.com/js/c.js",
      "//tracking.intrepy.com/js/c.js",
      "javascript:alert(1)",
      "data:text/javascript,alert(1)",
      "tracking.intrepy.com/js/c.js",
      "https://user:pass@tracking.intrepy.com/c.js",
      'https://x.com/c.js"></script><script>alert(1)</script>',
      "https://x.com/c.js\"onload=\"alert(1)",
      "https://x.com/a b.js",
      "https://x.com/c.js'",
      "https://x.com/<script>",
      "not a url at all",
    ]) {
      assert.equal(analyticsSrc(bad as string | undefined), null, String(bad));
    }
  });

  it("a rejected src means no injection anywhere", () => {
    assert.equal(injectAnalytics("/", SHELL, "javascript:alert(1)"), null);
    assert.equal(injectAnalytics("/", SHELL, undefined), null);
  });
});

describe("the enable flag fails closed", () => {
  it("is off unless it is exactly true", () => {
    for (const off of [undefined, "", " ", "0", "1", "yes", "on", "enabled", "false", "no"]) {
      assert.equal(analyticsEnabled(off as string | undefined), false, String(off));
    }
  });

  it("is on for true, case- and space-insensitively", () => {
    for (const on of ["true", "TRUE", " True "]) {
      assert.equal(analyticsEnabled(on), true, on);
    }
  });
});

describe("the server wiring cannot broaden the allowlist", () => {
  const server = readFileSync(new URL("../../api-server/index.ts", import.meta.url), "utf8");

  it("registers the analytics handler only by iterating ANALYTICS_ROUTES", () => {
    assert.ok(server.includes("for (const route of ANALYTICS_ROUTES)"));
    assert.ok(server.includes("app.get(route,"));
    // No hand-written path next to the injector.
    assert.equal(/app\.get\("\/admin/.test(server), false);
  });

  it("registers it before the static/SPA-fallback handlers", () => {
    assert.ok(
      server.indexOf("for (const route of ANALYTICS_ROUTES)") <
        server.indexOf('app.use("/*", serveStatic'),
      "analytics routes must win over serveStatic for the three form paths",
    );
  });

  it("does not register at all unless both env vars are set", () => {
    assert.ok(server.includes("if (ANALYTICS_ON && ANALYTICS_SRC) {"));
  });
});
