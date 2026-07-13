#!/usr/bin/env node
// DrSnip Reporting MCP — HTTP entrypoint (Streamable HTTP, STATELESS).
// READ-ONLY, AGGREGATE-ONLY. Same tools as the stdio entrypoint.
//
// Deployed on Fly (same 6PN as drsnip-intake-db, which is private) so it can
// reach DRSNIP_INTAKE_DATABASE_URL. Stateless = a fresh server + transport per
// request.
//
// CREDENTIALED: every /mcp request must present `Authorization: Bearer
// <MCP_AUTH_TOKEN>` (or an OAuth access token). Refuses to start without a
// token so it can never run open.
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadEnv } from "./env.js";
import { buildServer, activeTools } from "./build-server.js";
import { handleOAuth, validateAccessToken, wwwAuthenticate, oauthConfigured } from "./oauth.js";

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.MCP_AUTH_TOKEN;
const MCP_PATH = process.env.MCP_PATH || "/mcp";

if (!TOKEN || TOKEN.length < 16) {
  process.stderr.write(
    "[drsnip-reporting] refusing to start: set MCP_AUTH_TOKEN (>=16 chars). A remote MCP must be credentialed.\n",
  );
  process.exit(1);
}

// /mcp accepts EITHER an OAuth access token (claude.ai connector flow) OR the
// static MCP_AUTH_TOKEN (programmatic clients / Claude Desktop config).
function authorized(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] || "");
  if (!m) return false;
  const got = m[1];
  if (got.length === TOKEN.length) {
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i);
    if (diff === 0) return true;
  }
  return validateAccessToken(got, req);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/healthz" || url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "drsnip-reporting", tools: activeTools().length, oauth: oauthConfigured() }));
    return;
  }

  // OAuth discovery / authorize / token / register (claude.ai connector flow).
  if (oauthConfigured() && (await handleOAuth(req, res))) return;

  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }
  if (!authorized(req)) {
    // RFC 9728: point the client at our resource metadata so it starts OAuth.
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": oauthConfigured() ? wwwAuthenticate(req) : "Bearer",
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // Stateless: a fresh read-only server + transport per request.
  const body = req.method === "POST" ? await readBody(req) : undefined;
  if (body === null) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
    process.stderr.write(`[drsnip-reporting] request error: ${err.message}\n`);
  }
});

httpServer.listen(PORT, HOST, () => {
  process.stderr.write(
    `[drsnip-reporting] READ-ONLY aggregate-only HTTP MCP on :${PORT}${MCP_PATH} (bearer-protected, stateless). ` +
      `${activeTools().length} tools.\n`,
  );
});
