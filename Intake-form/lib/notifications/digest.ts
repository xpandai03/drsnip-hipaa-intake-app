// Train 3 — the sweep digest, rendered.
//
// PURE and exported so the no-PHI guarantee is unit-asserted rather than
// assumed: the renderer is handed counts and submission IDs and has no access
// to a name, DOB, phone or email. Anything that would need one is structurally
// absent from DigestData.
//
// The digest REPORTS. It never acts. Retrying a stuck row is explicitly out of
// scope — the n8n webhook is not idempotent and a replay can duplicate a chart
// (FINDINGS-submission-health.md §6 row 2). A human decides.

/** One stuck row: a bridge result that never came back. IDs only. */
export interface StuckRow {
  id: string;
  formType: string;
  /** Whole minutes since the submission landed. */
  ageMinutes: number;
}

/** A failed bridge call in the window, grouped by the stored error text. */
export interface FailedGroup {
  errorMessage: string;
  count: number;
  ids: string[];
}

export interface DigestData {
  generatedAt: Date;
  consoleBaseUrl: string;
  stuck: StuckRow[];
  failed24h: FailedGroup[];
  manualReview: {
    open: number;
    oldestDays: number | null;
    added24h: number;
  };
  /** Ledger rows in the window whose outcome was not "sent". */
  notificationProblems24h: Array<{
    channel: string;
    outcome: string;
    detail: string | null;
    count: number;
  }>;
}

export interface RenderedDigest {
  subject: string;
  body: string;
  /** True when every section is empty — the "all quiet" case. */
  quiet: boolean;
}

function link(base: string, id: string): string {
  return `${base.replace(/\/+$/, "")}/admin/submissions/${id}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function isQuiet(d: DigestData): boolean {
  return (
    d.stuck.length === 0 &&
    d.failed24h.length === 0 &&
    d.notificationProblems24h.length === 0
  );
}

/**
 * Render the digest. Counts, IDs and console links only.
 *
 * Manual-review backlog is reported as a count even when nothing else has
 * happened, because a backlog that only grows is the standing finding — but it
 * does not by itself make the digest "noisy", so `quiet` ignores it.
 */
export function renderDigest(d: DigestData): RenderedDigest {
  const quiet = isQuiet(d);
  const lines: string[] = [];

  lines.push(
    `DrSnip intake — hourly sweep, ${d.generatedAt.toISOString()}`,
    "",
  );

  // --- stuck ---------------------------------------------------------------
  if (d.stuck.length === 0) {
    lines.push("Stuck (no bridge result recorded): 0");
  } else {
    lines.push(
      `Stuck (no bridge result recorded): ${d.stuck.length}`,
      "  These rows show as 'stuck' in the console. n8n may well have done the",
      "  work — check the execution before assuming the patient was missed.",
      "  Do NOT resubmit: the bridge is not idempotent and can duplicate a chart.",
    );
    for (const s of d.stuck) {
      lines.push(
        `  - ${s.id} (${s.formType}, ${s.ageMinutes} min) ${link(d.consoleBaseUrl, s.id)}`,
      );
    }
  }
  lines.push("");

  // --- failed --------------------------------------------------------------
  const failedTotal = d.failed24h.reduce((a, g) => a + g.count, 0);
  lines.push(`Failed in the last 24h: ${failedTotal}`);
  for (const g of d.failed24h) {
    lines.push(`  - ${g.count} x "${g.errorMessage}"`);
    for (const id of g.ids) {
      lines.push(`      ${id} ${link(d.consoleBaseUrl, id)}`);
    }
  }
  lines.push("");

  // --- manual review -------------------------------------------------------
  const mr = d.manualReview;
  lines.push(
    `Manual review: ${mr.open} open` +
      (mr.oldestDays === null
        ? ""
        : `, oldest ${mr.oldestDays} ${plural(mr.oldestDays, "day", "days")}`) +
      `, +${mr.added24h} in 24h`,
  );
  lines.push("");

  // --- notification problems ----------------------------------------------
  if (d.notificationProblems24h.length === 0) {
    lines.push("Notification skips/errors in the last 24h: 0");
  } else {
    lines.push("Notification skips/errors in the last 24h:");
    for (const p of d.notificationProblems24h) {
      lines.push(
        `  - ${p.count} x ${p.channel} ${p.outcome}${p.detail ? ` (${p.detail})` : ""}`,
      );
    }
  }

  lines.push(
    "",
    "This sweep reports only; it never retries, replays, or contacts anyone.",
  );

  return {
    subject: quiet
      ? "DrSnip intake sweep — all clear"
      : `DrSnip intake sweep — ${d.stuck.length} stuck, ${failedTotal} failed 24h`,
    body: lines.join("\n") + "\n",
    quiet,
  };
}
