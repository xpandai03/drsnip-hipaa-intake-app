// Marketing-source DB lookup for the LeadSource attribution path.
//
// The submissions handler calls getLeadSourceForKey() to resolve a
// ?source=<key> URL param to the Salesforce LeadSource string. Before
// this module existed, the mapping was hardcoded to three legacy keys
// (fnn / internal / federal) in _lib/lead-fields.ts:SOURCE_DEFAULTS and
// anything else collapsed to "SOFA: Webinar" — silent misattribution.
//
// The cache is in-memory per Vercel function instance. 5-min TTL keeps
// new admin-added sources visible within minutes of being added without
// pinging the DB on every submit. Each cold start refetches; admins
// don't have to manually invalidate.

import { db, marketingSources } from "@workspace/db";

type CachedMap = { byKey: Map<string, string>; expiresAt: number };

let cache: CachedMap | null = null;
const TTL_MS = 5 * 60 * 1000;

async function refreshCache(): Promise<CachedMap> {
  const rows = await db
    .select({
      sourceKey: marketingSources.sourceKey,
      leadSource: marketingSources.leadSource,
    })
    .from(marketingSources);
  // NOTE: we deliberately do NOT filter by is_active. A printed flyer or
  // long-running ad creative may carry a now-archived source key for
  // years; LeadSource attribution should still resolve. Only the admin
  // Sources tab and the public Source dropdown filter on active.
  const byKey = new Map<string, string>();
  for (const r of rows) byKey.set(r.sourceKey, r.leadSource);
  return { byKey, expiresAt: Date.now() + TTL_MS };
}

/**
 * Resolve a URL `?source=<key>` to its Salesforce LeadSource string.
 * Returns null if no marketing_sources row matches. Caller decides the
 * fallback strategy (typically: raw key value, then channel default).
 */
export async function getLeadSourceForKey(
  sourceKey: string,
): Promise<string | null> {
  const key = sourceKey.trim();
  if (!key) return null;
  if (!cache || cache.expiresAt <= Date.now()) {
    cache = await refreshCache();
  }
  return cache.byKey.get(key) ?? null;
}

/** Test-only: force the next call to re-read from the DB. */
export function invalidateMarketingSourcesCache(): void {
  cache = null;
}
