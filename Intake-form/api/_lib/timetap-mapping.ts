// TimeTap payload <-> Salesforce Appointment__c mapping. Pure functions —
// no DB, no HTTP, no env. The byte-exact contract is locked by snapshot
// tests in api/_test/timetap-mapping.test.ts; mirrors the lead-fields.ts
// pattern.
//
// Direction: TimeTap webhook JSON --> SF Appointment__c REST field shape,
// and back. Field names match the existing AppointmentResponseHelper.cls /
// objects/Appointment__c/fields/ schema (29 custom fields, see feasibility
// report Area 1). We mirror the helper's shape but do NOT depend on it —
// the helper has known gaps (no cancelReason/cancelUser deserialization)
// that we surface in raw_payload on the event log side.
//
// UTC handling: TimeTap supplies startDateTimeUTC / endDateTimeUTC as ISO
// strings. SF's REST API accepts ISO 8601 with the trailing 'Z'; we pass
// them through unchanged when present so any tooling-side timezone math is
// not introduced here.

import type { SalesforceAppointmentFields } from "./sf";

// ---------------------------------------------------------------------------
// Inbound shape — TimeTap webhook body
// ---------------------------------------------------------------------------

export type TimeTapClient = {
  clientId?: number | null;
  emailAddress?: string | null;
  cellPhone?: string | null;
  fullName?: string | null;
};

export type TimeTapProfessional = {
  professionalId?: number | null;
  userName?: string | null;
  email?: string | null;
  fullName?: string | null;
};

export type TimeTapReason = {
  reasonId?: number | null;
  visitMinutes?: number | null;
  reasonDesc?: string | null;
  active?: boolean | null;
  reasonType?: string | null;
  internalName?: string | null;
};

export type TimeTapLocation = {
  locationName?: string | null;
};

