// Minimal OAuth 2.1 layer so claude.ai's custom-connector flow can authenticate.
//
// claude.ai (and the MCP authorization spec, 2025-06-18) require the server to
// be an OAuth 2.1 *resource server*: 401 → protected-resource metadata (RFC
// 9728) → authorization-server metadata (RFC 8414) → dynamic client
// registration (RFC 7591) → authorization-code flow with PKCE. A static bearer
// token (which the connector UI has no field for) cannot satisfy this.
//
// This is a SINGLE-USER, READ-ONLY reporting connector, so the "login" is one
// shared password (OAUTH_LOGIN_PASSWORD). Security properties:
//   - PKCE (S256) on every code exchange,
//   - codes/tokens are HMAC-signed JWTs, short-lived, audience-bound to /mcp,
//   - exact redirect_uri match (anti open-redirect),
//   - the connector still grants only the read-only tools.
// Stateless: no DB. Codes encode their own PKCE challenge + redirect_uri;
// tokens encode their audience + expiry. Nothing is written anywhere.
import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";

const SECRET = () =>
  process.env.OAUTH_SIGNING_SECRET || process.env.MCP_AUTH_TOKEN || "";
const LOGIN_PASSWORD = () => process.env.OAUTH_LOGIN_PASSWORD || "";

export function oauthConfigured() {
  return SECRET().length >= 16 && LOGIN_PASSWORD().length >= 1;
}

// ── tiny base64url + HS256 JWT (no deps) ───────────────────────────────────
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o) => b64url(JSON.stringify(o));
const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function sign(data) {
  return b64url(createHmac("sha256", SECRET()).update(data).digest());
}
function signJwt(payload, ttlSec) {
  const body = { ...payload, iat: Math.floor(nowSec()), exp: Math.floor(nowSec()) + ttlSec };
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const p = b64urlJson(body);
  return `${head}.${p}.${sign(`${head}.${p}`)}`;
}
function verifyJwt(token, expectTyp) {
  try {
    const [h, p, s] = String(token).split(".");
    if (!h || !p || !s) return null;
    const expected = sign(`${h}.${p}`);
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromB64url(p).toString("utf8"));
    if (payload.exp && payload.exp < nowSec()) return null;
    if (expectTyp && payload.typ !== expectTyp) return null;
    return payload;
  } catch {
    return null;
  }
}
// nowSec is injectable-free; new Date() is fine in a long-running server.
function nowSec() {
  return Date.now() / 1000;
}
const s256 = (v) => b64url(createHash("sha256").update(v).digest());

