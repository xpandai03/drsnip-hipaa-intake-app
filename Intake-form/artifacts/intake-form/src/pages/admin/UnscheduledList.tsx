// The patients behind one count on "Unscheduled at day 14". Admin only.
//
// Minimum necessary: name, first registration date and days since, most
// recent appointment, a link to the submission in this console, and the
// DrChrono chart. The rows come from the same definition as the counts, so the
// total here equals the number that was clicked.

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { useAuth } from "@/lib/auth-context";
import { clinicTime } from "@/components/reporting/freshness";

type Cohort = { kind: "month"; month: string } | { kind: "range"; from: string; to: string } | { kind: "none" };
type ListRow = {
  chart_id: string;
  submission_id: string | null;
  name: string;
  registered_on: string;
  days_since: number;
  has_appointment: boolean;
  latest_status: string | null;
  latest_date: string | null;
};
type ListResponse = {
  bucket: string;
  bucket_label: string;
  cohort: Cohort;
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

/** "June 2026: never booked, no appointment (57)" */
export function listTitle(d: Pick<ListResponse, "cohort" | "bucket_label" | "total">): string {
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

export default function UnscheduledList() {
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
    for (const k of ["bucket", "month", "range"]) {
      const v = params.get(k);
      if (v !== null) p.set(k, v);
    }
    p.set("page", String(page));
    return p.toString();
  }, [params, page]);

  const q = useQuery({
    queryKey: ["unscheduled-list", apiQs],
    queryFn: () => getJson<ListResponse>(`/api/admin/unscheduled/list?${apiQs}`),
    enabled: isAdmin,
    placeholderData: (prev) => prev,
    retry: 1,
  });
  const d = q.data;

  return (
    <AdminLayout>
      <div data-testid="unscheduled-list-page">
        <Link href="/admin/unscheduled" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline" data-testid="back-link">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Unscheduled at day 14
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
            <h1 className="text-xl font-semibold" data-testid="list-title">{listTitle(d)}</h1>
            {d.cohort.kind === "month" && !dayFourteenReached(d.cohort.month) && (
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-200" data-testid="list-not-day14">
                Some of these patients registered less than 14 days ago and have not reached day 14 yet.
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Oldest registration first. Each patient appears once, under their first registration.
            </p>

            <div className="mt-4 overflow-x-auto rounded-lg border bg-card">
              <table className="w-full text-sm" data-testid="list-table">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Patient</th>
                    <th scope="col" className="px-3 py-2 font-medium">First registered</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Days since</th>
                    <th scope="col" className="px-3 py-2 font-medium">Most recent appointment</th>
                    <th scope="col" className="px-3 py-2 font-medium">Submission</th>
                    <th scope="col" className="px-3 py-2 font-medium">DrChrono chart</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.chart_id} className="border-b last:border-0" data-testid="list-row">
                      <td className="px-3 py-2 font-medium">{r.name || <span className="text-muted-foreground">(no name)</span>}</td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.registered_on}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.days_since}</td>
                      <td className="px-3 py-2"><Appointment r={r} /></td>
                      <td className="px-3 py-2">
                        {r.submission_id ? (
                          <Link href={`/admin/submissions/${r.submission_id}`} className="text-primary hover:underline">Open</Link>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {/* Same chart URL the submission detail modal uses. */}
                        <a href={`https://app.drchrono.com/chart/${r.chart_id}/documents`} target="_blank" rel="noopener noreferrer"
                          className="text-primary hover:underline">{r.chart_id}</a>
                      </td>
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
 * True once day 14 has passed for the month's last registrant: the same rule
 * the counts use (month end + 14 days). Approximate to the hour across DST,
 * which only affects the wording of a note.
 */
export function dayFourteenReached(month: string, now: Date = new Date()): boolean {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const nextMonthStartPacific = Date.UTC(y, m, 1, 8); // 00:00 PST ≈ 08:00 UTC
  return now.getTime() >= nextMonthStartPacific + 14 * 86400000;
}
