// POST /api/registration-partial — drop-off beacon for the REGISTRATION form.
//
// Public, authenticated-by-origin, fire-and-forget. The client upserts a partial
// once the visitor has passed the contact step; each later step advance updates
// furthest_step + updated_at only.
//
// PRIVACY (locked, server-enforced): the request is parsed against a CLOSED
// whitelist (zod strips every unknown key), and the row is built ONLY from those
// parsed fields. There is no raw_payload and no medical/insurance/step-answer
// column on the table, so a partial carrying a medical answer is impossible by
// construction — not by client politeness.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, registrationPartials, sql } from "@workspace/db";
import { z } from "zod";
import { extractAttribution } from "./_lib/attribution";
import { originAllowed, purgeExpiredPartials } from "./_lib/partials";

// CLOSED whitelist. zod strips unknown keys on parse, so anything not named here
// (e.g. a medical answer) never survives parsing, let alone reaches the DB.
export const partialSchema = z.object({
  partialId: z.string().min(8).max(64),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  email: z.string().max(160).optional(),
  phone: z.string().max(40).optional(),
  officeLocation: z.string().max(120).optional(),
  furthestStep: z.number().int().min(0).max(50).optional(),
  furthestStepLabel: z.string().max(120).optional(),
  // Attribution is read via extractAttribution below; declared so it's not
  // stripped before we can read it. Its inner shape is itself whitelisted there.
  attribution: z.record(z.string(), z.unknown()).optional(),
});

export type PartialInput = z.infer<typeof partialSchema>;

const str = (v: string | undefined | null) => {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, 160);
  return t === "" ? null : t;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!originAllowed(req.headers.origin)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parsed = partialSchema.safeParse(req.body);
  if (!parsed.success) {
    // Never blocks the wizard (fire-and-forget); just decline to store.
    return res.status(400).json({ error: "Invalid partial" });
  }
  const p = parsed.data;
  const attr = extractAttribution(p); // reads p.attribution — whitelisted subset
  const step = typeof p.furthestStep === "number" ? p.furthestStep : null;

  try {
    await db
      .insert(registrationPartials)
      .values({
        partialId: p.partialId,
        firstName: str(p.firstName),
        lastName: str(p.lastName),
        email: str(p.email),
        phone: str(p.phone),
        officeLocation: str(p.officeLocation),
        furthestStep: step,
        furthestStepLabel: str(p.furthestStepLabel),
        source: attr.source,
        utmSource: attr.utmSource,
        utmMedium: attr.utmMedium,
        utmCampaign: attr.utmCampaign,
        utmTerm: attr.utmTerm,
        utmContent: attr.utmContent,
        clickId: attr.clickId,
        clickIdType: attr.clickIdType,
      })
      .onConflictDoUpdate({
        target: registrationPartials.partialId,
        set: {
          // Contact can change if the visitor edits it later.
          firstName: str(p.firstName),
          lastName: str(p.lastName),
          email: str(p.email),
          phone: str(p.phone),
          officeLocation: str(p.officeLocation),
          // Furthest step never decreases.
          furthestStep: sql`greatest(${registrationPartials.furthestStep}, ${step})`,
          furthestStepLabel: str(p.furthestStepLabel),
          updatedAt: sql`now()`,
        },
      });
  } catch (err) {
    // Losing a drop-off record is acceptable; never surface to the visitor.
    console.error(
      "registration-partial: upsert failed",
      err instanceof Error ? err.name : "UnknownError",
    );
    return res.status(204).end();
  }

  void purgeExpiredPartials(); // lazy retention on writes
  return res.status(204).end();
}
