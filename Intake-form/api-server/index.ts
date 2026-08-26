// Single-process API + static server for the DrSnip intake app.
//
// Phase 1 (DrSnip): replaces the Vercel serverless functions for the Fly.io
// deployment. Every former api/<route>.ts handler is mounted here as a Hono
// route through the vercel-adapter shim — the handler logic is unchanged.
// Hono also serves the built Vite SPA with an SPA-fallback so client-side
// (wouter) routes resolve.
//
// Listens on $PORT (default 8080).

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { adapt } from "./vercel-adapter";
import {
  frameAncestorsFor,
  xFrameOptionsFor,
} from "../api/_lib/frame-policy";

import submitHandler from "../api/submit";
import loginHandler from "../api/auth/login";
import logoutHandler from "../api/auth/logout";
import meHandler from "../api/auth/me";
import submissionsHandler from "../api/submissions/index";
import submissionsExportHandler from "../api/submissions/export";
import submissionDetailHandler from "../api/submissions/[id]";
import submissionPdfHandler from "../api/submissions/[id]/pdf";
import activityHandler from "../api/submissions/activity";
import submissionsBulkDeleteHandler from "../api/submissions/bulk-delete";
import settingsHandler from "../api/settings/[key]";
import marketingSourcesHandler from "../api/admin/marketing-sources";
import marketingSourceByIdHandler from "../api/admin/marketing-sources/[id]";
import linksHandler from "../api/admin/links";
import reportingConnectorHandler from "../api/admin/reporting-connector";
import reportsSummaryHandler from "../api/reports/summary";
import reportsCountsHandler from "../api/reports/counts";
import registrationPartialHandler from "../api/registration-partial";
import registrationPartialsListHandler from "../api/registration-partials/index";
import registrationPartialsExportHandler from "../api/registration-partials/export";
import registrationPartialDeleteHandler from "../api/registration-partials/[id]";
import fileHandler from "../api/files/[id]";
import internalSubmissionFilesHandler from "../api/internal/submission-files/[submissionId]";
import internalFileHandler from "../api/internal/files/[id]";
import internalInsurancePdfHandler from "../api/internal/insurance-pdf/[submissionId]";

const app = new Hono();

// ---- Framing policy ----------------------------------------------------
// Registered FIRST so it covers every route, including the static SPA and the
// client-side-routing fallback. Sets the header BEFORE next(), matching the
// existing /plan/* X-Robots-Tag middleware — that pattern is proven to ride the
// index.html document response through serveStatic.
//
// Public form routes are embeddable by the client's marketing site only;
// /api/*, /admin/* and /healthz are not framable at all. Only frame-ancestors
// is set — see api/_lib/frame-policy.ts for why a fuller CSP is out of scope.
app.use("*", async (c, next) => {
  await next();
  // Set AFTER next() on purpose. The /api/* routes run through
  // ./vercel-adapter, which builds a brand-new Response from only the headers
  // the wrapped handler set — anything applied before next() is discarded on
  // those routes. Applying afterwards lands on the final response for every
  // route shape: adapted handlers, c.json(), and serveStatic alike.
  const path = c.req.path;
  c.header("Content-Security-Policy", frameAncestorsFor(path));
  const xfo = xFrameOptionsFor(path);
  // Omitted on the form routes on purpose: X-Frame-Options cannot express a
  // third-party allowlist, so SAMEORIGIN there would block the intended embed.
  if (xfo) c.header("X-Frame-Options", xfo);
});

// ---- Health check (Fly.io http_service checks hit this) ----------------
app.get("/healthz", (c) => c.json({ status: "ok" }));

// ---- API routes --------------------------------------------------------
// Each route is mounted with `.all()` — the underlying handler does its own
// method dispatch (and returns 405 for unsupported methods), exactly as it
// did under Vercel. `/api/submissions/activity` is registered before the
// `/:id` route so the static segment always wins.
app.all("/api/submit", adapt(submitHandler));
app.all("/api/auth/login", adapt(loginHandler));
app.all("/api/auth/logout", adapt(logoutHandler));
app.all("/api/auth/me", adapt(meHandler));
app.all("/api/submissions", adapt(submissionsHandler));
app.all("/api/submissions/activity", adapt(activityHandler));
// Static segment before the `/:id` route so "export" isn't read as an id (D.2).
app.all("/api/submissions/export", adapt(submissionsExportHandler));
// Static segment before `/:id` so "bulk-delete" isn't read as an id.
app.all("/api/submissions/bulk-delete", adapt(submissionsBulkDeleteHandler));
app.all("/api/submissions/:id/pdf", adapt(submissionPdfHandler));
app.all("/api/submissions/:id", adapt(submissionDetailHandler));
app.all("/api/settings/:key", adapt(settingsHandler));
app.all("/api/admin/marketing-sources", adapt(marketingSourcesHandler));
app.all("/api/admin/marketing-sources/:id", adapt(marketingSourceByIdHandler));
app.all("/api/admin/links", adapt(linksHandler));
app.all("/api/admin/reporting-connector", adapt(reportingConnectorHandler));
app.all("/api/reports/summary", adapt(reportsSummaryHandler));
app.all("/api/reports/counts", adapt(reportsCountsHandler));
// Registration drop-off partials (Train 2). Specific paths before the :id route.
app.all("/api/registration-partial", adapt(registrationPartialHandler));
app.all("/api/registration-partials/export", adapt(registrationPartialsExportHandler));
app.all("/api/registration-partials", adapt(registrationPartialsListHandler));
app.all("/api/registration-partials/:id", adapt(registrationPartialDeleteHandler));
app.all("/api/files/:id", adapt(fileHandler));

// ---- Internal service-to-service routes (Train C) ----------------------
// Called by the n8n Insurance workflow ONLY, authenticated by X-DrSnip-Service-Token
// (api/_lib/service-auth.ts) — never by a browser, never by a console session.
// Registered before the /api/* 404 so they resolve; nothing links to them.
app.all("/api/internal/submission-files/:submissionId", adapt(internalSubmissionFilesHandler));
app.all("/api/internal/files/:id", adapt(internalFileHandler));
app.all("/api/internal/insurance-pdf/:submissionId", adapt(internalInsurancePdfHandler));

// Unknown /api/* paths are genuine 404s — never fall through to the SPA.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Hidden client roadmap (/plan/*) — keep it out of search indexes at the HTTP
// layer (belt-and-suspenders with the page's own robots meta). Runs before the
// static handlers so the header rides the index.html document response.
app.use("/plan/*", async (c, next) => {
  c.header("X-Robots-Tag", "noindex, nofollow");
  await next();
});

// Public integration guide (/integration) — meant to be shared and forwarded by
// link, so it has no token, but it should never turn up in search results.
// Same belt-and-suspenders as /plan: this header plus the page's own robots meta.
app.use("/integration", async (c, next) => {
  c.header("X-Robots-Tag", "noindex, nofollow");
  await next();
});

// ---- Static SPA + client-side-routing fallback ------------------------
// STATIC_ROOT is resolved relative to the process working directory. Both
// local (`pnpm start` from Intake-form/) and the Docker image keep the SPA
// build at this same relative path.
const STATIC_ROOT = "artifacts/intake-form/dist/public";

app.use("/*", serveStatic({ root: STATIC_ROOT }));
// SPA fallback: any unmatched non-API GET returns index.html so wouter can
// resolve client-side routes (/admin/*, etc.).
app.get("/*", serveStatic({ path: `${STATIC_ROOT}/index.html` }));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api-server] listening on port ${info.port}`);
});
