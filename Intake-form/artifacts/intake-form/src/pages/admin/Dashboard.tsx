import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertCircle, Info } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { PageHeader, ScopeLine } from "./PageHeader";
import { Skeleton } from "@/components/ui/skeleton";

// ===========================================================================
// Intake dashboard. All data comes from aggregate-only, auth-guarded endpoints
// (/api/reports/*, /api/submissions/activity). Every grouped cell is
// <5-suppressed server-side; a suppressed cell arrives as the string "<5" and
// is never plotted.
//
// FOUR CORRECTIONS from the previous version, each of which changed what a
// reader would believe:
//
//  1. Form-type tiles are DERIVED from by_form_type instead of naming
//     "registration" and "consultation" in the component. Insurance inquiries
//     existed in the data and in the grand total but had no tile, so the tiles
//     could not add up to the total they sat beside.
//
//  2. "Success rate — 92%" is gone. It was `success / Σ(non-suppressed status
//     counts)` computed in the browser: an EHR write-back rate, presented as a
//     patient outcome, over a denominator that dropped suppressed cells (which
//     are the failure modes, so hiding one RAISED the number) and counted
//     deliberate skips as failures. The rate is now computed server-side from
//     true counts over an explicit eligible denominator, is labelled as
//     processing, and sits in its own panel away from the patient counts.
//     See writebackOutcome() in api/_lib/reporting.ts.
//
//  3. "New vs returning" is gone. It read create/update/matched out of the
//     DrChrono response, where every consultation is hard-coded 'matched' and
//     'create' only means "no existing chart matched the identity supplied".
//     It is now labelled as what it is: a record-processing action.
//
//  4. Subtitles state the population their query actually covers. The office
//     and coverage tiles claimed a form-type scope the queries never applied.
//
// Dates are clinic days (Pacific) throughout, matching the CSV exports. They
// used to be UTC here, so an evening submission was charted on the next day.
// ===========================================================================

// ---- shared types ---------------------------------------------------------
type Count = number | string; // number, or "<5" when suppressed
type CountRow = { value: string | null; count: Count };
type Scope = {
  form_type: string | null;
  from: string | null;
  to: string | null;
  location: string | null;
  timezone: string;
  timezone_label: string;
  unit: string;
};
type CountsResponse = {
  dimension: string;
  rows: CountRow[];
  suppressed_cells: number;
  scope?: Scope;
  note?: string;
};
type Writeback = {
  resolved: number;
  succeeded: number;
  manual_review: Count;
  failed: Count;
  pending: Count;
  skipped: Count;
  rate_pct: number | null;
  basis: string;
};
type SummaryResponse = {
  total_submissions: number;
  date_range: { from: string | null; to: string | null };
  requested_range: { from: string | null; to: string | null };
  timezone_label: string;
  by_form_type: CountRow[];
  by_n8n_status: CountRow[];
  ehr_writeback: Writeback;
  suppressed_cells: number;
};
type DayBucket = {
  date: string;
  total: number;
  by_form_type: Record<string, number>;
};
type ActivityResponse = {
  start_date: string;
  end_date: string;
  timezone_label: string;
  series: string[];
  daily_counts: DayBucket[];
  summary: Record<string, number>;
};

// DrSnip blue ramp. Deep for the primary series, lighter for the rest.
const SERIES_COLOR: Record<string, string> = {
  registration: "#0F4C81",
  consultation: "#4E8ABE",
  insurance: "#A8C6E0",
};
const BAR_COLORS = [
  "#0F4C81",
  "#1D5D93",
  "#2E7CB8",
  "#4E8ABE",
  "#6FA0CB",
  "#8FB4D6",
  "#A8C6E0",
  "#C3D9EA",
];

// Human labels for the form_type values. Anything unexpected falls through to
// the raw value rather than being dropped or relabelled.
const FORM_LABEL: Record<string, string> = {
  registration: "Registrations",
  consultation: "Consultations",
  insurance: "Insurance inquiries",
};
function formLabel(value: string): string {
  return FORM_LABEL[value] ?? value;
}

