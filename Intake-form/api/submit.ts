import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import {
  V1_RULE_SET,
  compileRuleSet,
  evaluate,
  type LeadInput,
} from "@workspace/scoring";
import { db, eq, scoringRuleSets, submissions } from "@workspace/db";
import {
  SalesforceCreateLeadError,
  createLead,
  strippedFederalAgency,
} from "./_lib/sf";
import {
  SOURCE_DEFAULTS,
  buildSalesforceFields,
  type SourceKey,
} from "./_lib/lead-fields";

// ---------------------------------------------------------------------------
// Body shape (mirrors FormData in artifacts/intake-form/src/pages/Home.tsx)
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  // Identity
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().max(80),
  phone: z.string().min(1).max(40),
  stateResidence: z.string().min(1).max(80),

  // Agency
  agency: z.string().optional(),
  agencyOther: z.string().optional(),

  // Survey
  speakerRating: z.string().optional(),
  workshopContent: z.string().optional(),
  preRetirementReview: z.string().optional(),
  evalComments: z.string().optional(),
  yearsToRetire: z.string().optional(),
  age: z.string().optional(),
  separating: z.string().optional(),
  maritalStatus: z.string().optional(),
  maxingTsp: z.string().optional(),
  tspContributionPct: z.string().optional(),
  externalInvestments: z.string().optional(),
  tspBalance: z.string().optional(),
  areasOfConcern: z.string().optional(),

  // Channel attribution
  source: z.string().optional(),
  leadSource: z.string().optional(),
  surveyDetail: z.string().optional(),
  campaign: z.string().optional(),
  event: z.string().optional(),
  utmSource: z.string().optional(),
  utmMedium: z.string().optional(),
  utmCampaign: z.string().optional(),
});

type Body = z.infer<typeof bodySchema>;

