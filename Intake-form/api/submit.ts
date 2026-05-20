import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { db, submissions } from "@workspace/db";

// ---------------------------------------------------------------------------
// POST /api/submit — accepts a submission from either DrSnip form.
//
// Identity + insurance-card-stub fields land in dedicated columns; every form
// answer (including all medical-history fields) is kept verbatim in
// `raw_payload`. `.passthrough()` keeps the form-specific answer keys so they
// reach raw_payload without each needing a schema entry.
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

  const front = body.insuranceCardFront ?? null;
  const back = body.insuranceCardBack ?? null;

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
        // Full submission JSON, retained for the admin detail view + audit.
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
