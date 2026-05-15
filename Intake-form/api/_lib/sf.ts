// Salesforce direct-push helper for the intake form.
//
// Auth: OAuth 2.0 Client Credentials Flow against the CJC Connected App
// (`CJC Form Direct Integration`, Run-As `teamcampbell@cjcwealth.com`).
// Tokens last ~2h; we cache in-memory and refresh at ~90 minutes to be safe.
//
// API: REST POST /services/data/v59.0/sobjects/Lead with the field-mapped
// JSON. On 401 (token expired mid-flight), re-auth once and retry the call.
//
// Phase 1 invariant: the `Federal_Agency__c` prefix-strip regex
// `/^[\s► ]+/` MUST be preserved. The form's UI shows the prefixed labels
// for hierarchy, but the SF picklist is stored bare and rejects the
// prefix. submit.ts strips it before fields reach this helper, but we
// apply it defensively here too — see strippedFederalAgency().

import { z } from "zod";

// ---------------------------------------------------------------------------
// Env + config
// ---------------------------------------------------------------------------

const envSchema = z.object({
  SF_INSTANCE_URL: z.string().url(),
  SF_CLIENT_ID: z.string().min(1),
  SF_CLIENT_SECRET: z.string().min(1),
  SF_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v59.0"),
});

function readEnv(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse({
    SF_INSTANCE_URL: process.env.SF_INSTANCE_URL,
    SF_CLIENT_ID: process.env.SF_CLIENT_ID,
    SF_CLIENT_SECRET: process.env.SF_CLIENT_SECRET,
    SF_API_VERSION: process.env.SF_API_VERSION ?? "v59.0",
  });
  if (!parsed.success) {
    // Don't echo the parsed object — would leak the client secret.
    throw new Error(
      "Salesforce env not configured: SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET required",
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

type CachedToken = { accessToken: string; expiresAt: number };

// In-memory cache. Per Vercel serverless function instance; survives warm
// invocations, dies on cold start. That's fine — re-auth costs ~150ms.
let tokenCache: CachedToken | null = null;

// Refresh tokens 30 min before they expire (SF tokens ~2h). Keeps us well
// inside the safety window even with clock skew or slow re-auths.
const TOKEN_REFRESH_BUFFER_MS = 30 * 60 * 1000;

async function fetchAccessToken(env: z.infer<typeof envSchema>): Promise<CachedToken> {
  const tokenUrl = `${env.SF_INSTANCE_URL.replace(/\/$/, "")}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.SF_CLIENT_ID,
    client_secret: env.SF_CLIENT_SECRET,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    // The error body may echo back values like error_description; do NOT
    // include the request body in the thrown message (would leak secret).
    const text = await res.text().catch(() => "");
    throw new Error(
      `Salesforce token request failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
    );
  }
  const payload = (await res.json()) as { access_token?: string; expires_in?: string | number };
  if (!payload.access_token) {
    throw new Error("Salesforce token response missing access_token");
  }
  // SF returns expires_in seconds as a string in some configs; default 7200.
  const expiresInSec = Number(payload.expires_in ?? 7200);
  const expiresAt = Date.now() + expiresInSec * 1000 - TOKEN_REFRESH_BUFFER_MS;
  return { accessToken: payload.access_token, expiresAt };
}

/**
 * Returns a fresh-enough access token, fetching one if the cache is empty
 * or about to expire. Concurrent callers within a cold start may issue
 * parallel token requests; that's acceptable (SF tolerates it, and only
 * the last writer's token is kept in cache).
 */
export async function getAccessToken(): Promise<string> {
  const env = readEnv();
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }
  tokenCache = await fetchAccessToken(env);
  return tokenCache.accessToken;
}

/** Forget the cached token; next call to getAccessToken() will re-auth. */
export function invalidateAccessToken(): void {
  tokenCache = null;
}

// ---------------------------------------------------------------------------
// Federal_Agency__c prefix strip (Phase 1 invariant)
// ---------------------------------------------------------------------------

