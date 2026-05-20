import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { db, submissions } from "@workspace/db";

// ---------------------------------------------------------------------------
// Body shape — mirrors FormData in artifacts/intake-form/src/pages/Home.tsx.
//
// Phase 1 (DrSnip adaptation) keeps the existing CJC form fields so the form
// still renders and submits. Phase 2 replaces the form content with DrSnip's
// patient-intake questions and revises this schema accordingly.
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

// ---------------------------------------------------------------------------
// Handler — POST /api/submit
//
// Phase 1: validate the body, persist one row to `submissions`, return its id.
// The CJC-era lead scoring, Salesforce push, TimeTap self-scheduling redirect,
// and hold-valve gate have all been removed.
//
// HIPAA: never log request-body content. Logs carry IDs and error types only.
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

  // Agency: the form sends "Other" + agencyOther for free text, otherwise the
  // picklist value. Collapse to a single string for the federal_agency column.
  const agencyValue =
    body.agency === "Other"
      ? (body.agencyOther ?? "").trim()
      : (body.agency ?? "").trim();

  try {
    const [row] = await db
      .insert(submissions)
      .values({
        // Channel attribution — passed through as-is.
        source: body.source ?? "",
        surveyDetail: body.surveyDetail ?? "",
        leadSource: body.leadSource ?? "",
        campaign: body.campaign || null,
        event: body.event || null,
        utmSource: body.utmSource || null,
        utmMedium: body.utmMedium || null,
        utmCampaign: body.utmCampaign || null,
        // Identity
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        stateResidence: body.stateResidence,
        federalAgency: agencyValue,
        // Survey answers
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
        // Full payload, retained for audit/forensics.
        rawPayload: body,
      })
      .returning({ id: submissions.id });

    return res.status(200).json({ success: true, id: row.id });
  } catch (err) {
    // HIPAA: log the error type only — never the request body.
    console.error(
      "submit: failed to persist submission",
      err instanceof Error ? err.name : "UnknownError",
    );
    return res
      .status(500)
      .json({ success: false, error: "Submission could not be saved" });
  }
}