// ---- date range presets ---------------------------------------------------
const RANGES = [
  { key: "7", label: "7d", days: 7 },
  { key: "30", label: "30d", days: 30 },
  { key: "90", label: "90d", days: 90 },
  { key: "all", label: "All", days: null as number | null },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

/**
 * Clinic-day range params. Uses the en-CA/Pacific formatter rather than
 * toISOString(), so "today" is the clinic's today — the previous version used
 * getUTCDate() and could start a window on tomorrow after 5pm Pacific.
 */
const CLINIC_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function clinicDay(d: Date): string {
  return CLINIC_DAY_FMT.format(d);
}
function rangeParams(rangeKey: RangeKey): { from?: string; to?: string } {
  const r = RANGES.find((x) => x.key === rangeKey)!;
  if (r.days == null) return {};
  const today = new Date();
  // Step through midday so a DST transition cannot shift the start day.
  const start = new Date(today.getTime() - (r.days - 1) * 86_400_000);
  return { from: clinicDay(start), to: clinicDay(today) };
}

// ---- fetchers -------------------------------------------------------------
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}
function qs(p: { from?: string; to?: string }, extra?: Record<string, string>) {
  const s = new URLSearchParams(extra);
  if (p.from) s.set("from", p.from);
  if (p.to) s.set("to", p.to);
  const out = s.toString();
  return out ? `?${out}` : "";
}

// ---- chartable helpers ----------------------------------------------------
/** Keep only numeric (non-suppressed) cells for plotting; report hidden count. */
function plottable(
  rows: CountRow[],
  nullLabel = "Unspecified",
): { data: { name: string; count: number }[]; hidden: number } {
  let hidden = 0;
  const data: { name: string; count: number }[] = [];
  for (const r of rows) {
    if (typeof r.count === "number") {
      data.push({ name: r.value ?? nullLabel, count: r.count });
    } else {
      hidden += 1;
    }
  }
  return { data, hidden };
}

function fmt(n: Count): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : n;
}

// ===========================================================================
export default function AdminDashboard() {
  return (
    <AdminLayout>
      <DashboardPage />
    </AdminLayout>
  );
}

