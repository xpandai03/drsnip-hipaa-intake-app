// Phase 4 C.4 — patientmail: a staff notification email fired AFTER a
// successful n8n bridge call (see api/submit.ts). It mirrors what JotForm does
// today: it tells DrSnip staff a new intake arrived so they can locate the
// patient in DrChrono.
//
// Architecture (fixed): the send lives in the APP, not in n8n — so it stays
// debuggable and killswitchable here. The DrChrono Patient ID is created
// downstream in n8n and is NOT available at this point, so it is intentionally
// omitted; a Patient-ID version is deferred to a future n8n block.
//
// The email carries EXACTLY four labelled fields — Office, Name, DOB, Phone —
// and nothing else (no medical/insurance data, no card images, no full
// submission dump, no Patient ID).
//
// HIPAA: those four fields are PHI leaving the system. Therefore this module is
//   - env-gated (PATIENTMAIL_ENABLED killswitch + PATIENTMAIL_TO recipient),
//   - best-effort: it NEVER throws and a failure never blocks the submission,
//   - audit-logged with IDs + recipient only — the Name/DOB/Phone VALUES are
//     never written to a log line.

export interface PatientNotification {
  submissionId: string;
  office: string;
  name: string;
  dob: string;
  phone: string;
}

export interface MailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
}

/** Transport seam — injectable so dev/tests stub it with no real send. The
 *  default implementation is SMTP via nodemailer (see smtpTransport). */
export type MailTransport = (msg: MailMessage) => Promise<void>;

interface PatientmailConfig {
  enabled: boolean;
  to: string;
  from: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
}

function readConfig(): PatientmailConfig {
  return {
    enabled: process.env.PATIENTMAIL_ENABLED === "true",
    to: process.env.PATIENTMAIL_TO ?? "",
    from: process.env.PATIENTMAIL_FROM ?? "",
    smtp: {
      host: process.env.PATIENTMAIL_SMTP_HOST ?? "",
      port: Number(process.env.PATIENTMAIL_SMTP_PORT ?? "587"),
      secure: process.env.PATIENTMAIL_SMTP_SECURE === "true",
      user: process.env.PATIENTMAIL_SMTP_USER ?? "",
      pass: process.env.PATIENTMAIL_SMTP_PASS ?? "",
    },
  };
}

/** Killswitch — true only when PATIENTMAIL_ENABLED is exactly "true". */
export function patientmailEnabled(): boolean {
  return process.env.PATIENTMAIL_ENABLED === "true";
}

/**
 * The bridge outcomes that warrant a notification. ONLY a clean "success"
 * sends — a `failed` or `manual_review` bridge call sends nothing. Kept as a
 * pure predicate so the submission handler's gating is unit-testable.
 */
export function shouldNotify(bridgeStatus: string): boolean {
  return bridgeStatus === "success";
}

const EMPTY = "—";
function field(v: string): string {
  return v && v.trim() ? v.trim() : EMPTY;
}

/** Build the four-line body. EXACTLY Office / Name / DOB / Phone. */
export function buildMessage(
  cfg: Pick<PatientmailConfig, "to" | "from">,
  n: PatientNotification,
): MailMessage {
  const text =
    [
      `Office: ${field(n.office)}`,
      `Name: ${field(n.name)}`,
      `DOB: ${field(n.dob)}`,
      `Phone: ${field(n.phone)}`,
    ].join("\n") + "\n";
  return {
    to: cfg.to,
    from: cfg.from,
    subject: "New DrSnip intake submission",
    text,
  };
}

// One structured audit line. HIPAA: only IDs + the staff recipient address are
// ever logged here — never the Office/Name/DOB/Phone field values.
function audit(event: string, fields: Record<string, unknown>): void {
  console.log(
    `[patientmail] ${event} ` +
      JSON.stringify({ ts: new Date().toISOString(), ...fields }),
  );
}

/**
 * Best-effort staff notification. NEVER throws — returns true iff an email was
 * actually dispatched, false on any skip/failure. Gated by PATIENTMAIL_ENABLED
 * and PATIENTMAIL_TO; either missing → clean skip, no error.
 *
 * `transport` is injectable for tests; when omitted, the default SMTP
 * transport (nodemailer, lazily imported) is used.
 */
export async function notifyPatientSubmission(
  n: PatientNotification,
  transport?: MailTransport,
): Promise<boolean> {
  try {
    const cfg = readConfig();
    if (!cfg.enabled) {
      audit("skipped", { submission_id: n.submissionId, reason: "disabled" });
      return false;
    }
    if (!cfg.to) {
      audit("skipped", {
        submission_id: n.submissionId,
        reason: "no_recipient",
      });
      return false;
    }

    const send = transport ?? smtpTransport(cfg);
    await send(buildMessage(cfg, n));

    // Audit on success — recipient + submission id only, no PHI values.
    audit("sent", { submission_id: n.submissionId, recipient: cfg.to });
    return true;
  } catch (err) {
    // Best-effort: swallow + log the error TYPE only (no PHI, no message body).
    audit("error", {
      submission_id: n.submissionId,
      error: err instanceof Error ? err.name : "UnknownError",
    });
    return false;
  }
}

/** Default transport: SMTP via nodemailer, all config from env. nodemailer is
 *  imported lazily so the module loads (and tests run with an injected stub)
 *  without requiring the dependency on every code path. */
function smtpTransport(cfg: PatientmailConfig): MailTransport {
  return async (msg) => {
    const nodemailer = await import("nodemailer");
    const tx = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      auth: cfg.smtp.user
        ? { user: cfg.smtp.user, pass: cfg.smtp.pass }
        : undefined,
    });
    await tx.sendMail({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
  };
}
