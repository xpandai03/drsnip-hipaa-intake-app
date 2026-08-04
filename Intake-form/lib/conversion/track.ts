// Dormant server-side conversion hook (Phase 2). On a genuine submission
// success, optionally fires a Google Analytics 4 Measurement Protocol event so
// the agency can attribute a conversion. Ships OFF: nothing leaves the server
// unless CONVERSION_TRACKING_ENABLED === "true" AND the GA4 target is fully
// configured.
//
// HARD RULES (HIPAA):
//   • Event payload whitelist is EXACTLY { event name, form_type, timestamp,
//     click id where applicable }. NEVER name/email/phone/DOB/address/patient id.
//   • No third-party SDK — a single fetch to the documented GA4 endpoint.
//   • The client_id is a fresh random UUID (NOT a patient identifier, NOT a
//     cookie) — GA4 requires one; it links nothing back to the person.
//   • Fires on SUBMISSION success (row persisted), independent of n8n bridge
//     outcome: manual_review and a failed bridge are still completed submissions.
//   • Never throws, never blocks — it runs after the response is sent.

export type ConversionConfig = {
  enabled: boolean;
  ga4MeasurementId: string;
  ga4ApiSecret: string;
  eventName: string;
};

export type ConversionInput = {
  formType: string;
  clickId?: string | null;
  clickIdType?: string | null; // 'gclid' | 'fbclid'
  timestampMs: number;
  clientId: string; // random UUID supplied by the caller
};

const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";

/** Read config from env. All empty/unset by default → hook stays inert. */
export function readConversionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConversionConfig {
  return {
    enabled: env.CONVERSION_TRACKING_ENABLED === "true",
    ga4MeasurementId: env.GA4_MEASUREMENT_ID ?? "",
    ga4ApiSecret: env.GA4_API_SECRET ?? "",
    eventName: env.CONVERSION_EVENT_NAME ?? "intake_conversion",
  };
}

/** True only when the master flag is on AND the GA4 target is fully set. */
export function conversionReady(cfg: ConversionConfig): boolean {
  return (
    cfg.enabled &&
    cfg.ga4MeasurementId.length > 0 &&
    cfg.ga4ApiSecret.length > 0
  );
}

/**
 * Build the GA4 Measurement Protocol body. PII-FREE by construction: the only
 * event params are form_type, a timestamp, and the click id (when present).
 */
export function buildGa4Payload(cfg: ConversionConfig, input: ConversionInput) {
  const params: Record<string, string | number> = {
    form_type: input.formType,
    submitted_at: input.timestampMs,
  };
  // Include the click id ONLY for Google (gclid); it is a campaign token, not PII.
  if (input.clickIdType === "gclid" && input.clickId) {
    params.gclid = input.clickId;
  }
  return {
    client_id: input.clientId,
    // GA4 wants epoch micros for server events.
    timestamp_micros: input.timestampMs * 1000,
    non_personalized_ads: true,
    events: [{ name: cfg.eventName, params }],
  };
}

/**
 * Fire the conversion event. Inert by default: with the flag off or the GA4
 * target unset, it returns WITHOUT any network call. Never throws.
 * Returns true iff a request was actually dispatched (for tests/telemetry).
 */
export async function fireConversion(
  input: ConversionInput,
  cfg: ConversionConfig = readConversionConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!conversionReady(cfg)) return false; // ← dormant path
  try {
    const url =
      `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(cfg.ga4MeasurementId)}` +
      `&api_secret=${encodeURIComponent(cfg.ga4ApiSecret)}`;
    await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildGa4Payload(cfg, input)),
    });
    return true;
  } catch {
    // Conversion signalling must never affect intake.
    return false;
  }
}
