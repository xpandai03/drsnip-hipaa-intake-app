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

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdminLayout } from "./AdminLayout";
import { PageHeader } from "./PageHeader";
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
function JourneyPanel({
  formMetric, apptMetric, entryLabel, outcomeLabel, from, to, windowDays,
}: {
  formMetric: string; apptMetric: string;
  entryLabel: string; outcomeLabel: string;
  from: string; to: string; windowDays: number;
}) {
  const q = (metric: string) =>
    `/api/reports/journey?metric=${encodeURIComponent(metric)}` +
    `&from=${from}&to=${to}&window=${windowDays}`;
  const form = useQuery({
    queryKey: ["journey", formMetric, from, to, windowDays],
    queryFn: () => getJson<JourneyResponse>(q(formMetric)),
    // A failed refetch must NOT blank a good number. Keep showing the last
    // value with a staleness notice instead of dropping to zero.
    placeholderData: (prev) => prev,
    retry: 1,
  });
  const appt = useQuery({
    queryKey: ["journey", apptMetric, from, to, windowDays],
    queryFn: () => getJson<JourneyResponse>(q(apptMetric)),
    placeholderData: (prev) => prev,
    retry: 1,
  });

  if (form.isLoading && !form.data) {
    return <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground" data-testid="journey-loading">Loading…</div>;
  }
  if (form.isError && !form.data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" data-testid="journey-error">
        <p className="font-medium">Could not load this journey.</p>
        <p className="mt-1 text-muted-foreground">
          Nothing is shown rather than a zero — a failed request is not a result.
          <button className="ml-2 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => form.refetch()}>Retry</button>
        </p>
      </div>
    );
  }
  const f = form.data!;
  const a = appt.data;

  // The waterfall is used ONLY here, where each stage is a true subset of the
  // one above: everyone who submitted the outcome form is in the entry cohort.
  const stages: WaterfallStage[] = [
    {
      id: "entry", label: entryLabel,
      state: f.cohort === null ? "suppressed" : "measured",
      ...(f.cohort === null ? {} : { value: f.cohort }),
      unit: "patients",
      coverage: `Distinct linked patient IDs whose first ${entryLabel.toLowerCase()} falls in this period.`,
    },
    {
      id: "mature-den", label: `Had ${windowDays} full days to respond`,
      state: f.mature_window.denominator === null ? "suppressed"
           : f.mature_window.denominator === 0 ? "not_yet" : "measured",
      ...(f.mature_window.denominator ? { value: f.mature_window.denominator } : {}),
      unit: "patients",
      coverage: `Entries too recent to have had ${windowDays} days are excluded here, not counted as failures.`,
    },
    {
      id: "outcome", label: `${outcomeLabel} within ${windowDays} days`,
      state: f.mature_window.numerator === null ? "suppressed"
           : f.mature_window.denominator === 0 ? "not_yet" : "measured",
      ...(f.mature_window.numerator !== null && f.mature_window.denominator ? { value: f.mature_window.numerator } : {}),
      unit: "patients",
      conversion: f.mature_window.rate === null ? null : pct(f.mature_window.rate),
      coverage: f.counts_what,
    },
    {
      id: "attendance", label: "Attended the appointment",
      state: "unavailable",
      coverage:
        "Most appointments have no status history retrieved, so an absent history means " +
        "'not looked up', not 'did not arrive'. The clinic has also not confirmed which status " +
        "values mean the patient arrived.",
    },
  ];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold">Form progression</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Each stage below is a subset of the one above it. {SCALE_NOTE}
        </p>
        {/* Horizontal on desktop, VERTICAL on mobile. A four-stage horizontal
            waterfall at 390px truncates every label ("Insurance inq…", "Had 14
            full da…"), which defeats the point of naming the stages. Same
            split the insurance demo already uses. */}
        <div className="mt-3 hidden md:block">
          <WaterfallChart
            stages={stages}
            colors={RAMP}
            orientation="horizontal"
            ariaLabel={`${entryLabel} to ${outcomeLabel} progression`}
          />
        </div>
        <div className="mt-3 md:hidden">
          <WaterfallChart
            stages={stages}
            colors={RAMP}
            orientation="vertical"
            ariaLabel={`${entryLabel} to ${outcomeLabel} progression`}
          />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <ModeCard title="Observed to date" block={f.observed_to_date} testId="mode-observed" />
          <ModeCard title={`Within ${windowDays} days (mature)`} block={f.mature_window} testId="mode-mature" />
        </div>
        <Explain>
          <p>{f.counts_what}</p>
          <p>
            <strong>Observed to date</strong> counts every outcome seen so far, including for
            patients who registered days ago. It only ever rises, so two periods of different ages
            cannot be compared on it.
          </p>
          <p>
            <strong>Within {windowDays} days</strong> keeps only entries that have already had the
            full {windowDays} days available. Entries inside the period that are still too recent
            are removed from the denominator — a September patient who registered on the 2nd IS
            included; one who registered yesterday is not.
          </p>
          {f.durations.matched !== null && f.durations.p50_days !== null && (
            <p>
              Median time from {entryLabel.toLowerCase()} to {outcomeLabel.toLowerCase()}:{" "}
              <strong>{f.durations.p50_days.toFixed(1)} days</strong> among the {f.durations.matched}{" "}
              matched patients only — not across the whole cohort.
            </p>
          )}
        </Explain>
      </section>

      <section>
        <h3 className="text-sm font-semibold">Appointment record evidence</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          These are <strong>overlapping categories, not a funnel</strong> — one patient can appear
          in more than one. They are deliberately not drawn as descending stages.
        </p>
        {appt.isLoading && !a ? (
          <div className="mt-3 rounded-lg border p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : appt.isError && !a ? (
          <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" data-testid="appt-error">
            Could not load appointment evidence. No value is shown rather than a zero.
          </div>
        ) : a ? (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ModeCard
                title="Appointment record found"
                block={a.observed_to_date}
                minimum={a.is_observed_minimum}
                testId="appt-found"
              />
              <CountCard
                title={a.secondary.labels.a ?? "Forward-scheduled"}
                value={a.secondary.a}
                help="Record created before the time it was scheduled for — the conservative subset that looks like a genuine forward booking."
                testId="appt-forward"
              />
              <CountCard
                title={a.secondary.labels.b ?? "Created at/after scheduled time"}
                value={a.secondary.b}
                help="Its own category. Not bad data, and not an advance booking."
                testId="appt-after"
              />
              <CountCard
                title={a.secondary.labels.c ?? "Record predating entry"}
                value={a.secondary.c}
                help="An earlier appointment record already existed. Having one does not disqualify a patient from the measures above."
                testId="appt-prior"
              />
              <CountCard
                title="Unresolved"
                value={a.coverage.unresolved}
                help="No record found AND no complete history retrieved for that patient. These are unknowns, not negatives."
                testId="appt-unresolved"
              />
              <UnavailableCard
                title="Attendance"
                reason="Blocked on incomplete status-history retrieval and an unconfirmed arrival mapping."
                testId="appt-attendance"
              />
            </div>
            <Explain label="Why this is a minimum, and what it does not say">
              <p>{a.counts_what}</p>
              <p>
                <strong>It is a proportion of the cohort, but not a complete booking-conversion
                rate.</strong> A patient counted here definitely has an appointment record. A
                patient not counted may still have one: {a.coverage.unresolved ?? "some"} patients
                have neither a record found nor a complete history retrieved, so the true figure is
                at least this and no more than this plus the unresolved group.
              </p>
              <p><strong>Scope:</strong> {a.provider_scope}</p>
              <p>{a.coverage.note}</p>
            </Explain>
          </>
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Journeys() {
  const [tab, setTab] = useState<"registration" | "insurance">("registration");
  const [periodId, setPeriodId] = useState<(typeof PERIODS)[number]["id"]>("all");
  const [windowDays, setWindowDays] = useState<number>(14);

  const period = useMemo(() => PERIODS.find((p) => p.id === periodId)!, [periodId]);
  const from = period.from;
  const to = period.to();

  const freshness = useQuery({
    queryKey: ["journey-freshness"],
    queryFn: () => getJson<JourneyResponse>(`/api/reports/journey?metric=registration_to_consultation&from=${from}&to=${to}&window=14`),
    placeholderData: (prev) => prev,
  });
  const fr = freshness.data?.freshness;

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
          <span className="inline-flex items-center rounded-full border border-amber-600/30 bg-amber-50 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                data-testid="badge-snapshot">
            {/* Never "Live": recurring appointment sync is disabled. */}
            Appointment snapshot — last refreshed{" "}
            {fr?.appointments_synced_at
              ? new Date(fr.appointments_synced_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })
              : "unknown"}
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Intake submissions update as forms arrive. <strong>Appointment records do not</strong> —
          recurring sync is switched off, so they are a stored snapshot refreshed by hand. Counted
          in distinct linked patient IDs; where one person holds two charts this is a chart count.
          Entry dates use clinic days (Pacific).
        </p>
      </PageHeader>

      {/* tabs */}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Journey">
        {([
          ["registration", "Registration journey"],
          ["insurance", "Insurance inquiry journey"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
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
            onChange={(e) => setPeriodId(e.target.value as typeof periodId)}
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
            onChange={(e) => setWindowDays(Number(e.target.value))}
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
          apptMetric="appointment_evidence_registration"
          entryLabel="Registration"
          outcomeLabel="Consultation form submitted"
          from={from} to={to} windowDays={windowDays}
        />
      ) : (
        <JourneyPanel
          formMetric="insurance_to_registration"
          apptMetric="appointment_evidence_insurance"
          entryLabel="Insurance inquiry"
          outcomeLabel="Registration submitted"
          from={from} to={to} windowDays={windowDays}
        />
      )}

      <p className="mt-8 text-xs text-muted-foreground">
        Small groups are withheld, together with any total that would let them be recovered by
        subtraction. “Withheld” never means zero. The synthetic insurance follow-up demonstration
        is a separate page and none of its figures appear here.
      </p>
    </div>
    </AdminLayout>
  );
}
