// The freshness badge, and the one hook every reporting page uses to get it.
//
// THE BUG THIS REPLACES. The journeys page read its freshness off the side of a
// six-second metric call, so for six seconds it rendered
//
//     "Appointment snapshot — last refreshed unknown"
//
// "unknown" was not true: nothing was known yet because nothing had been asked.
// A reader could not tell that apart from a genuinely missing timestamp, which
// is the state that means someone has to go and look at the sync.
//
// FIVE STATES, NEVER COLLAPSED INTO ONE:
//
//   checking   the request is in flight. Not "unknown".
//   updating   we have a timestamp and are refreshing it. Shows the old one.
//   unavailable the request FAILED. Says so, and offers Retry. The last value
//               we did see is kept and marked stale — never replaced by a zero
//               or by "unknown".
//   never      the request succeeded and there is genuinely no sync yet.
//   ok         a timestamp, plus how it is being kept current.
//
// `ok` further carries live / late / paused / manual from the server, which
// decides from evidence: a schedule that is switched on but has not succeeded
// inside its cadence reads "late", never "live".

import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertTriangle, RefreshCw, Clock, CheckCircle2, PauseCircle } from "lucide-react";

export type FreshnessResponse = {
  as_of: string;
  intake: { latest_submission_at: string | null; note: string };
  appointments: {
    complete_as_of: string | null;
    state: "live" | "late" | "paused" | "manual" | "never";
    update_mode: "manual" | "scheduled";
    linked_patients: number | null;
    history_complete_patients: number | null;
    awaiting_catchup: number | null;
  };
  sync: {
    schedule_enabled: boolean;
    run_state: string;
    last_attempt_at: string | null;
    last_success_at: string | null;
    cursor_lag_seconds: number | null;
    expected_interval_minutes: number | null;
    failed_runs_24h: number | null;
    schedules: Array<{
      key: string; scope: string; enabled: boolean; cadence: string;
      expected_interval_minutes: number;
      last_attempt_at: string | null; last_success_at: string | null;
      last_outcome: string | null; run_state: string;
      cursor_lag_seconds: number | null;
      failed_runs_24h: number; partial_runs_24h: number;
      recurring_active: boolean;
    }>;
  };
};

export function clinicTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Shared across every reporting page.
 *
 * `staleTime` is short and `refetchInterval` is a minute: this is the one call
 * on the page whose whole job is to be current, and it costs a few milliseconds
 * (drsnip_journey_freshness() alone, not a metric).
 *
 * It is deliberately NOT retried forever. Two attempts, then the badge says the
 * check failed and offers the reader the retry. An indefinite spinner is a way
 * of never admitting something is broken.
 */
export function useFreshness() {
  return useQuery<FreshnessResponse>({
    queryKey: ["reports-freshness"],
    queryFn: async () => {
      const res = await fetch("/api/reports/freshness", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`freshness returned ${res.status}`);
      return (await res.json()) as FreshnessResponse;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
    placeholderData: (prev) => prev,
  });
}

const TONE = {
  neutral: "border-[var(--sh-border)] bg-[var(--sh-surface)] text-[var(--sh-muted)]",
  good: "border-emerald-600/30 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  warn: "border-amber-600/30 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  bad: "border-rose-600/30 bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
} as const;

function Badge({
  tone, icon: Icon, children, spin, testId,
}: {
  tone: keyof typeof TONE; icon: typeof Clock; children: React.ReactNode;
  spin?: boolean; testId: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}
    >
      <Icon className={`h-3 w-3 shrink-0 ${spin ? "animate-spin" : ""}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * How current the appointment data is, in one badge.
 *
 * The value shown is `complete_as_of` — the instant appointment data is
 * COMPLETE to, which is the sync cursor once recurring sync is running. It is
 * not the moment of the last request: a run that read only part of its window
 * does not advance the cursor, so the badge stays honest about coverage rather
 * than reporting activity.
 */
export function AppointmentFreshnessBadge({
  query,
}: {
  query: ReturnType<typeof useFreshness>;
}) {
  const { data, isPending, isError, isFetching, refetch } = query;

  // In flight, nothing to show yet. NOT "unknown".
  if (isPending && !data) {
    return (
      <Badge tone="neutral" icon={Loader2} spin testId="freshness-checking">
        Appointment data — checking how current it is…
      </Badge>
    );
  }

  // The request failed. Keep whatever we last saw, say it is stale, offer retry.
  if (isError) {
    const last = clinicTime(data?.appointments.complete_as_of);
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge tone="bad" icon={AlertTriangle} testId="freshness-unavailable">
          {last
            ? `Appointment data — freshness check failed; last known ${last} (may be stale)`
            : "Appointment data — freshness check failed"}
        </Badge>
        <button
          type="button"
          onClick={() => refetch()}
          data-testid="freshness-retry"
          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium hover:bg-[var(--sh-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
        </button>
      </span>
    );
  }

  const a = data!.appointments;
  const when = clinicTime(a.complete_as_of);

  if (a.state === "never" || !when) {
    return (
      <Badge tone="warn" icon={AlertTriangle} testId="freshness-never">
        Appointment data — no sync has completed yet
      </Badge>
    );
  }

  const suffix = isFetching ? " · updating" : "";

  if (a.state === "live") {
    return (
      <Badge tone="good" icon={CheckCircle2} testId="freshness-live">
        Appointment data complete to {when} · updates hourly{suffix}
      </Badge>
    );
  }
  if (a.state === "late") {
    return (
      <Badge tone="warn" icon={Clock} testId="freshness-late">
        Appointment data complete to {when} · hourly sync is behind{suffix}
      </Badge>
    );
  }
  if (a.state === "paused") {
    return (
      <Badge tone="warn" icon={PauseCircle} testId="freshness-paused">
        Appointment data complete to {when} · scheduled sync is switched off{suffix}
      </Badge>
    );
  }
  return (
    <Badge tone="warn" icon={Clock} testId="freshness-manual">
      Appointment data complete to {when} · refreshed by hand{suffix}
    </Badge>
  );
}

/** Intake is written by the live forms, so it needs only a timestamp. */
export function IntakeFreshnessBadge({ query }: { query: ReturnType<typeof useFreshness> }) {
  const { data, isPending, isError } = query;
  if (isPending && !data) {
    return (
      <Badge tone="neutral" icon={Loader2} spin testId="intake-freshness-checking">
        Intake — checking…
      </Badge>
    );
  }
  if (isError || !data?.intake.latest_submission_at) {
    return (
      <Badge tone="neutral" icon={Clock} testId="intake-freshness-unknown">
        Intake — live as forms arrive
      </Badge>
    );
  }
  return (
    <Badge tone="good" icon={CheckCircle2} testId="intake-freshness">
      Intake live · newest submission {clinicTime(data.intake.latest_submission_at)}
    </Badge>
  );
}
