// Train 3 — the notification ledger writer.
//
// Every app-side send records exactly one row per ATTEMPT, including the ones
// that deliberately send nothing. The skip is the important case: `patientmail`
// has been skipping with `no_recipient` on every registration and consultation
// success since launch (PATIENTMAIL_TO is unset, by design — the real email
// comes from the n8n Gmail nodes), and nothing anywhere recorded that. After
// n8n's 14-day retention there was no way to answer "did anyone get told?".
//
// CONTRACT: `record()` never throws and never rethrows. A ledger failure must
// not break a send, and must not fail a request — the ledger is evidence, not
// a dependency. Callers therefore do not need to wrap it.
//
// PHI: the table has nowhere to put any. `recipientClass` is a role, not an
// address; `detail` is a short machine reason. `sanitizeDetail` is the last
// line of defence — it truncates and strips anything that looks like an email
// address or a long free-text blob, so a careless caller cannot leak a message
// body or a patient address into the ledger.

import { db, notificationEvents } from "@workspace/db";

/** Which sender produced the row. */
export type NotificationChannel =
  | "insurance_notify"
  | "fallback_doorbell"
  | "patientmail"
  | "digest";

/** Who the send was aimed at, as a ROLE. Never an address. */
export type RecipientClass = "staff" | "operator";

export type NotificationOutcome = "sent" | "skipped" | "error";

export interface NotificationRecord {
  submissionId?: string | null;
  channel: NotificationChannel;
  kind: string;
  recipientClass: RecipientClass;
  outcome: NotificationOutcome;
  detail?: string | null;
}

/** Hard cap on `detail`. Long enough for "HTTP 500" or an error name, short
 *  enough that a rendered email body cannot fit. */
const DETAIL_MAX = 120;

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

/**
 * Last-resort scrubber for `detail`. Pure + exported so the PHI guarantee is
 * unit-asserted rather than assumed: any email-shaped token is replaced, and
 * the result is truncated. Not a substitute for callers passing short reasons.
 */
export function sanitizeDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  const scrubbed = String(detail).replace(EMAIL_RE, "[redacted]").trim();
  if (scrubbed.length === 0) return null;
  return scrubbed.length <= DETAIL_MAX
    ? scrubbed
    : scrubbed.slice(0, DETAIL_MAX) + "…";
}

function audit(event: string, fields: Record<string, unknown>): void {
  console.log(
    `[ledger] ${event} ` + JSON.stringify({ ts: new Date().toISOString(), ...fields }),
  );
}

/**
 * Append one ledger row. NEVER throws. Returns true iff the row was written,
 * so a caller may assert in tests without having to handle a failure.
 */
export async function record(entry: NotificationRecord): Promise<boolean> {
  try {
    await db.insert(notificationEvents).values({
      submissionId: entry.submissionId ?? null,
      channel: entry.channel,
      kind: entry.kind,
      recipientClass: entry.recipientClass,
      outcome: entry.outcome,
      detail: sanitizeDetail(entry.detail),
    });
    return true;
  } catch (err) {
    // Swallow: evidence is worth less than the send it describes.
    audit("write_failed", {
      channel: entry.channel,
      kind: entry.kind,
      outcome: entry.outcome,
      error: err instanceof Error ? err.name : "UnknownError",
    });
    return false;
  }
}
