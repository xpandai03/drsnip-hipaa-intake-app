// The published attendance outcome card.
//
// FOUR OUTCOMES, NOT TWO, and deliberately no rate.
//
//   evidenced in the window      a timed arrival, placed in this cohort's window
//   evidence with no usable time a status that says the patient was here but
//                                carries no arrival time. It is NOT folded into
//                                the windowed count: a scheduled time is not
//                                proof of when somebody walked in
//   evidenced outside the window real, but attributable to a different period
//   not established              no record either way. NOT "did not attend"
//
// No percentage is shown. A rate needs a dependable record of non-attendance,
// and the clinic has not confirmed it has one.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";

type Attendance =
  | {
      status: "unapproved" | "withdrawn";
      reason: string;
      withdrawn: {
        reason: string | null; previous_version: number | null;
        previously_confirmed_by: string | null; at: string | null;
      } | null;
    }
  | {
      status: "ok";
      unit: string;
      definition: {
        version: number | null; confirmed_by_name: string | null;
        confirmed_by_role: string | null; confirmed_on: string | null;
        confirmed_scope: string | null; undecided_labels: number | null;
        new_labels_since_approval: number | null;
      };
      cohort: { total: number | null; eligible: number | null; immature: number | null; note: string };
      arrival: {
        evidenced_in_window: number | null; evidenced_untimed: number | null;
        evidenced_outside_window: number | null; not_established: number | null;
        remote_only: number | null; in_window_resting_on_deleted_record: number | null;
      };
      notes: Record<string, string>;
      evidence_as_of: string | null;
    };

const n = (v: number | null) => (v === null ? "withheld" : v.toLocaleString());

export function AttendanceOutcome({
  metric, from, to, windowDays,
}: { metric: string; from: string; to: string; windowDays: number }) {
  const q = useQuery({
    queryKey: ["attendance", metric, from, to, windowDays],
    queryFn: async () => {
      const r = await fetch(
        `/api/reports/attendance?metric=${encodeURIComponent(metric)}&from=${from}&to=${to}&window=${windowDays}`,
        { credentials: "same-origin" },
      );
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as Attendance;
    },
    retry: 1,
    placeholderData: (p) => p,
  });

  if (q.isPending && !q.data) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-4" data-testid="attendance-outcome">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Attendance</div>
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Checking…
        </p>
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4" data-testid="attendance-outcome" role="alert">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Attendance</div>
        <p className="mt-2 flex items-start gap-1.5 text-sm">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          This could not be loaded.
          <button type="button" onClick={() => void q.refetch()}
                  className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Try again
          </button>
        </p>
      </div>
    );
  }

  // Bound to a const so the discriminated union narrows across the branches;
  // `q.data` is a fresh property read each time and narrowing does not survive.
  const data = q.data;

  if (data.status === "unapproved" || data.status === "withdrawn") {
    const w = data.withdrawn;
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-4" data-testid="attendance-outcome">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Attendance</div>
        <div className="mt-1 text-base font-medium text-muted-foreground">
          {w ? "Withdrawn" : "Not published yet"}
        </div>
        {w ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="attendance-withdrawn">
            The definition previously confirmed by{" "}
            <strong>{w.previously_confirmed_by ?? "the clinic"}</strong> was withdrawn
            {w.at ? ` on ${new Date(w.at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium" })}` : ""}
            {w.reason ? `: ${w.reason}` : "."}
          </p>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{data.reason}</p>
        )}
      </div>
    );
  }

  // Positive discriminant rather than "not the other two": TypeScript narrows a
  // union reliably on `=== "ok"`, and a future third unpublished state then
  // fails to compile here rather than rendering an empty card.
  if (data.status !== "ok") return null;
  const a = data.arrival;
  const d = data.definition;

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="attendance-outcome">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Attendance</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums" data-testid="attendance-evidenced">
          {n(a.evidenced_in_window)}
        </span>
        <span className="text-sm text-muted-foreground">
          of {n(data.cohort.eligible)} eligible patients, arrival evidenced
        </span>
      </div>

      <dl className="mt-3 space-y-1 text-xs">
        <div>
          <dt className="inline font-medium">Arrival not established: </dt>
          <dd className="inline tabular-nums" data-testid="attendance-unknown">{n(a.not_established)}</dd>
          <span className="text-muted-foreground"> — no record either way, not a count of people who did not come.</span>
        </div>
        <div>
          <dt className="inline font-medium">Evidence with no usable time: </dt>
          <dd className="inline tabular-nums">{n(a.evidenced_untimed)}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Evidenced outside this window: </dt>
          <dd className="inline tabular-nums">{n(a.evidenced_outside_window)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {data.notes.no_rate} {data.notes.movement}
      </p>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Counted in distinct patients. Confirmed by <strong>{d.confirmed_by_name}</strong>
        {d.confirmed_by_role ? ` (${d.confirmed_by_role})` : ""}
        {d.confirmed_on ? ` on ${d.confirmed_on}` : ""}
        {d.confirmed_scope ? `, for ${d.confirmed_scope}` : ""}.
        {d.undecided_labels ? ` ${d.undecided_labels} status labels are still undecided.` : ""}
        {d.new_labels_since_approval
          ? ` ${d.new_labels_since_approval} new status labels have appeared since — not counted.`
          : ""}
      </p>
    </div>
  );
}
