// PATCH / DELETE /api/admin/marketing-sources/[id]
//
// PATCH — update a row's display_name, lead_source, default_medium, or
//         is_active flag. source_key is NOT editable (it's the stable
//         attribution key — changing it would orphan all live URLs).
// DELETE — soft-delete via is_active = false. Hard delete is intentionally
//          unavailable: a printed flyer with ?source=<key> can hit the
//          form years later and we still want the LeadSource attribution
//          to resolve.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  db,
  eq,
  marketingSources,
} from "@workspace/db";
import { z } from "zod";
import { requireAuth } from "../../_lib/auth";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const patchBodySchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  lead_source: z.string().min(1).max(120).optional(),
  default_medium: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v && v.length > 0 ? v : null)),
  is_active: z.boolean().optional(),
});

function firstOf(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0] as string | undefined;
  if (typeof value === "string") return value;
  return undefined;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = firstOf(req.query.id);
  if (!id || !UUID_PATTERN.test(id)) {
    return res.status(400).json({ error: "Invalid source id" });
  }

  if (req.method === "PATCH") {
    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const body = parsed.data;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.display_name !== undefined) updates.displayName = body.display_name;
    if (body.lead_source !== undefined) updates.leadSource = body.lead_source;
    if (body.default_medium !== undefined) updates.defaultMedium = body.default_medium;
    if (body.is_active !== undefined) updates.isActive = body.is_active;
    // Defensive: if the caller only sent unknown keys, we'd otherwise
    // bump updatedAt for no reason. Bail out with 400.
    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: "No updatable fields supplied" });
    }
    const [row] = await db
      .update(marketingSources)
      .set(updates)
      .where(eq(marketingSources.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Source not found" });
    return res.status(200).json({ source: row });
  }

  if (req.method === "DELETE") {
    const [row] = await db
      .update(marketingSources)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(marketingSources.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Source not found" });
    return res.status(200).json({ source: row });
  }

  res.setHeader("Allow", "PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
