// TimeTap REST API client. Used by both the outbound poller
// (api/cron/timetap-poll.ts) and any future Salesforce-initiated update
// path. NOT used by the inbound webhook receiver — that one just parses
// what TimeTap pushes to us.
//
// Auth dance (verified live against the CJC tenant 2026-05-15):
//   1. GET ${BASE}/sessionToken?apiKey=&timestamp=&signature= — auth
//      travels in QUERY PARAMS on this single call, NOT headers.
//      signature = MD5_hex(apiKey + privateKey)   (concatenated, no separator)
//      timestamp = current Unix time in SECONDS.
//   2. Response: `{"sessionToken":"st.api.api.<32hex>"}`.
//   3. Subsequent calls send `Authorization: Bearer <sessionToken>`.
// Tokens timeout on inactivity; we cache for 60 min and refresh on any 401.
//
// Env vars: TIMETAP_BASE_URL (https://api.timetap.com/test — see note on
// the /test prefix in .env.local.example), TIMETAP_API_KEY,
// TIMETAP_API_SECRET.

import { createHash } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const envSchema = z.object({
  TIMETAP_BASE_URL: z.string().url(),
  TIMETAP_API_KEY: z.string().min(1),
  TIMETAP_API_SECRET: z.string().min(1),
});

function readEnv(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse({
    TIMETAP_BASE_URL: process.env.TIMETAP_BASE_URL,
    TIMETAP_API_KEY: process.env.TIMETAP_API_KEY,
    TIMETAP_API_SECRET: process.env.TIMETAP_API_SECRET,
  });
  if (!parsed.success) {
    throw new Error(
      "TimeTap env not configured: TIMETAP_BASE_URL, TIMETAP_API_KEY, TIMETAP_API_SECRET required",
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Session-token cache
// ---------------------------------------------------------------------------

type CachedSession = { sessionToken: string; expiresAt: number };
let sessionCache: CachedSession | null = null;
const SESSION_TTL_MS = 60 * 60 * 1000; // documented as ~60 min; refresh on 401

function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

export class TimeTapError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `TimeTap request failed: ${status} ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

async function fetchSessionToken(env: z.infer<typeof envSchema>): Promise<CachedSession> {
  const base = env.TIMETAP_BASE_URL.replace(/\/$/, "");
  // Signature is MD5 hex of (apiKey + privateKey) concatenated with no
  // separator. Verified against live CJC tenant 2026-05-15 — the prior
  // implementation hashed only the secret and TimeTap returned 403.
  const signature = md5Hex(`${env.TIMETAP_API_KEY}${env.TIMETAP_API_SECRET}`);
  // Unix seconds. TimeTap's sample URLs show the value as seconds, not ms.
  const timestamp = Math.floor(Date.now() / 1000);
  // Auth on this call travels in QUERY PARAMS, not headers. No bearer
  // exists yet (we're requesting one) and TimeTap's apiKey + signature
  // header shape is not what their backend expects.
  const url =
    `${base}/sessionToken?apiKey=${encodeURIComponent(env.TIMETAP_API_KEY)}` +
    `&timestamp=${timestamp}` +
    `&signature=${signature}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new TimeTapError(res.status, text);
  }
  let parsed: { sessionToken?: string } | null = null;
  try {
    parsed = JSON.parse(text) as { sessionToken?: string };
  } catch {
    // fall through to the missing-token branch
  }
  const token = parsed?.sessionToken;
  if (!token) {
    throw new TimeTapError(
      res.status,
      text,
      "TimeTap sessionToken response missing sessionToken field",
    );
  }
  return { sessionToken: token, expiresAt: Date.now() + SESSION_TTL_MS };
}

export async function getSessionToken(): Promise<string> {
  if (sessionCache && sessionCache.expiresAt > Date.now()) {
    return sessionCache.sessionToken;
  }
  const env = readEnv();
  sessionCache = await fetchSessionToken(env);
  return sessionCache.sessionToken;
}

export function invalidateSessionToken(): void {
  sessionCache = null;
}

// ---------------------------------------------------------------------------
// Internal request helper with one 401 retry
// ---------------------------------------------------------------------------

async function tt<T>(init: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}): Promise<T> {
  const env = readEnv();
  const base = env.TIMETAP_BASE_URL.replace(/\/$/, "");
  const qs = init.query
    ? "?" +
      Object.entries(init.query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";

  const doFetch = async () => {
    const token = await getSessionToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}${init.path}${qs}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return res;
  };

  let res = await doFetch();
  if (res.status === 401) {
    invalidateSessionToken();
    res = await doFetch();
  }
  const text = await res.text();
  if (!res.ok) throw new TimeTapError(res.status, text);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TimeTapError(res.status, text, "TimeTap response was not valid JSON");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type TimeTapAppointment = Record<string, unknown> & {
  calendarId?: number;
  calendarid?: number;
};

export type ListAppointmentsParams = {
  /** ISO 8601, used as `modifiedSince` filter. */
  modifiedSince?: string;
  pageNumber?: number;
  pageSize?: number;
};

/**
 * List appointments. The exact parameter names are confirmed in part by
 * public docs (pageNumber + pageSize) and inferred for modifiedSince;
 * a live smoke test should validate this before relying on it for backfill.
 */
export async function listAppointments(
  params: ListAppointmentsParams = {},
): Promise<TimeTapAppointment[]> {
  const json = await tt<{ results?: TimeTapAppointment[] } | TimeTapAppointment[]>({
    method: "GET",
    path: "/appointments",
    query: {
      modifiedSince: params.modifiedSince,
      pageNumber: params.pageNumber,
      pageSize: params.pageSize,
    },
  });
  if (Array.isArray(json)) return json;
  return Array.isArray(json?.results) ? json.results : [];
}

export async function getAppointment(
  calendarId: string | number,
): Promise<TimeTapAppointment | null> {
  try {
    return await tt<TimeTapAppointment>({
      method: "GET",
      path: `/appointments/${encodeURIComponent(String(calendarId))}`,
    });
  } catch (err) {
    if (err instanceof TimeTapError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Push an update for an existing TimeTap appointment. TimeTap's API
 * documents PUT /appointments/{id} for updates; if a tenant uses PATCH
 * semantics, swap the method here. The payload shape comes from
 * sfAppointmentToTimeTapUpdate() in _lib/timetap-mapping.ts.
 */
export async function updateAppointment(
  calendarId: string | number,
  payload: Record<string, unknown>,
): Promise<TimeTapAppointment> {
  return await tt<TimeTapAppointment>({
    method: "PUT",
    path: `/appointments/${encodeURIComponent(String(calendarId))}`,
    body: payload,
  });
}