export type TimeTapAppointmentPayload = {
  calendarId?: number | string | null;
  // TimeTap's docs aren't fully consistent on casing; accept either.
  calendarid?: number | string | null;
  businessId?: number | null;
  professional?: TimeTapProfessional | null;
  location?: TimeTapLocation | null;
  reason?: TimeTapReason | null;
  client?: TimeTapClient | null;
  customFieldDesc?: string | null;
  createddate?: string | null;
  createduser?: string | null;
  modifieddate?: string | null;
  modifieduser?: string | null;
  status?: string | null;
  displayStatus?: string | null;
  clientReminderHours?: number | null;
  staffReminderHours?: number | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  startDateTimeUTC?: string | null;
  endDateTimeUTC?: string | null;
  joinURL?: string | null;
  staffTimeZone?: string | null;
  clientTimeZone?: string | null;
  // Cancellation context — present on cancellation webhooks. The existing
  // Apex helper does NOT deserialize these (feasibility report Area 2).
  // We capture them verbatim in raw_payload on the event log; Workstream B
  // is what actually plumbs them into Appointment__c columns.
  cancelReason?: string | null;
  cancelUser?: string | null;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// The four service-class values that mark a DC SOFA Site-originated booking,
// per WebhookListener.cls:60-63. Matched here so the Vercel sync writes
// the same Is_Created_From_DC_SOFA_Site__c=true that the Apex listener did.
// ---------------------------------------------------------------------------

export const DC_SOFA_SERVICE_CLASSES = new Set<string>([
  "CFQ A-10 (auto calendar)",
  "CFQ A-9 (auto calendar)",
  "CFQ A-8 (auto calendar)",
  "CFQ A-7 (auto calendar)",
]);

// ---------------------------------------------------------------------------
// Outbound — SF Appointment__c REST shape we update via REST PATCH
// ---------------------------------------------------------------------------

export type SfAppointmentRecord = {
  Id?: string;
  Name?: string | null;
  Client_Email__c?: string | null;
  Status__c?: string | null;
  Reason_Desc__c?: string | null;
  Service_Class__c?: string | null;
  Staff_Name__c?: string | null;
  Business_Id__c?: number | null;
  Reason_Id__c?: number | null;
  Client_Id__c?: number | null;
  Staff_Id__c?: number | null;
  Start_Date_Time__c?: string | null;
  End_Date_Time__c?: string | null;
  Is_Created_From_DC_SOFA_Site__c?: boolean | null;
  [key: string]: unknown;
};

export type TimeTapUpdatePayload = {
  status?: string | null;
  startDateTimeUTC?: string | null;
  endDateTimeUTC?: string | null;
  reason?: { reasonId?: number | null; reasonDesc?: string | null; internalName?: string | null } | null;
  client?: { clientId?: number | null; emailAddress?: string | null } | null;
  professional?: { professionalId?: number | null; fullName?: string | null } | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceCalendarId(
  payload: TimeTapAppointmentPayload,
): string | undefined {
  const raw = payload.calendarId ?? payload.calendarid;
  if (raw === null || raw === undefined) return undefined;
  return String(raw);
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// timeTapPayloadToSfFields
// ---------------------------------------------------------------------------

/**
 * Pure mapping: TimeTap webhook payload → Salesforce Appointment__c field
 * shape. Returns undefined ONLY if calendarId is missing — every other
 * field is optional in the output (we let SF reject if it doesn't like the
 * combination, but we don't gate the mapping itself).
 *
 * Status is preserved verbatim (status, falling back to displayStatus).
 * DateTimes pass through unchanged (TimeTap supplies ISO UTC).
 */
export function timeTapPayloadToSfFields(
  payload: TimeTapAppointmentPayload,
): SalesforceAppointmentFields | undefined {
  const calendarId = coerceCalendarId(payload);
  if (!calendarId) return undefined;

  const fields: SalesforceAppointmentFields = {
    Name: calendarId,
  };

  const businessId = asNumber(payload.businessId);
  if (businessId !== undefined) fields.Business_Id__c = businessId;

  const status = asString(payload.status) ?? asString(payload.displayStatus);
  if (status) fields.Status__c = status;

  const reason = payload.reason ?? undefined;
  if (reason) {
    const reasonId = asNumber(reason.reasonId);
    if (reasonId !== undefined) fields.Reason_Id__c = reasonId;
    const reasonDesc = asString(reason.reasonDesc);
    if (reasonDesc) fields.Reason_Desc__c = reasonDesc;
    const internalName = asString(reason.internalName);
    if (internalName) fields.Service_Class__c = internalName;
    if (internalName && DC_SOFA_SERVICE_CLASSES.has(internalName)) {
      fields.Is_Created_From_DC_SOFA_Site__c = true;
    }
  }

  const client = payload.client ?? undefined;
  if (client) {
    const clientId = asNumber(client.clientId);
    if (clientId !== undefined) fields.Client_Id__c = clientId;
    const email = asString(client.emailAddress);
    if (email) fields.Client_Email__c = email;
  }

  const professional = payload.professional ?? undefined;
  if (professional) {
    const professionalId = asNumber(professional.professionalId);
    if (professionalId !== undefined) fields.Staff_Id__c = professionalId;
    const fullName = asString(professional.fullName);
    if (fullName) fields.Staff_Name__c = fullName;
  }

  const startUtc = asString(payload.startDateTimeUTC);
  if (startUtc) fields.Start_Date_Time__c = startUtc;
  const endUtc = asString(payload.endDateTimeUTC);
  if (endUtc) fields.End_Date_Time__c = endUtc;

  return fields;
}

// ---------------------------------------------------------------------------
// sfAppointmentToTimeTapUpdate
// ---------------------------------------------------------------------------

/**
 * Pure mapping: SF Appointment__c row → minimal TimeTap update payload.
 * Used by the outbound poller (api/cron/timetap-poll.ts). Only includes
 * fields TimeTap accepts on an appointment update; ids in the inner reason
 * / client / professional objects let TimeTap resolve the right linked
 * record without us having to look up TimeTap-side names.
 */
export function sfAppointmentToTimeTapUpdate(
  record: SfAppointmentRecord,
): TimeTapUpdatePayload {
  const payload: TimeTapUpdatePayload = {};

  if (record.Status__c !== undefined && record.Status__c !== null) {
    payload.status = record.Status__c;
  }
  if (record.Start_Date_Time__c) payload.startDateTimeUTC = record.Start_Date_Time__c;
  if (record.End_Date_Time__c) payload.endDateTimeUTC = record.End_Date_Time__c;

  const reasonId = asNumber(record.Reason_Id__c);
  const reasonDesc = asString(record.Reason_Desc__c);
  const internalName = asString(record.Service_Class__c);
  if (reasonId !== undefined || reasonDesc || internalName) {
    payload.reason = {};
    if (reasonId !== undefined) payload.reason.reasonId = reasonId;
    if (reasonDesc) payload.reason.reasonDesc = reasonDesc;
    if (internalName) payload.reason.internalName = internalName;
  }

  const clientId = asNumber(record.Client_Id__c);
  const email = asString(record.Client_Email__c);
  if (clientId !== undefined || email) {
    payload.client = {};
    if (clientId !== undefined) payload.client.clientId = clientId;
    if (email) payload.client.emailAddress = email;
  }

  const staffId = asNumber(record.Staff_Id__c);
  const staffName = asString(record.Staff_Name__c);
  if (staffId !== undefined || staffName) {
    payload.professional = {};
    if (staffId !== undefined) payload.professional.professionalId = staffId;
    if (staffName) payload.professional.fullName = staffName;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Diff helper — used by the cron poller to detect whether the outbound
// payload differs from the last successful outbound write for the same
// calendarId. JSON-stable comparison; keys missing in either side count as
// distinct values.
// ---------------------------------------------------------------------------

export function timeTapUpdatePayloadsEqual(
  a: TimeTapUpdatePayload,
  b: TimeTapUpdatePayload,
): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