// Same regex as Intake-form/api/submit.ts (Phase 1). Strips leading
// whitespace AND the U+25BA arrow that marks sub-agency entries in the
// dropdown UI. The SF picklist is stored bare and rejects the prefix.
//
// DO NOT change this regex without verifying against the 28 sub-agency
// entries in artifacts/intake-form/src/pages/Home.tsx. The Path C ship
// (Phase 1, 2026-05-08) depends on this exact normalization.
export const FEDERAL_AGENCY_PREFIX_PATTERN = /^[\s► ]+/;

export function strippedFederalAgency(value: string): string {
  return value.replace(FEDERAL_AGENCY_PREFIX_PATTERN, "").trim();
}

// ---------------------------------------------------------------------------
// createLead
// ---------------------------------------------------------------------------

export type SalesforceLeadFields = Record<string, unknown>;

export type CreateLeadResult = {
  id: string;
  success: true;
};

export type CreateLeadError = {
  status: number;
  /** Errors array from Salesforce. Caller logs these; don't leak to client. */
  errors: Array<{ statusCode?: string; message?: string; fields?: string[] }>;
};

export class SalesforceCreateLeadError extends Error {
  readonly status: number;
  readonly errors: CreateLeadError["errors"];
  constructor(detail: CreateLeadError) {
    super(`Salesforce createLead failed: ${detail.status} ${JSON.stringify(detail.errors).slice(0, 300)}`);
    this.status = detail.status;
    this.errors = detail.errors;
  }
}

async function sfCreateLeadOnce(fields: SalesforceLeadFields): Promise<CreateLeadResult> {
  const env = readEnv();
  const token = await getAccessToken();
  const url = `${env.SF_INSTANCE_URL.replace(/\/$/, "")}/services/data/${env.SF_API_VERSION}/sobjects/Lead`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
  });

  if (res.status === 401) {
    // Token expired mid-flight — caller will retry.
    invalidateAccessToken();
    const errors = await res.json().catch(() => []);
    throw new SalesforceCreateLeadError({
      status: 401,
      errors: Array.isArray(errors) ? errors : [],
    });
  }

  if (!res.ok) {
    const errors = await res.json().catch(() => []);
    throw new SalesforceCreateLeadError({
      status: res.status,
      errors: Array.isArray(errors) ? errors : [],
    });
  }

  const payload = (await res.json()) as { id?: string; success?: boolean };
  if (!payload.id) {
    throw new SalesforceCreateLeadError({
      status: 500,
      errors: [{ message: "Salesforce returned no Lead id" }],
    });
  }
  return { id: payload.id, success: true };
}

/**
 * POST a new Lead to Salesforce. Applies the Phase 1 prefix-strip to
 * Federal_Agency__c if present. On HTTP 401, re-authenticates once and
 * retries the call. Other errors throw SalesforceCreateLeadError without
 * retry — the caller decides whether to log + mark sf_status='error'.
 */
