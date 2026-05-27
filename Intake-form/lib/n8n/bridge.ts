// n8n bridge — fire-and-forget delivery of a custom-app submission to the v2
// n8n webhooks (Registration or Consultation). Never throws: every code path
// returns an N8nOutcome the caller can persist on the submission row.
//
// Kill switch: when `N8N_BRIDGE_ENABLED !== 'true'`, the bridge is a no-op and
// returns `{ status: 'failed', errorMessage: 'bridge disabled' }`.
//
// HIPAA: structured ID-only logging. The submission body is PHI; we never log
// its contents, only the submission_id, webhook URL (safe — no secrets), the
// outcome status, and timing.

import {
  buildRegistrationPayload,
  buildConsultationPayload,
  type SubmissionBody,
} from "./payload";

export type N8nStatus = "success" | "manual_review" | "failed";

export interface N8nOutcome {
  status: N8nStatus;
  patientId?: number;
  /** Parsed JSON response from n8n, when one was returned. */
  responseBody?: unknown;
  /** Short, non-PHI error description when status is 'failed'. */
  errorMessage?: string;
  /** Diagnostic snapshot captured on failure paths so the admin console + DB
   *  show the actual reason instead of a bare null. Always non-PHI. */
  diagnostic?: {
    /** 'http' = response came back; 'fetch' = thrown before/during fetch;
     *  'config' = env var / kill switch path. */
    kind: "http" | "fetch" | "config";
    httpStatus?: number;
    contentType?: string;
    bodySnippet?: string;
    bodyLength?: number;
    parseError?: string;
    errorName?: string;
    errorMessage?: string;
    causeMessage?: string;
    stackHead?: string;
    elapsedMs?: number;
  };
}

interface BridgeEnv {
  enabled: boolean;
  registrationUrl: string;
  consultationUrl: string;
  secret: string;
}

function readEnv(): BridgeEnv {
  return {
    enabled: process.env.N8N_BRIDGE_ENABLED === "true",
    registrationUrl: process.env.N8N_WEBHOOK_REGISTRATION_URL ?? "",
    consultationUrl: process.env.N8N_WEBHOOK_CONSULTATION_URL ?? "",
    secret: process.env.N8N_WEBHOOK_SECRET ?? "",
  };
}

const TIMEOUT_MS = 30_000;

// Treat any object response with success===true as a successful match.
function classify(json: unknown): N8nStatus {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (o.success === true) return "success";
    if (
      o.success === false &&
      o.reason === "manual_review_required"
    ) {
      return "manual_review";
    }
  }
  return "failed";
}

function logEvent(
  event: string,
  fields: Record<string, unknown>,
): void {
  // One structured line per event. No PHI fields.
  console.log(
    `[n8n-bridge] ${event} ` +
      JSON.stringify({
        ts: new Date().toISOString(),
        ...fields,
      }),
  );
}

// Cap on the body snippet stored in the DB. Webhook responses are usually
// <1KB; if n8n returns an HTML error page it can be much larger. We only need
// enough to identify the failure mode, never the full body.
const BODY_SNIPPET_MAX = 2048;

function snippet(text: string): string {
  if (text.length <= BODY_SNIPPET_MAX) return text;
  return text.slice(0, BODY_SNIPPET_MAX) + "...[truncated]";
}

function stackHead(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  const firstLine = err.stack.split("\n").find((l) => l.trim().startsWith("at "));
  return firstLine ? firstLine.trim() : undefined;
}

function causeMessage(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return undefined;
}

