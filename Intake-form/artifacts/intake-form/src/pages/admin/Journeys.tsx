// Patient journeys — REAL intake data.
//
// Two separate journeys, each on its own tab, because they are different
// cohorts that overlap and must never be summed:
//
//   Registration journey      registration -> consultation form -> appointment evidence
//   Insurance inquiry journey inquiry -> registration -> appointment evidence
//
// THREE THINGS THIS PAGE IS BUILT TO PREVENT
//
// 1. An observed-to-date number being read as a fixed-window rate. Both modes
//    are shown SIDE BY SIDE, always, so neither can be mistaken for the other.
//    That confusion is exactly how "37.3%" got relabelled as a 14-day rate.
//
// 2. Overlapping measures drawn as a descending funnel. The waterfall is used
//    ONLY where each stage is a genuine subset of the one above it. Appointment
//    evidence is a set of OVERLAPPING categories — a patient can have both a
//    forward-scheduled record and one created after its scheduled time — so it
//    is rendered as cards, never as funnel segments.
//
// 3. An appointment figure reading as "booked" or "attended". The labels say
//    "record found", the scope line says all providers and all appointment
//    types, and the unresolved count sits next to every number.
//
// The synthetic insurance-follow-up demo stays at its own route. Nothing on
// this page is synthetic and nothing from the demo is mixed in.

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { RefreshCw } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { PageHeader } from "./PageHeader";
import {
  useFreshness,
  AppointmentFreshnessBadge,
  IntakeFreshnessBadge,
} from "@/components/reporting/freshness";
import {
  AttendanceReviewCard,
  AttendanceReviewPanel,
} from "@/components/reporting/attendance-review";
import { AttendanceOutcome } from "@/components/reporting/attendance-outcome";
import {
  WaterfallChart,
  type WaterfallStage,
  SCALE_NOTE,
} from "@/components/ui/waterfall-chart";

// ---------------------------------------------------------------------------
// Types mirroring /api/reports/journey.
// ---------------------------------------------------------------------------
type ModeBlock = {
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  note: string;
  window_days?: number;
};

