// Not booked — registrations whose patient has nothing booked as of today, by
// the month they registered, split into canceled or no show / no appointment.
//
// Admin only, counts only. THE PAGE CALCULATES NOTHING: every count, share and
// the headline come from /api/admin/not-booked.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { RefreshCw } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { PageHeader } from "./PageHeader";
import { useAuth } from "@/lib/auth-context";
import { clinicTime } from "@/components/reporting/freshness";

type Month = {
  form_month: string;
  complete: boolean;
  cohort: number;
  not_booked: number;
  not_booked_pct: number | null;
  canceled_or_no_show: number;
  no_appointment: number;
};
type Totals = Omit<Month, "form_month" | "complete"> & {
  from_month: string;
  to_month: string;
  months: number;
  avg_not_booked_per_month: number;
};
type NotBookedResponse = {
  months: Month[];
  totals: Totals | null;
  right_now: { registrations_30d: number; not_yet_synced: number; not_booked_now: number };
  data_as_of: string | null;
  headline: string | null;
};

const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => `${LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const num = (v: number) => v.toLocaleString("en-US");
const share = (p: number | null) => (p === null ? "" : `${p.toFixed(1)}%`);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return (await res.json()) as T;
}

/** A count that opens the patients behind it. 0 is plain text. */
function CountLink({ n, bucket, cohort }: { n: number; bucket: string; cohort: string }) {
  if (n <= 0) return <>{num(n)}</>;
  return (
    <Link
      href={`/admin/not-booked/list?bucket=${bucket}${cohort ? `&${cohort}` : ""}`}
      className="hover:underline focus-visible:underline focus-visible:outline-none"
      data-testid={`link-${bucket}`}
    >
      {num(n)}
    </Link>
  );
}

function Row({ label, m, cohort, total = false }: { label: string; m: Month | Totals; cohort: string; total?: boolean }) {
  return (
    <tr className={`border-b last:border-0 ${total ? "bg-muted/40 font-semibold" : ""}`} data-testid={total ? "row-total" : `row-${label}`}>
      <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">{label}</th>
      <td className="px-3 py-2 text-right tabular-nums">{num(m.cohort)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        <CountLink n={m.not_booked} bucket="not_booked" cohort={cohort} />{" "}
        <span className="text-xs font-normal text-muted-foreground">{share(m.not_booked_pct)}</span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums"><CountLink n={m.canceled_or_no_show} bucket="canceled_noshow" cohort={cohort} /></td>
      <td className="px-3 py-2 text-right tabular-nums"><CountLink n={m.no_appointment} bucket="no_appointment" cohort={cohort} /></td>
    </tr>
  );
}

function Report({ d }: { d: NotBookedResponse }) {
  const asOf = clinicTime(d.data_as_of);
  const t = d.totals;
  return (
    <>
      {d.headline && (
        <p className="mb-4 rounded-lg border bg-card px-4 py-3 text-lg font-semibold" data-testid="not-booked-headline">
          {d.headline}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm" data-testid="not-booked-table">
          <caption className="sr-only">Registrations by month, and how many have nothing booked as of today.</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">Registered in</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Registrations</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Not booked</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Canceled or no show</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">No appointment</th>
            </tr>
          </thead>
          <tbody>
            {d.months.map((m) => (
              <Row key={m.form_month} label={`${monthName(m.form_month)}${m.complete ? "" : " (this month so far)"}`} m={m} cohort={`month=${m.form_month}`} />
            ))}
            {t && <Row label={`${monthName(t.from_month)} – ${monthName(t.to_month)}`} m={t} cohort={`range=${t.from_month}..${t.to_month}`} total />}
          </tbody>
        </table>
      </div>
      {t && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="not-booked-average">
          On average {num(t.avg_not_booked_per_month)} registrations a month have not booked ({monthName(t.from_month)} to {monthName(t.to_month)}).
          “Canceled or no show” and “No appointment” split the “Not booked” count.
        </p>
      )}

      <section className="mt-6 rounded-lg border bg-card p-4" data-testid="not-booked-right-now">
        <h2 className="text-sm font-semibold">Right now</h2>
        <p className="mt-1 text-sm">
          Of <strong>{num(d.right_now.registrations_30d)}</strong> registrations in the last 30 days,{" "}
          <strong><CountLink n={d.right_now.not_booked_now} bucket="right_now_not_booked" cohort="" /></strong> have not booked yet.
          {d.right_now.not_yet_synced > 0 && <> {num(d.right_now.not_yet_synced)} more are waiting for their appointment history to be read.</>}
        </p>
      </section>

      <p className="mt-4 text-sm" data-testid="not-booked-as-of">
        <strong>Data as of {asOf ?? "— unavailable"}</strong>{asOf ? " (Pacific)" : ""}.
      </p>

      <div className="mt-4 space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          Each person is counted once, in the month of their first registration. “Booked” uses the clinic&rsquo;s own
          definition (the same one as <Link href="/admin/conversion" className="underline">Conversion by cohort</Link>):
          an appointment on their chart that is complete, signed no review, procedure not performed, checked in,
          checked in online, arrived, ready or in a room, in session, scheduled, confirmed or rescheduled. Anyone
          without one is not booked.
        </p>
        <p>
          A blank or any other status is ignored: a patient whose appointments all have an ignored status is not
          counted. Select any count to see the patients behind it.
        </p>
      </div>
    </>
  );
}

export default function NotBooked() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const q = useQuery({
    queryKey: ["not-booked"],
    queryFn: () => getJson<NotBookedResponse>("/api/admin/not-booked"),
    enabled: isAdmin,
    retry: 1,
  });

  return (
    <AdminLayout>
      <div data-testid="not-booked-page">
        <PageHeader
          eyebrow="Actual intake data"
          title="Not booked"
          subtitle="Registrations whose patient has nothing booked as of today, by the month they registered."
        />
        {!isAdmin ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="not-booked-admin-only">
            This page is available to admins only.
          </p>
        ) : q.isError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert" data-testid="not-booked-error">
            <p className="font-medium">This report could not be loaded.</p>
            <button type="button" onClick={() => { void q.refetch(); }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </button>
          </div>
        ) : !q.data ? (
          <div className="h-40 animate-pulse rounded-lg border bg-card" role="status" aria-busy="true" data-testid="not-booked-loading">
            <span className="sr-only">Loading.</span>
          </div>
        ) : (
          <Report d={q.data} />
        )}
      </div>
    </AdminLayout>
  );
}
