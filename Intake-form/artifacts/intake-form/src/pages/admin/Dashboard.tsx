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
import { AlertCircle, Loader2 } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ===========================================================================
// Marketing dashboard (Phase 1 — the six EXISTS tiles from
// FINDINGS-marketing-dashboard.md). All data comes from aggregate-only,
// auth-guarded endpoints (/api/reports/*, /api/submissions/activity). Every
// grouped cell is <5-suppressed server-side; a suppressed cell arrives as the
// string "<5" and is never plotted — a tile with no plottable cells shows
// "Insufficient data".
//
// SCOPE: attribution, drop-off, zip, referring-physician, and conversion tiles
// are deliberately NOT here (MISSING/DERIVABLE tiers — see the findings doc).
// ===========================================================================

// ---- shared types ---------------------------------------------------------
type Count = number | string; // number, or "<5" when suppressed
type CountRow = { value: string | null; count: Count };
type CountsResponse = {
  dimension: string;
  rows: CountRow[];
  suppressed_cells: number;
  note?: string;
};
type SummaryResponse = {
  total_submissions: number;
  date_range: { from: string | null; to: string | null };
  by_form_type: CountRow[];
  by_n8n_status: CountRow[];
};
type DayBucket = {
  date: string;
  total: number;
  by_form_type: { registration: number; consultation: number };
};
type ActivityResponse = {
  start_date: string;
  end_date: string;
  daily_counts: DayBucket[];
  summary: { total: number; registration: number; consultation: number };
};

const BRAND = "#0F4C81";
const BAR_COLORS = [
  "#0F4C81",
  "#2E7CB8",
  "#06B6D4",
  "#38BDF8",
  "#7DD3FC",
  "#0EA5E9",
  "#155E75",
  "#60A5FA",
];

// ---- date range presets ---------------------------------------------------
// Activity.tsx exposes no range picker (fixed 90d), so this is a minimal
// dashboard-native selector feeding every query. (Noted as a discrepancy.)
const RANGES = [
  { key: "7", label: "7d", days: 7 },
  { key: "30", label: "30d", days: 30 },
  { key: "90", label: "90d", days: 90 },
  { key: "all", label: "All", days: null as number | null },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function rangeParams(rangeKey: RangeKey): { from?: string; to?: string } {
  const r = RANGES.find((x) => x.key === rangeKey)!;
  if (r.days == null) return {};
  return { from: isoDaysAgo(r.days - 1), to: todayIso() };
}

// ---- fetchers -------------------------------------------------------------
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

function countsUrl(dimension: string, p: { from?: string; to?: string }): string {
  const qs = new URLSearchParams({ dimension });
  if (p.from) qs.set("from", p.from);
  if (p.to) qs.set("to", p.to);
  return `/api/reports/counts?${qs.toString()}`;
}
function summaryUrl(p: { from?: string; to?: string }): string {
  const qs = new URLSearchParams();
  if (p.from) qs.set("from", p.from);
  if (p.to) qs.set("to", p.to);
  const s = qs.toString();
  return `/api/reports/summary${s ? `?${s}` : ""}`;
}

// ---- chartable helpers ----------------------------------------------------
// Keep only numeric (non-suppressed) cells for plotting; report hidden count.
function plottable(
  rows: CountRow[],
  nullLabel = "Unspecified",
): {
  data: { name: string; count: number }[];
  hidden: number;
} {
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
    queryFn: () => getJson<SummaryResponse>(summaryUrl(p)),
  });
  const activity = useQuery({
    queryKey: ["activity-dashboard"],
    queryFn: () => getJson<ActivityResponse>(`/api/submissions/activity`),
  });
  const howHeard = useQuery({
    queryKey: ["reports-how_heard", range],
    queryFn: () => getJson<CountsResponse>(countsUrl("how_heard", p)),
  });
  const office = useQuery({
    queryKey: ["reports-office", range],
    queryFn: () => getJson<CountsResponse>(countsUrl("office_location", p)),
  });
  const coverage = useQuery({
    queryKey: ["reports-coverage", range],
    queryFn: () => getJson<CountsResponse>(countsUrl("insurance_coverage", p)),
  });
  const status = useQuery({
    queryKey: ["reports-status", range],
    queryFn: () => getJson<CountsResponse>(countsUrl("n8n_status", p)),
  });
  const action = useQuery({
    queryKey: ["reports-action", range],
    queryFn: () => getJson<CountsResponse>(countsUrl("action_label", p)),
  });
  const source = useQuery({
    queryKey: ["reports-source", range],
    queryFn: () => getJson<CountsResponse>(countsUrl("source", p)),
  });

  return (
    <div className="min-h-screen pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">
              Marketing dashboard
            </h1>
            <p className="text-sm text-white/75 mt-1">
              Aggregate intake metrics. Groups under 5 are hidden for privacy.
            </p>
          </div>
          <div className="flex gap-1.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors " +
                  (range === r.key
                    ? "bg-white text-slate-900"
                    : "bg-white/10 text-white/80 hover:bg-white/20")
                }
              >
                {r.label}
              </button>
            ))}
          </div>
        </header>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatTile
            label="Total submissions"
            value={
              summary.data ? summary.data.total_submissions.toLocaleString() : "—"
            }
          />
          <StatTile
            label="Success rate"
            value={successRate(status.data)}
          />
          <StatTile
            label="Registrations"
            value={formCount(summary.data, "registration")}
          />
          <StatTile
            label="Consultations"
            value={formCount(summary.data, "consultation")}
          />
        </div>

        {/* Volume trend (reuses /api/submissions/activity — last 30 days) */}
        <Section title="Form volume — last 30 days">
          {activity.isLoading ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : activity.isError ? (
            <TileError />
          ) : (
            <VolumeTrend data={activity.data!} />
          )}
        </Section>

        {/* Category tiles */}
        <div className="grid gap-6 lg:grid-cols-2 mt-6">
          <CategoryTile
            title="Attribution — submissions by source"
            subtitle="Tagged links only · untagged/direct shown for honest coverage"
            q={source}
            nullLabel="Untagged / direct"
          />
          <CategoryTile
            title="How did you hear about us?"
            subtitle="Consultation form only · multi-select (selections can exceed submissions)"
            q={howHeard}
          />
          <CategoryTile
            title="New vs returning"
            subtitle="create = new patient · update/matched = returning"
            q={action}
          />
          <CategoryTile
            title="Office location"
            subtitle="Registration & insurance submissions"
            q={office}
          />
          <CategoryTile
            title="Insurance coverage"
            subtitle="Registration submissions"
            q={coverage}
          />
          <CategoryTile
            title="Sync outcome"
            subtitle="success · manual_review · failed · pending"
            q={status}
          />
        </div>
      </div>
    </div>
  );
}

