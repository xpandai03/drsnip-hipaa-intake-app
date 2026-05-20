// GET / POST /api/admin/links — DrSnip patient-form link generator history.
//
// GET  — the 10 most recent generated links.
// POST — record a generated link. Body:
//        { formType, campaign?, notes?, generatedUrl }
//
// Auth-guarded (same pattern as /api/admin/marketing-sources).
//
// HIPAA: logs error types only — link records carry no patient data.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, desc, linkGenerations } from "@workspace/db";
import { z } from "zod";
import { requireAuth } from "../_lib/auth";

const createBodySchema = z.object({
  formType: z.enum(["registration", "consultation"]),
  campaign: z.string().max(200).optional().default(""),
  notes: z.string().max(1000).optional().default(""),
  generatedUrl: z.string().min(1).max(2000),
});

const RECENT_COLUMNS = {
  id: linkGenerations.id,
  createdAt: linkGenerations.createdAt,
  formType: linkGenerations.formType,
  campaign: linkGenerations.campaign,
  notes: linkGenerations.notes,
  generatedUrl: linkGenerations.generatedUrl,
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (req.method === "GET") {
    const rows = await db
      .select(RECENT_COLUMNS)
      .from(linkGenerations)
      .orderBy(desc(linkGenerations.createdAt))
      .limit(10);
    return res.status(200).json({ links: rows });
  }

  if (req.method === "POST") {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid body" });
    }
    const body = parsed.data;
    const campaign = body.campaign.trim();
    const notes = body.notes.trim();
    try {
      const [row] = await db
        .insert(linkGenerations)
        .values({
          createdBy: auth.user.email,
          // `source` is NOT NULL — fall back to "direct" when no campaign.
          source: campaign || "direct",
          campaign: campaign || null,
          formType: body.formType,
          notes: notes || null,
          generatedUrl: body.generatedUrl,
        })
        .returning(RECENT_COLUMNS);
      return res.status(201).json({ link: row });
    } catch (err) {
      console.error(
        "links POST failed",
        err instanceof Error ? err.name : "UnknownError",
      );
      return res.status(500).json({ error: "Internal error" });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
