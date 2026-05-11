// Lightweight stand-ins for VercelRequest / VercelResponse so tests can
// invoke the route handlers without spinning up `vercel dev`. Captures the
// status code, JSON body, and Set-Cookie header for assertions.

import type { VercelRequest, VercelResponse } from "@vercel/node";

export type MockResponse = VercelResponse & {
  statusCode: number;
  jsonBody: unknown;
  headers: Record<string, string | string[]>;
};

export function makeReq(opts: {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}): VercelRequest {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  return {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ?? {},
    // Not all VercelRequest fields are populated — handlers under test only
    // touch method, headers, body. Cast lets TypeScript accept the rest.
  } as unknown as VercelRequest;
}

export function makeRes(): MockResponse {
  const res: Partial<MockResponse> & Record<string, unknown> = {
    statusCode: 0,
    jsonBody: undefined,
    headers: {},
  };
  res.status = function (code: number) {
    (this as MockResponse).statusCode = code;
    return this as MockResponse;
  };
  res.json = function (body: unknown) {
    (this as MockResponse).jsonBody = body;
    return this as MockResponse;
  };
  res.setHeader = function (name: string, value: string | string[]) {
    (this as MockResponse).headers[name] = value;
    return this as MockResponse;
  };
  res.getHeader = function (name: string) {
    return (this as MockResponse).headers[name];
  };
  return res as MockResponse;
}

/** Pull the cookie value the handler set via Set-Cookie. */
export function readSessionCookieFromRes(
  res: MockResponse,
  name: string,
): string | null {
  const raw = res.headers["Set-Cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const first = header.split(";")[0];
  const idx = first.indexOf("=");
  if (idx === -1) return null;
  const k = first.slice(0, idx).trim();
  if (k !== name) return null;
  return decodeURIComponent(first.slice(idx + 1).trim());
}
