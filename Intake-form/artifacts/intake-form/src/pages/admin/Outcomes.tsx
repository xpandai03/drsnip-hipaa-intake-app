// Monthly outcomes — where each entry month's patients stand NOW, under the
// client's own definition of "converted" (Jeffrey Cho, 2026-09-21;
// outcome_status_rules v2).
//
// For patients whose first registration (or insurance inquiry) fell in a given
// month: how many have at least one appointment in the converted set, how many
// only canceled or did not show, how many have only unclassified statuses, and
// how many have no appointment at all. One count per patient.
//
// THE PAGE CALCULATES NOTHING. /api/reports/outcomes returns every count, the
// converted share and every label, already protected. The rules this
// component holds itself to (see outcomes-view.ts):
//   * a withheld value renders as "Withheld" — never 0, never blank;
//   * nothing is added up, divided, or derived from its neighbours;
//   * a bar is drawn only when all four outcomes were published.

import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { PageHeader } from "./PageHeader";
import { clinicTime } from "@/components/reporting/freshness";
import {
  COHORTS, BUCKET_KEYS, MAX_MONTHS,
  type OutcomesResponse, type MonthRow, type Count, type ViewState,
  cell, chartable, clinicMonth, isStale, monthLabel, monthOptions, newestFirst,
  parseViewState, pctLabel, rowNotice, toSearch, withheldReasons,
} from "./outcomes-view";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return (await res.json()) as T;
}

// Colours for the four outcomes. Unclassified is deliberately NOT grey: grey is
// how "withheld" reads, and the two must never be confused.
const BAR: Record<(typeof BUCKET_KEYS)[number], string> = {
  converted: "hsl(208 79% 26%)",
  not_converted: "hsl(4 62% 58%)",
  unclassified_only: "hsl(38 80% 58%)",
  no_appointment: "hsl(210 14% 78%)",
};

// ---------------------------------------------------------------------------
function Withheld({ why = "Withheld to protect a small group" }: { why?: string }) {
  return (
    <span
      className="inline-flex items-center rounded border border-dashed px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
      title={why}
      data-testid="cell-withheld"
    >
      Withheld<span className="sr-only"> — {why}</span>
    </span>
  );
}

function Num({ v, testId }: { v: Count; testId?: string }) {
  const c = cell(v);
  return c.kind === "withheld"
    ? <Withheld />
    : <span className="tabular-nums" data-testid={testId}>{c.n.toLocaleString("en-US")}</span>;
}

/** A bar only when every part is published. Otherwise say so, neutrally. */
function Breakdown({ row }: { row: MonthRow }) {
  if (row.status !== "ok") return null;
  if (!chartable(row)) {
    return (
      <span className="text-[11px] text-muted-foreground" data-testid="breakdown-withheld">
        Breakdown withheld
      </span>
    );
  }
  const covered = row.cohort.covered as number;
  return (
    <div className="flex h-2.5 w-full min-w-[80px] overflow-hidden rounded-sm bg-muted" aria-hidden="true" data-testid="breakdown-bar">
      {BUCKET_KEYS.map((k) => {
        const n = row.outcomes[k] as number;
        return n > 0 ? <span key={k} style={{ width: `${(n / covered) * 100}%`, background: BAR[k] }} /> : null;
      })}
    </div>
  );
}

/** "412 · 64.7%" — the share comes from the server, never from this file. */
function Converted({ row }: { row: MonthRow }) {
  const p = pctLabel(row.converted_pct);
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <Num v={row.outcomes.converted} testId="converted-count" />
      {p && <span className="text-xs text-muted-foreground tabular-nums" data-testid="converted-pct">{p}</span>}
    </span>
  );
}

