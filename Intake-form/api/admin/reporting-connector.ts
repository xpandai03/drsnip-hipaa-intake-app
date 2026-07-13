// GET /api/admin/reporting-connector — connection details for the DrSnip
// reporting MCP, surfaced by the admin console "Ask AI" page.
//
// ADMIN ONLY (requireAdmin): viewers get 403, so the OAuth login password and
// bearer token are NEVER sent to a read-only console user (front desk /
// patientmail). The connector URL itself is public and non-secret.
//
// The secrets are read from env (Fly secrets on drsnip-intake-demo) and are
// never hardcoded in the client bundle:
//   REPORTING_MCP_OAUTH_PASSWORD, REPORTING_MCP_BEARER, REPORTING_MCP_URL(opt)
//
// HIPAA: this returns connector credentials only — no patient data. The
// reporting MCP it points at is itself aggregate-only and PHI-free.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin } from "../_lib/auth";

const DEFAULT_URL = "https://drsnip-reporting-mcp.fly.dev/mcp";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Admin-only — viewers get 403, unauthenticated get 401. The UI also gates
  // on role, but this server check is the real boundary.
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const url = process.env.REPORTING_MCP_URL || DEFAULT_URL;
  const oauthLoginPassword = process.env.REPORTING_MCP_OAUTH_PASSWORD || null;
  const bearerToken = process.env.REPORTING_MCP_BEARER || null;

  return res.status(200).json({
    url,
    oauthLoginPassword,
    bearerToken,
    configured: Boolean(oauthLoginPassword && bearerToken),
  });
}
