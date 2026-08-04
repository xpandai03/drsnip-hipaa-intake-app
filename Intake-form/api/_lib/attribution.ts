// Server-side attribution extraction + catalog validation for /api/submit.
//
// Attribution is PASSIVE metadata: nothing here may block, delay, or alter a
// submission. Extraction is pure; validation is best-effort and degrades to
// "unvalidated" on any error (an empty/unreachable catalog never gates a write).
// patient_id is never read as attribution.

import { db, marketingSources, and, eq } from "@workspace/db";

export type AttributionColumns = {
  source: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  clickId: string | null;
  clickIdType: string | null;
};

const MAX_LEN = 200;

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, MAX_LEN);
  return t === "" ? null : t;
}

/**
 * Pull attribution from the submit body. Reads the `attribution` object that
 * registration/consultation send; falls back to a top-level `source` (the
 * insurance form's existing single-field capture) so its source still lands in
 * the column with zero insurance-form changes. Never reads patient_id.
 */
export function extractAttribution(body: unknown): AttributionColumns {
  const b = (body ?? {}) as Record<string, unknown>;
  const a = (b.attribution ?? {}) as Record<string, unknown>;

  const source = str(a.source) ?? str(b.source); // insurance fallback
  const gclid = str(a.gclid);
  const fbclid = str(a.fbclid);
  // gclid (Google) takes precedence over fbclid (Meta) for the primary column;
  // both raw values remain in raw_payload.attribution.
  const clickId = gclid ?? fbclid;
  const clickIdType = gclid ? "gclid" : fbclid ? "fbclid" : null;

  return {
    source,
    utmSource: str(a.utmSource) ?? str(a.utm_source),
    utmMedium: str(a.utmMedium) ?? str(a.utm_medium),
    utmCampaign: str(a.utmCampaign) ?? str(a.utm_campaign),
    utmTerm: str(a.utmTerm) ?? str(a.utm_term),
    utmContent: str(a.utmContent) ?? str(a.utm_content),
    clickId,
    clickIdType,
  };
}

/**
 * Validate a source against the marketing_sources catalog.
 *   null   → no source supplied (direct/untagged)
 *   true   → matched an ACTIVE catalog key
 *   false  → source present but unrecognized OR catalog unreachable (stored anyway)
 * Never throws.
 */
export async function validateSource(
  source: string | null,
): Promise<boolean | null> {
  if (!source) return null;
  try {
    const rows = await db
      .select({ id: marketingSources.id })
      .from(marketingSources)
      .where(
        and(
          eq(marketingSources.sourceKey, source),
          eq(marketingSources.isActive, true),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    // Catalog unreachable → store raw + flag unvalidated. Never gate the write.
    return false;
  }
}