// ---- derived headline metrics ---------------------------------------------
function successRate(status?: CountsResponse): string {
  if (!status) return "—";
  let success = 0;
  let total = 0;
  for (const r of status.rows) {
    if (typeof r.count !== "number") continue; // suppressed cells excluded
    total += r.count;
    if (r.value === "success") success += r.count;
  }
  if (total === 0) return "—";
  return `${Math.round((success / total) * 100)}%`;
}
function formCount(summary: SummaryResponse | undefined, form: string): string {
  if (!summary) return "—";
  const row = summary.by_form_type.find((r) => r.value === form);
  if (!row) return "0";
  return typeof row.count === "number" ? row.count.toLocaleString() : row.count;
}

// ---- components -----------------------------------------------------------
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">
        {label}
      </div>
      <div className="text-2xl font-semibold mt-1 text-slate-900">{value}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-5">
      <h2 className="text-base font-semibold text-slate-900 mb-4">{title}</h2>
      {children}
    </section>
  );
}

function VolumeTrend({ data }: { data: ActivityResponse }) {
  const last30 = data.daily_counts.slice(-30);
  if (last30.every((d) => d.total === 0)) return <Insufficient />;
  return (
    <div style={{ width: "100%", height: 260 }}>
      <ResponsiveContainer>
        <BarChart
          data={last30.map((d) => ({
            date: d.date.slice(5),
            Registration: d.by_form_type.registration,
            Consultation: d.by_form_type.consultation,
          }))}
          margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11 }}
            stroke="#64748b"
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis tick={{ fontSize: 11 }} stroke="#64748b" allowDecimals={false} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} />
          <Bar dataKey="Registration" stackId="ft" fill={BRAND} />
          <Bar dataKey="Consultation" stackId="ft" fill="#06B6D4" />
        </BarChart>
      </ResponsiveContainer>
    </div>
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
  q: {
    isLoading: boolean;
    isError: boolean;
    data?: CountsResponse;
  };
  nullLabel?: string;
}) {
  return (
    <section className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-5">
      <div className="mb-1">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-56 rounded-2xl mt-3" />
      ) : q.isError ? (
        <TileError />
      ) : (
        <CategoryChart data={q.data!} nullLabel={nullLabel} />
      )}
    </section>
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
            ? `All ${hidden} group${hidden === 1 ? "" : "s"} are below the privacy threshold (<5).`
            : data.note
        }
      />
    );
  }
  const height = Math.max(160, rows.length * 34 + 40);
  return (
    <>
      <div style={{ width: "100%", height }} className="mt-2">
        <ResponsiveContainer>
          <BarChart
            layout="vertical"
            data={rows}
            margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} stroke="#64748b" allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="name"
              width={130}
              tick={{ fontSize: 11 }}
              stroke="#64748b"
            />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} cursor={{ fill: "#f1f5f9" }} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {rows.map((_, i) => (
                <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {(hidden > 0 || data.note) && (
        <p className="text-xs text-slate-400 mt-2">
          {hidden > 0 &&
            `${hidden} small group${hidden === 1 ? "" : "s"} hidden (<5). `}
          {data.note}
        </p>
      )}
    </>
  );
}

function Insufficient({ note }: { note?: string }) {
  return (
    <div className="py-14 text-center">
      <p className="text-sm font-medium text-slate-500">Insufficient data</p>
      {note && <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">{note}</p>}
    </div>
  );
}

function TileError() {
  return (
    <div className="py-14 text-center">
      <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
      <p className="text-sm text-slate-500">Couldn't load this tile.</p>
    </div>
  );
}
