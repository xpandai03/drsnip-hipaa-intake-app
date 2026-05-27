import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { db, eq, submissions } from "@workspace/db";
import {
  callN8nConsultation,
  callN8nRegistration,
  type N8nOutcome,
} from "../lib/n8n/bridge";

// ---------------------------------------------------------------------------
// POST /api/submit — accepts a submission from either DrSnip form.
//
// Identity + insurance-card-stub fields land in dedicated columns; every form
// answer (including all medical-history fields) is kept verbatim in
// `raw_payload`. `.passthrough()` keeps the form-specific answer keys so they
// reach raw_payload without each needing a schema entry.
//
// Phase-3 n8n bridge: after the DB write commits, we respond 200 to the
// client and then fire-and-forget the bridge call to the v2 n8n webhook
// (Registration or Consultation). The bridge updates the submission row with
// the n8n outcome (status, patient_id, response body, response timestamp)
// once n8n responds (or the call times out / errors). The user never waits
// on n8n.
//
// HIPAA: never log request-body content. Logs carry IDs and error types only.
// ---------------------------------------------------------------------------

// A stubbed file reference — filename + size only. No bytes (see
// components/ui/FileUploadStub.tsx).
const fileRefSchema = z
  .object({
    filename: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
  })
  .nullable()
  .optional();

const bodySchema = z
  .object({
    formType: z.enum(["registration", "consultation"]).default("registration"),
    firstName: z.string().min(1).max(120),
    lastName: z.string().min(1).max(120),
    email: z.string().email().max(160),
    phone: z.string().min(1).max(40),
    dateOfBirth: z.string().max(40).optional(),
    stateResidence: z.string().max(120).optional(),
    insuranceCardFront: fileRefSchema,
    insuranceCardBack: fileRefSchema,
  })
  // Keep every other form answer so it flows through into raw_payload.
  .passthrough();

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid request body" });
    return;
  }
  const body = parsed.data;

  const front = body.insuranceCardFront ?? null;
  const back = body.insuranceCardBack ?? null;

  // Pull the dedicated mental-illness screening answer out of the
  // .passthrough() body — Registration-form only; absent on Consultation.
  const mhMentalIllnessRaw = (body as Record<string, unknown>).mhMentalIllness;
  const mhMentalIllness =
    typeof mhMentalIllnessRaw === "string" && mhMentalIllnessRaw !== ""
      ? mhMentalIllnessRaw
      : null;

  let submissionId: string;
  try {
    const [row] = await db
      .insert(submissions)
      .values({
        formType: body.formType,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        dateOfBirth: body.dateOfBirth || null,
        stateResidence: body.stateResidence || null,
        // Stubbed insurance-card refs — filename only, never bytes.
        insuranceCardFrontFilename: front?.filename ?? null,
        insuranceCardBackFilename: back?.filename ?? null,
        hasInsuranceCards: Boolean(front || back),
        mhMentalIllness,
        // Full submission JSON, retained for the admin detail view + audit.
        rawPayload: body,
      })
      .returning({ id: submissions.id });

    submissionId = row.id;
    res.status(200).json({ success: true, id: row.id });
  } catch (err) {
    // HIPAA: log the error type only — never the request body.
    console.error(
      "submit: failed to persist submission",
      err instanceof Error ? err.name : "UnknownError",
    );
    res
      .status(500)
      .json({ success: false, error: "Submission could not be saved" });
    return;
  }

  // ---- Fire-and-forget n8n bridge --------------------------------------
  // Runs AFTER res.json() has buffered the response. The Hono adapter
  // (api-server/vercel-adapter.ts) builds the final Response when this
  // handler returns; the bridge work continues on the Node event loop
  // because the long-running Fly process stays alive. The bridge never
  // throws — every code path returns an N8nOutcome.
  void runN8nBridge(submissionId, body).catch((err) => {
    // Defensive: should never hit. Bridge code catches internally.
    console.error(
      "submit: unexpected bridge error",
      err instanceof Error ? err.name : "UnknownError",
    );
  });
}

async function runN8nBridge(
  submissionId: string,
  body: z.infer<typeof bodySchema>,
): Promise<void> {
  const submittedAt = new Date();

  const outcome: N8nOutcome =
    body.formType === "consultation"
      ? await callN8nConsultation(submissionId, body, submittedAt)
      : await callN8nRegistration(submissionId, body, submittedAt);

  try {
    await db
      .update(submissions)
      .set({
        n8nStatus: outcome.status,
        n8nPatientId: outcome.patientId ?? null,
        n8nResponseAt: new Date(),
        n8nResponseBody: outcomeForDb(outcome),
      })
      .where(eq(submissions.id, submissionId));
  } catch (err) {
    // Persistence failure — log type only, never the body.
    console.error(
      "submit: bridge outcome write failed",
      err instanceof Error ? err.name : "UnknownError",
    );
  }
}

// Compose the JSONB column value. Always include the bridge's view; only
// include responseBody when n8n actually returned one.
function outcomeForDb(outcome: N8nOutcome): Record<string, unknown> {
  const out: Record<string, unknown> = { bridge_status: outcome.status };
  if (outcome.errorMessage) out.error_message = outcome.errorMessage;
  if (outcome.responseBody !== undefined) out.response = outcome.responseBody;
  return out;
}
