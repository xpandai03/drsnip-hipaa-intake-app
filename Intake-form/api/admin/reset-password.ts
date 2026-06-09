import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import {
  findActiveUserByEmail,
  hashPassword,
  invalidateAllUserSessions,
  requireAdmin,
  setUserPasswordHash,
} from "../_lib/auth";
import { generateTempPassword } from "../_lib/password";

// ---------------------------------------------------------------------------
// POST /api/admin/reset-password — Phase 5 Block 1, admin-initiated reset.
//
// Admin-only (requireAdmin). The admin supplies a target email; the server
// generates a strong one-time temporary password, stores its hash, sets
// must_reset_password = true (forcing a change on next login), and invalidates
// every existing session for that user. The plaintext temp password is
// returned to the ADMIN exactly once so they can convey it out-of-band
// (phone/in-person). It is never logged or persisted in plaintext.
//
// No email is sent — this path is intentionally email-free (Phase 2 adds the
// self-service emailed flow). HIPAA: audit line carries IDs only, never the
// password or the response body.
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  email: z.string().email().max(254),
});

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Admin gate first — viewer → 403, unauth → 401, before any DB work.
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const target = await findActiveUserByEmail(parsed.data.email);
  if (!target) {
    // This endpoint is admin-only (not a public surface), so telling a trusted
    // admin "no such active user" is useful and not an enumeration risk.
    res.status(404).json({ error: "No active user with that email" });
    return;
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  await setUserPasswordHash(target.id, passwordHash, true);
  const killed = await invalidateAllUserSessions(target.id);

  // Audit: IDs + counts only. Never the temp password.
  console.log(
    `[admin-reset] ${JSON.stringify({
      ts: new Date().toISOString(),
      actor_user_id: auth.user.id,
      target_user_id: target.id,
      sessions_invalidated: killed,
      event: "password_reset_issued",
    })}`,
  );

  // The temp password is returned ONCE, to the admin, for out-of-band delivery.
  res.status(200).json({
    email: target.email,
    tempPassword,
    mustResetPassword: true,
  });
}