function CoverageNotes({ row }: { row: MonthRow }) {
  const nc = row.cohort.not_covered;
  const un = row.cohort.unlinked_submissions;
  const notes: React.ReactNode[] = [];
  if (nc === null) notes.push(<span key="nc">a few awaiting their first history read</span>);
  else if (nc > 0) notes.push(<span key="nc">{nc} awaiting their first history read</span>);
  if (un === null) notes.push(<span key="un">a few submissions not linked to a chart</span>);
  else if (un > 0) notes.push(<span key="un">{un} submission{un === 1 ? "" : "s"} not linked to a chart</span>);
  if (!notes.length) return null;
  return (
    <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground" data-testid="coverage-notes">
      Not counted: {notes.reduce<React.ReactNode[]>((acc, n, i) => (i ? [...acc, " · ", n] : [n]), [])}
    </div>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} aria-hidden="true" />;
}

function TableSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-4" data-testid="outcomes-loading" role="status" aria-busy="true">
      <span className="sr-only">Loading monthly outcomes.</span>
      <Skeleton className="h-4 w-56" />
      <div className="mt-4 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid grid-cols-4 gap-3 lg:grid-cols-7">
            <Skeleton className="h-5" /><Skeleton className="h-5" /><Skeleton className="h-5" />
            <Skeleton className="h-5" /><Skeleton className="hidden h-5 lg:block" />
            <Skeleton className="hidden h-5 lg:block" /><Skeleton className="hidden h-5 lg:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadError({ onRetry, detail }: { onRetry: () => void; detail?: string }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" data-testid="outcomes-error" role="alert">
      <p className="font-medium">Monthly outcomes could not be loaded.</p>
      <p className="mt-1 text-muted-foreground">
        Nothing is shown rather than a zero — a failed request is not a result.
      </p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
      <button
        type="button"
        onClick={onRetry}
        data-testid="outcomes-retry"
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Outcomes() {
  // The question being asked lives in the address, so a link reproduces it and
  // reload keeps it. pushState: each change is a new question, so Back returns
  // to the previous one.
  const search = useSearch();
  const current = clinicMonth();
  const view = useMemo(() => parseViewState(search, current), [search, current]);
  const months = useMemo(() => monthOptions(current), [current]);

  const go = useCallback((next: ViewState) => {
    const qs = toSearch(next);
    if (qs === new URLSearchParams(window.location.search).toString()) return;
    window.history.pushState(null, "", `${window.location.pathname}?${qs}`);
    // wouter's useSearch listens for popstate; pushState does not fire it.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // A first visit (or a repaired bad link) writes the question it is actually
  // showing into the address, so the link is shareable straight away.
  useEffect(() => {
    const qs = toSearch(view);
    if (qs !== new URLSearchParams(window.location.search).toString()) {
      window.history.replaceState(null, "", `${window.location.pathname}?${qs}`);
    }
  }, [view]);

  const setFrom = (from: string) => {
    let to = view.to;
    if (from > to) to = from;
    const span = months.indexOf(to) - months.indexOf(from) + 1;
    if (span > MAX_MONTHS) to = months[months.indexOf(from) + MAX_MONTHS - 1];
    go({ ...view, from, to });
  };
  const setTo = (to: string) => {
    let from = view.from;
    if (to < from) from = to;
    const span = months.indexOf(to) - months.indexOf(from) + 1;
    if (span > MAX_MONTHS) from = months[months.indexOf(to) - MAX_MONTHS + 1];
    go({ ...view, from, to });
  };

  const url = `/api/reports/outcomes?form=${view.cohort}&from=${view.from}&to=${view.to}`;
  const q = useQuery({
    queryKey: ["outcomes", view.cohort, view.from, view.to],
    queryFn: () => getJson<OutcomesResponse>(url),
    placeholderData: (prev) => prev,
    retry: 1,
  });

  const d = q.data;
  const rows = d ? newestFirst(d.months) : [];
  const allEmpty = d !== undefined && rows.every((r) => r.status === "empty" || r.status === "not_started");
  const cutoff = d ? clinicTime(d.as_of.evidence_cutoff) : null;
  const stale = d ? isStale(d.as_of.evidence_age_minutes) : false;
  const noun = view.cohort === "insurance" ? "insurance inquiry" : "registration";

  return (
    <AdminLayout>
      <div data-testid="outcomes-page">
        <PageHeader
          eyebrow="Actual intake data"
          title="Monthly outcomes"
          subtitle="For patients who registered or sent an insurance inquiry in each month: how many have converted — at least one appointment on their chart in the clinic's converted set."
        >
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center rounded-full border border-emerald-600/30 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              Actual intake data
            </span>
            <Link
              href={`/admin/conversion?form=${view.cohort}`}
              data-testid="link-cohort-view"
              className="rounded-full border px-2 py-0.5 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Conversion by cohort →
            </Link>
          </div>
        </PageHeader>

        {d && (
          <div
            className="mb-4 flex gap-2 rounded-lg border border-emerald-600/30 bg-emerald-50/60 px-3 py-2 text-xs leading-relaxed text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100"
            data-testid="rules-banner"
            role="note"
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <p>
              <strong>The clinic&rsquo;s definition</strong>
              {d.rules.confirmed_on ? ` (${d.rules.confirmed_by ?? "client"}, ${d.rules.confirmed_on})` : ""}.{" "}
              {d.rules.explanation}
            </p>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div role="radiogroup" aria-label="Who entered in each month" className="flex rounded-md border bg-card p-0.5">
            {COHORTS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={view.cohort === c.id}
                data-testid={`cohort-${c.id}`}
                onClick={() => go({ ...view, cohort: c.id })}
                className={`rounded px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  view.cohort === c.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-muted-foreground">Entry months from</span>
            <select
              value={view.from}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="filter-from"
              className="rounded-md border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-muted-foreground">to</span>
            <select
              value={view.to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="filter-to"
              className="rounded-md border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </label>
          <p className="max-w-sm text-xs text-muted-foreground">
            Whole clinic months (Pacific), up to {MAX_MONTHS} at a time. A patient belongs to the month of
            their first {noun}.
          </p>
        </div>

        {d && (
          <p className="mb-3 text-sm" data-testid="data-complete-to">
            <strong>Appointment data complete to {cutoff ?? "— unavailable"}</strong>
            <span className="text-muted-foreground">
              {cutoff ? " (Pacific). Updated hourly." : ""}
              {d.as_of.basis === "history_baseline"
                ? " The hourly sync has not completed yet; this is the earliest full history read."
                : ""}
            </span>
          </p>
        )}
        {stale && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-200" data-testid="stale-warning" role="status">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Appointment data has not been refreshed for over three hours. Figures may be behind.
          </p>
        )}
        {q.isFetching && d && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground" role="status" data-testid="outcomes-updating">
            <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> Updating. The rows below are the previous answer until it finishes.
          </p>
        )}

        {q.isError ? (
          <LoadError onRetry={() => { void q.refetch(); }} detail={q.error instanceof Error ? q.error.message : undefined} />
        ) : !d ? (
          <TableSkeleton />
        ) : (
          <>
            {allEmpty && (
              <p className="mb-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="outcomes-empty">
                No {view.cohort === "insurance" ? "insurance inquiries" : "registrations"} linked to a patient
                chart in the selected months. This is an absence of entries, not missing appointment evidence.
              </p>
            )}

            <div className="hidden overflow-x-auto rounded-lg border bg-card lg:block">
              <table className="w-full text-sm" data-testid="outcomes-table">
                <caption className="sr-only">
                  {d.label}, by entry month, newest first. Each linked patient is counted once.
                </caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Entry month</th>
                    <th scope="col" className="px-3 py-2 font-medium">Patients</th>
                    {BUCKET_KEYS.map((k) => (
                      <th key={k} scope="col" className="px-3 py-2 text-right font-medium">{d.buckets[k].label}</th>
                    ))}
                    <th scope="col" className="px-3 py-2 font-medium">Breakdown</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const notice = rowNotice(r);
                    return (
                      <tr key={r.entry_month} className="border-b align-top last:border-0" data-testid={`row-${r.entry_month}`}>
                        <th scope="row" className="px-3 py-2.5 text-left font-medium">
                          {monthLabel(r.entry_month)}
                          {r.status === "ok" && !r.entry_period_complete && (
                            <span className="block text-[11px] font-normal text-muted-foreground">month still open</span>
                          )}
                        </th>
                        {notice ? (
                          <td colSpan={6} className="px-3 py-2.5 text-xs text-muted-foreground" data-testid="row-notice">
                            {notice}
                            {r.status === "empty" || r.status === "not_started" ? null : <CoverageNotes row={r} />}
                          </td>
                        ) : (
                          <>
                            <td className="px-3 py-2.5">
                              <Num v={r.cohort.covered} testId="covered" />
                              <CoverageNotes row={r} />
                            </td>
                            {BUCKET_KEYS.map((k) => (
                              <td key={k} className="px-3 py-2.5 text-right" data-testid={`cell-${k}`}>
                                {k === "converted" ? <Converted row={r} /> : <Num v={r.outcomes[k]} />}
                              </td>
                            ))}
                            <td className="px-3 py-2.5 align-middle"><Breakdown row={r} /></td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <ul className="grid gap-3 sm:grid-cols-2 lg:hidden" data-testid="outcomes-cards">
              {rows.map((r) => {
                const notice = rowNotice(r);
                return (
                  <li key={r.entry_month} className="rounded-lg border bg-card p-3" data-testid={`card-${r.entry_month}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold">{monthLabel(r.entry_month)}</h3>
                      {!notice && (
                        <span className="text-xs text-muted-foreground">
                          <Num v={r.cohort.covered} /> patients
                        </span>
                      )}
                    </div>
                    {notice ? (
                      <p className="mt-1 text-xs text-muted-foreground">{notice}</p>
                    ) : (
                      <>
                        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                          {BUCKET_KEYS.map((k) => (
                            <div key={k} className="flex items-baseline justify-between gap-2">
                              <dt className="text-muted-foreground">{d.buckets[k].label}</dt>
                              <dd className="font-medium">{k === "converted" ? <Converted row={r} /> : <Num v={r.outcomes[k]} />}</dd>
                            </div>
                          ))}
                        </dl>
                        <div className="mt-2"><Breakdown row={r} /></div>
                        <CoverageNotes row={r} />
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

            <dl className="mt-4 space-y-1 text-xs" data-testid="bucket-glossary">
              {BUCKET_KEYS.map((k) => (
                <div key={k} className="flex gap-1.5">
                  <dt className="flex shrink-0 items-center gap-1.5 font-semibold">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BAR[k] }} aria-hidden="true" />
                    {d.buckets[k].label}:
                  </dt>
                  <dd className="text-muted-foreground">{d.buckets[k].means}</dd>
                </div>
              ))}
            </dl>

            {rows.some((r) => r.withheld.length > 0) && (
              <div className="mt-3 space-y-1 text-xs text-muted-foreground" data-testid="withheld-explained">
                {rows.filter((r) => r.withheld.length > 0).map((r) => (
                  <p key={r.entry_month}>
                    <strong className="text-foreground">{monthLabel(r.entry_month)}:</strong> {withheldReasons(r).join(" ")}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-5 space-y-2 text-xs leading-relaxed text-muted-foreground" data-testid="counting-notes">
              <p>
                <strong className="text-foreground">Each linked patient is counted once,</strong> in exactly one
                column, in the month of their first {noun}. Every appointment on the chart counts, whatever its
                type or date — including appointments made before the form.
              </p>
              <p>
                Submissions that were never linked to a patient chart cannot be followed to an appointment. They
                are shown beside each month as a count of submissions — not people — and are not in the columns.
              </p>
              <p>
                Small groups are withheld inside the database, together with anything that would let them be
                worked out. &ldquo;Withheld&rdquo; never means zero.
              </p>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