export async function createLead(fields: SalesforceLeadFields): Promise<CreateLeadResult> {
  // Defensive prefix-strip: submit.ts already strips before calling, but
  // applying here guards against any future caller that forgets.
  const normalized: SalesforceLeadFields = { ...fields };
  if (typeof normalized.Federal_Agency__c === "string") {
    normalized.Federal_Agency__c = strippedFederalAgency(
      normalized.Federal_Agency__c,
    );
  }

  try {
    return await sfCreateLeadOnce(normalized);
  } catch (err) {
    if (err instanceof SalesforceCreateLeadError && err.status === 401) {
      // One retry after re-auth. Lets us survive a token that aged out
      // between cache check and HTTP send.
      return await sfCreateLeadOnce(normalized);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// updateLead — partial-field PATCH on an existing Salesforce Lead
// ---------------------------------------------------------------------------
//
// Used by api/submit.ts to optimistically flip Lead.Meeting_stage__c to
// 'Scheduled' the moment a qualifying intake-form submission is about to
// redirect the user to TimeTap. The proper webhook-driven flip happens
// later via the Update_Lead_On_Appointment Salesforce flow (Phase 2 —
// see cjc-sf-metadata/reports/welcome-email-investigation.md §2 for the
// gap), but until that ships, this PATCH keeps the Lead's stage in sync
// with user intent rather than waiting for booking confirmation.
//
// Best-effort: throws SalesforceCreateLeadError on failure (callers must
// wrap in try/catch). One 401 retry, same pattern as createLead.

async function sfUpdateLeadOnce(
  leadId: string,
  fields: SalesforceLeadFields,
): Promise<void> {
  const env = readEnv();
  const token = await getAccessToken();
  const url = `${env.SF_INSTANCE_URL.replace(/\/$/, "")}/services/data/${env.SF_API_VERSION}/sobjects/Lead/${encodeURIComponent(leadId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
  });
  if (res.status === 204) return;
  if (res.status === 401) {
    invalidateAccessToken();
    const errors = await res.json().catch(() => []);
    throw new SalesforceCreateLeadError({
      status: 401,
      errors: Array.isArray(errors) ? errors : [],
    });
  }
  const errors = await res.json().catch(() => []);
  throw new SalesforceCreateLeadError({
    status: res.status,
    errors: Array.isArray(errors) ? errors : [],
  });
}

/**
 * PATCH /sobjects/Lead/{leadId} with the supplied field delta. One 401
 * retry. Throws SalesforceCreateLeadError on non-204 responses — caller
 * must wrap in try/catch.
 */
export async function updateLead(
  leadId: string,
  fields: SalesforceLeadFields,
): Promise<void> {
  try {
    return await sfUpdateLeadOnce(leadId, fields);
  } catch (err) {
    if (err instanceof SalesforceCreateLeadError && err.status === 401) {
      return await sfUpdateLeadOnce(leadId, fields);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Appointment__c — TimeTap sync (Workstream A)
// ---------------------------------------------------------------------------

export type SalesforceAppointmentFields = Record<string, unknown> & {
  Name: string;
};

export type UpsertAppointmentResult = {
  id: string;
  /** 'created' on insert, 'updated' on UPDATE of an existing row. */
  action: "created" | "updated";
};

export class SalesforceAppointmentError extends Error {
  readonly status: number;
  readonly errors: unknown;
  constructor(status: number, errors: unknown, message?: string) {
    super(
      message ??
        `Salesforce Appointment__c failed: ${status} ${JSON.stringify(errors).slice(0, 300)}`,
    );
    this.status = status;
    this.errors = errors;
  }
}

async function sfRequest(
  init: { method: string; path: string; body?: unknown },
): Promise<Response> {
  const env = readEnv();
  const token = await getAccessToken();
  const url = `${env.SF_INSTANCE_URL.replace(/\/$/, "")}/services/data/${env.SF_API_VERSION}${init.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    invalidateAccessToken();
  }
  return res;
}

/** SOQL query with one round of 401 retry. */
export async function sfQuery<T>(soql: string): Promise<T[]> {
  const tryOnce = async () => {
    const res = await sfRequest({
      method: "GET",
      path: `/query?q=${encodeURIComponent(soql)}`,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new SalesforceAppointmentError(res.status, body, `SOQL query failed: ${res.status}`);
    }
    const json = (await res.json()) as { records?: T[] };
    return Array.isArray(json.records) ? json.records : [];
  };
  try {
    return await tryOnce();
  } catch (err) {
    if (err instanceof SalesforceAppointmentError && err.status === 401) {
      return await tryOnce();
    }
    throw err;
  }
}

async function findAppointmentIdByName(name: string): Promise<string | undefined> {
  // SOQL string-literal escape: ' → \'. Name is the TimeTap calendarId
  // (numeric stringified), so realistically no quotes; defense in depth.
  const escaped = name.replace(/'/g, "\\'");
  const rows = await sfQuery<{ Id: string }>(
    `SELECT Id FROM Appointment__c WHERE Name = '${escaped}' ORDER BY CreatedDate DESC LIMIT 1`,
  );
  return rows[0]?.Id;
}

async function sfUpsertAppointmentOnce(
  fields: SalesforceAppointmentFields,
): Promise<UpsertAppointmentResult> {
  const existingId = await findAppointmentIdByName(fields.Name);

  if (existingId) {
    // PATCH /sobjects/Appointment__c/{id} with the field delta. SF expects
    // the Id NOT to be present in the body for PATCH-by-id; strip it
    // defensively.
    const { Id: _id, Name: _name, ...patchFields } = fields as Record<string, unknown>;
    void _id;
    void _name;
    const res = await sfRequest({
      method: "PATCH",
      path: `/sobjects/Appointment__c/${existingId}`,
      body: patchFields,
    });
    if (res.status === 204) return { id: existingId, action: "updated" };
    const body = await res.json().catch(() => null);
    throw new SalesforceAppointmentError(res.status, body);
  }

  const res = await sfRequest({
    method: "POST",
    path: `/sobjects/Appointment__c`,
    body: fields,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new SalesforceAppointmentError(res.status, body);
  }
  const payload = (await res.json()) as { id?: string; success?: boolean };
  if (!payload.id) {
    throw new SalesforceAppointmentError(500, payload, "Salesforce returned no Appointment id");
  }
  return { id: payload.id, action: "created" };
}

/**
 * Upsert an Appointment__c by Name (= TimeTap calendarId).
 *
 * Two-step: SELECT-by-Name then INSERT or UPDATE. Race condition window
 * is short but real — if two webhooks for the same calendarId hit in the
 * same ~150ms, both could miss the SELECT and both INSERT. The feasibility
 * report flagged this in the decision rules; we accept the risk for v1
 * because:
 *   1. TimeTap webhook deliveries to a single appointment within 150ms are
 *      rare (it implies an admin double-clicked save).
 *   2. Switching to native SF UPSERT by external-id would require marking
 *      Appointment__c.Name as External ID, which is a schema change the
 *      task brief explicitly forbids.
 *   3. If a duplicate slips through, the LATER webhook's UPDATE pass picks
 *      it up next time the same calendarId changes (SOQL ORDER BY
 *      CreatedDate DESC LIMIT 1).
 *
 * One 401-retry like createLead.
 */
export async function upsertAppointment(
  fields: SalesforceAppointmentFields,
): Promise<UpsertAppointmentResult> {
  if (!fields.Name) {
    throw new SalesforceAppointmentError(400, null, "upsertAppointment requires Name");
  }
  try {
    return await sfUpsertAppointmentOnce(fields);
  } catch (err) {
    if (err instanceof SalesforceAppointmentError && err.status === 401) {
      return await sfUpsertAppointmentOnce(fields);
    }
    throw err;
  }
}

/**
 * SOQL query for Appointment__c rows changed since a high-water mark.
 * Used by the outbound poller (api/cron/timetap-poll.ts). Caller passes
 * an ISO 8601 timestamp; SOQL's DateTime literal grammar accepts the
 * full ISO form.
 *
 * Returns rows ordered by LastModifiedDate ASC so the caller can advance
 * the high-water mark to the latest row processed even if the batch
 * partially fails.
 */
export async function listAppointmentsModifiedSince(
  highWaterMarkIso: string,
  limit = 200,
): Promise<Array<Record<string, unknown> & { Id: string; Name: string; LastModifiedDate: string }>> {
  const fieldList = [
    "Id",
    "Name",
    "LastModifiedDate",
    "Client_Email__c",
    "Status__c",
    "Reason_Desc__c",
    "Service_Class__c",
    "Staff_Name__c",
    "Business_Id__c",
    "Reason_Id__c",
    "Client_Id__c",
    "Staff_Id__c",
    "Start_Date_Time__c",
    "End_Date_Time__c",
    "Is_Created_From_DC_SOFA_Site__c",
  ].join(", ");
  const soql = `SELECT ${fieldList} FROM Appointment__c WHERE LastModifiedDate > ${highWaterMarkIso} ORDER BY LastModifiedDate ASC LIMIT ${limit}`;
  return await sfQuery<Record<string, unknown> & { Id: string; Name: string; LastModifiedDate: string }>(
    soql,
  );
}
