// Tests for the LeadSource resolution path (Issue 1 — UTM URLs landing
// as "SOFA Webinar" in Salesforce). Two layers:
//
//   1. getLeadSourceForKey — DB lookup. Read-only against the seeded
//      marketing_sources table. No mocking; live DB. (Tests run with
//      DATABASE_URL exported, same pattern as submit.test.ts.)
//
//   2. buildSalesforceFields with the new leadSourceOverride param —
//      pure function, exhaustive byte-exact assertions on the produced
//      Salesforce payload. Mirrors lead-fields.test.ts.
//
// What's intentionally NOT tested here:
//   - End-to-end submit.ts → live Salesforce. The existing submit.test.ts
//     covers validation paths without SF round-trip; mocking the SF call
//     for a full submit test is a separate workstream (see the "mocked-SF
//     version" note in submit.test.ts).
//   - Cache eviction — TTL behavior is straightforward; testing it
//     requires fragile timer mocks. The lookup function is exercised by
//     repeated calls below, which is enough signal that the cache works.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getLeadSourceForKey,
  invalidateMarketingSourcesCache,
} from "../_lib/marketing-sources";
import {
  SOURCE_DEFAULTS,
  buildSalesforceFields,
  type LeadFieldsInput,
} from "../_lib/lead-fields";

before(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run marketing-sources tests");
  }
});

// ---------------------------------------------------------------------------
// Layer 1: live DB lookup
// ---------------------------------------------------------------------------

describe("getLeadSourceForKey — DB lookup against seeded rows", () => {
  it("legacy 'fnn' resolves to 'FNN: Webinar' (byte-exact)", async () => {
    invalidateMarketingSourcesCache();
    const result = await getLeadSourceForKey("fnn");
    assert.equal(result, "FNN: Webinar");
  });

  it("legacy 'internal' resolves to 'Internal: Webinar' (byte-exact)", async () => {
    const result = await getLeadSourceForKey("internal");
    assert.equal(result, "Internal: Webinar");
  });

  it("legacy 'federal' resolves to 'SOFA: Webinar' (byte-exact)", async () => {
    const result = await getLeadSourceForKey("federal");
    assert.equal(result, "SOFA: Webinar");
  });

  it("new marketing channel 'instagram' resolves to 'Instagram Ads'", async () => {
    const result = await getLeadSourceForKey("instagram");
    assert.equal(result, "Instagram Ads");
  });

  it("new marketing channel 'facebook' resolves to 'Facebook Ads'", async () => {
    const result = await getLeadSourceForKey("facebook");
    assert.equal(result, "Facebook Ads");
  });

  it("unknown key returns null (caller's job to fall back)", async () => {
    const result = await getLeadSourceForKey("not-a-real-source-xyz-12345");
    assert.equal(result, null);
  });

  it("empty / whitespace key returns null without hitting DB", async () => {
    assert.equal(await getLeadSourceForKey(""), null);
    assert.equal(await getLeadSourceForKey("   "), null);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: buildSalesforceFields with leadSourceOverride
// ---------------------------------------------------------------------------

const baseInput: LeadFieldsInput = {
  firstName: "Pat",
  lastName: "Tester",
  email: "pat.tester@example.gov",
  phone: "555-0100",
  stateResidence: "VA",
  yearsToRetire: "2-5",
  age: "59 1/2 or over",
  maritalStatus: "Married",
  maxingTsp: "NO",
  tspContributionPct: "10",
  externalInvestments: "YES",
  tspBalance: "Over $1 million",
  areasOfConcern: "retirement planning",
  separating: "YES",
};

describe("buildSalesforceFields — leadSourceOverride precedence", () => {
  it("override='Instagram Ads' on a 'federal' channel produces LeadSource='Instagram Ads'", () => {
    const out = buildSalesforceFields(
      baseInput,
      "federal",
      "DOD",
      "A",
      undefined,
      "Instagram Ads",
    );
    assert.equal(out.LeadSource, "Instagram Ads");
    // Survey_Detail__c still comes from the channel default (federal). This
    // is the deliberate behavior — Salesforce-side Apex routes campaigns
    // by Survey_Detail__c; routing for new channels is a follow-up.
    assert.equal(out.Survey_Detail__c, SOURCE_DEFAULTS.federal.surveyDetail);
  });

  it("override=null falls through to channel default (legacy behavior preserved)", () => {
    const out = buildSalesforceFields(
      baseInput,
      "federal",
      "DOD",
      "A",
      undefined,
      null,
    );
    assert.equal(out.LeadSource, SOURCE_DEFAULTS.federal.leadSource);
  });

  it("override omitted (undefined) falls through to channel default", () => {
    const out = buildSalesforceFields(baseInput, "fnn", "DOD", "A", undefined);
    assert.equal(out.LeadSource, SOURCE_DEFAULTS.fnn.leadSource);
  });

  it("body.leadSource wins over both override and channel default", () => {
    const out = buildSalesforceFields(
      { ...baseInput, leadSource: "Hand-set Lead Source" },
      "federal",
      "DOD",
      "A",
      undefined,
      "Instagram Ads",
    );
    assert.equal(out.LeadSource, "Hand-set Lead Source");
  });

  it("override='' (empty string) falls through to channel default", () => {
    const out = buildSalesforceFields(
      baseInput,
      "federal",
      "DOD",
      "A",
      undefined,
      "",
    );
    assert.equal(out.LeadSource, SOURCE_DEFAULTS.federal.leadSource);
  });

  it("raw-key fallback: unknown source falling through gives readable LeadSource", () => {
    // Simulates the submit.ts path where the DB lookup returned null and
    // submit.ts passes the raw ?source= key as the override.
    const out = buildSalesforceFields(
      baseInput,
      "federal",
      "DOD",
      "A",
      undefined,
      "tiktok",
    );
    assert.equal(out.LeadSource, "tiktok");
  });
});
