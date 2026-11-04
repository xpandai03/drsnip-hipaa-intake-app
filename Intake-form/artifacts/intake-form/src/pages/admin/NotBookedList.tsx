// The patients behind one count on "Not booked" or "Conversion by cohort".
// Admin only. One page component serves both sources.
//
// Minimum necessary: name, first registration date and days since, most
// recent appointment, a link to the submission in this console, and the
// DrChrono chart. Not booked lists add the marketing source and why the
// patient is not booked (canceled or no show / no appointment); conversion
// lists add "Converted on".

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, RefreshCw } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { useAuth } from "@/lib/auth-context";
import { clinicTime } from "@/components/reporting/freshness";

type Cohort = { kind: "month"; month: string } | { kind: "range"; from: string; to: string } | { kind: "none" };
type ListRow = {
  chart_id: string | null;
  submission_id: string | null;
  name: string;
  /** Not booked lists only. */
  source?: string | null;
  registered_on: string;
  days_since: number;
  has_appointment: boolean;
  latest_status: string | null;
  latest_date: string | null;
  converted_on?: string | null;
  /** Not booked lists only. */
  status?: "Canceled or no show" | "No appointment";
};
type ListResponse = {
  title?: string;
  bucket: string;
  bucket_label?: string;
  cohort?: Cohort;
  total: number;
  page: number;
  page_size: number;
  pages: number;
  data_as_of: string | null;
  rows: ListRow[];
};

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => `${LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "June 2026: not booked, no appointment (57)" */
export function listTitle(d: Pick<ListResponse, "cohort" | "bucket_label" | "total" | "title">): string {
  if (d.title) return d.title;
  if (!d.cohort || !d.bucket_label) return `${d.total.toLocaleString("en-US")} patients`;
  const who = d.cohort.kind === "month" ? monthName(d.cohort.month)
    : d.cohort.kind === "range" ? `${monthName(d.cohort.from)} – ${monthName(d.cohort.to)}` : "";
  return who ? `${who}: ${d.bucket_label} (${d.total.toLocaleString("en-US")})`
    : `${capital(d.bucket_label)} (${d.total.toLocaleString("en-US")})`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return (await res.json()) as T;
}

function Appointment({ r }: { r: ListRow }) {
  if (!r.has_appointment) return <span className="text-muted-foreground">No appointment</span>;
  return (
    <span>
      {r.latest_status ?? <span className="text-muted-foreground">No status</span>}
      {r.latest_date && <span className="text-muted-foreground"> · {r.latest_date}</span>}
    </span>
  );
}

/** Where a patient list comes from. One page component serves every source. */
export type ListSource = {
  id: string;
  api: string;
  csv: string;
  /** Query keys passed through to the API (never "page" — that is ours). */
  keys: readonly string[];
  back: (params: URLSearchParams) => { href: string; label: string };
  /** Conversion lists show "Converted on". */
  convertedOn: boolean;
  /** Label for the first-form date column. */
  firstLabel: (params: URLSearchParams) => string;
  /** Not booked lists: the Source and Status columns, and the note for a month still running. */
  notBooked: boolean;
};

export const NOT_BOOKED_SOURCE: ListSource = {
  id: "not-booked",
  api: "/api/admin/not-booked/list",
  csv: "/api/admin/not-booked/list.csv",
  keys: ["bucket", "month", "range"],
  back: () => ({ href: "/admin/not-booked", label: "Not booked" }),
  convertedOn: false,
  firstLabel: () => "Registered",
  notBooked: true,
};

export const CONVERSION_SOURCE: ListSource = {
  id: "conversion",
  api: "/api/admin/conversion/list",
  csv: "/api/admin/conversion/list.csv",
  keys: ["form", "grain", "period", "bucket"],
  back: (p) => ({
    href: `/admin/conversion?form=${p.get("form") === "insurance" ? "insurance" : "registration"}&grain=${p.get("grain") === "week" ? "week" : "month"}`,
    label: "Conversion by cohort",
  }),
  convertedOn: true,
  firstLabel: (p) => (p.get("form") === "insurance" ? "First inquiry" : "First registered"),
  notBooked: false,
};

export default function NotBookedList() {
  return <PatientListPage source={NOT_BOOKED_SOURCE} />;
}

export function PatientListPage({ source }: { source: ListSource }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);

  const goPage = useCallback((n: number) => {
    const p = new URLSearchParams(window.location.search);
    p.set("page", String(n));
    window.history.pushState(null, "", `${window.location.pathname}?${p.toString()}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.scrollTo({ top: 0 });
  }, []);

  const apiQs = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of source.keys) {
      const v = params.get(k);
      if (v !== null) p.set(k, v);
    }
    p.set("page", String(page));
    return p.toString();
  }, [params, page, source]);

  // The export takes the same bucket and cohort, never a page: it is every row.
  const csvQs = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of source.keys) {
      const v = params.get(k);
      if (v !== null) p.set(k, v);
    }
    return p.toString();
  }, [params, source]);

  const q = useQuery({
    queryKey: [`${source.id}-list`, apiQs],
    queryFn: () => getJson<ListResponse>(`${source.api}?${apiQs}`),
    enabled: isAdmin,
    placeholderData: (prev) => prev,
    retry: 1,
  });
  const d = q.data;
  const back = source.back(params);

  return (
    <AdminLayout>
      <div data-testid={`${source.id}-list-page`}>
        <Link href={back.href} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline" data-testid="back-link">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> {back.label}
        </Link>

        {!isAdmin ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="list-admin-only">
            This page is available to admins only.
          </p>
        ) : q.isError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert" data-testid="list-error">
            <p className="font-medium">This list could not be loaded.</p>
            <p className="mt-1 text-muted-foreground">{q.error instanceof Error ? q.error.message : ""}</p>
            <button type="button" onClick={() => { void q.refetch(); }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </button>
          </div>
        ) : !d ? (
          <div className="h-40 animate-pulse rounded-lg border bg-card" role="status" aria-busy="true" data-testid="list-loading">
            <span className="sr-only">Loading.</span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-xl font-semibold" data-testid="list-title">{listTitle(d)}</h1>
              {d.total > 0 && (
                <a
                  href={`${source.csv}?${csvQs}`}
                  download
                  data-testid="export-csv"
                  className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export CSV
                </a>
              )}
            </div>
            {source.notBooked && d.cohort?.kind === "month" && !monthEnded(d.cohort.month) && (
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-200" data-testid="list-month-running">
                This month is still running: some of these patients registered only recently.
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Oldest first. Each patient appears once, under their first {source.firstLabel(params) === "First inquiry" ? "insurance inquiry" : "registration"}.
            </p>

            <div className="mt-4 overflow-x-auto rounded-lg border bg-card">
              <table className="w-full text-sm" data-testid="list-table">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Patient</th>
                    {source.notBooked && <th scope="col" className="px-3 py-2 font-medium">Source</th>}
                    <th scope="col" className="px-3 py-2 font-medium">{source.firstLabel(params)}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Days since</th>
                    <th scope="col" className="px-3 py-2 font-medium">Most recent appointment</th>
                    {source.notBooked && <th scope="col" className="px-3 py-2 font-medium">Status</th>}
                    <th scope="col" className="px-3 py-2 font-medium">Submission</th>
                    <th scope="col" className="px-3 py-2 font-medium">DrChrono chart</th>
                    {source.convertedOn && <th scope="col" className="px-3 py-2 font-medium">Converted on</th>}
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.chart_id ?? r.submission_id ?? r.registered_on} className="border-b last:border-0" data-testid="list-row">
                      <td className="px-3 py-2 font-medium">{r.name || <span className="text-muted-foreground">(no name)</span>}</td>
                      {source.notBooked && (
                        <td className="px-3 py-2" data-testid="cell-source">{r.source ?? <span className="text-muted-foreground">—</span>}</td>
                      )}
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.registered_on}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.days_since}</td>
                      <td className="px-3 py-2"><Appointment r={r} /></td>
                      {source.notBooked && <td className="whitespace-nowrap px-3 py-2" data-testid="cell-status">{r.status ?? ""}</td>}
                      <td className="px-3 py-2">
                        {r.submission_id ? (
                          <Link href={`/admin/submissions/${r.submission_id}`} className="text-primary hover:underline">Open</Link>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {/* Same chart URL the submission detail modal uses. */}
                        {r.chart_id ? (
                          <a href={`https://app.drchrono.com/chart/${r.chart_id}/documents`} target="_blank" rel="noopener noreferrer"
                            className="text-primary hover:underline">{r.chart_id}</a>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      {source.convertedOn && <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.converted_on ?? ""}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {d.pages > 1 && (
              <div className="mt-3 flex items-center gap-2 text-sm" data-testid="list-pagination">
                <button type="button" disabled={d.page <= 1} onClick={() => goPage(d.page - 1)}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 disabled:opacity-40">
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Previous
                </button>
                <span className="text-muted-foreground">Page {d.page} of {d.pages}</span>
                <button type="button" disabled={d.page >= d.pages} onClick={() => goPage(d.page + 1)}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 disabled:opacity-40">
                  Next <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )}

            <p className="mt-4 text-sm" data-testid="list-as-of">
              <strong>Data as of {clinicTime(d.data_as_of) ?? "— unavailable"}</strong>{d.data_as_of ? " (Pacific)" : ""}.
            </p>
          </>
        )}
      </div>
    </AdminLayout>
  );
}

/**
 * True once the month has ended on the clinic calendar: the same rule the
 * counts use for "complete". Approximate to the hour across DST, which only
 * affects the wording of a note.
 */
export function monthEnded(month: string, now: Date = new Date()): boolean {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const nextMonthStartPacific = Date.UTC(y, m, 1, 8); // 00:00 PST ≈ 08:00 UTC
  return now.getTime() >= nextMonthStartPacific;
}
