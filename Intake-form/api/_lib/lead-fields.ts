// Salesforce Lead payload mapping — extracted from api/submit.ts so the
// public submit handler AND the admin release endpoint can build the same
// payload from the same inputs.
//
// Byte-exact contract: a given (input, source, agencyValue, rank, leadScore)
// MUST produce a byte-identical payload regardless of caller. This is what
// guarantees a held-then-released lead lands in Salesforce with the same
// Lead shape it would have had if the valve were OFF. The snapshot test in
// api/_test/lead-fields.test.ts locks the contract — do not modify a
// fixture's expected output without understanding why it changed.

import type { SalesforceLeadFields } from "./sf";

export type SourceKey = "federal" | "internal" | "fnn";

export const SOURCE_DEFAULTS: Record<
  SourceKey,
  { leadSource: string; surveyDetail: string }
> = {
  federal: { leadSource: "SOFA: Webinar", surveyDetail: "DC SOFA" },
  internal: { leadSource: "Internal: Webinar", surveyDetail: "DC SOFA 2" },
  fnn: { leadSource: "FNN: Webinar", surveyDetail: "DC SOFA 3" },
};

// Narrow input shape — only the fields buildSalesforceFields actually reads.
// Both the public submit handler (where this is a subset of the Zod-parsed
// Body) and the admin release endpoint (where this is reconstructed from a
// stored submissions row) produce objects that satisfy this shape via
// TypeScript's structural typing.
export type LeadFieldsInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  stateResidence: string;
  leadSource?: string;
  surveyDetail?: string;
  yearsToRetire?: string;
  age?: string;
  separating?: string;
  maritalStatus?: string;
  maxingTsp?: string;
  tspContributionPct?: string;
  externalInvestments?: string;
  tspBalance?: string;
  areasOfConcern?: string;
};

export function buildSalesforceFields(
  body: LeadFieldsInput,
  source: SourceKey,
  agencyValue: string,
  rank: string | undefined,
  leadScore: string | undefined,
  /**
   * Optional pre-resolved LeadSource (from the marketing_sources table
   * lookup in api/submit.ts). When present, takes precedence over the
   * channel default but is overridden by an explicit body.leadSource.
   *
   * Fallback ladder (highest priority first):
   *   1. body.leadSource (form-side override; not in use today)
   *   2. leadSourceOverride (DB lookup or raw ?source= key)
   *   3. SOURCE_DEFAULTS[source].leadSource (legacy 3-channel default)
   */
  leadSourceOverride?: string | null,
): SalesforceLeadFields {
  const defaults = SOURCE_DEFAULTS[source];
  const resolvedLeadSource =
    body.leadSource && body.leadSource.length > 0
      ? body.leadSource
      : leadSourceOverride && leadSourceOverride.length > 0
        ? leadSourceOverride
        : defaults.leadSource;
  const fields: SalesforceLeadFields = {
    FirstName: body.firstName,
    LastName: body.lastName,
    Email: body.email,
    Phone: body.phone,
    State: body.stateResidence,
    Federal_Agency__c: agencyValue,
    LeadSource: resolvedLeadSource,
    Survey_Detail__c: body.surveyDetail && body.surveyDetail.length > 0
      ? body.surveyDetail
      : defaults.surveyDetail,
  };
  if (body.yearsToRetire) fields.Sofa_Consultation_Survey_Q2__c = body.yearsToRetire;
  if (body.age) fields.Sofa_Consultation_Survey_Q4__c = body.age;
  if (body.maritalStatus) fields.Sofa_Consultation_Survey_Q5__c = body.maritalStatus;
  if (body.maxingTsp) fields.Sofa_Consultation_Survey_Q8__c = body.maxingTsp;
  if (body.tspContributionPct) {
    fields.Sofa_Consultation_Survey_Q8_Other__c = body.tspContributionPct;
  }
  if (body.externalInvestments) fields.Sofa_Consultation_Survey_Q9__c = body.externalInvestments;
  if (body.tspBalance) fields.Sofa_Consultation_Survey_Q10__c = body.tspBalance;
  if (body.areasOfConcern) fields.Sofa_Consultation_Survey_Q13__c = body.areasOfConcern;
  if (body.separating) fields.Sofa_Consultation_Survey_Q15__c = body.separating;
  if (rank) fields.Rank__c = rank;
  if (leadScore) fields.Lead_Score__c = leadScore;
  return fields;
}
