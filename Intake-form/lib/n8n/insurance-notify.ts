// Insurance staff notification — a "doorbell" email to patientmail@drsnip.com
// when an insurance form arrives. The old JotForm emailed the team on every
// submission; the embedded insurance form skipped the n8n bridge entirely
// (Phase 1), so nobody was told. This restores the notification for insurance
// ONLY, reusing the PROVEN production mechanism: the app POSTs a PHI-light
// payload to a minimal n8n workflow whose Gmail node (existing "Gmail account"
// OAuth credential) sends the mail. No new email provider is introduced.
//
// Architecture mirror of lib/n8n/bridge.ts: same X-DrSnip-Token auth, same
// fire-and-forget/never-throw contract, same audit-without-PHI logging.
//
// HIPAA — the email is a DOORBELL, not the document. It carries EXACTLY:
//   patient name · "New insurance form submission" · submitted date/time (PT) ·
//   office · a deep link to the authed console detail.
// It NEVER carries carrier/policy/group/subscriber, DOB, card images, medical
// answers, or any submission dump. The PHI lives in the console, behind auth.
// buildInsuranceNotification is pure so this whitelist is unit-asserted.

export interface InsuranceNotifyInput {
  submissionId: string;
  name: string;
  office: string;
  /** Submission time (absolute). Rendered in Pacific for the email body. */
  submittedAt: Date;
}

export interface NotifyMessage {
  subject: string;
  body: string;
}

// The one prod origin the console is served from. Overridable via env for
// staging/preview. The fallback is the CANONICAL console host (intake.drsnip.com)
// — previously the raw Fly hostname, which produced correct-but-unbranded links
// whenever PUBLIC_APP_URL was unset (which it was, in production).
function consoleBaseUrl(): string {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  const base = raw && raw.length > 0 ? raw : "https://intake.drsnip.com";
  return base.replace(/\/+$/, "");
}

/** Render an absolute instant as "Aug 16, 2:14 PM PT" in America/Los_Angeles.
 *  Using Intl with an explicit timeZone makes the 11:58 PM PT edge date in
 *  Pacific, never UTC's tomorrow. */
export function formatPacific(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  // Intl renders "Aug 16, 2:14 PM"; append the zone label.
  return `${parts} PT`;
}

/**
 * Build the doorbell email. PURE + exported so the content whitelist is tested
 * directly. Input is deliberately narrow — name/office/time/id only — so the
 * builder is structurally incapable of leaking carrier/policy/DOB/medical data.
 */
export function buildInsuranceNotification(
  input: InsuranceNotifyInput,
  baseUrl: string = consoleBaseUrl(),
): NotifyMessage {
  const name = input.name.trim() || "A patient";
  const office = input.office.trim();
  const where = office ? ` (${office})` : "";
  const link = `${baseUrl.replace(/\/+$/, "")}/admin/submissions/${input.submissionId}`;
  // Train E: this is now the NON-SUCCESS fallback. It also fires in the known
  // race where n8n exceeds the app's 30s abort but later succeeds — in which
  // case the chart email arrives too and staff see two messages for one
  // submission. The copy therefore says "being processed", never "failed":
  // a duplicate that reads as an error would send staff chasing a problem that
  // does not exist. A duplicate beats a silent miss, but only if it reads right.
  return {
    subject: "New insurance form submission — DrSnip intake",
    body:
      `${name} submitted an insurance form on ${formatPacific(input.submittedAt)}${where}.\n\n` +
      `The submission is being processed. Open it in the console:\n${link}\n\n` +
      `If a DrChrono chart is created, a separate email with the chart link follows.`,
  };
}

/**
 * Train E — should the APP send the fallback doorbell?
 *
 * Exactly one email must reach staff per insurance submission, and never zero.
 * On a successful bridge call the Insurance v1 workflow has already sent the
 * chart-linked email, so the app must stay silent; on every other outcome
 * nothing has emailed yet and the app is the only sender left. Mirrors
 * shouldNotify() in lib/email/patientmail.ts. Pure, so the "exactly one"
 * property is asserted without a DB, an n8n instance, or a timer.
 */
export function shouldSendFallback(bridgeStatus: string): boolean {
  return bridgeStatus !== "success";
}

interface NotifyEnv {
  url: string;
  secret: string;
}

function readEnv(): NotifyEnv {
  return {
    url: process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL ?? "",
    secret: process.env.N8N_WEBHOOK_SECRET ?? "",
  };
}

function audit(event: string, fields: Record<string, unknown>): void {
  // One structured line. HIPAA: submission_id + recipient channel only, never
  // the name/office VALUES or the rendered body.
  console.log(
    `[insurance-notify] ${event} ` +
      JSON.stringify({ ts: new Date().toISOString(), ...fields }),
  );
}

/** Transport seam — injectable for tests. Default posts to the n8n webhook. */
export type NotifyTransport = (
  env: NotifyEnv,
  payload: { submissionId: string; subject: string; body: string },
) => Promise<void>;

const TIMEOUT_MS = 15_000;

function httpTransport(): NotifyTransport {
  return async (env, payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(env.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DrSnip-Token": env.secret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Best-effort insurance notification. NEVER throws — returns true iff the
 * webhook POST was dispatched, false on any skip/failure. A missing webhook URL
 * is a clean skip (deploy-before-secret is a no-op, not an error), so intake is
 * never blocked or delayed by notification wiring.
 */
export async function notifyInsuranceSubmission(
  input: InsuranceNotifyInput,
  transport?: NotifyTransport,
): Promise<boolean> {
  try {
    const env = readEnv();
    if (!env.url) {
      audit("skipped", { submission_id: input.submissionId, reason: "no_url" });
      return false;
    }
    const msg = buildInsuranceNotification(input);
    const send = transport ?? httpTransport();
    await send(env, {
      submissionId: input.submissionId,
      subject: msg.subject,
      body: msg.body,
    });
    audit("sent", { submission_id: input.submissionId, channel: "n8n_gmail" });
    return true;
  } catch (err) {
    audit("error", {
      submission_id: input.submissionId,
      error: err instanceof Error ? err.name : "UnknownError",
    });
    return false;
  }
}
