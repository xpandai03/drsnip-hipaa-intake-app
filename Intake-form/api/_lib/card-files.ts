// Persist uploaded card image bytes into submission_files (BAA-covered Postgres).
//
// Called AFTER the submission row commits and the response is sent, so it can
// NEVER block or fail intake — losing an image is acceptable; losing a patient
// is not. A rejected/oversize/undecodable file is recorded as a marker row
// (status set, no bytes) so the console can show an honest state.
//
// HIPAA: bytes are PHI. They are only ever written to the bytea column and
// served through the authed endpoint — never logged, never in JSON/raw_payload.

import { db, submissionFiles } from "@workspace/db";

export const MAX_BYTES = 10 * 1024 * 1024; // defense-in-depth; client caps at 5MB
export const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

// Mimes a browser <img> can render as a thumbnail. Others (heic/pdf) get a
// "view file" link instead of a broken image.
export const RENDERABLE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export type CardStatus = "stored" | "too_large" | "rejected" | "failed";

/**
 * Classify a decoded card file. Pure — the single source of truth for what
 * gets stored. Bytes are only kept for `stored`; every other status is a
 * marker row with no PHI bytes. Never throws.
 */
export function classifyCardBytes(
  buf: Buffer | null,
  mime: string | null,
): { status: CardStatus; keepBytes: boolean } {
  if (!buf || buf.length === 0) return { status: "failed", keepBytes: false };
  if (buf.length > MAX_BYTES) return { status: "too_large", keepBytes: false };
  if (!mime || !ALLOWED_MIME.has(mime.toLowerCase()))
    return { status: "rejected", keepBytes: false };
  return { status: "stored", keepBytes: true };
}

type CardRef = {
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
  base64Data?: unknown;
};

function refOf(v: unknown): CardRef | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as CardRef) : null;
}
function s(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

/** Store any card bytes present on the submit body. Never throws. */
export async function storeSubmissionFiles(
  submissionId: string,
  body: unknown,
): Promise<void> {
  const b = (body ?? {}) as Record<string, unknown>;
  const slots: { kind: string; ref: CardRef | null }[] = [
    { kind: "insurance_front", ref: refOf(b.insuranceCardFront) },
    { kind: "insurance_back", ref: refOf(b.insuranceCardBack) },
    { kind: "partner_front", ref: refOf(b.partnerInsuranceCardFront) },
    { kind: "partner_back", ref: refOf(b.partnerInsuranceCardBack) },
  ];

  for (const { kind, ref } of slots) {
    if (!ref) continue;
    const b64 = typeof ref.base64Data === "string" ? ref.base64Data : "";
    // No bytes → nothing to store (historical rows / no upload). Skip so we
    // don't create empty marker rows for cards that were never attached.
    if (b64 === "") continue;

    try {
      const filename = s(ref.filename, 255);
      const mime = s(ref.contentType, 120);
      let buf: Buffer | null = null;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        buf = null;
      }
      const size = buf ? buf.length : typeof ref.size === "number" ? ref.size : 0;

      const { status, keepBytes } = classifyCardBytes(buf, mime);
      const bytes: Buffer | null = keepBytes ? buf : null;

      await db.insert(submissionFiles).values({
        submissionId,
        kind,
        filename,
        mime,
        sizeBytes: size,
        status,
        bytes,
      });
    } catch (err) {
      // Never surface to the patient; intake already succeeded.
      console.error(
        "card-files: store failed",
        err instanceof Error ? err.name : "UnknownError",
      );
    }
  }
}
