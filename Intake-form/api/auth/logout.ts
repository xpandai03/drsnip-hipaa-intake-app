import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  destroySession,
} from "../_lib/auth";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Idempotent: if there's no cookie / no session row, still respond 200.
  // The client just wants to know the cookie has been cleared.
  const cookieHeader = req.headers.cookie ?? "";
  const sessionId = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);

  if (sessionId) {
    await destroySession(decodeURIComponent(sessionId));
  }
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}
