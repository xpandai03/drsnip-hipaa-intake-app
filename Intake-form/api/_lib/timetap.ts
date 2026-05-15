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

// Retry-on-5xx helper. TimeTap's API Gateway returns 504s intermittently
// (observed 2/5 timeout rate during live probing on 2026-05-15). One
// retry with a 1s delay recovers most of those without compounding load.
function isTransientStatus(status: number): boolean {
  return status === 504 || status === 502 || status === 503 || status === 408;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // One retry on 5xx — TimeTap's sessionToken endpoint flaps regularly.
  let lastBody = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (res.ok) {
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
    lastStatus = res.status;
    lastBody = text;
    if (!isTransientStatus(res.status)) break;
    if (attempt === 0) await sleep(1000);
  }
  throw new TimeTapError(lastStatus, lastBody);
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

  // 401 path = stale bearer token, refresh and retry once.
  // 5xx path = TimeTap upstream flake, retry once with 1s delay.
  // 4xx (other) and 2nd-failure cases bubble to the caller as TimeTapError.
  let res = await doFetch();
  if (res.status === 401) {
    invalidateSessionToken();
    res = await doFetch();
  }
  if (isTransientStatus(res.status)) {
    await sleep(1000);
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
  /** Required by TimeTap — defaults to OPEN. */
  status?: string;
  /** Start of date range, Unix epoch in milliseconds. */
  startDateMs?: number;
  /** End of date range, Unix epoch in milliseconds. */
  endDateMs?: number;
  pageNumber?: number;
  pageSize?: number;
};

/**
 * List appointments. Verified live 2026-05-15: the endpoint requires
 * POST (GET returns 405 with a date range), uses the `STATUS` query
 * param (uppercase — TimeTap rejects body-based STATUS with "field
 * required"), and accepts `startDate` / `endDate` as Unix epoch
 * milliseconds (13-digit). Page params go in the query string too.
 *
 * Used for backfill / future Sales-rep tooling — the cron poller in
 * api/cron/timetap-poll.ts does NOT call this (it queries Salesforce
 * for changes and pushes individual updates via updateAppointment).
 */
export async function listAppointments(
  params: ListAppointmentsParams = {},
): Promise<TimeTapAppointment[]> {
  const json = await tt<{ results?: TimeTapAppointment[] } | TimeTapAppointment[]>({
    method: "POST",
    path: "/appointments",
    query: {
      STATUS: params.status ?? "OPEN",
      startDate: params.startDateMs,
      endDate: params.endDateMs,
      pageNumber: params.pageNumber,
      pageSize: params.pageSize,
    },
    body: {},
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
 * Push an update for an existing TimeTap appointment via PATCH.
 *
 * Verified live 2026-05-15 against the CJC tenant: PATCH /appointments/
 * {id} accepts partial-field bodies. PUT to the same path is a different
 * operation (full replace; demands a STATUS field in the body). 404 from
 * this endpoint manifests as HTTP 400 with the body
 * `"Appointment for Id X not found!"` — callers should treat that case
 * as a permanent-for-this-row failure, not a transient error.
 *
 * Payload shape comes from sfAppointmentToTimeTapUpdate() in
 * _lib/timetap-mapping.ts.
 */
export async function updateAppointment(
  calendarId: string | number,
  payload: Record<string, unknown>,
): Promise<TimeTapAppointment> {
  return await tt<TimeTapAppointment>({
    method: "PATCH",
    path: `/appointments/${encodeURIComponent(String(calendarId))}`,
    body: payload,
  });
}
