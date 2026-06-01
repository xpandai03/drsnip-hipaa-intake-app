import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { db, eq, submissions } from "@workspace/db";
import {
  callN8nConsultation,
  callN8nRegistration,
  type N8nOutcome,
} from "../lib/n8n/bridge";
import {
  notifyPatientSubmission,
  shouldNotify,
} from "../lib/email/patientmail";

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

// Insurance-card capture (Phase 3 card-upload). Patients now upload real
// JPEG/PNG bytes; the FileUploadStub component reads the file as a base64
// data URL and strips the prefix. base64Data is OPTIONAL on the schema so
// legacy metadata-only refs (Phase 2 stub) still validate cleanly; the
// bridge mapper only forwards the card to n8n when base64Data is set and
// non-empty.
//
// HIPAA: base64Data is PHI. Never logged from this handler. The bytes are
// stripped before the row is persisted to `raw_payload` (see
// sanitizeForPersistence below) so the DB row stays lean and the bytes
// only live in the n8n call to DrChrono.
const MAX_CARD_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_LEN = Math.ceil((MAX_CARD_BYTES / 3) * 4) + 16;
const fileRefSchema = z
  .object({
    filename: z.string().min(1).max(255),
    size: z.number().int().nonnegative().max(MAX_CARD_BYTES),
    contentType: z.string().max(120).optional(),
    base64Data: z.string().max(MAX_BASE64_LEN).optional(),
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

  // Diagnostic: non-PHI breadcrumb for card upload debugging. Logs the
  // count and total payload size of cards present. NEVER logs base64Data,
  // filenames, or content-types (filenames may carry identifiers).
  const cards: Array<{ size: number; hasBytes: boolean }> = [];
  if (front) cards.push({ size: front.size, hasBytes: Boolean(front.base64Data) });
  if (back) cards.push({ size: back.size, hasBytes: Boolean(back.base64Data) });
  if (cards.length > 0) {
    console.log(
      "[submit] cards " +
        JSON.stringify({
          ts: new Date().toISOString(),
          card_count: cards.length,
          cards_with_bytes: cards.filter((c) => c.hasBytes).length,
          total_size_kb: Math.round(
            cards.reduce((acc, c) => acc + c.size, 0) / 1024,
          ),
        }),
    );
  }

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
        // Filename + flag captured for audit; raw bytes are NEVER persisted
        // here (only in the n8n bridge call, which forwards them to DrChrono).
        insuranceCardFrontFilename: front?.filename ?? null,
        insuranceCardBackFilename: back?.filename ?? null,
        hasInsuranceCards: Boolean(front || back),
        mhMentalIllness,
        // Full submission JSON minus card bytes — keeps the row lean and
        // avoids storing PHI bytes redundantly. The bridge call below uses
        // the original `body` (with bytes intact) so DrChrono still gets
        // the card images.
        rawPayload: sanitizeForPersistence(body),
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

  // ---- C.4 patientmail: best-effort staff notification -----------------
  // Fires ONLY after a successful bridge call (shouldNotify === status
  // 'success'); a failed / manual_review / errored bridge sends nothing.
  // notifyPatientSubmission never throws and is killswitched + audit-logged
  // without PHI, so this can never block or fail the (already-responded)
  // submission. The DrChrono Patient ID does not exist yet and is omitted.
  if (shouldNotify(outcome.status)) {
    const officeRaw = (body as Record<string, unknown>).officeLocation;
    await notifyPatientSubmission({
      submissionId,
      office: typeof officeRaw === "string" ? officeRaw : "",
      name: `${body.firstName} ${body.lastName}`.trim(),
      dob: body.dateOfBirth ?? "",
      phone: body.phone,
    });
  }
}

// Compose the JSONB column value. Always include the bridge's view; include
// responseBody when n8n returned one (even if null); always include the
// diagnostic on a failed outcome so the admin console + future debugging
// sees the actual reason instead of a bare `response: null`.
function outcomeForDb(outcome: N8nOutcome): Record<string, unknown> {
  const out: Record<string, unknown> = { bridge_status: outcome.status };
  if (outcome.errorMessage) out.error_message = outcome.errorMessage;
  if (outcome.responseBody !== undefined) out.response = outcome.responseBody;
  if (outcome.diagnostic) out.diagnostic = outcome.diagnostic;
  return out;
}

// Strip raw card bytes from the submission body before it's persisted to
// `raw_payload`. Filename / content-type / size are preserved so the admin
// detail view can show what was attached, but the actual bytes (PHI) only
// live in the n8n bridge call → DrChrono. Phase 4 will replace this with
// BAA-covered object storage and a stable key in raw_payload.
function sanitizeForPersistence(
  body: z.infer<typeof bodySchema>,
): z.infer<typeof bodySchema> {
  const stripCard = (
    card: z.infer<typeof fileRefSchema>,
  ): z.infer<typeof fileRefSchema> => {
    if (!card) return card;
    // Drop base64Data only; keep metadata.
    const { base64Data: _b, ...metadata } = card;
    void _b;
    return metadata;
  };
  return {
    ...body,
    insuranceCardFront: stripCard(body.insuranceCardFront),
    insuranceCardBack: stripCard(body.insuranceCardBack),
  };
}
