// Byte-exact snapshot tests for buildSalesforceFields.
//
// Contract: a given (input, source, agencyValue, rank, leadScore) MUST
// produce the exact Salesforce Lead payload below. The same function is
// called by both the public submit handler and the admin release endpoint
// (Step 6 of the hold-valve feature); if the byte-exact output drifts
// between paths, a held-then-released lead would land in Salesforce with
// a different shape than a normally-submitted one — silent data drift.
//
// Lead_Score__c spacing is irregular and matches SF's expected literals
// exactly. See cjc-sf-metadata/reports/timetap-routing-audit.md §"Findings"
// for why the strings look like that and what depends on them.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_DEFAULTS,
  buildSalesforceFields,
  type LeadFieldsInput,
} from "../_lib/lead-fields";

// Common input fragment — survey answers populated. Each fixture overrides
// rank/leadScore plus any answer-specific deltas.
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
  // leadSource / surveyDetail omitted → defaults from SOURCE_DEFAULTS apply.
};

describe("buildSalesforceFields — byte-exact SF payload contract", () => {
  it("A-10 (over $1mm): federal source, defaults applied, A-rank + 10 score", () => {
    const actual = buildSalesforceFields(
      baseInput,
      "federal",
      "Dept of Defense (DOD): Navy",
      "A",
      "10  (over $1mm)",
    );
    assert.deepStrictEqual(actual, {
      FirstName: "Pat",
      LastName: "Tester",
      Email: "pat.tester@example.gov",
      Phone: "555-0100",
      State: "VA",
      Federal_Agency__c: "Dept of Defense (DOD): Navy",
      LeadSource: SOURCE_DEFAULTS.federal.leadSource,
      Survey_Detail__c: SOURCE_DEFAULTS.federal.surveyDetail,
      Sofa_Consultation_Survey_Q2__c: "2-5",
      Sofa_Consultation_Survey_Q4__c: "59 1/2 or over",
      Sofa_Consultation_Survey_Q5__c: "Married",
      Sofa_Consultation_Survey_Q8__c: "NO",
      Sofa_Consultation_Survey_Q8_Other__c: "10",
      Sofa_Consultation_Survey_Q9__c: "YES",
      Sofa_Consultation_Survey_Q10__c: "Over $1 million",
      Sofa_Consultation_Survey_Q13__c: "retirement planning",
      Sofa_Consultation_Survey_Q15__c: "YES",
      Rank__c: "A",
      Lead_Score__c: "10  (over $1mm)",
    });
  });

  it("A-7 ($0-$350k): internal source override, A-rank + 7 score, two-space byte-exact", () => {
    const input: LeadFieldsInput = {
      ...baseInput,
      tspBalance: "Under $350k",
      leadSource: "Custom Source",
      surveyDetail: "Custom Detail",
    };
    const actual = buildSalesforceFields(
      input,
      "internal",
      "GSA",
      "A",
      "7  ($0-$350k)",
    );
    assert.deepStrictEqual(actual, {
      FirstName: "Pat",
      LastName: "Tester",
      Email: "pat.tester@example.gov",
      Phone: "555-0100",
      State: "VA",
      Federal_Agency__c: "GSA",
      LeadSource: "Custom Source",
      Survey_Detail__c: "Custom Detail",
      Sofa_Consultation_Survey_Q2__c: "2-5",
      Sofa_Consultation_Survey_Q4__c: "59 1/2 or over",
      Sofa_Consultation_Survey_Q5__c: "Married",
      Sofa_Consultation_Survey_Q8__c: "NO",
      Sofa_Consultation_Survey_Q8_Other__c: "10",
      Sofa_Consultation_Survey_Q9__c: "YES",
      Sofa_Consultation_Survey_Q10__c: "Under $350k",
      Sofa_Consultation_Survey_Q13__c: "retirement planning",
      Sofa_Consultation_Survey_Q15__c: "YES",
      Rank__c: "A",
      Lead_Score__c: "7  ($0-$350k)",
    });
  });

  it("B+ (no Lead_Score__c): fnn source, B+ rank, leadScore undefined → omitted", () => {
    const input: LeadFieldsInput = {
      ...baseInput,
      maxingTsp: "YES",
      tspBalance: "$350k - $600k",
    };
    const actual = buildSalesforceFields(
      input,
      "fnn",
      "FAA",
      "B+",
      undefined,
    );
    assert.deepStrictEqual(actual, {
      FirstName: "Pat",
      LastName: "Tester",
      Email: "pat.tester@example.gov",
      Phone: "555-0100",
      State: "VA",
      Federal_Agency__c: "FAA",
      LeadSource: SOURCE_DEFAULTS.fnn.leadSource,
      Survey_Detail__c: SOURCE_DEFAULTS.fnn.surveyDetail,
      Sofa_Consultation_Survey_Q2__c: "2-5",
      Sofa_Consultation_Survey_Q4__c: "59 1/2 or over",
      Sofa_Consultation_Survey_Q5__c: "Married",
      Sofa_Consultation_Survey_Q8__c: "YES",
      Sofa_Consultation_Survey_Q8_Other__c: "10",
      Sofa_Consultation_Survey_Q9__c: "YES",
      Sofa_Consultation_Survey_Q10__c: "$350k - $600k",
      Sofa_Consultation_Survey_Q13__c: "retirement planning",
      Sofa_Consultation_Survey_Q15__c: "YES",
      Rank__c: "B+",
      // Lead_Score__c intentionally absent — undefined leadScore → key omitted.
    });
  });

  it("C (catch-all): federal source, C rank, no leadScore", () => {
    const actual = buildSalesforceFields(
      baseInput,
      "federal",
      "USDA",
      "C",
      undefined,
    );
    assert.deepStrictEqual(actual, {
      FirstName: "Pat",
      LastName: "Tester",
      Email: "pat.tester@example.gov",
      Phone: "555-0100",
      State: "VA",
      Federal_Agency__c: "USDA",
      LeadSource: SOURCE_DEFAULTS.federal.leadSource,
      Survey_Detail__c: SOURCE_DEFAULTS.federal.surveyDetail,
      Sofa_Consultation_Survey_Q2__c: "2-5",
      Sofa_Consultation_Survey_Q4__c: "59 1/2 or over",
      Sofa_Consultation_Survey_Q5__c: "Married",
      Sofa_Consultation_Survey_Q8__c: "NO",
      Sofa_Consultation_Survey_Q8_Other__c: "10",
      Sofa_Consultation_Survey_Q9__c: "YES",
      Sofa_Consultation_Survey_Q10__c: "Over $1 million",
      Sofa_Consultation_Survey_Q13__c: "retirement planning",
      Sofa_Consultation_Survey_Q15__c: "YES",
      Rank__c: "C",
    });
  });

  it("N/A (unqualified): minimal input, no survey answers populated, no rank/score", () => {
    const minimalInput: LeadFieldsInput = {
      firstName: "Minimal",
      lastName: "Lead",
      email: "minimal@example.gov",
      phone: "555-0200",
      stateResidence: "MD",
      // No optional fields populated.
    };
    const actual = buildSalesforceFields(
      minimalInput,
      "federal",
      "DHS",
      "N/A",
      undefined,
    );
    assert.deepStrictEqual(actual, {
      FirstName: "Minimal",
      LastName: "Lead",
      Email: "minimal@example.gov",
      Phone: "555-0200",
      State: "MD",
      Federal_Agency__c: "DHS",
      LeadSource: SOURCE_DEFAULTS.federal.leadSource,
      Survey_Detail__c: SOURCE_DEFAULTS.federal.surveyDetail,
      Rank__c: "N/A",
      // All Sofa_Consultation_Survey_Q*__c keys absent — only set when input has the answer.
      // Lead_Score__c absent — undefined leadScore.
    });
  });

  // Byte-exact spot-check on the four Lead_Score__c literals. These exact
  // strings (irregular spacing and all) appear verbatim in the Salesforce
  // Apex controller's `==` checks; any drift here misroutes leads silently.
  it("Lead_Score__c literals are byte-identical to SF reference values", () => {
    const cases: Array<[string, string]> = [
      ["10  (over $1mm)", "10  (over $1mm)"],   // two spaces after 10
      ["9 ($601k - $1mm)", "9 ($601k - $1mm)"], // one space, spaces around hyphen
      ["8  ($351k-$600k)", "8  ($351k-$600k)"], // two spaces, no spaces around hyphen
      ["7  ($0-$350k)", "7  ($0-$350k)"],       // two spaces, no spaces around hyphen
    ];
    for (const [score, expected] of cases) {
      const out = buildSalesforceFields(
        baseInput,
        "federal",
        "X",
        "A",
        score,
      );
      assert.equal(out.Lead_Score__c, expected);
    }
  });
});
