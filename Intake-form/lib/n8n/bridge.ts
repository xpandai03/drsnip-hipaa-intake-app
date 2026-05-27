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

    let parsedBody: unknown = null;
    try {
      parsedBody = await res.json();
    } catch {
      parsedBody = null;
    }

    if (!res.ok) {
      logEvent("non_2xx", {
        submission_id: submissionId,
        webhook_url: webhookUrl,
        status: res.status,
        elapsed_ms: elapsedMs,
      });
      return {
        status: "failed",
        responseBody: parsedBody,
        errorMessage: `HTTP ${res.status}`,
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
    const aborted =
      err instanceof Error && err.name === "AbortError";
    const reason = aborted ? "timeout" : err instanceof Error ? err.name : "unknown";
    logEvent("error", {
      submission_id: submissionId,
      webhook_url: webhookUrl,
      reason,
      elapsed_ms: elapsedMs,
    });
    return {
      status: "failed",
      errorMessage: aborted ? `timeout after ${TIMEOUT_MS}ms` : reason,
    };
  } finally {
    clearTimeout(timer);
  }
}

function disabledOutcome(submissionId: string, route: string): N8nOutcome {
  logEvent("disabled", { submission_id: submissionId, route });
  return { status: "failed", errorMessage: "bridge disabled" };
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
