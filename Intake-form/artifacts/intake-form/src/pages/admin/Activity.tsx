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
// Types — mirror /api/submissions/activity
// ---------------------------------------------------------------------------

type DayBucket = {
  date: string;
  total: number;
  by_source: { federal: number; internal: number; fnn: number };
  by_rank: {
    A: number;
    "B+": number;
    B: number;
    C: number;
    "N/A": number;
    unscored: number;
  };
};

type ActivityResponse = {
  start_date: string;
  end_date: string;
  daily_counts: DayBucket[];
  summary: { total: number; sent: number; errored: number; success_rate: number };
};

async function fetchActivity(): Promise<ActivityResponse> {
  const res = await fetch(`/api/submissions/activity`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`/api/submissions/activity returned ${res.status}`);
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
            Submission volume over the last 90 days. Click any day on the heatmap
            to filter the Submissions tab to that date.
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
    let aCount = 0;
    for (const b of last30) {
      total += b.total;
      aCount += b.by_rank.A;
    }
    return {
      total,
      aCount,
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
          accent="text-slate-900"
        />
        <Tile
          label="Success rate (90d)"
          value={`${(data.summary.success_rate * 100).toFixed(1)}%`}
          accent="text-emerald-700"
          sublabel={`${data.summary.sent.toLocaleString()} of ${data.summary.total.toLocaleString()} sent`}
        />
        <Tile
          label="Avg per day (30d)"
          value={summaryLast30.avgPerDay.toFixed(1)}
          accent="text-slate-900"
        />
        <Tile
          label="A-tier (30d)"
          value={summaryLast30.aCount.toLocaleString()}
          accent="text-emerald-700"
        />
      </div>

      {/* Heatmap */}
      <section className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Last 90 days</h2>
          <span className="text-xs text-slate-500">
            {data.start_date} → {data.end_date}
          </span>
        </div>
        <Heatmap data={data.daily_counts} />
      </section>

      {/* Stacked bar by source — last 30 days */}
      <section className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-5">
        <h2 className="text-base font-semibold text-slate-900 mb-4">By channel (last 30 days)</h2>
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
                  federal: d.by_source.federal,
                  internal: d.by_source.internal,
                  fnn: d.by_source.fnn,
                }))}
                margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#64748b" />
                <YAxis tick={{ fontSize: 11 }} stroke="#64748b" allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6 }}
                  labelStyle={{ color: "#0f172a" }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="federal" stackId="src" fill="#6366f1" />
                <Bar dataKey="internal" stackId="src" fill="#8b5cf6" />
                <Bar dataKey="fnn" stackId="src" fill="#14b8a6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  accent,
  sublabel,
}: {
  label: string;
  value: string;
  accent: string;
  sublabel?: string;
}) {
  return (
    <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent}`}>{value}</div>
      {sublabel && <div className="text-xs text-slate-500 mt-1">{sublabel}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heatmap — hand-rolled SVG. 13 weeks × 7 days. Rectangles colored by daily
// total relative to the window's max. Hovering a cell shows a tooltip with
// the date and per-source breakdown; clicking deep-links into the
// Submissions tab filtered to that day.
// ---------------------------------------------------------------------------

const CELL_SIZE = 12;
const CELL_GAP = 3;
const COL_COUNT = 13;
const ROW_COUNT = 7;
const HEATMAP_WIDTH = COL_COUNT * (CELL_SIZE + CELL_GAP) - CELL_GAP + 30;
const HEATMAP_HEIGHT = ROW_COUNT * (CELL_SIZE + CELL_GAP) - CELL_GAP + 22;

const HEATMAP_COLORS = [
  "#f1f5f9", // 0 (slate-100)
  "#bbf7d0", // low
  "#86efac",
  "#4ade80",
  "#16a34a",
  "#15803d", // max
];

function heatmapColor(value: number, max: number): string {
  if (value === 0 || max === 0) return HEATMAP_COLORS[0];
  // Buckets 1..5 — keep zero distinct from the lightest "had activity" color.
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

  // Lay out the days right-to-left, oldest at top-left of the leftmost
  // column. The grid is fixed at 91 cells (13 × 7). If the API returns
  // fewer days (e.g., shorter window), we pad with placeholders.
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
        {/* Day-of-week labels (left side) */}
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
                {cell.date}: {cell.total} submission{cell.total === 1 ? "" : "s"}
                {cell.total > 0
                  ? ` (federal ${cell.by_source.federal}, internal ${cell.by_source.internal}, fnn ${cell.by_source.fnn})`
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
          <span className="text-indigo-700">federal {hover.by_source.federal}</span>
          <span className="text-violet-700">internal {hover.by_source.internal}</span>
          <span className="text-teal-700">fnn {hover.by_source.fnn}</span>
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