// ── signed client_id (stateless DCR): encodes the registered redirect_uris ──
function makeClientId(redirectUris) {
  const data = b64urlJson({ ru: redirectUris, n: randomUUID() });
  return `${data}~${sign(data)}`;
}
function parseClientId(clientId) {
  const [data, sig] = String(clientId).split("~");
  if (!data || !sig || sign(data) !== sig) return null;
  try {
    return JSON.parse(fromB64url(data).toString("utf8"));
  } catch {
    return null;
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
function readRaw(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function html(res, code, body) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}
function resourceUri(req) {
  return `${baseUrl(req)}/mcp`;
}

export function wwwAuthenticate(req) {
  return `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`;
}

/** True if the presented bearer is a valid OAuth access token for this server. */
export function validateAccessToken(token, req) {
  const p = verifyJwt(token, "at");
  return !!p && p.aud === resourceUri(req);
}

// ── metadata docs ──────────────────────────────────────────────────────────
function protectedResourceMetadata(req) {
  return { resource: resourceUri(req), authorization_servers: [baseUrl(req)] };
}
function authServerMetadata(req) {
  const base = baseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp", "read"],
  };
}

const loginPage = (params, error) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to DrSnip Reporting</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#CD1C3A;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:20px;padding:32px;max-width:360px;width:90%;box-shadow:0 20px 50px rgba(0,0,0,.25)}
h1{font-size:18px;margin:0 0 4px}p{color:#64748b;font-size:14px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px}
button{width:100%;margin-top:14px;padding:12px;background:#CD1C3A;color:#fff;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#dc2626;font-size:13px;margin-top:10px}</style></head>
<body><form class="card" method="POST" action="/authorize">
<h1>Connect to DrSnip Reporting</h1><p>Enter the access password to let your Claude read your DrSnip intake reporting (read-only).</p>
<input type="password" name="password" placeholder="Access password" autofocus required>
${Object.entries(params)
  .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v ?? "")}">`)
  .join("")}
<button type="submit">Connect</button>${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
</form></body></html>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Handle an OAuth route. Returns true if it consumed the request.
 * Routes: /.well-known/oauth-protected-resource(/*), /.well-known/oauth-authorization-server(/*),
 *         /.well-known/openid-configuration, /authorize, /token, /register.
 */
export async function handleOAuth(req, res) {
  const url = new URL(req.url, baseUrl(req));
  const path = url.pathname;

  if (path.startsWith("/.well-known/oauth-protected-resource")) {
    return json(res, 200, protectedResourceMetadata(req)), true;
  }
  if (
    path.startsWith("/.well-known/oauth-authorization-server") ||
    path === "/.well-known/openid-configuration"
  ) {
    return json(res, 200, authServerMetadata(req)), true;
  }

  if (path === "/register" && req.method === "POST") {
    let meta = {};
    try {
      meta = JSON.parse((await readRaw(req)) || "{}");
    } catch {
      return json(res, 400, { error: "invalid_client_metadata" }), true;
    }
    const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
    if (redirectUris.length === 0) {
      return json(res, 400, { error: "invalid_redirect_uri" }), true;
    }
    const clientId = makeClientId(redirectUris);
    return (
      json(res, 201, {
        client_id: clientId,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(nowSec()),
      }),
      true
    );
  }

  if (path === "/authorize") {
    const params =
      req.method === "POST"
        ? Object.fromEntries(new URLSearchParams(await readRaw(req)))
        : Object.fromEntries(url.searchParams);
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state, resource, scope } = params;

    const client = parseClientId(client_id);
    if (!client || !client.ru.includes(redirect_uri)) {
      return html(res, 400, "<h1>Invalid client or redirect_uri</h1>"), true;
    }
    if (response_type !== "code" || code_challenge_method !== "S256" || !code_challenge) {
      return redirectErr(res, redirect_uri, state, "invalid_request"), true;
    }

    if (req.method === "GET") {
      return html(res, 200, loginPage({ client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state, resource, scope })), true;
    }
    // POST — verify password
    const pw = Buffer.from(params.password || "");
    const expected = Buffer.from(LOGIN_PASSWORD());
    const ok = pw.length === expected.length && timingSafeEqual(pw, expected);
    if (!ok) {
      return html(res, 401, loginPage({ client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state, resource, scope }, "Incorrect password — try again.")), true;
    }
    const code = signJwt({ typ: "code", cc: code_challenge, ru: redirect_uri, aud: resource || resourceUri(req) }, 300);
    const sep = redirect_uri.includes("?") ? "&" : "?";
    res.writeHead(302, { Location: `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}` });
    return res.end(), true;
  }

  if (path === "/token" && req.method === "POST") {
    const body = Object.fromEntries(new URLSearchParams(await readRaw(req)));
    if (body.grant_type === "authorization_code") {
      const code = verifyJwt(body.code, "code");
      if (!code) return json(res, 400, { error: "invalid_grant" }), true;
      if (code.ru !== body.redirect_uri) return json(res, 400, { error: "invalid_grant" }), true;
      if (s256(body.code_verifier || "") !== code.cc) return json(res, 400, { error: "invalid_grant", error_description: "PKCE failed" }), true;
      const aud = code.aud === resourceUri(req) ? code.aud : resourceUri(req);
      return issueTokens(res, aud), true;
    }
    if (body.grant_type === "refresh_token") {
      const rt = verifyJwt(body.refresh_token, "rt");
      if (!rt) return json(res, 400, { error: "invalid_grant" }), true;
      return issueTokens(res, resourceUri(req)), true;
    }
    return json(res, 400, { error: "unsupported_grant_type" }), true;
  }

  return false;
}

function issueTokens(res, aud) {
  const access_token = signJwt({ typ: "at", aud }, 3600);
  const refresh_token = signJwt({ typ: "rt", aud }, 60 * 60 * 24 * 30);
  return json(res, 200, { access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: "mcp read" });
}

function redirectErr(res, redirectUri, state, err) {
  const sep = redirectUri.includes("?") ? "&" : "?";
  res.writeHead(302, { Location: `${redirectUri}${sep}error=${err}${state ? `&state=${encodeURIComponent(state)}` : ""}` });
  res.end();
}
