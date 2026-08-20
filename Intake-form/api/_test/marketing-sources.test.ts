// Marketing-source resolution + source validation.
//
// 2026-08-20: rewritten. The original tested two layers, one of which no longer
// exists. Layer 1 (getLeadSourceForKey) survives and is kept. Layer 2 asserted
// Salesforce LeadSource precedence via _lib/lead-fields.ts:buildSalesforceFields
// — that module, and Salesforce itself, were removed in the CJC→DrSnip strip, so
// the whole file died on a missing import and had not run since. There is no
// DrSnip equivalent to adapt those assertions to, so they are dropped rather
// than faked; what replaces them is coverage of validateSource(), which is the
// function the live DrSnip attribution path actually calls from api/submit.ts.
//
// The original also asserted CJC seed data ("FNN: Webinar", "SOFA: Webinar",
// federal/TSP channels). Those rows are not part of the DrSnip catalog, so the
// value-specific assertions are replaced by behavioral ones that hold for any
// catalog contents.
//
// DB-FREE by default: every assertion below runs without DATABASE_URL, because
// the properties that matter most — blank input short-circuits, and attribution
// NEVER throws or gates a submission — are exactly the ones that must hold when
// the catalog is unreachable. The optional live-DB block at the bottom runs only
// when DATABASE_URL is set.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getLeadSourceForKey,
  invalidateMarketingSourcesCache,
} from "../_lib/marketing-sources";
import { extractAttribution, validateSource } from "../_lib/attribution";

describe("getLeadSourceForKey — short-circuit paths (no DB required)", () => {
  it("empty key returns null without hitting the DB", async () => {
    assert.equal(await getLeadSourceForKey(""), null);
  });

  it("whitespace-only key returns null without hitting the DB", async () => {
    assert.equal(await getLeadSourceForKey("   "), null);
    assert.equal(await getLeadSourceForKey("\t\n"), null);
  });

  it("invalidateMarketingSourcesCache is callable and idempotent", () => {
    invalidateMarketingSourcesCache();
    invalidateMarketingSourcesCache();
  });
});

describe("validateSource — attribution must never gate a submission", () => {
  it("no source supplied returns null (direct/untagged traffic)", async () => {
    assert.equal(await validateSource(null), null);
    assert.equal(await validateSource(""), null);
  });

  it("an unreachable catalog degrades to false, never throws", async () => {
    // This is the load-bearing property: api/submit.ts awaits validateSource
    // before the insert, so a throw here would fail real intake. With no
    // DATABASE_URL the query rejects and the function must swallow it.
    const result = await validateSource("some-unrecognized-key");
    assert.equal(typeof result === "boolean", true);
    assert.equal(result, false);
  });

  it("never throws for hostile input shapes", async () => {
    for (const v of ["'; DROP TABLE submissions;--", "x".repeat(500), "🙂"]) {
      const r = await validateSource(v);
      assert.equal(r === true || r === false, true);
    }
  });
});

describe("extractAttribution — pure, degrades to NULLs, never throws", () => {
  it("an empty body yields all-null columns", () => {
    const a = extractAttribution({});
    for (const [k, v] of Object.entries(a)) {
      assert.equal(v, null, `${k} should be null for an empty body`);
    }
  });

  it("non-object bodies do not throw", () => {
    for (const body of [null, undefined, 42, "str", []]) {
      const a = extractAttribution(body);
      assert.equal(typeof a, "object");
    }
  });

  it("a tagged body carries source through", () => {
    const a = extractAttribution({ source: "instagram" });
    assert.equal(a.source, "instagram");
  });
});

// ---------------------------------------------------------------------------
// Live-DB block — only when DATABASE_URL is configured. Asserts BEHAVIOR, not
// specific catalog rows, so it stays green as marketing sources are added or
// renamed by admins.
// ---------------------------------------------------------------------------
describe("live catalog lookups (skipped without DATABASE_URL)", () => {
  const live = Boolean(process.env.DATABASE_URL);

  it("an unknown key resolves to null", { skip: !live }, async () => {
    invalidateMarketingSourcesCache();
    assert.equal(await getLeadSourceForKey("not-a-real-source-xyz-12345"), null);
  });

  it("validateSource is false for an unknown key", { skip: !live }, async () => {
    assert.equal(await validateSource("not-a-real-source-xyz-12345"), false);
  });

  it("repeated lookups are consistent (cache coherent)", { skip: !live }, async () => {
    invalidateMarketingSourcesCache();
    const first = await getLeadSourceForKey("instagram");
    const second = await getLeadSourceForKey("instagram");
    assert.equal(first, second);
  });
});
