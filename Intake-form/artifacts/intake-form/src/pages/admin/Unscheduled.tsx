// Unscheduled at day 14 — registrations with nothing booked two weeks after the
// patient first registered, and what happened to them afterwards.
//
// Admin only, counts only. THE PAGE CALCULATES NOTHING: every count, share and
// the headline come from /api/admin/unscheduled-day14.

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
  unscheduled_d14: number;
  unscheduled_pct: number | null;
  booked_later: number;
  booked_later_pct: number | null;
  never: number;
  never_pct: number | null;
  never_no_appointment: number;
  never_canceled_or_no_show: number;
  never_no_status_only: number;
};
type Totals = Omit<Month, "form_month" | "complete"> & {
  from_month: string;
  to_month: string;
  months: number;
  avg_unscheduled_per_month: number;
};
type Day14Response = {
  months: Month[];
  totals: Totals | null;
  right_now: { registrations_30d: number; not_yet_synced: number; nothing_booked_now: number; past_day_14: number };
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
      href={`/admin/unscheduled/list?bucket=${bucket}${cohort ? `&${cohort}` : ""}`}
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
        <CountLink n={m.unscheduled_d14} bucket="unscheduled_d14" cohort={cohort} />{" "}
        <span className="text-xs font-normal text-muted-foreground">{share(m.unscheduled_pct)}</span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        <CountLink n={m.booked_later} bucket="booked_later" cohort={cohort} />{" "}
        <span className="text-xs font-normal text-muted-foreground">{share(m.booked_later_pct)}</span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        <CountLink n={m.never} bucket="never_booked" cohort={cohort} />{" "}
        <span className="text-xs font-normal text-muted-foreground">{share(m.never_pct)}</span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums"><CountLink n={m.never_no_appointment} bucket="never_no_appt" cohort={cohort} /></td>
      <td className="px-3 py-2 text-right tabular-nums"><CountLink n={m.never_canceled_or_no_show} bucket="never_canceled_noshow" cohort={cohort} /></td>
      <td className="px-3 py-2 text-right tabular-nums"><CountLink n={m.never_no_status_only} bucket="never_no_status" cohort={cohort} /></td>
    </tr>
  );
}

function Report({ d }: { d: Day14Response }) {
  const asOf = clinicTime(d.data_as_of);
  const t = d.totals;
  return (
    <>
      {d.headline && (
        <p className="mb-4 rounded-lg border bg-card px-4 py-3 text-lg font-semibold" data-testid="day14-headline">
          {d.headline}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm" data-testid="day14-table">
          <caption className="sr-only">Registrations by month, and how many had nothing booked 14 days after registering.</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">Registered in</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Registrations</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Nothing booked by day 14</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">…booked later</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">…never booked</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Never booked: no appointment</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Never booked: canceled or no-show</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Never booked: appointment with no status</th>
            </tr>
          </thead>
          <tbody>
            {d.months.map((m) => (
              <Row key={m.form_month} label={`${monthName(m.form_month)}${m.complete ? "" : " (day 14 not reached for everyone yet)"}`} m={m} cohort={`month=${m.form_month}`} />
            ))}
            {t && <Row label={`${monthName(t.from_month)} – ${monthName(t.to_month)}`} m={t} cohort={`range=${t.from_month}..${t.to_month}`} total />}
          </tbody>
        </table>
      </div>
      {t && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="day14-average">
          On average {num(t.avg_unscheduled_per_month)} registrations a month had nothing booked by day 14 ({monthName(t.from_month)} to {monthName(t.to_month)}).
          “Booked later” and “never booked” are shares of the people with nothing booked by day 14.
        </p>
      )}

      <section className="mt-6 rounded-lg border bg-card p-4" data-testid="day14-right-now">
        <h2 className="text-sm font-semibold">Right now</h2>
        <p className="mt-1 text-sm">
          Of <strong>{num(d.right_now.registrations_30d)}</strong> registrations in the last 30 days,{" "}
          <strong><CountLink n={d.right_now.nothing_booked_now} bucket="right_now_unbooked" cohort="" /></strong> have nothing booked yet.{" "}
          <strong><CountLink n={d.right_now.past_day_14} bucket="right_now_past_d14" cohort="" /></strong> of those registered more than 14 days ago.
          {d.right_now.not_yet_synced > 0 && <> {num(d.right_now.not_yet_synced)} more are waiting for their appointment history to be read.</>}
        </p>
      </section>

      <p className="mt-4 text-sm" data-testid="day14-as-of">
        <strong>Data as of {asOf ?? "— unavailable"}</strong>{asOf ? " (Pacific)" : ""}.
      </p>

      <div className="mt-4 space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          Each person is counted once, from the day of their first registration. “Booked” uses the clinic&rsquo;s own
          definition (the same one as <Link href="/admin/conversion" className="underline">Conversion by cohort</Link>):
          an appointment on their chart that is complete, signed, procedure not performed, checked in, ready in a room,
          in session, scheduled, confirmed or rescheduled. The booking date is when that appointment was created; one
          made before the registration counts as booked by day 14.
        </p>
        <p>
          “Appointment with no status” means appointments exist on the chart but none has a status the clinic has
          defined (most often a blank status). Select any count to see the patients behind it.
        </p>
      </div>
    </>
  );
}

export default function Unscheduled() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const q = useQuery({
    queryKey: ["unscheduled-day14"],
    queryFn: () => getJson<Day14Response>("/api/admin/unscheduled-day14"),
    enabled: isAdmin,
    retry: 1,
  });

  return (
    <AdminLayout>
      <div data-testid="unscheduled-page">
        <PageHeader
          eyebrow="Actual intake data"
          title="Unscheduled at day 14"
          subtitle="Registrations with nothing booked two weeks after the patient first registered, and what happened to them afterwards."
        />
        {!isAdmin ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="day14-admin-only">
            This page is available to admins only.
          </p>
        ) : q.isError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert" data-testid="day14-error">
            <p className="font-medium">This report could not be loaded.</p>
            <button type="button" onClick={() => { void q.refetch(); }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </button>
          </div>
        ) : !q.data ? (
          <div className="h-40 animate-pulse rounded-lg border bg-card" role="status" aria-busy="true" data-testid="day14-loading">
            <span className="sr-only">Loading.</span>
          </div>
        ) : (
          <Report d={q.data} />
        )}
      </div>
    </AdminLayout>
  );
}
