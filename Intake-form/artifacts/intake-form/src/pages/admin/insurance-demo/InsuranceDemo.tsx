// ===========================================================================
// Insurance follow-up DEMONSTRATION.
//
// Illustrates the proposed service: Xpand takes responsibility for
// insurance-inquiry follow-up, with staff oversight, and reports progress
// toward booked and attended appointments.
//
// THIS PAGE IS NOT A SERVICE. It reads ONLY ./demo-fixtures — no fetch, no
// query client, no database, no messaging endpoint, no schedule. Approve /
// Edit / Skip change local component state and nothing else; there is no
// endpoint behind any of them. "Reset demo" restores the fixture state, and so
// does a reload. api/_test/demo-isolation.test.ts reads this file's source and
// fails the build if that ever stops being true.
//
// Every panel carries a Demo label, because any one of them can be
// screenshotted on its own.
// ===========================================================================

import { useMemo, useState } from "react";
import { useSearchParams } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  FlaskConical,
  Info,
  PhoneCall,
  RotateCcw,
  SkipForward,
  UserCheck,
} from "lucide-react";
import { AdminLayout } from "../AdminLayout";
import { PageHeader, ScopeLine } from "../PageHeader";
import {
  SCALE_NOTE,
  StageTable,
  WaterfallChart,
  assertNested,
  type WaterfallStage,
} from "@/components/ui/waterfall-chart";
import {
  COHORT,
  DEMO_BANNER,
  ILLUSTRATIVE_BASELINE,
  QUEUE,
  QUEUE_STATUS_LABEL,
  RECORDS,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_SOURCE,
  WEEK,
  WEEKLY_FOLLOW_UPS,
  conversionFromPrev,
  dayToDate,
  inquiryToBooked,
  maturedRecords,
  maturingRecords,
  meanDaysToEstimate,
  stageCount,
  stageCounts,
  weeklyActivity,
  type QueueItem,
} from "./demo-fixtures";

const BLUE_RAMP = [
  "#A8C6E0",
  "#8FB4D6",
  "#6FA0CB",
  "#4E8ABE",
  "#1D5D93",
  "#0F4C81",
];

type View = "waterfall" | "queue" | "scoreboard";
const VIEWS: Array<{ key: View; label: string }> = [
  { key: "waterfall", label: "Waterfall" },
  { key: "queue", label: "Follow-up queue" },
  { key: "scoreboard", label: "Weekly scoreboard" },
];

// ---------------------------------------------------------------------------
// Labelling
// ---------------------------------------------------------------------------

/** The page-level banner. Sticky, so it stays on screen while scrolling. */
function DemoBanner() {
  return (
    <div
      className="sticky top-[3.5rem] z-20 -mx-4 mb-5 flex items-start gap-2 border-y px-4 py-2.5 text-sm font-medium sm:-mx-6 sm:px-6 md:top-0 md:mx-0 md:border"
      style={{
        background: "var(--sh-demo-bg)",
        borderColor: "var(--sh-demo-border)",
        color: "var(--sh-demo-fg)",
      }}
      data-testid="demo-banner"
      role="note"
    >
      <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{DEMO_BANNER}</span>
    </div>
  );
}

/** Per-panel label, so no single screenshot can lose the context. */
function DemoTag({ className = "" }: { className?: string }) {
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
        className
      }
      style={{
        background: "var(--sh-demo-bg)",
        borderColor: "var(--sh-demo-border)",
        color: "var(--sh-demo-fg)",
      }}
    >
      <FlaskConical className="h-2.5 w-2.5" />
      Demo
    </span>
  );
}

function Panel({
  title,
  subtitle,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={
        "border border-[var(--sh-border)] bg-[var(--sh-card)] p-4 sm:p-6 " + className
      }
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[var(--sh-fg)]">{title}</h2>
          {subtitle && (
            <p className="mt-1 max-w-3xl text-xs text-[var(--sh-muted)]">{subtitle}</p>
          )}
        </div>
        <DemoTag />
      </div>
      {children}
    </section>
  );
}

// ===========================================================================
export default function InsuranceDemo() {
  return (
    <AdminLayout>
      <InsuranceDemoPage />
    </AdminLayout>
  );
}

function InsuranceDemoPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view");
  const view: View = VIEWS.some((v) => v.key === raw) ? (raw as View) : "waterfall";

  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    next.set("view", v);
    // replace: keeps the back button out of the tab history.
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Reports · demonstration"
        title="Insurance follow-up"
        subtitle="What the proposed service would look like in this console: every insurance inquiry followed up with staff oversight, and progress reported through to attended appointments."
      >
        <ScopeLine
          parts={[
            `${COHORT.entryWindowDays}-day cohort · ${COHORT.firstEntryDay} to ${COHORT.lastEntryDay}`,
            `observed through ${COHORT.observedThrough}`,
            "counted as inquiries, one row per inquiry",
            "invented data",
          ]}
        />
      </PageHeader>

      <DemoBanner />

      {/* View switch. A real tablist, keyboard-operable, URL-backed. */}
      <div
        role="tablist"
        aria-label="Demonstration views"
        className="mb-5 flex gap-1 border-b border-[var(--sh-border)]"
      >
        {VIEWS.map((v) => {
          const on = view === v.key;
          return (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={`demo-tab-${v.key}`}
              onClick={() => setView(v.key)}
              className={
                "-mb-px min-h-11 border-b-2 px-4 text-sm font-medium transition-colors " +
                (on
                  ? "border-[var(--sh-accent)] text-[var(--sh-fg)]"
                  : "border-transparent text-[var(--sh-muted)] hover:text-[var(--sh-fg)]")
              }
            >
              {v.label}
            </button>
          );
        })}
      </div>

      {view === "waterfall" && <WaterfallView />}
      {view === "queue" && <QueueView />}
      {view === "scoreboard" && <ScoreboardView />}
    </div>
  );
}

// ===========================================================================
// View 1 — the waterfall
// ===========================================================================

