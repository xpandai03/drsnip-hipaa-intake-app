import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertCircle, Loader2 } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Types — mirror /api/submissions/activity (Phase 2 — DrSnip). Aggregates by
// form_type; the CJC per-rank / SF-status breakdowns were removed.
// ---------------------------------------------------------------------------

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

// Brand colors for the form-type series.
const COLOR_REGISTRATION = "#0F4C81";
const COLOR_CONSULTATION = "#06B6D4";

async function fetchActivity(): Promise<ActivityResponse> {
  const res = await fetch(`/api/submissions/activity`, {
    credentials: "same-origin",
  });
  if (!res.ok)
    throw new Error(`/api/submissions/activity returned ${res.status}`);
  return (await res.json()) as ActivityResponse;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminActivity() {
  return (
    <AdminLayout>
      <ActivityPage />
    </AdminLayout>
  );
}

function ActivityPage() {
  const query = useQuery({
    queryKey: ["activity"],
    queryFn: fetchActivity,
    refetchOnWindowFocus: true,
  });

  return (
    <div className="min-h-screen pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-white">Activity</h1>
          <p className="text-sm text-white/75 mt-1">
            Submission volume over the last 90 days. Click any day on the
            heatmap to filter the Submissions tab to that date.
          </p>
        </header>

        {query.isLoading ? (
          <ActivitySkeleton />
        ) : query.isError ? (
          <ActivityError onRetry={() => query.refetch()} />
        ) : query.data ? (
          <ActivityBody data={query.data} />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function ActivityBody({ data }: { data: ActivityResponse }) {
  const last30 = data.daily_counts.slice(-30);
  const summaryLast30 = useMemo(() => {
    let total = 0;
    for (const b of last30) total += b.total;
    return {
      total,
      avgPerDay: last30.length > 0 ? total / last30.length : 0,
    };
  }, [last30]);

  return (
    <div className="space-y-6">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile
          label="Submissions (30d)"
          value={summaryLast30.total.toLocaleString()}
        />
        <Tile
          label="Registrations (90d)"
          value={data.summary.registration.toLocaleString()}
        />
        <Tile
          label="Consultations (90d)"
          value={data.summary.consultation.toLocaleString()}
        />
        <Tile
          label="Avg per day (30d)"
          value={summaryLast30.avgPerDay.toFixed(1)}
        />
      </div>

      {/* Heatmap */}
      <section className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">
            Last 90 days
          </h2>
          <span className="text-xs text-slate-500">
            {data.start_date} → {data.end_date}
          </span>
        </div>
        <Heatmap data={data.daily_counts} />
      </section>

      {/* Stacked bar by form type — last 30 days */}
      <section className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-5">
        <h2 className="text-base font-semibold text-slate-900 mb-4">
          By form type (last 30 days)
        </h2>
        {last30.every((d) => d.total === 0) ? (
          <p className="text-sm text-slate-500 py-10 text-center">
            No submissions in the last 30 days.
          </p>
        ) : (
          <div style={{ width: "100%", height: 280 }}>
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
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#64748b" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="#64748b"
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6 }}
                  labelStyle={{ color: "#0f172a" }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  dataKey="Registration"
                  stackId="ft"
                  fill={COLOR_REGISTRATION}
                />
                <Bar
                  dataKey="Consultation"
                  stackId="ft"
                  fill={COLOR_CONSULTATION}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">
        {label}
      </div>
      <div className="text-2xl font-semibold mt-1 text-slate-900">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heatmap — hand-rolled SVG. 13 weeks × 7 days, colored by daily total
// relative to the window max. Clicking a cell deep-links into Submissions
// filtered to that day.
// ---------------------------------------------------------------------------

const CELL_SIZE = 12;
const CELL_GAP = 3;
const COL_COUNT = 13;
const ROW_COUNT = 7;
const HEATMAP_WIDTH = COL_COUNT * (CELL_SIZE + CELL_GAP) - CELL_GAP + 30;
const HEATMAP_HEIGHT = ROW_COUNT * (CELL_SIZE + CELL_GAP) - CELL_GAP + 22;

// Blue intensity scale (on-brand).
const HEATMAP_COLORS = [
  "#f1f5f9", // 0
  "#cfe3f3",
  "#93c5e8",
  "#4a90c2",
  "#1d6aa3",
  "#0F4C81", // max
];

function heatmapColor(value: number, max: number): string {
  if (value === 0 || max === 0) return HEATMAP_COLORS[0];
  const ratio = value / max;
  if (ratio < 0.2) return HEATMAP_COLORS[1];
  if (ratio < 0.4) return HEATMAP_COLORS[2];
  if (ratio < 0.6) return HEATMAP_COLORS[3];
  if (ratio < 0.8) return HEATMAP_COLORS[4];
  return HEATMAP_COLORS[5];
}

function Heatmap({ data }: { data: DayBucket[] }) {
  const [, setLocation] = useLocation();
  const [hover, setHover] = useState<DayBucket | null>(null);

  const max = useMemo(
    () => data.reduce((m, d) => (d.total > m ? d.total : m), 0),
    [data],
  );

  const days = data.slice(-91);
  const placeholders = Math.max(0, 91 - days.length);
  const cells: Array<DayBucket | null> = [
    ...Array.from({ length: placeholders }, () => null),
    ...days,
  ];

  const onClick = (d: DayBucket) => {
    const qs = new URLSearchParams();
    qs.set("start_date", d.date);
    qs.set("end_date", d.date);
    setLocation(`/admin/submissions?${qs.toString()}`);
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${HEATMAP_WIDTH} ${HEATMAP_HEIGHT}`}
        width="100%"
        style={{ maxWidth: 640 }}
        role="img"
        aria-label="Submissions heatmap — last 90 days"
      >
        {["", "Mon", "", "Wed", "", "Fri", ""].map((lbl, i) => (
          <text
            key={i}
            x={0}
            y={i * (CELL_SIZE + CELL_GAP) + CELL_SIZE + 8}
            fontSize="9"
            fill="#94a3b8"
          >
            {lbl}
          </text>
        ))}
        {cells.map((cell, idx) => {
          const col = Math.floor(idx / ROW_COUNT);
          const row = idx % ROW_COUNT;
          const x = 22 + col * (CELL_SIZE + CELL_GAP);
          const y = row * (CELL_SIZE + CELL_GAP) + 10;
          if (!cell) {
            return (
              <rect
                key={idx}
                x={x}
                y={y}
                width={CELL_SIZE}
                height={CELL_SIZE}
                fill="transparent"
              />
            );
          }
          return (
            <rect
              key={idx}
              x={x}
              y={y}
              width={CELL_SIZE}
              height={CELL_SIZE}
              rx={2}
              fill={heatmapColor(cell.total, max)}
              stroke={cell.total > 0 ? "rgba(0,0,0,0.05)" : "rgba(0,0,0,0.03)"}
              onMouseEnter={() => setHover(cell)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onClick(cell)}
              style={{ cursor: "pointer" }}
            >
              <title>
                {cell.date}: {cell.total} submission
                {cell.total === 1 ? "" : "s"}
                {cell.total > 0
                  ? ` (registration ${cell.by_form_type.registration}, consultation ${cell.by_form_type.consultation})`
                  : ""}
              </title>
            </rect>
          );
        })}
      </svg>

      <Legend2 max={max} />

      {hover && (
        <div className="mt-2 text-xs text-slate-600 inline-flex flex-wrap gap-x-3 gap-y-1">
          <span className="font-medium text-slate-900">{hover.date}</span>
          <span>{hover.total} total</span>
          <span className="text-sky-700">
            registration {hover.by_form_type.registration}
          </span>
          <span className="text-teal-700">
            consultation {hover.by_form_type.consultation}
          </span>
        </div>
      )}
    </div>
  );
}

function Legend2({ max }: { max: number }) {
  return (
    <div className="flex items-center gap-1 mt-3 text-[10px] text-slate-500">
      <span>Less</span>
      {HEATMAP_COLORS.map((c, i) => (
        <span
          key={i}
          className="inline-block w-3 h-3 rounded-sm border border-black/5"
          style={{ background: c }}
          aria-hidden
        />
      ))}
      <span>More</span>
      {max > 0 && <span className="ml-2">peak: {max}/day</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading / error states
// ---------------------------------------------------------------------------

function ActivitySkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-3xl" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-3xl" />
      <Skeleton className="h-72 rounded-3xl" />
    </div>
  );
}

function ActivityError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 py-16 text-center">
      <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
      <p className="text-slate-700 font-medium">Couldn't load activity.</p>
      <p className="text-sm text-slate-500 mt-1">
        Network or server error. Try again in a moment.
      </p>
      <Button variant="outline" onClick={onRetry} className="mt-4">
        <Loader2 className="w-4 h-4" />
        Retry
      </Button>
    </div>
  );
}
