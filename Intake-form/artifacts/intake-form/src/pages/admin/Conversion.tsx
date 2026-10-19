// Conversion by cohort — the view the clinic asked for on 2026-09-21.
//
// "Forms submitted in month X: what share has converted as of today, and how
// did that fill in — by the end of X, X+1, X+2, X+3, later?" Registration and
// insurance separately; by month or by ISO week.
//
// THE PAGE CALCULATES NOTHING. Every count and share comes from
// /api/reports/conversion-cohorts (see conversion-view.ts for the cell rules):
// a period that has not ended is BLANK, a protected small group says
// "Withheld", and neither is ever shown as 0.

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { RefreshCw, AlertTriangle, CheckCircle2, Download } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { AdminLayout } from "./AdminLayout";
import { PageHeader } from "./PageHeader";
import { clinicTime } from "@/components/reporting/freshness";
import {
  FORMS, GRAINS,
  type CohortsResponse, type PeriodRow, type ViewState,
  fillText, isStale, parseViewState, pctText, periodLabel, rowNotice, rowSentence, toSearch,
} from "./conversion-view";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return (await res.json()) as T;
}

function Toggle<T extends string>({ label, value, options, onChange, testPrefix }: {
  label: string; value: T; options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void; testPrefix: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          data-testid={`${testPrefix}-${o.id}`}
          onClick={() => onChange(o.id)}
          className={`rounded px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            value === o.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Fill({ c }: { c: PeriodRow["fill"][number] }) {
  const f = fillText(c);
  if (f.kind === "not_ended") return <span data-testid="fill-not-ended" aria-label="Period not ended" />;
  if (f.kind === "withheld") {
    return (
      <span className="inline-flex rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground" data-testid="fill-withheld">
        Withheld
      </span>
    );
  }
  return <span className="tabular-nums" data-testid="fill-value">{f.text}</span>;
}

function ConvertedNow({ r }: { r: PeriodRow }) {
  const p = pctText(r.converted_now.pct);
  if (r.converted_now.count === null || p === null) {
    return (
      <span className="inline-flex rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground" data-testid="converted-withheld">
        Withheld
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-1.5" data-testid="converted-now">
      <span className="font-semibold tabular-nums">{p}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{r.converted_now.count.toLocaleString("en-US")}</span>
    </span>
  );
}

/** Admin only: the unclassified-appointment CSV, with the same count the file has. */
function UnclassifiedExport() {
  const q = useQuery({
    queryKey: ["unclassified-count"],
    queryFn: () => getJson<{ rows: number; no_other_converted: number }>("/api/reports/unclassified-count"),
    retry: 1,
  });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="unclassified-export">
      <a
        href="/admin/conversion/unclassified.csv"
        download
        data-testid="unclassified-download"
        className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        Download unclassified appointments (CSV)
      </a>
      <span className="text-xs text-muted-foreground" data-testid="unclassified-count">
        {q.data ? `${q.data.rows.toLocaleString("en-US")} rows` : q.isError ? "count unavailable" : "counting…"}
      </span>
    </div>
  );
}

export default function Conversion() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const search = useSearch();
  const view = useMemo(() => parseViewState(search), [search]);
  const go = useCallback((next: ViewState) => {
    const qs = toSearch(next);
    if (qs === new URLSearchParams(window.location.search).toString()) return;
    window.history.pushState(null, "", `${window.location.pathname}?${qs}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const url = `/api/reports/conversion-cohorts?form=${view.form}&grain=${view.grain}`;
  const q = useQuery({
    queryKey: ["conversion-cohorts", view.form, view.grain],
    queryFn: () => getJson<CohortsResponse>(url),
    placeholderData: (prev) => prev,
    retry: 1,
  });
  const d = q.data;
  const cutoff = d ? clinicTime(d.as_of.evidence_cutoff) : null;
  const periodWord = view.grain === "month" ? "month" : "week";

  return (
    <AdminLayout>
      <div data-testid="conversion-page">
        <PageHeader
          eyebrow="Actual intake data"
          title="Conversion by cohort"
          subtitle="Patients grouped by when their first form came in: the share converted as of today, and how that filled in over the following periods."
        >
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center rounded-full border border-emerald-600/30 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              Actual intake data
            </span>
            <Link
              href={`/admin/outcomes?cohort=${view.form}`}
              data-testid="link-monthly-outcomes"
              className="rounded-full border px-2 py-0.5 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Monthly outcomes →
            </Link>
          </div>
        </PageHeader>

        {d && (
          <div className="mb-4 flex gap-2 rounded-lg border border-emerald-600/30 bg-emerald-50/60 px-3 py-2 text-xs leading-relaxed text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100" data-testid="rules-banner" role="note">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <p>
              <strong>The clinic&rsquo;s definition</strong>
              {d.rules.confirmed_on ? ` (${d.rules.confirmed_by ?? "client"}, ${d.rules.confirmed_on})` : ""}.{" "}
              {d.rules.explanation} The conversion date is when the earliest converted appointment was created.
            </p>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Toggle label="Which form" value={view.form} options={FORMS} onChange={(form) => go({ ...view, form })} testPrefix="form" />
          <Toggle label="Group by" value={view.grain} options={GRAINS} onChange={(grain) => go({ ...view, grain })} testPrefix="grain" />
          {isAdmin && <UnclassifiedExport />}
        </div>

        {d && (
          <p className="mb-3 text-sm" data-testid="data-complete-to">
            <strong>Appointment data complete to {cutoff ?? "— unavailable"}</strong>
            <span className="text-muted-foreground">{cutoff ? " (Pacific). Updated hourly." : ""}</span>
          </p>
        )}
        {d && isStale(d.as_of.evidence_age_minutes) && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-200" data-testid="stale-warning" role="status">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Appointment data has not been refreshed for over three hours. Figures may be behind.
          </p>
        )}
        {q.isFetching && d && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> Updating.
          </p>
        )}

        {q.isError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" data-testid="conversion-error" role="alert">
            <p className="font-medium">Conversion by cohort could not be loaded.</p>
            <p className="mt-1 text-muted-foreground">Nothing is shown rather than a zero — a failed request is not a result.</p>
            <button type="button" onClick={() => { void q.refetch(); }} data-testid="conversion-retry"
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </button>
          </div>
        ) : !d ? (
          <div className="rounded-lg border bg-card p-4" data-testid="conversion-loading" role="status" aria-busy="true">
            <span className="sr-only">Loading conversion by cohort.</span>
            <div className="h-4 w-56 animate-pulse rounded bg-muted" />
            <div className="mt-4 space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-5 animate-pulse rounded bg-muted" />)}</div>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
              <table className="w-full text-sm" data-testid="conversion-table">
                <caption className="sr-only">
                  {d.label} cohorts by {periodWord}, newest first. Each linked patient is counted once, in the {periodWord} of their first form.
                </caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">{view.grain === "month" ? "Form month" : "Form week"}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Forms</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Converted as of today</th>
                    {d.columns.map((col) => (
                      <th key={col} scope="col" className="px-3 py-2 text-right font-medium">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.periods.map((r) => {
                    const notice = rowNotice(r);
                    return (
                      <tr key={r.period_start} className="border-b last:border-0" data-testid={`period-${r.period_start}`}>
                        <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">
                          {periodLabel(r.period_start, view.grain)}
                          {r.status === "ok" && !r.period_complete && (
                            <span className="block text-[11px] font-normal text-muted-foreground">still running</span>
                          )}
                        </th>
                        {notice ? (
                          <td colSpan={7} className="px-3 py-2 text-xs text-muted-foreground">{notice}</td>
                        ) : (
                          <>
                            <td className="px-3 py-2 text-right tabular-nums" data-testid="forms">{(r.forms ?? 0).toLocaleString("en-US")}</td>
                            <td className="px-3 py-2 text-right"><ConvertedNow r={r} /></td>
                            {r.fill.map((c, i) => (
                              <td key={i} className="px-3 py-2 text-right" data-testid={`fill-${i}`}><Fill c={c} /></td>
                            ))}
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* PHONE: one card per period, no sideways scrolling. */}
            <ul className="grid gap-3 md:hidden" data-testid="conversion-cards">
              {d.periods.map((r) => {
                const notice = rowNotice(r);
                return (
                  <li key={r.period_start} className="rounded-lg border bg-card p-3" data-testid={`card-${r.period_start}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold">{periodLabel(r.period_start, view.grain)}</h3>
                      {!notice && <span className="text-xs text-muted-foreground">{(r.forms ?? 0).toLocaleString("en-US")} forms</span>}
                    </div>
                    {notice ? (
                      <p className="mt-1 text-xs text-muted-foreground">{notice}</p>
                    ) : (
                      <>
                        <div className="mt-1 text-xs text-muted-foreground">Converted as of today: <ConvertedNow r={r} /></div>
                        <dl className="mt-2 grid grid-cols-5 gap-1 text-center text-xs">
                          {d.columns.map((col, i) => (
                            <div key={col}>
                              <dt className="text-[11px] text-muted-foreground">{col}</dt>
                              <dd className="mt-0.5 min-h-[1.25rem]"><Fill c={r.fill[i]} /></dd>
                            </div>
                          ))}
                        </dl>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="mt-4 space-y-0.5 text-xs text-muted-foreground" data-testid="row-sentences">
              {d.periods.map((r) => {
                const s = rowSentence(r, view.grain);
                return s ? <p key={r.period_start}>{s}</p> : null;
              })}
            </div>

            <div className="mt-5 space-y-2 text-xs leading-relaxed text-muted-foreground" data-testid="counting-notes">
              <p>
                <strong className="text-foreground">P+0</strong> is the {periodWord} the form came in;{" "}
                <strong className="text-foreground">P+1</strong> the next, and so on. Each column is the share of the
                cohort converted <em>by the end of</em> that {periodWord}. <strong className="text-foreground">Later</strong>{" "}
                is the share converted by today, shown once P+3 has ended. A blank cell is a {periodWord} that has not
                ended yet — it is not zero.
              </p>
              <p>
                Forms counts patients, not submissions: each linked patient once, in the {periodWord} of their first{" "}
                {view.form === "insurance" ? "insurance inquiry" : "registration"}. An appointment made before the form
                counts in P+0. Submissions never linked to a chart are not counted.
              </p>
              <p>&ldquo;Converted as of today&rdquo; for a month is the same number Monthly outcomes shows for that month.</p>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
