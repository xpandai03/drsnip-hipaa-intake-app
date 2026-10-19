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
  /** Hourly appointment-sync health. Absent when the sweep could not read it. */
  syncZero?: SyncZeroStatus;
}

/**
 * Train 4. The hourly incremental appointment sync returned 0 appointments on
 * ~690 consecutive runs (2026-09-20 → 2026-10-19) while logging success, and
 * nothing noticed. A single empty hour is normal; a run of them is the signal.
 */
export const SYNC_ZERO_THRESHOLD = 6;

export interface SyncZeroStatus {
  /** Consecutive most-recent successful incremental runs that saw 0 appointments. */
  zeroStreak: number;
  /** When the current streak began (its earliest run), or null when there is none. */
  streakSince: Date | null;
  /** Appointments seen by the latest successful incremental run, or null if none. */
  lastSeen: number | null;
}

/** Pure: is the zero streak long enough to alarm? */
export function syncZeroAlarming(s: SyncZeroStatus | undefined): boolean {
  return !!s && s.zeroStreak >= SYNC_ZERO_THRESHOLD;
}

/**
 * Pure: should the sweep write a `sync_zero` ledger row now? Once per streak —
 * `alreadyRecordedForStreak` is true when a sync_zero row exists at or after
 * the streak's first run.
 */
export function shouldRecordSyncZero(
  s: SyncZeroStatus | undefined,
  alreadyRecordedForStreak: boolean,
): boolean {
  return syncZeroAlarming(s) && !alreadyRecordedForStreak;
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
    d.notificationProblems24h.length === 0 &&
    !syncZeroAlarming(d.syncZero)
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

  // --- appointment sync -----------------------------------------------------
  if (d.syncZero) {
    lines.push("");
    const z = d.syncZero;
    if (syncZeroAlarming(z)) {
      lines.push(
        `Appointment sync: ALERT, ${z.zeroStreak} consecutive hourly runs saw 0 appointments` +
          (z.streakSince ? ` (since ${z.streakSince.toISOString()})` : ""),
        "  Outcome and journey figures stop moving until this clears. Check the",
        "  `since` window the hourly workflow sends (jUNJrRWhZkogFhpX).",
      );
    } else {
      lines.push(
        `Appointment sync: ok, ${z.zeroStreak} empty ${plural(z.zeroStreak, "run", "runs")} in a row` +
          (z.lastSeen === null ? "" : `, latest run saw ${z.lastSeen}`),
      );
    }
  }

  lines.push(
    "",
    "This sweep reports only; it never retries, replays, or contacts anyone.",
  );

  return {
    subject: quiet
      ? "DrSnip intake sweep: all clear"
      : `DrSnip intake sweep: ${d.stuck.length} stuck, ${failedTotal} failed 24h`,
    body: lines.join("\n") + "\n",
    quiet,
  };
}