function DashboardPage() {
  const [range, setRange] = useState<RangeKey>("30");
  const p = useMemo(() => rangeParams(range), [range]);

  const summary = useQuery({
    queryKey: ["reports-summary", range],
    queryFn: () => getJson<SummaryResponse>(`/api/reports/summary${qs(p)}`),
  });
  // The range picker now drives the volume chart too. It used to be pinned to a
  // fixed 90 days while the picker changed everything around it.
  const activity = useQuery({
    queryKey: ["activity", range],
    queryFn: () => getJson<ActivityResponse>(`/api/submissions/activity${qs(p)}`),
  });

  // Written out rather than generated in a loop: these are hooks, and the call
  // order must be fixed and obvious.
  const countsQuery = (dimension: string) => ({
    queryKey: [`reports-${dimension}`, range] as const,
    queryFn: () =>
      getJson<CountsResponse>(`/api/reports/counts${qs(p, { dimension })}`),
  });
  const howHeard = useQuery(countsQuery("how_heard"));
  const office = useQuery(countsQuery("office_location"));
  const coverage = useQuery(countsQuery("insurance_coverage"));
  const action = useQuery(countsQuery("action_label"));
  const source = useQuery(countsQuery("source"));

  const s = summary.data;
  const tz = s?.timezone_label ?? "clinic days (Pacific)";
  const windowLabel =
    p.from && p.to ? `${p.from} to ${p.to}` : s?.date_range.from ? `all time` : null;

  return (
    <div>
      <PageHeader
        eyebrow="Reports"
        title="Intake dashboard"
        subtitle="Aggregate intake volume and processing status. Groups of fewer than 5 are hidden for privacy."
        actions={
          <div
            className="flex gap-1.5"
            role="group"
            aria-label="Date range"
          >
            {RANGES.map((r) => {
              const on = range === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setRange(r.key)}
                  className={
                    "min-h-10 px-3 text-sm font-medium transition-colors " +
                    (on
                      ? "bg-[var(--sh-accent)] text-white"
                      : "border border-[var(--sh-border)] bg-white text-[var(--sh-muted)] hover:bg-[var(--sh-surface-hover)]")
                  }
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        }
      >
        <ScopeLine
          parts={[
            windowLabel,
            tz,
            "counted as submissions, not unique patients",
            "not de-duplicated",
          ]}
        />
      </PageHeader>

      {/* ---- Volume tiles. Derived from by_form_type, so they add up. ---- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Total submissions"
          value={s ? s.total_submissions.toLocaleString("en-US") : "—"}
          note="all forms"
          loading={summary.isLoading}
          error={summary.isError}
        />
        {(s?.by_form_type ?? []).map((row) => (
          <StatTile
            key={row.value ?? "unknown"}
            label={formLabel(row.value ?? "unknown")}
            value={fmt(row.count)}
            note="submissions"
            loading={summary.isLoading}
            error={summary.isError}
          />
        ))}
        {/* Placeholders keep the 4-up row from reflowing while loading. */}
        {summary.isLoading &&
          [0, 1, 2].map((i) => <StatTile key={`sk-${i}`} label="" value="" loading />)}
      </div>

      {s && !summary.isLoading && (
        <p className="mt-2 text-xs text-[var(--sh-muted)]">
          The form tiles sum to the total. Each counts submissions — one patient
          can appear more than once.
        </p>
      )}

      {/* ---- Volume trend ---- */}
      <Card className="mt-6">
        <CardHead
          title="Submission volume"
          subtitle={`One bar per ${tz.replace(/^clinic days/, "clinic day")}, stacked by form.`}
        />
        {activity.isLoading ? (
          <Skeleton className="h-64" />
        ) : activity.isError ? (
          <TileError />
        ) : (
          <VolumeTrend data={activity.data!} />
        )}
      </Card>

      {/* ---- Processing status. Deliberately NOT beside the patient counts. */}
      <Card className="mt-6">
        <CardHead
          title="EHR write-back"
          subtitle="Whether each submission reached DrChrono. This is processing status, not a patient outcome — a sync problem is not a drop in demand."
        />
        {summary.isLoading ? (
          <Skeleton className="h-28" />
        ) : summary.isError ? (
          <TileError />
        ) : (
          <WritebackPanel wb={s!.ehr_writeback} />
        )}
      </Card>

      {/* ---- Category tiles ---- */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <CategoryTile
          title="Website entry point"
          subtitle="The ?source= tag on the form URL. NOT a verified acquisition channel: an embedded form cannot read its parent page's campaign parameters, so most traffic arrives untagged."
          q={source}
          nullLabel="Untagged / no tag reached the form"
        />
        <CategoryTile
          title="How did you hear about us?"
          subtitle="Consultation form only. Multi-select, so selections can exceed submissions."
          q={howHeard}
        />
        <CategoryTile
          title="Clinic location"
          subtitle="All submissions. Registration and insurance record a clinic; the consultation form does not ask, so those appear as 'Not asked'. Spelling variants are grouped."
          q={office}
          nullLabel="Not asked (consultation)"
        />
        <CategoryTile
          title="Insurance coverage"
          subtitle="All submissions. Asked on the registration and insurance forms only; consultation rows appear as 'Not asked'."
          q={coverage}
          nullLabel="Not asked (consultation)"
        />
        <CategoryTile
          title="DrChrono record action"
          subtitle="What the EHR write-back did. NOT new-vs-returning patients: every consultation is recorded as 'matched' by definition, and 'create' only means no existing chart matched the details given."
          q={action}
        />
        <CategoryTile
          title="Sync outcome by status"
          subtitle="success · manual_review · failed · not_applicable (deliberate skip) · pending"
          q={{
            isLoading: summary.isLoading,
            isError: summary.isError,
            data: s
              ? { dimension: "n8n_status", rows: s.by_n8n_status, suppressed_cells: 0 }
              : undefined,
          }}
        />
      </div>
    </div>
  );
}

// ---- components -----------------------------------------------------------
function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={
        "border border-[var(--sh-border)] bg-[var(--sh-card)] p-4 sm:p-6 " + className
      }
    >
      {children}
    </section>
  );
}

function CardHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-[var(--sh-fg)]">{title}</h2>
      {subtitle && (
        <p className="mt-1 max-w-3xl text-xs text-[var(--sh-muted)]">{subtitle}</p>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  note,
  loading,
  error,
}: {
  label: string;
  value: string;
  note?: string;
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <div className="border border-[var(--sh-border)] bg-[var(--sh-card)] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
        {label || " "}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <div className="sh-num mt-1 text-2xl font-bold text-[var(--sh-fg)]">
          {error ? "—" : value || " "}
        </div>
      )}
      {note && !loading && (
        <div className="mt-0.5 text-xs text-[var(--sh-muted)]">{note}</div>
      )}
    </div>
  );
}

/**
 * The write-back panel. The rate is rendered ONLY when the server supplied one
 * — a null rate means the denominator was zero, and "0%" would be a fabricated
 * number. A real 0 over a real denominator does render as 0%.
 */