async function postToN8n(
  submissionId: string,
  webhookUrl: string,
  payload: unknown,
  env: BridgeEnv,
): Promise<N8nOutcome> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DrSnip-Token": env.secret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    const contentType = res.headers.get("content-type") ?? undefined;

    // Always read the raw text first — JSON parsing is layered on top, so a
    // body that isn't valid JSON still surfaces its actual contents in the
    // diagnostic. n8n's own error responses are sometimes HTML or empty.
    let rawText = "";
    let textReadError: string | undefined;
    try {
      rawText = await res.text();
    } catch (readErr) {
      textReadError =
        readErr instanceof Error
          ? `${readErr.name}: ${readErr.message}`
          : "unknown text-read error";
    }

    let parsedBody: unknown = null;
    let parseError: string | undefined;
    if (rawText) {
      try {
        parsedBody = JSON.parse(rawText);
      } catch (parseErr) {
        parsedBody = null;
        parseError =
          parseErr instanceof Error
            ? `${parseErr.name}: ${parseErr.message}`
            : "unknown JSON parse error";
      }
    } else if (!textReadError) {
      parseError = "empty response body";
    }

    const baseDiagnostic = {
      kind: "http" as const,
      httpStatus: res.status,
      contentType,
      bodyLength: rawText.length,
      bodySnippet: rawText ? snippet(rawText) : "",
      parseError: parseError ?? textReadError,
      elapsedMs,
    };

    if (!res.ok) {
      logEvent("non_2xx", {
        submission_id: submissionId,
        webhook_url: webhookUrl,
        status: res.status,
        content_type: contentType,
        body_length: rawText.length,
        body_snippet: snippet(rawText),
        parse_error: baseDiagnostic.parseError,
        elapsed_ms: elapsedMs,
      });
      return {
        status: "failed",
        responseBody: parsedBody,
        errorMessage: `HTTP ${res.status}`,
        diagnostic: baseDiagnostic,
      };
    }

    const outcomeStatus = classify(parsedBody);
    const o = parsedBody as Record<string, unknown> | null;
    const patientIdRaw = o && o.patient_id;
    const patientId =
      typeof patientIdRaw === "number"
        ? patientIdRaw
        : typeof patientIdRaw === "string" && /^\d+$/.test(patientIdRaw)
          ? Number(patientIdRaw)
          : undefined;

    // On `failed`, log + return the diagnostic so the admin console shows
    // exactly what n8n sent back (status, content-type, raw body snippet,
    // JSON parse error). Previously this branch silently stored
    // responseBody=null with no breadcrumb.
    if (outcomeStatus === "failed") {
      logEvent("response_failed", {
        submission_id: submissionId,
        webhook_url: webhookUrl,
        http_status: res.status,
        content_type: contentType,
        body_length: rawText.length,
        body_snippet: snippet(rawText),
        parse_error: baseDiagnostic.parseError,
        elapsed_ms: elapsedMs,
      });
      return {
        status: "failed",
        responseBody: parsedBody,
        errorMessage:
          parseError ??
          textReadError ??
          "n8n response did not match success or manual_review shape",
        diagnostic: baseDiagnostic,
      };
    }

    logEvent("response", {
      submission_id: submissionId,
      webhook_url: webhookUrl,
      outcome: outcomeStatus,
      patient_id: patientId,
      elapsed_ms: elapsedMs,
    });

    return {
      status: outcomeStatus,
      patientId,
      responseBody: parsedBody,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const aborted = err instanceof Error && err.name === "AbortError";
    const errorName = err instanceof Error ? err.name : "unknown";
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    const cause = causeMessage(err);

    logEvent("error", {
      submission_id: submissionId,
      webhook_url: webhookUrl,
      reason: aborted ? "timeout" : errorName,
      error_message: errorMessage,
      cause_message: cause,
      stack_head: stackHead(err),
      elapsed_ms: elapsedMs,
    });

    return {
      status: "failed",
      errorMessage: aborted
        ? `timeout after ${TIMEOUT_MS}ms`
        : `${errorName}: ${errorMessage}`,
      diagnostic: {
        kind: "fetch",
        errorName,
        errorMessage,
        causeMessage: cause,
        stackHead: stackHead(err),
        elapsedMs,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function disabledOutcome(submissionId: string, route: string): N8nOutcome {
  logEvent("disabled", { submission_id: submissionId, route });
  return {
    status: "failed",
    errorMessage: "bridge disabled",
    diagnostic: { kind: "config", errorMessage: "bridge disabled" },
  };
}

function missingConfigOutcome(
  submissionId: string,
  route: string,
  missing: string,
): N8nOutcome {
  logEvent("misconfigured", {
    submission_id: submissionId,
    route,
    missing,
  });
  return {
    status: "failed",
    errorMessage: `missing config: ${missing}`,
    diagnostic: { kind: "config", errorMessage: `missing config: ${missing}` },
  };
}

/** Diagnostic-only count of cards being shipped to n8n. HIPAA: never logs
 *  base64Data or filenames — only counts and the size buckets used in the
 *  admin console. */
function summarizeCards(
  body: SubmissionBody,
): { count: number; with_bytes: number; total_kb: number } {
  const f = (body as Record<string, unknown>).insuranceCardFront as
    | { size?: number; base64Data?: string }
    | null
    | undefined;
  const b = (body as Record<string, unknown>).insuranceCardBack as
    | { size?: number; base64Data?: string }
    | null
    | undefined;
  const refs = [f, b].filter((c): c is { size?: number; base64Data?: string } =>
    Boolean(c),
  );
  return {
    count: refs.length,
    with_bytes: refs.filter(
      (c) => typeof c.base64Data === "string" && c.base64Data.length > 0,
    ).length,
    total_kb: Math.round(
      refs.reduce((acc, c) => acc + (typeof c.size === "number" ? c.size : 0), 0) /
        1024,
    ),
  };
}

/** Deliver a Registration submission to n8n. Never throws. */
export async function callN8nRegistration(
  submissionId: string,
  body: SubmissionBody,
  submittedAt: Date = new Date(),
): Promise<N8nOutcome> {
  const env = readEnv();
  if (!env.enabled) return disabledOutcome(submissionId, "registration");
  if (!env.registrationUrl)
    return missingConfigOutcome(
      submissionId,
      "registration",
      "N8N_WEBHOOK_REGISTRATION_URL",
    );
  if (!env.secret)
    return missingConfigOutcome(
      submissionId,
      "registration",
      "N8N_WEBHOOK_SECRET",
    );

  const cards = summarizeCards(body);
  if (cards.count > 0) {
    logEvent("cards_outbound", {
      submission_id: submissionId,
      card_count: cards.count,
      cards_with_bytes: cards.with_bytes,
      total_kb: cards.total_kb,
    });
  }

  const payload = buildRegistrationPayload(submissionId, body, submittedAt);
  return postToN8n(submissionId, env.registrationUrl, payload, env);
}

/** Deliver a Consultation submission to n8n. Never throws. */
export async function callN8nConsultation(
  submissionId: string,
  body: SubmissionBody,
  submittedAt: Date = new Date(),
): Promise<N8nOutcome> {
  const env = readEnv();
  if (!env.enabled) return disabledOutcome(submissionId, "consultation");
  if (!env.consultationUrl)
    return missingConfigOutcome(
      submissionId,
      "consultation",
      "N8N_WEBHOOK_CONSULTATION_URL",
    );
  if (!env.secret)
    return missingConfigOutcome(
      submissionId,
      "consultation",
      "N8N_WEBHOOK_SECRET",
    );

  const payload = buildConsultationPayload(submissionId, body, submittedAt);
  return postToN8n(submissionId, env.consultationUrl, payload, env);
}
