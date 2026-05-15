// GET / POST /api/admin/marketing-sources
//
// GET — list marketing sources. Returns active rows by default; pass
//       `?all=1` to include soft-deleted (inactive) rows.
// POST — create a new source. Body shape:
//        { source_key, display_name, lead_source, default_medium? }
//
// Auth-guarded (same pattern as /api/submissions/* and /api/settings/[key]).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  db,
  desc,
  eq,
  marketingSources,
} from "@workspace/db";
import { z } from "zod";
import { requireAuth } from "../_lib/auth";

const createBodySchema = z.object({
  source_key: z
    .string()
    .min(1)
    .max(100)
    // Lowercase letters, digits, and dash. Same constraint marketing tools
    // (Google Analytics, Facebook Ads) accept for utm_source — avoids
    // surprises when this key flows through ad-platform URL builders.
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and dashes only"),
  display_name: z.string().min(1).max(120),
  lead_source: z.string().min(1).max(120),
  default_medium: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
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

  if (req.method === "GET") {
    const includeInactive = firstOf(req.query.all) === "1";
    const query = db
      .select()
      .from(marketingSources)
      .orderBy(desc(marketingSources.isActive), marketingSources.displayName);
    const rows = includeInactive
      ? await query
      : await query.where(eq(marketingSources.isActive, true));
    return res.status(200).json({ sources: rows });
  }

  if (req.method === "POST") {
    const parsed = createBodySchema.safeParse(req.body);
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
    try {
      const [row] = await db
        .insert(marketingSources)
        .values({
          sourceKey: body.source_key,
          displayName: body.display_name,
          leadSource: body.lead_source,
          defaultMedium: body.default_medium,
        })
        .returning();
      return res.status(201).json({ source: row });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Postgres unique-violation surfaces as 23505 in the driver error.
      if (message.includes("duplicate key") || message.includes("23505")) {
        return res.status(409).json({
          error: "source_key already exists",
          source_key: body.source_key,
        });
      }
      console.error("marketing-sources POST failed", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
