import type { VercelRequest, VercelResponse } from "@vercel/node";

const REQUIRED_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "stateResidence",
] as const;

type Body = Record<string, unknown> & {
  agency?: string;
  agencyOther?: string;
};

function isString(v: unknown): v is string {
  return typeof v === "string";
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res
      .status(405)
      .json({ success: false, error: "Method not allowed" });
  }

  const webhookUrl = process.env.ZAPIER_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("ZAPIER_WEBHOOK_URL env var is not set");
    return res
      .status(500)
      .json({ success: false, error: "Service is not configured" });
  }

  const body = (req.body ?? {}) as Body;
  if (typeof body !== "object" || body === null) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid request body" });
  }

  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const value = body[field];
    if (!isString(value) || value.trim() === "") {
      missing.push(field);
    }
  }

  const agencyValue =
    body.agency === "Other" ? body.agencyOther : body.agency;
  if (!isString(agencyValue) || agencyValue.trim() === "") {
    missing.push("federalAgency");
  }

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Missing required fields: ${missing.join(", ")}`,
    });
  }

  try {
    const zapResponse = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        federalAgency: agencyValue,
      }),
    });

    if (!zapResponse.ok) {
      const text = await zapResponse.text().catch(() => "");
      console.error(
        "Zapier webhook returned non-OK:",
        zapResponse.status,
        text,
      );
      return res
        .status(502)
        .json({ success: false, error: "Submission could not be delivered" });
    }

    let leadId: string | undefined;
    try {
      const data = (await zapResponse.json()) as {
        id?: string;
        leadId?: string;
      };
      leadId = data.leadId ?? data.id;
    } catch {
      // Zapier often returns plain text or empty body — that's fine
    }

    return res
      .status(200)
      .json({ success: true, ...(leadId ? { leadId } : {}) });
  } catch (err) {
    console.error("Form submission error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Submission failed" });
  }
}