function resolveSource(raw: unknown): SourceKey {
  if (typeof raw === "string") {
    const n = raw.trim().toLowerCase();
    if (n === "fnn") return "fnn";
    if (n === "internal") return "internal";
    if (n === "federal") return "federal";
  }
  return "federal";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res
      .status(405)
      .json({ success: false, error: "Method not allowed" });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid request body" });
  }
  const body = parsed.data;

  // Federal agency: form sends "Other" + agencyOther for free-text, else the
  // picklist value (possibly with sub-agency ' ► ' prefix). Strip the prefix
  // before persisting (Phase 1 invariant — see api/_lib/sf.ts).
  const rawAgency = body.agency === "Other" ? body.agencyOther : body.agency;
  if (!rawAgency || rawAgency.trim() === "") {
    return res.status(400).json({
      success: false,
      error: "Missing required field: federalAgency",
    });
  }
  const agencyValue = strippedFederalAgency(rawAgency);

  const source = resolveSource(body.source);
  const channelDefaults = SOURCE_DEFAULTS[source];
  const leadSource =
    body.leadSource && body.leadSource.length > 0
      ? body.leadSource
      : channelDefaults.leadSource;
  const surveyDetail =
    body.surveyDetail && body.surveyDetail.length > 0
      ? body.surveyDetail
      : channelDefaults.surveyDetail;

  // ---- 1) Persist the submission row up front, sf_status='pending'. -----
  // This guarantees an audit trail even if scoring or SF push fails.
  const [row] = await db
    .insert(submissions)
    .values({
      source,
      surveyDetail,
      leadSource,
      campaign: body.campaign || null,
      event: body.event || null,
      utmSource: body.utmSource || null,
      utmMedium: body.utmMedium || null,
      utmCampaign: body.utmCampaign || null,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: body.phone,
      stateResidence: body.stateResidence,
      federalAgency: agencyValue,
      qSpeakerRating: body.speakerRating || null,
      qWorkshopContent: body.workshopContent || null,
      qPreRetirement: body.preRetirementReview ?? "",
      qEvalComments: body.evalComments || null,
      qYearsToRetire: body.yearsToRetire || null,
      qAge: body.age || null,
      qSeparating: body.separating || null,
      qMaritalStatus: body.maritalStatus || null,
      qMaxingTsp: body.maxingTsp || null,
      qTspContributionPct: body.tspContributionPct || null,
      qExternalInvestments: body.externalInvestments || null,
      qTspBalance: body.tspBalance || null,
      qAreasOfConcern: body.areasOfConcern || null,
      sfStatus: "pending",
      rawPayload: body,
    })
    .returning({ id: submissions.id });
  const submissionId = row.id;

  // ---- 2) Score via the published RuleSet. ------------------------------
  let rank: string | undefined;
  let leadScore: string | undefined;
  let scoringRuleSetId: string | undefined;
  let scoringTrace: unknown;
  try {
    const published = await db
      .select({
        id: scoringRuleSets.id,
        version: scoringRuleSets.version,
        rules: scoringRuleSets.rules,
      })
      .from(scoringRuleSets)
      .where(eq(scoringRuleSets.status, "published"))
      .limit(1);

    // Fall back to V1_RULE_SET if no published row exists yet (covers the
    // window between deploy and seed-rule-set-v1 being run).
    const ruleSet =
      published.length > 0
        ? compileRuleSet(published[0].rules)
        : V1_RULE_SET;
    scoringRuleSetId = published[0]?.id;
    const version = published[0]?.version ?? 0;

    const leadInput: LeadInput = {
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: body.phone,
      stateResidence: body.stateResidence,
      federalAgency: agencyValue,
      preRetirementReview: body.preRetirementReview,
      yearsToRetire: body.yearsToRetire,
      age: body.age,
      separating: body.separating,
      maritalStatus: body.maritalStatus,
      maxingTsp: body.maxingTsp,
      tspContributionPct: body.tspContributionPct,
      externalInvestments: body.externalInvestments,
      tspBalance: body.tspBalance,
      areasOfConcern: body.areasOfConcern,
      source,
      leadSource,
      surveyDetail,
      campaign: body.campaign,
      event: body.event,
    };
    const result = evaluate(ruleSet, leadInput, {
      ruleSetId: scoringRuleSetId ?? "fallback-v1",
      version,
    });
    rank = result.rank;
    leadScore = result.leadScore;
    scoringTrace = result.trace;

    await db
      .update(submissions)
      .set({
        rank: rank ?? null,
        leadScore: leadScore ?? null,
        scoringRuleSetId: scoringRuleSetId ?? null,
        scoringTrace: scoringTrace as Record<string, unknown>,
      })
      .where(eq(submissions.id, submissionId));
  } catch (err) {
    console.error("scoring error", err);
    await db
      .update(submissions)
      .set({
        sfStatus: "error",
        sfError: `scoring: ${err instanceof Error ? err.message : String(err)}`,
      })
      .where(eq(submissions.id, submissionId));
    return res
      .status(500)
      .json({ success: false, error: "Submission could not be scored" });
  }

  // ---- 3) Push to Salesforce. -------------------------------------------
  const sfFields = buildSalesforceFields(
    body,
    source,
    agencyValue,
    rank,
    leadScore,
  );
  try {
    const sfResult = await createLead(sfFields);
    await db
      .update(submissions)
      .set({
        sfLeadId: sfResult.id,
        sfStatus: "sent",
        sfAttempts: 1,
        sfLastAttemptAt: new Date(),
      })
      .where(eq(submissions.id, submissionId));
    return res.status(200).json({ success: true, leadId: sfResult.id });
  } catch (err) {
    const message =
      err instanceof SalesforceCreateLeadError
        ? `sf:${err.status}:${err.errors[0]?.statusCode ?? "unknown"}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error("SF createLead error", message);
    await db
      .update(submissions)
      .set({
        sfStatus: "error",
        sfError: message,
        sfAttempts: 1,
        sfLastAttemptAt: new Date(),
      })
      .where(eq(submissions.id, submissionId));
    // Do NOT leak SF error details to the client. Generic message only.
    return res
      .status(502)
      .json({ success: false, error: "Submission could not be delivered" });
  }
}