function WritebackPanel({ wb }: { wb: Writeback }) {
  const unavailable = wb.rate_pct === null;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
            Written back automatically
          </div>
          {unavailable ? (
            <>
              <div className="mt-1 text-2xl font-bold italic text-slate-400">
                not available
              </div>
              <div className="mt-0.5 text-xs text-[var(--sh-muted)]">
                No submission in this window has a resolved outcome yet, so there
                is nothing to take a rate of.
              </div>
            </>
          ) : (
            <>
              <div className="sh-num mt-1 text-2xl font-bold text-[var(--sh-fg)]">
                {wb.rate_pct}%
              </div>
              <div className="sh-num mt-0.5 text-xs text-[var(--sh-muted)]">
                {wb.succeeded.toLocaleString("en-US")} of{" "}
                {wb.resolved.toLocaleString("en-US")} resolved
              </div>
            </>
          )}
        </div>
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {[
            ["Manual review", wb.manual_review],
            ["Failed", wb.failed],
            ["Still in flight", wb.pending],
            ["Deliberate skip", wb.skipped],
          ].map(([k, v]) => (
            <div key={String(k)}>
              <dt className="text-xs text-[var(--sh-muted)]">{k}</dt>
              <dd className="sh-num text-base font-semibold text-[var(--sh-fg)]">
                {fmt(v as Count)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="mt-4 flex items-start gap-1.5 border-t border-[var(--sh-border)] pt-3 text-xs text-[var(--sh-muted)]">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Basis: {wb.basis}.</span>
      </p>
    </div>
  );
}

function VolumeTrend({ data }: { data: ActivityResponse }) {
  const days = data.daily_counts;
  if (days.length === 0 || days.every((d) => d.total === 0)) {
    return (
      <Insufficient note="No submissions in this window. That is a measured zero, not missing data." />
    );
  }
  // Series come from the response, so a form type can never be silently
  // dropped from the stack while still counting toward the total.
  const series = data.series.filter((k) => days.some((d) => (d.by_form_type[k] ?? 0) > 0));
  const rows = days.map((d) => {
    const row: Record<string, string | number> = { date: d.date.slice(5) };
    for (const k of series) row[formLabel(k)] = d.by_form_type[k] ?? 0;
    return row;
  });
  return (
    <>
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              stroke="#64748b"
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11 }} stroke="#64748b" allowDecimals={false} />
            <Tooltip contentStyle={{ fontSize: 12 }} />
            {series.map((k) => (
              <Bar
                key={k}
                dataKey={formLabel(k)}
                stackId="ft"
                fill={SERIES_COLOR[k] ?? "#94A3B8"}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--sh-muted)]">
        {series.map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5"
              style={{ background: SERIES_COLOR[k] ?? "#94A3B8" }}
            />
            {formLabel(k)}
          </li>
        ))}
      </ul>
    </>
  );
}

function CategoryTile({
  title,
  subtitle,
  q,
  nullLabel,
}: {
  title: string;
  subtitle: string;
  q: { isLoading: boolean; isError: boolean; data?: CountsResponse };
  nullLabel?: string;
}) {
  return (
    <Card>
      <CardHead title={title} subtitle={subtitle} />
      {q.isLoading ? (
        <Skeleton className="h-56" />
      ) : q.isError ? (
        <TileError />
      ) : !q.data ? (
        <Insufficient />
      ) : (
        <CategoryChart data={q.data} nullLabel={nullLabel} />
      )}
    </Card>
  );
}

function CategoryChart({
  data,
  nullLabel,
}: {
  data: CountsResponse;
  nullLabel?: string;
}) {
  const { data: rows, hidden } = plottable(data.rows, nullLabel);
  if (rows.length === 0) {
    return (
      <Insufficient
        note={
          hidden > 0
            ? `All ${hidden} group${hidden === 1 ? "" : "s"} are below the privacy threshold (fewer than 5).`
            : data.note ?? "No submissions in this window matched this question."
        }
      />
    );
  }
  const height = Math.max(160, rows.length * 34 + 40);
  return (
    <>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer>
          <BarChart
            layout="vertical"
            data={rows}
            margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              stroke="#64748b"
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={150}
              tick={{ fontSize: 11 }}
              stroke="#64748b"
            />
            <Tooltip contentStyle={{ fontSize: 12 }} cursor={{ fill: "#f1f5f9" }} />
            <Bar dataKey="count">
              {rows.map((_, i) => (
                <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {(hidden > 0 || data.note) && (
        <p className="mt-2 text-xs text-[var(--sh-muted)]">
          {hidden > 0 &&
            `${hidden} small group${hidden === 1 ? "" : "s"} hidden (fewer than 5). `}
          {data.note}
        </p>
      )}
    </>
  );
}

function Insufficient({ note }: { note?: string }) {
  return (
    <div className="py-14 text-center">
      <p className="text-sm font-medium text-[var(--sh-muted)]">Nothing to show</p>
      {note && (
        <p className="mx-auto mt-1 max-w-sm text-xs text-slate-400">{note}</p>
      )}
    </div>
  );
}

function TileError() {
  return (
    <div className="py-14 text-center">
      <AlertCircle className="mx-auto mb-2 h-6 w-6 text-rose-400" />
      <p className="text-sm text-[var(--sh-muted)]">Couldn&rsquo;t load this panel.</p>
    </div>
  );
}