type JourneyResponse = {
  metric: string;
  definition_version: string;
  label: string;
  counts_what: string;
  observed_to_date: ModeBlock;
  mature_window: ModeBlock & { window_days: number };
  cohort: number | null;
  secondary: {
    a: number | null; b: number | null; c: number | null;
    labels: { a: string | null; b: string | null; c: string | null };
  };
  coverage: { unresolved: number | null; sufficient_coverage: number | null; note: string };
  durations: { matched: number | null; p50_days: number | null; p75_days: number | null; p90_days: number | null; note: string };
  provider_scope: string;
  is_observed_minimum: boolean;
  status: string;
  scope: { from: string; to: string | null; timezone_label: string };
  freshness: {
    intake_latest_at: string | null;
    appointments_synced_at: string | null;
    appointment_sync_active: boolean;
    appointment_update_mode: string;
    history_complete_patients: number | null;
    linked_patients: number | null;
  };
  suppression: { threshold: number; note: string };
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

const WINDOWS = [7, 14, 30] as const;

const RAMP = ["hsl(208 79% 22%)", "hsl(208 62% 34%)", "hsl(197 55% 45%)", "hsl(200 20% 70%)"];

/** Pacific day string, without dragging a date library in. */
function clinicDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

const PERIODS = [
  { id: "all", label: "All intake history", from: "2026-06-15", to: () => clinicDay(new Date()) },
  { id: "jul", label: "July 2026", from: "2026-07-01", to: () => "2026-07-31" },
  { id: "aug", label: "August 2026", from: "2026-08-01", to: () => "2026-08-31" },
  { id: "sep", label: "September 2026", from: "2026-09-01", to: () => clinicDay(new Date()) },
] as const;

// ---------------------------------------------------------------------------
// Small presentational pieces.
// ---------------------------------------------------------------------------
function pct(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

/** One number with its own explanation, and an honest empty state. */
function ModeCard({
  title, block, minimum, testId,
}: { title: string; block: ModeBlock; minimum?: boolean; testId: string }) {
  const withheld = block.numerator === null || block.denominator === null;
  const zeroDen = block.denominator === 0;
  return (
    <div className="rounded-lg border bg-card p-4" data-testid={testId}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">
          {zeroDen ? "—" : withheld ? "Withheld" : `${minimum ? "at least " : ""}${pct(block.rate)}`}
        </span>
        {!withheld && !zeroDen && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {block.numerator} of {block.denominator}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {zeroDen
          ? "No one was eligible in this period, so there is no rate to show. This is not 0%."
          : withheld
            ? "Withheld: the group is small enough that publishing it could identify someone."
            : block.note}
      </p>
    </div>
  );
}

/** A count that may be withheld, with the reason shown in place of a number. */
function CountCard({
  title, value, help, testId,
}: { title: string; value: number | null; help: string; testId: string }) {
  return (
    <div className="rounded-lg border bg-card p-4" data-testid={testId}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {value === null ? <span className="text-base font-medium">Withheld</span> : value}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {value === null
          ? "Withheld: small groups are not published, and neither are totals that would reveal them."
          : help}
      </p>
    </div>
  );
}

function UnavailableCard({ title, reason, testId }: { title: string; reason: string; testId: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-4" data-testid={testId}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="mt-1 text-base font-medium text-muted-foreground">Not available yet</div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{reason}</p>
    </div>
  );
}

/**
 * The shape of the answer, drawn while the answer is on its way.
 *
 * NOT a number and NOT a demo figure. A placeholder that looked like a result
 * would be worse than a spinner: a reader who glanced away and back could not
 * tell a stand-in from a measurement. These are empty grey blocks in exactly
 * the positions the real cards occupy, so the page does not jump when they
 * arrive, and they are announced to screen readers as busy.
 */
function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} aria-hidden="true" />;
}

function PanelSkeleton() {
  return (
    <div className="space-y-6" data-testid="journey-loading" role="status" aria-busy="true">
      <span className="sr-only">Loading this journey&rsquo;s figures.</span>
      <section className="rounded-lg border bg-muted/20 p-4">
        <Skeleton className="h-4 w-20" />
        <div className="mt-3 flex flex-wrap gap-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-48" />
        </div>
      </section>
      <section>
        <Skeleton className="h-4 w-44" />
        <div className="mt-3 space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-4/5" />
          <Skeleton className="h-9 w-3/5" />
        </div>
      </section>
      <section className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </section>
      <section>
        <Skeleton className="h-4 w-52" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </section>
    </div>
  );
}

/**
 * A failed request, said plainly, with the way out.
 *
 * Never a zero and never a dash that could read as "none": a request that did
 * not answer is not a measurement of nothing.
 */
function PanelError({ onRetry, detail }: { onRetry: () => void; detail?: string }) {
  return (
    <div
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
      data-testid="journey-error"
      role="alert"
    >
      <p className="font-medium">This journey could not be loaded.</p>
      <p className="mt-1 text-muted-foreground">
        Nothing is shown rather than a zero — a failed request is not a result. The figures
        that were here before, if any, are not being updated.
      </p>
      {detail && <p className="mt-1 font-mono text-xs text-muted-foreground">{detail}</p>}
      <button
        type="button"
        onClick={onRetry}
        data-testid="journey-retry"
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
      </button>
    </div>
  );
}

/** Expandable "what exactly is this" block, so the main view stays readable. */
function Explain({ children, label = "What is counted" }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="mt-3 rounded-md border bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label}
      </summary>
      <div className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// One journey panel.
// ---------------------------------------------------------------------------
type BookingResponse = {
  metric: string; label: string; counts_what: string;
  snapshot_cutoff: string | null;
  cohort: { total: number | null; covered: number | null; not_covered: number | null;
            eligible: number | null; immature: number | null; note: string };
  recorded: { count: number | null; rate: number | null };
  advance_booking: { count: number | null; rate: number | null; note: string };
  at_or_after_scheduled: { count: number | null; note: string };
  prior: { past_visit: number | null; future_booking: number | null; note: string };
  changed_after_recording: { later_cancelled: number | null; later_deleted: number | null; note: string };
  none_recorded: number | null;
  timing: { matched: number | null; p50_days: number | null };
  provider_scope: string; coverage_note: string;
  attendance: { available: boolean; mapping_version: string; approval_state: string;
                reason: string | null; outstanding_decision: string[] };
  status: string;
};

function JourneyPanel({
  formMetric, bookingMetric, attendanceMetric, entryLabel, outcomeLabel,
  from, to, windowDays, onOpenReview,
}: {
  formMetric: string; bookingMetric: string; attendanceMetric: string;
  entryLabel: string; outcomeLabel: string;
  from: string; to: string; windowDays: number;
  onOpenReview: () => void;
}) {
  const q = (base: string, metric: string) =>
    `${base}?metric=${encodeURIComponent(metric)}&from=${from}&to=${to}&window=${windowDays}`;

  const form = useQuery({
    queryKey: ["journey", formMetric, from, to, windowDays],
    queryFn: () => getJson<JourneyResponse>(q("/api/reports/journey", formMetric)),
    placeholderData: (prev) => prev, retry: 1,
  });
  const book = useQuery({
    queryKey: ["booking", bookingMetric, from, to, windowDays],
    queryFn: () => getJson<BookingResponse>(q("/api/reports/booking", bookingMetric)),
    placeholderData: (prev) => prev, retry: 1,
  });

  // An error wins over stale data: if the newest request failed, say so rather
  // than leaving an older answer on screen with nothing to mark it as old.
  if (book.isError) {
    return <PanelError onRetry={() => { void book.refetch(); }} />;
  }
  if (!book.data) {
    return <PanelSkeleton />;
  }
  const b = book.data;
  const f = form.data;
  // The two queries are independent. The appointment journey can render while
  // the consultation measure is still loading, and one failing must not blank
  // the other.
  const updating = book.isFetching || form.isFetching;

  // THE APPOINTMENT JOURNEY. Genuinely nested: every advance booking is a
  // recorded appointment, and every recorded appointment belongs to an
  // eligible patient. MATURITY IS NOT A STAGE HERE — it is measurement
  // eligibility, not something a patient did, so it lives in the cohort line
  // above the chart.
  //
  // ATTENDANCE IS DELIBERATELY ABSENT from this silhouette. Its definition,
  // once approved, may count arrivals at appointments that were NOT advance
  // bookings, so nesting it under the narrowest stage would be wrong. It is an
  // outcome card instead.
  const stages: WaterfallStage[] = [
    {
      id: "eligible", label: `${entryLabel} cohort (eligible)`,
      state: b.cohort.eligible === null ? "suppressed" : "measured",
      ...(b.cohort.eligible === null ? {} : { value: b.cohort.eligible }),
      unit: "patients",
      coverage: "Patients whose appointment history was retrieved and whose full follow-up window had elapsed before the snapshot.",
    },
    {
      id: "recorded", label: "Appointment record created after entry",
      state: b.recorded.count === null ? "suppressed" : "measured",
      ...(b.recorded.count === null ? {} : { value: b.recorded.count }),
      unit: "patients",
      conversion: b.recorded.rate === null ? null : pct(b.recorded.rate),
      coverage: "The timestamp on the record. Not proof of when a human booked, and not attendance.",
    },
    {
      id: "advance", label: "Advance booking recorded",
      state: b.advance_booking.count === null ? "suppressed" : "measured",
      ...(b.advance_booking.count === null ? {} : { value: b.advance_booking.count }),
      unit: "patients",
      conversion: b.advance_booking.rate === null ? null : pct(b.advance_booking.rate),
      coverage: b.advance_booking.note,
    },
  ];

  // The instant these appointment figures are as at. The server returns it with
  // the figures, so it is never absent while they are on screen; if it ever is,
  // say what is missing rather than the word "unknown", which reads as a
  // property of the data instead of a gap in what we were told.
  const snap = b.snapshot_cutoff
    ? new Date(b.snapshot_cutoff).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })
    : "an instant this response did not state";

  return (
    <div className="space-y-6" aria-busy={updating || undefined}>
      {updating && (
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="journey-updating"
          role="status"
        >
          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
          Updating these figures. The numbers below are the previous ones until it finishes.
        </p>
      )}
      {/* cohort + maturity context — NOT a funnel stage */}
      <section className="rounded-lg border bg-muted/20 p-4" data-testid="cohort-context">
        <h3 className="text-sm font-semibold">Cohort</h3>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span><strong className="tabular-nums">{b.cohort.total ?? "—"}</strong> entered in this period</span>
          <span><strong className="tabular-nums">{b.cohort.eligible ?? "—"}</strong> eligible to measure</span>
          <span className="text-muted-foreground">
            {b.cohort.immature ?? "—"} still inside their {windowDays}-day window at the snapshot
          </span>
          {(b.cohort.not_covered ?? 0) > 0 && (
            <span className="text-muted-foreground">{b.cohort.not_covered} not covered by the snapshot</span>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{b.cohort.note}</p>
      </section>

      <section>
        <h3 className="text-sm font-semibold">Appointment journey</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Each stage is a subset of the one above it. {SCALE_NOTE}
        </p>
        <div className="mt-3 hidden md:block">
          <WaterfallChart stages={stages} colors={RAMP} orientation="horizontal"
                          ariaLabel={`${entryLabel} to appointment record`} />
        </div>
        <div className="mt-3 md:hidden">
          <WaterfallChart stages={stages} colors={RAMP} orientation="vertical"
                          ariaLabel={`${entryLabel} to appointment record`} />
        </div>
        <Explain label="What is counted, and as at when">
          <p>{b.counts_what}</p>
          <p><strong>As at {snap}</strong> — the appointment snapshot. {b.coverage_note}</p>
          <p><strong>Scope:</strong> {b.provider_scope}</p>
          {b.timing.p50_days !== null && (
            <p>Median time from {entryLabel.toLowerCase()} to an advance booking:{" "}
              <strong>{b.timing.p50_days.toFixed(1)} days</strong>, among the {b.timing.matched} matched.</p>
          )}
        </Explain>
      </section>

      {/* attendance: an OUTCOME, not a stage under advance booking */}
      {/* ATTENDANCE — an OUTCOME, deliberately not a stage under advance booking.
          Once approved, its definition may count arrivals at appointments that
          were never advance bookings, so nesting it under the narrowest stage
          would be wrong. It does not depend on the consultation form either.

          The old pair of cards said attendance was unavailable and left the
          reader nowhere to go. The blocker was never data; it was a decision
          with no way to record it. */}
      <section className="grid gap-3 sm:grid-cols-2">
        <AttendanceOutcome metric={attendanceMetric} from={from} to={to} windowDays={windowDays} />
        <AttendanceReviewCard onOpen={onOpenReview} />
      </section>

      {/* consultation: a SEPARATE progression measure, not a booking stage */}
      <section>
        <h3 className="text-sm font-semibold">{outcomeLabel}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          A separate measure. It is <strong>not</strong> a step on the way to an appointment, and
          attendance does not depend on it.
        </p>
        {f ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ModeCard title="Observed to date" block={f.observed_to_date} testId="mode-observed" />
            <ModeCard title={`Within ${windowDays} days (mature)`} block={f.mature_window} testId="mode-mature" />
          </div>
        ) : form.isError ? (
          <div
            className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
            data-testid="consultation-error"
            role="alert"
          >
            <p className="font-medium">This measure could not be loaded.</p>
            <p className="mt-1 text-muted-foreground">
              The appointment figures above are unaffected — they come from a separate request.
            </p>
            <button
              type="button"
              onClick={() => { void form.refetch(); }}
              data-testid="consultation-retry"
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </button>
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="consultation-loading" role="status" aria-busy="true">
            <span className="sr-only">Loading the consultation measure.</span>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}
        {f && (
          <Explain>
            <p>{f.counts_what}</p>
            <p>
              Intake data is current to <strong>now</strong>; the appointment figures above are as
              at the snapshot. The two have different as-of times on purpose.
            </p>
          </Explain>
        )}
      </section>

      {/* contextual measures — overlapping, deliberately not a funnel */}
      <section>
        <h3 className="text-sm font-semibold">Context</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Overlapping categories, <strong>not</strong> a sequence — one patient can appear in several.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <CountCard title="Recorded at/after its scheduled time" value={b.at_or_after_scheduled.count}
                     help={b.at_or_after_scheduled.note} testId="ctx-at-after" />
          <CountCard title="Had a past visit before entry" value={b.prior.past_visit}
                     help={b.prior.note} testId="ctx-prior-past" />
          <CountCard title="Already scheduled at entry" value={b.prior.future_booking}
                     help="Booked before entry, for a date after it." testId="ctx-prior-future" />
          <CountCard title="Later cancelled" value={b.changed_after_recording.later_cancelled}
                     help={b.changed_after_recording.note} testId="ctx-cancelled" />
          <CountCard title="Record later deleted" value={b.changed_after_recording.later_deleted}
                     help="Deleted at the source. The evidence that a record was created is kept."
                     testId="ctx-deleted" />
          <CountCard title="No appointment recorded" value={b.none_recorded}
                     help="A real negative within the snapshot scope: their history was retrieved and their window had elapsed."
                     testId="ctx-none" />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
type TabId = "registration" | "insurance";

const TABS: ReadonlyArray<readonly [TabId, string]> = [
  ["registration", "Registration journey"],
  ["insurance", "Insurance inquiry journey"],
] as const;

function isTab(v: string | null): v is TabId {
  return v === "registration" || v === "insurance";
}
function isPeriod(v: string | null): v is (typeof PERIODS)[number]["id"] {
  return PERIODS.some((p) => p.id === v);
}

export default function Journeys() {
  // WHAT IS SELECTED LIVES IN THE URL.
  //
  // The tab, the entry period and the follow-up window are all part of the
  // question being asked, so all three belong in the address. Before this, a
  // link to "the insurance journey for August on a 30-day window" did not
  // exist: every link landed on the registration tab, all history, 14 days, and
  // the recipient had to be told which controls to set. Reload and Back now
  // work too.
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const tab: TabId = isTab(params.get("journey")) ? (params.get("journey") as TabId) : "registration";
  const periodId = isPeriod(params.get("period"))
    ? (params.get("period") as (typeof PERIODS)[number]["id"])
    : "all";
  const windowParam = Number(params.get("window"));
  const windowDays = WINDOWS.includes(windowParam as (typeof WINDOWS)[number]) ? windowParam : 14;

  // replaceState, not pushState: changing a filter is refining one question,
  // not asking a new one, so Back should leave the page rather than walk every
  // control the reader touched on the way.
  const setParam = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    next.set(key, value);
    window.history.replaceState(
      null, "",
      `${window.location.pathname}?${next.toString()}`,
    );
    // wouter's useSearch subscribes to popstate, which replaceState does not
    // fire. Dispatching it keeps the hook and the address bar in step.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const period = useMemo(() => PERIODS.find((p) => p.id === periodId)!, [periodId]);
  const from = period.from;
  const to = period.to();

  // One cheap call (drsnip_journey_freshness() alone, single-digit ms) instead
  // of reading freshness off the side of a six-second metric. That delay was
  // the whole reason the badge used to say "last refreshed unknown".
  const freshness = useFreshness();
  const [reviewOpen, setReviewOpen] = useState(false);

  // Pages self-wrap in AdminLayout in this app — the route does not do it.
  // Without this the page renders with no navigation and no sign-out.
  return (
    <AdminLayout>
    <div data-testid="journeys-page">
      <PageHeader
        eyebrow="Actual intake data"
        title="Patient journeys"
        subtitle="Real submissions and stored appointment records. Nothing on this page is synthetic."
      >
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center rounded-full border border-emerald-600/30 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                data-testid="badge-actual">
            Actual intake data
          </span>
          {/* The badge decides live / late / paused / manual from EVIDENCE the
              server returns — a completed run inside the cadence — never from
              the fact that a schedule was configured. While the check is in
              flight it says "checking", never "unknown". */}
          <IntakeFreshnessBadge query={freshness} />
          <AppointmentFreshnessBadge query={freshness} />
        </div>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Intake submissions update as forms arrive. Appointment records are re-read on a
          schedule; the badge above says the instant they are <em>complete to</em>, which is not
          the same as the last time sync ran — a run that could not finish its window leaves that
          instant where it was. Counted in distinct linked patient IDs; where one person holds two
          charts this is a chart count. Entry dates use clinic days (Pacific).
        </p>
      </PageHeader>

      {/* tabs */}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Journey">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setParam("journey", id)}
            data-testid={`tab-${id}`}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              tab === id ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* filters — only combinations the contracts can answer */}
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="mb-1 block font-medium text-muted-foreground">Entry period</span>
          <select
            className="min-w-0 rounded-md border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={periodId}
            data-testid="filter-period"
            onChange={(e) => setParam("period", e.target.value)}
          >
            {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium text-muted-foreground">Follow-up window</span>
          <select
            className="rounded-md border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={windowDays}
            data-testid="filter-window"
            onChange={(e) => setParam("window", e.target.value)}
          >
            {WINDOWS.map((w) => <option key={w} value={w}>{w} days</option>)}
          </select>
        </label>
        <p className="max-w-md text-xs text-muted-foreground">
          Periods are compared on <strong>equal windows only</strong>. A window is {windowDays} × 24
          hours from each entry, so a daylight-saving change cannot give one period extra time.
        </p>
      </div>

      {tab === "registration" ? (
        <JourneyPanel
          formMetric="registration_to_consultation"
          bookingMetric="booking_registration"
          attendanceMetric="attendance_registration"
          entryLabel="Registration"
          outcomeLabel="Consultation form submitted"
          from={from} to={to} windowDays={windowDays}
          onOpenReview={() => setReviewOpen(true)}
        />
      ) : (
        <JourneyPanel
          formMetric="insurance_to_registration"
          bookingMetric="booking_insurance"
          attendanceMetric="attendance_insurance"
          entryLabel="Insurance inquiry"
          outcomeLabel="Registration submitted"
          from={from} to={to} windowDays={windowDays}
          onOpenReview={() => setReviewOpen(true)}
        />
      )}

      <AttendanceReviewPanel
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        metric={tab === "registration" ? "attendance_registration" : "attendance_insurance"}
        from={from} to={to} windowDays={windowDays}
      />

      <p className="mt-8 text-xs text-muted-foreground">
        Small groups are withheld, together with any total that would let them be recovered by
        subtraction. “Withheld” never means zero. The synthetic insurance follow-up demonstration
        is a separate page, listed under “Demonstration” in Reports, and none of its figures
        appear here.
      </p>
    </div>
    </AdminLayout>
  );
}