function WaterfallView() {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const stages: WaterfallStage[] = useMemo(
    () =>
      STAGE_ORDER.map((id) => ({
        id,
        label: STAGE_LABEL[id],
        state: "measured" as const,
        value: stageCount(id),
        unit: "inquiries",
        conversion: conversionFromPrev(id),
        coverage: STAGE_SOURCE[id],
      })),
    [],
  );

  // A rise inside one cohort is impossible, so this should always be empty. If
  // it is not, the stages are not nested and the page says so rather than
  // drawing a widening funnel.
  const notNested = useMemo(() => assertNested(stages), [stages]);

  const toBooked = inquiryToBooked();
  const matured = maturedRecords();
  const maturing = maturingRecords();
  const maturedToBooked = inquiryToBooked(matured);
  const tte = meanDaysToEstimate();

  const open = openIdx === null ? null : stages[openIdx];

  return (
    <div className="space-y-6">
      {/* KPI row. Journey order, never sorted by size. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Inquiries" value={stageCount("inquiry").toLocaleString()} note="in the cohort" />
        <Kpi label="Estimates sent" value={stageCount("estimate").toLocaleString()} note="of those inquiries" />
        <Kpi label="Booked" value={stageCount("booked").toLocaleString()} note="observed to date" />
        <Kpi label="Attended" value={stageCount("attended").toLocaleString()} note="observed to date" />
      </div>

      {notNested.length > 0 && (
        <div className="border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
          <strong>These stages are not nested.</strong> {notNested.join(", ")} is
          larger than the stage before it, so these are not one cohort and are
          shown as separate measures rather than a single funnel. No value has
          been changed.
        </div>
      )}

      <Panel
        title="Inquiry to attended"
        subtitle={`The proposed workflow as one cohort: every inquiry that arrived between ${COHORT.firstEntryDay} and ${COHORT.lastEntryDay}, followed forward. Percentages are stage-to-stage within that cohort.`}
      >
        <div className="hidden md:block">
          <WaterfallChart
            stages={stages}
            colors={BLUE_RAMP}
            orientation="horizontal"
            activeIndex={openIdx}
            onStageActivate={(_s, i) => setOpenIdx((cur) => (cur === i ? null : i))}
            ariaLabel="Insurance follow-up journey, inquiry through attended"
          />
        </div>
        <div className="md:hidden">
          <WaterfallChart
            stages={stages}
            colors={BLUE_RAMP}
            orientation="vertical"
            activeIndex={openIdx}
            onStageActivate={(_s, i) => setOpenIdx((cur) => (cur === i ? null : i))}
            ariaLabel="Insurance follow-up journey, inquiry through attended"
          />
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-xs text-[var(--sh-muted)]">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{SCALE_NOTE}</span>
        </p>

        {open && (
          <div
            className="mt-4 border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900"
            data-testid="stage-detail"
          >
            <div className="font-semibold">{open.label}</div>
            <p className="mt-1">
              {open.value?.toLocaleString()} {open.unit}
              {open.conversion ? ` · ${open.conversion} of the previous stage` : ""}
            </p>
            <p className="mt-2 text-xs">{open.coverage}</p>
            <p className="mt-2 text-xs italic">
              In the demo, a stage opens this panel. In a live pilot it would open
              the matching list of records, for staff who are allowed to see them.
            </p>
          </div>
        )}

        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
            Stage detail
          </h3>
          <StageTable
            stages={stages}
            caption="Each stage of the proposed insurance follow-up journey, with its count, unit, stage-to-stage conversion and where the figure would come from."
          />
        </div>
      </Panel>

      {/* Cohort maturity — the honest pair. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Inquiry to booked"
          subtitle="Conversion is anchored on the inquiry, not the booking: it asks what happened to the people who inquired in this window."
        >
          <dl className="space-y-4">
            <div>
              <dt className="text-xs text-[var(--sh-muted)]">
                Whole cohort, observed to date
              </dt>
              <dd className="sh-num text-2xl font-bold text-[var(--sh-fg)]">
                {toBooked === null ? "not available" : `${toBooked}%`}
              </dd>
              <dd className="mt-0.5 text-xs text-[var(--sh-muted)]">
                {stageCount("booked")} of {stageCount("inquiry")} inquiries.
                Includes {maturing.length} that arrived in the last{" "}
                {COHORT.maturityDays} days and have barely had a chance to book,
                so this reads low.
              </dd>
            </div>
            <div className="border-t border-[var(--sh-border)] pt-3">
              <dt className="text-xs text-[var(--sh-muted)]">
                Settled sub-cohort ({COHORT.maturityDays}+ days observed)
              </dt>
              <dd className="sh-num text-2xl font-bold text-[var(--sh-fg)]">
                {maturedToBooked === null ? "not available" : `${maturedToBooked}%`}
              </dd>
              <dd className="mt-0.5 text-xs text-[var(--sh-muted)]">
                {stageCount("booked", matured)} of {matured.length} inquiries.
                Neither figure is final: the follow-up window is{" "}
                {COHORT.followUpWindowDays} days.
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel
          title="Time to estimate"
          subtitle="Measured only over the inquiries that actually received an estimate — averaging in the ones that never got one would be averaging over a denominator that does not apply."
        >
          <div className="sh-num text-2xl font-bold text-[var(--sh-fg)]">
            {tte.mean === null ? "not available" : `${tte.mean} days`}
          </div>
          <p className="mt-1 text-xs text-[var(--sh-muted)]">
            Mean, across {tte.n} of {RECORDS.length} inquiries.{" "}
            {RECORDS.length - tte.n} never reached an estimate and are excluded.
          </p>
          <CoveragePanel />
        </Panel>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="border border-[var(--sh-border)] bg-[var(--sh-card)] p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
          {label}
        </div>
        <DemoTag />
      </div>
      <div className="sh-num mt-1 text-2xl font-bold text-[var(--sh-fg)]">{value}</div>
      {note && <div className="mt-0.5 text-xs text-[var(--sh-muted)]">{note}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workstream D — what a real pilot would need connected
// ---------------------------------------------------------------------------

function CoveragePanel() {
  const rows = STAGE_ORDER.map((id) => ({
    label: STAGE_LABEL[id],
    live: STAGE_SOURCE[id].startsWith("Live today"),
    note: STAGE_SOURCE[id],
  }));
  return (
    <div className="mt-5 border-t border-[var(--sh-border)] pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
        What is measured today
      </h3>
      <ul className="mt-2 space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="flex items-start gap-2 text-xs">
            <span
              aria-hidden="true"
              className={
                "mt-1 inline-block h-2 w-2 shrink-0 " +
                (r.live ? "bg-[var(--sh-accent)]" : "border border-slate-400")
              }
            />
            <span>
              <span className="font-medium text-[var(--sh-fg)]">{r.label}</span>
              {" — "}
              <span className="text-[var(--sh-muted)]">{r.note}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs italic text-[var(--sh-muted)]">
        One of six stages is measured in the console today. The rest are what a
        live pilot would connect; matching and measurement definitions would be
        agreed before any of them is reported as fact.
      </p>
    </div>
  );
}

// ===========================================================================
// View 2 — the follow-up queue
// ===========================================================================

type ActionState = {
  outcome: "pending" | "approved" | "skipped";
  draft: string;
  skipReason: string;
  editing: boolean;
  log: string[];
};

function initialState(q: QueueItem): ActionState {
  return {
    outcome: "pending",
    draft: q.draft ?? "",
    skipReason: "",
    editing: false,
    log: [],
  };
}

function QueueView() {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Record<string, ActionState>>(() =>
    Object.fromEntries(QUEUE.map((q) => [q.recordId, initialState(q)])),
  );

  const reset = () => {
    setState(Object.fromEntries(QUEUE.map((q) => [q.recordId, initialState(q)])));
    setNonce((n) => n + 1);
  };

  const update = (id: string, patch: Partial<ActionState>) =>
    setState((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  return (
    <div className="space-y-4" key={nonce}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-[var(--sh-muted)]">
          Inquiries that have stopped moving, with the evidence behind each one
          and a suggested next step. Nothing here sends a message: approving a
          draft records a decision in this demo and stops.
        </p>
        <button
          type="button"
          onClick={reset}
          data-testid="demo-reset"
          className="inline-flex min-h-10 shrink-0 items-center gap-2 border border-[var(--sh-border)] bg-white px-3 text-sm font-medium text-[var(--sh-muted)] hover:bg-[var(--sh-surface-hover)]"
        >
          <RotateCcw className="h-4 w-4" />
          Reset demo
        </button>
      </div>

      {QUEUE.map((q) => (
        <QueueCard
          key={q.recordId}
          item={q}
          state={state[q.recordId]}
          onChange={(patch) => update(q.recordId, patch)}
        />
      ))}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  awaiting_response: "border-slate-200 bg-slate-50 text-slate-700",
  call_requested: "border-sky-200 bg-sky-50 text-sky-900",
  draft_awaiting_review: "border-amber-200 bg-amber-50 text-amber-900",
  human_review_required: "border-rose-200 bg-rose-50 text-rose-900",
  verification_pending: "border-amber-200 bg-amber-50 text-amber-900",
  booked: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

function QueueCard({
  item,
  state,
  onChange,
}: {
  item: QueueItem;
  state: ActionState;
  onChange: (patch: Partial<ActionState>) => void;
}) {
  const decided = state.outcome !== "pending";
  return (
    <section
      className="border border-[var(--sh-border)] bg-[var(--sh-card)] p-4 sm:p-6"
      data-testid={`queue-card-${item.recordId.replace(/\s+/g, "-")}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-[var(--sh-fg)]">
              {item.recordId}
            </h3>
            <span
              className={
                "border px-2 py-0.5 text-xs font-medium " +
                (STATUS_STYLE[item.status] ?? "border-slate-200 bg-slate-50")
              }
            >
              {QUEUE_STATUS_LABEL[item.status]}
            </span>
            <DemoTag />
          </div>
          <p className="mt-1 text-xs text-[var(--sh-muted)]">
            {item.location}
            {item.daysStalled > 0
              ? ` · no movement for ${item.daysStalled} days`
              : " · resolved"}
          </p>
        </div>
      </div>

      <p className="mt-3 text-sm text-[var(--sh-fg)]">{item.reason}</p>

      {/* Evidence */}
      <div className="mt-4">
        <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
          Evidence
        </h4>
        <ol className="mt-2 space-y-1">
          {item.events.map((e, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="sh-num w-24 shrink-0 text-[var(--sh-muted)]">
                {dayToDate(e.day)}
              </span>
              <span className="text-[var(--sh-fg)]">{e.label}</span>
              <span
                className={
                  "text-[10px] " + (e.live ? "text-[var(--sh-accent)]" : "text-amber-700")
                }
              >
                {e.live
                  ? "— recorded in the console today"
                  : "— not measured today; a pilot would record this"}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {/* Action */}
      {item.draft !== null ? (
        <div className="mt-4 border-t border-[var(--sh-border)] pt-4">
          <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
            Suggested follow-up
          </h4>
          {state.editing ? (
            <textarea
              value={state.draft}
              onChange={(e) => onChange({ draft: e.target.value })}
              rows={5}
              aria-label={`Draft follow-up for ${item.recordId}`}
              className="mt-2 w-full border border-[var(--sh-border)] bg-white p-3 text-sm text-[var(--sh-fg)]"
            />
          ) : (
            <p className="mt-2 whitespace-pre-line border-l-2 border-[var(--sh-accent)] bg-slate-50 p-3 text-sm text-[var(--sh-fg)]">
              {state.draft}
            </p>
          )}

          <p className="mt-3 flex items-start gap-1.5 text-xs text-[var(--sh-muted)]">
            <UserCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              A named staff member approves before anything is sent. Nothing is
              sent from this screen, and there is no send in this demo at all.
            </span>
          </p>

          {!decided ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-testid={`approve-${item.recordId.replace(/\s+/g, "-")}`}
                onClick={() =>
                  onChange({
                    outcome: "approved",
                    editing: false,
                    log: [...state.log, "Approved in demo — not sent"],
                  })
                }
                className="inline-flex min-h-10 items-center gap-2 bg-[var(--sh-accent)] px-4 text-sm font-medium text-white hover:opacity-90"
              >
                <Check className="h-4 w-4" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => onChange({ editing: !state.editing })}
                className="inline-flex min-h-10 items-center gap-2 border border-[var(--sh-border)] bg-white px-4 text-sm font-medium text-[var(--sh-fg)] hover:bg-[var(--sh-surface-hover)]"
              >
                {state.editing ? "Done editing" : "Edit"}
              </button>
              <button
                type="button"
                data-testid={`skip-${item.recordId.replace(/\s+/g, "-")}`}
                onClick={() =>
                  onChange({
                    outcome: "skipped",
                    editing: false,
                    log: [
                      ...state.log,
                      "Skipped in demo" +
                        (state.skipReason ? ` — ${state.skipReason}` : ""),
                    ],
                  })
                }
                className="inline-flex min-h-10 items-center gap-2 border border-[var(--sh-border)] bg-white px-4 text-sm font-medium text-[var(--sh-muted)] hover:bg-[var(--sh-surface-hover)]"
              >
                <SkipForward className="h-4 w-4" />
                Skip
              </button>
              <input
                value={state.skipReason}
                onChange={(e) => onChange({ skipReason: e.target.value })}
                placeholder="Reason (optional)"
                aria-label={`Skip reason for ${item.recordId}`}
                className="min-h-10 flex-1 border border-[var(--sh-border)] bg-white px-3 text-sm sm:max-w-xs"
              />
            </div>
          ) : (
            <div
              className={
                "mt-3 border p-3 text-sm font-medium " +
                (state.outcome === "approved"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-slate-200 bg-slate-50 text-slate-700")
              }
              data-testid={`outcome-${item.recordId.replace(/\s+/g, "-")}`}
              role="status"
            >
              {state.outcome === "approved"
                ? "Approved in demo — not sent. No message left this screen, and the patient is not marked booked."
                : "Skipped in demo" +
                  (state.skipReason ? ` — ${state.skipReason}` : "") +
                  ". Nothing was sent."}
            </div>
          )}
        </div>
      ) : (
        item.handoff && (
          <div className="mt-4 flex items-start gap-2 border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            {item.status === "human_review_required" ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <PhoneCall className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>
              <strong>Handed to staff.</strong> {item.handoff} No draft is
              produced and nothing is sent.
            </span>
          </div>
        )
      )}

      {/* History */}
      <div className="mt-4 border-t border-[var(--sh-border)] pt-3">
        <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
          Action history
        </h4>
        <ul className="mt-2 space-y-1 text-xs text-[var(--sh-muted)]">
          {item.history.map((h, i) => (
            <li key={`h-${i}`} className="flex gap-2">
              <span className="sh-num w-24 shrink-0">{dayToDate(h.day)}</span>
              <span>{h.text}</span>
            </li>
          ))}
          {state.log.map((l, i) => (
            <li key={`l-${i}`} className="flex gap-2 font-medium text-[var(--sh-fg)]">
              <span className="sh-num w-24 shrink-0">
                {dayToDate(WEEK.toDay)}
              </span>
              <span>{l}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Escalation */}
      <p className="mt-3 flex items-start gap-1.5 border-t border-[var(--sh-border)] pt-3 text-xs text-[var(--sh-muted)]">
        <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Escalation: no staff decision within two business days goes to the daily
          digest. A clinical question stops the follow-up and goes straight to
          clinical staff.
        </span>
      </p>
    </section>
  );
}

// ===========================================================================
// View 3 — the weekly scoreboard
// ===========================================================================

function ScoreboardView() {
  const activity = weeklyActivity();
  const matured = maturedRecords();
  const maturedToBooked = inquiryToBooked(matured);
  const cohortToBooked = inquiryToBooked();
  const counts = stageCounts();

  return (
    <div className="space-y-6">
      <Panel
        title={`This week's activity · ${dayToDate(WEEK.fromDay)} to ${dayToDate(WEEK.toDay)}`}
        subtitle="Events that happened during the week. These are activity counts, not a funnel: most of this week's bookings belong to inquiries from earlier weeks, so dividing one of these by another would be meaningless."
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {STAGE_ORDER.map((id) => (
            <div key={id} className="border border-[var(--sh-border)] p-3">
              <dt className="text-[11px] font-medium text-[var(--sh-muted)]">
                {STAGE_LABEL[id]}
              </dt>
              <dd className="sh-num mt-1 text-xl font-bold text-[var(--sh-fg)]">
                {activity[id]}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-[var(--sh-muted)]">
          Read down the row, not across: &ldquo;{activity.booked} booked&rdquo;
          and &ldquo;{activity.inquiry} inquiries&rdquo; are different people.
        </p>
      </Panel>

      <Panel
        title="Follow-up work this week"
        subtitle="What the service did, and what it handed back. Every send would require a named staff approval first."
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {[
            ["Follow-ups suggested", WEEKLY_FOLLOW_UPS.suggested],
            ["Approved by staff", WEEKLY_FOLLOW_UPS.approvedByStaff],
            ["Skipped by staff", WEEKLY_FOLLOW_UPS.skippedByStaff],
            ["Awaiting review", WEEKLY_FOLLOW_UPS.awaitingReview],
            ["Escalated to staff", WEEKLY_FOLLOW_UPS.escalatedToStaff],
          ].map(([label, n]) => (
            <div key={String(label)} className="border border-[var(--sh-border)] p-3">
              <dt className="text-[11px] font-medium text-[var(--sh-muted)]">
                {label}
              </dt>
              <dd className="sh-num mt-1 text-xl font-bold text-[var(--sh-fg)]">
                {n as number}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-[var(--sh-muted)]">
          Suggested does not equal sent: {WEEKLY_FOLLOW_UPS.suggested} suggested,{" "}
          {WEEKLY_FOLLOW_UPS.approvedByStaff} approved,{" "}
          {WEEKLY_FOLLOW_UPS.skippedByStaff} skipped,{" "}
          {WEEKLY_FOLLOW_UPS.awaitingReview} still waiting on a decision.
        </p>
      </Panel>

      <Panel
        title="Cohort outcome"
        subtitle="The separate question: of the people who inquired, how many booked? Anchored on the inquiry date, so the numerator and denominator are the same people."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="border border-[var(--sh-border)] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
              Settled sub-cohort
            </div>
            <div className="sh-num mt-1 text-2xl font-bold text-[var(--sh-fg)]">
              {maturedToBooked === null ? "not available" : `${maturedToBooked}%`}
            </div>
            <div className="mt-0.5 text-xs text-[var(--sh-muted)]">
              {stageCount("booked", matured)} booked of {matured.length} inquiries,
              each observed at least {COHORT.maturityDays} days.
            </div>
          </div>
          <div className="border border-[var(--sh-border)] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
              Whole cohort, observed to date
            </div>
            <div className="sh-num mt-1 text-2xl font-bold text-[var(--sh-fg)]">
              {cohortToBooked === null ? "not available" : `${cohortToBooked}%`}
            </div>
            <div className="mt-0.5 text-xs text-[var(--sh-muted)]">
              {counts[4].count} booked of {counts[0].count} inquiries. Still
              maturing; the follow-up window is {COHORT.followUpWindowDays} days.
            </div>
          </div>
        </div>

        {/* Baseline. Illustrative, and labelled as such three ways. */}
        <div
          className="mt-4 border p-4 text-sm"
          style={{
            background: "var(--sh-demo-bg)",
            borderColor: "var(--sh-demo-border)",
            color: "var(--sh-demo-fg)",
          }}
        >
          <div className="flex items-center gap-2 font-semibold">
            <FlaskConical className="h-4 w-4" />
            Illustrative baseline: {ILLUSTRATIVE_BASELINE.lowPct}&ndash;
            {ILLUSTRATIVE_BASELINE.highPct}%
          </div>
          <p className="mt-1 text-xs">
            This is a figure recalled in conversation about how many insurance
            enquirers become patients. It is <strong>not</strong> a measured
            booking rate from this console, it is not a target the demo claims to
            have beaten, and it is never used as a denominator. A real baseline
            would have to be measured before and after a pilot, on one agreed
            definition.
          </p>
        </div>

        <p className="mt-4 text-xs text-[var(--sh-muted)]">
          Deliberately absent: any revenue or procedure figure. A booked
          appointment is not an attended appointment and an attended appointment
          is not a completed procedure; this demo reports only the first two, and
          only as invented data.
        </p>
      </Panel>
    </div>
  );
}
