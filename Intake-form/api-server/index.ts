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

import submitHandler from "../api/submit";
import loginHandler from "../api/auth/login";
import logoutHandler from "../api/auth/logout";
import meHandler from "../api/auth/me";
import submissionsHandler from "../api/submissions/index";
import submissionDetailHandler from "../api/submissions/[id]";
import submissionPdfHandler from "../api/submissions/[id]/pdf";
import activityHandler from "../api/submissions/activity";
import settingsHandler from "../api/settings/[key]";
import marketingSourcesHandler from "../api/admin/marketing-sources";
import marketingSourceByIdHandler from "../api/admin/marketing-sources/[id]";
import linksHandler from "../api/admin/links";

const app = new Hono();

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
app.all("/api/submissions/:id/pdf", adapt(submissionPdfHandler));
app.all("/api/submissions/:id", adapt(submissionDetailHandler));
app.all("/api/settings/:key", adapt(settingsHandler));
app.all("/api/admin/marketing-sources", adapt(marketingSourcesHandler));
app.all("/api/admin/marketing-sources/:id", adapt(marketingSourceByIdHandler));
app.all("/api/admin/links", adapt(linksHandler));

// Unknown /api/* paths are genuine 404s — never fall through to the SPA.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

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
