import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import {
  findActiveUserByEmail,
  hashPassword,
  invalidateOtherUserSessions,
  requireAuth,
  setUserPasswordHash,
  verifyPassword,
} from "../_lib/auth";
import { validatePassword } from "../_lib/password";

// ---------------------------------------------------------------------------
// POST /api/auth/change-password — Phase 5 Block 1, authenticated self-change.
//
// Any logged-in user can change their own password. Requires the CURRENT
// password (so a stolen-but-idle session can't silently rotate credentials
// without knowing the password). On success: new hash stored, the
// must_reset_password flag cleared (this is how a user completes the
// admin-issued temp-password flow), and every OTHER session for the user is
// invalidated — the current session stays alive so the user isn't bounced.
//
// HIPAA: never log either password.
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
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

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { currentPassword, newPassword } = parsed.data;

  // Re-fetch to get the password hash (not carried on the session).
  const user = await findActiveUserByEmail(auth.user.email);
  if (!user) {
    // Session resolved but the user is gone/inactive — treat as unauthorized.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const currentOk = await verifyPassword(currentPassword, user.passwordHash);
  if (!currentOk) {
    res.status(400).json({ error: "Current password is incorrect" });
    return;
  }

  const policy = validatePassword(newPassword);
  if (!policy.ok) {
    res.status(400).json({ error: policy.error });
    return;
  }

  if (newPassword === currentPassword) {
    res.status(400).json({ error: "New password must be different" });
    return;
  }

  const passwordHash = await hashPassword(newPassword);
  await setUserPasswordHash(user.id, passwordHash, false);
  const killed = await invalidateOtherUserSessions(user.id, auth.session.id);

  console.log(
    `[change-password] ${JSON.stringify({
      ts: new Date().toISOString(),
      user_id: user.id,
      other_sessions_invalidated: killed,
      event: "password_changed",
    })}`,
  );

  res.status(200).json({ ok: true });
}
