// GET / PUT /api/settings/[key] — generic single-setting accessor.
//
// Auth-guarded. On PUT, captures the old + new values into settings_audit
// with the actor's email from the session cookie. Generic by design: any
// key (currently only "hold_a7_for_review" in active use). Value can be
// any JSON — caller is responsible for type discipline.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, eq, settings, settingsAudit } from "@workspace/db";
import { requireAuth } from "../_lib/auth";

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

  const key = firstOf(req.query.key);
  if (!key || key.length === 0 || key.length > 100) {
    return res.status(400).json({ error: "Invalid setting key" });
  }

  if (req.method === "GET") {
    const rows = await db
      .select({
        key: settings.key,
        value: settings.value,
        updatedAt: settings.updatedAt,
        updatedBy: settings.updatedBy,
      })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: "Setting not found", key });
    }
    return res.status(200).json(row);
  }

  if (req.method === "PUT") {
    const body = req.body as { value?: unknown; note?: unknown };
    if (body == null || typeof body !== "object" || !("value" in body)) {
      return res.status(400).json({ error: "Body must include `value`" });
    }
    const newValue = body.value;
    const note =
      typeof body.note === "string" && body.note.length > 0
        ? body.note.slice(0, 1000)
        : null;

    const existing = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    const oldValue = existing[0]?.value ?? null;
    const now = new Date();

    // Upsert the setting row.
    await db
      .insert(settings)
      .values({
        key,
        value: newValue as unknown as object,
        updatedAt: now,
        updatedBy: auth.user.email,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: newValue as unknown as object,
          updatedAt: now,
          updatedBy: auth.user.email,
        },
      });

    // Audit row — fire-and-forget shape, but await so a failure surfaces to
    // the admin instead of silently skipping the audit trail.
    await db.insert(settingsAudit).values({
      key,
      oldValue: oldValue as unknown as object,
      newValue: newValue as unknown as object,
      actorEmail: auth.user.email,
      note,
    });

    return res.status(200).json({
      key,
      value: newValue,
      updatedAt: now,
      updatedBy: auth.user.email,
    });
  }

  res.setHeader("Allow", "GET, PUT");
  return res.status(405).json({ error: "Method not allowed" });
}
