// Adapter — runs the existing Vercel-style API handlers (../api/*.ts) inside
// the Hono server. Each handler keeps its original
// `(req: VercelRequest, res: VercelResponse)` signature; this shim builds a
// minimal request/response pair from the Hono context, runs the handler, and
// converts the buffered result back into a standard `Response`.
//
// Phase 1 (DrSnip): introduced as part of the Vercel-functions → single Hono
// server migration for the Fly.io deployment. Handler logic is unchanged.
//
// HIPAA: this layer logs error *types* only — never request or response
// bodies.

import type { Context } from "hono";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export type VercelHandler = (
  req: VercelRequest,
  res: VercelResponse,
) => unknown | Promise<unknown>;

type HeaderValue = string | number | string[];

const JSON_HEADERS: ReadonlyArray<[string, HeaderValue]> = [
  ["Content-Type", "application/json; charset=utf-8"],
];

// Response body may be a string (JSON / text) or raw bytes (e.g. a PDF).
type ResponseBody = string | Uint8Array | null;

function buildResponse(
  statusCode: number,
  headers: Iterable<[string, HeaderValue]>,
  body: ResponseBody,
): Response {
  const out = new Headers();
  for (const [key, value] of headers) {
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
    } else {
      out.set(key, String(value));
    }
  }
  // Cast: a Uint8Array is a valid runtime Response body (undici), but TS 5.9's
  // generic-ArrayBuffer typing doesn't accept it into BodyInit directly.
  return new Response(body as BodyInit | null, {
    status: statusCode,
    headers: out,
  });
}

function errorResponse(): Response {
  return buildResponse(500, JSON_HEADERS, JSON.stringify({ error: "Internal Server Error" }));
}

/**
 * Wrap a Vercel-style handler as a Hono handler.
 */
export function adapt(handler: VercelHandler) {
  return async (c: Context): Promise<Response> => {
    // ---- Fake VercelRequest --------------------------------------------
    const method = c.req.method;

    let body: unknown = undefined;
    if (method !== "GET" && method !== "HEAD") {
      // Vercel pre-parses JSON bodies onto req.body. Mirror that; a
      // non-JSON or empty body simply leaves req.body undefined.
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }
    }

    // Vercel exposes both URL search params and dynamic path segments
    // ([id], [key]) on req.query. Merge them the same way.
    const query: Record<string, string> = {
      ...c.req.query(),
      ...c.req.param(),
    };

    const req = {
      method,
      headers: c.req.header(),
      body,
      query,
      cookies: {},
    } as unknown as VercelRequest;

    // ---- Fake VercelResponse -------------------------------------------
    let statusCode = 200;
    const headers = new Map<string, HeaderValue>();
    let responseBody: ResponseBody = null;
    let finished = false;

    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      setHeader(name: string, value: HeaderValue) {
        headers.set(name, value);
        return res;
      },
      getHeader(name: string) {
        return headers.get(name);
      },
      json(payload: unknown) {
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json; charset=utf-8");
        }
        responseBody = JSON.stringify(payload);
        finished = true;
        return res;
      },
      send(payload: unknown) {
        // Pass raw bytes (PDF, etc.) straight through; otherwise string-or-JSON.
        if (payload instanceof Uint8Array) {
          responseBody = payload;
        } else {
          responseBody =
            typeof payload === "string" ? payload : JSON.stringify(payload);
        }
        finished = true;
        return res;
      },
      end(payload?: unknown) {
        if (payload instanceof Uint8Array) {
          responseBody = payload;
        } else if (payload !== undefined && payload !== null) {
          responseBody = String(payload);
        }
        finished = true;
        return res;
      },
    } as unknown as VercelResponse;

    // ---- Run the handler -----------------------------------------------
    try {
      await handler(req, res);
    } catch (err) {
      console.error(
        "api-server: handler threw",
        err instanceof Error ? err.name : "UnknownError",
      );
      return errorResponse();
    }

    if (!finished) return errorResponse();

    return buildResponse(statusCode, headers, responseBody);
  };
}
