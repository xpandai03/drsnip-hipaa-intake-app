import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "wouter";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  RotateCcw,
  Search,
} from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { SubmissionDetailModal } from "./SubmissionDetailModal";

// ---------------------------------------------------------------------------
// Types — mirror the /api/submissions response shape.
// ---------------------------------------------------------------------------

type SubmissionRow = {
  id: string;
  createdAt: string;
  source: string;
  firstName: string;
  lastName: string;
  email: string;
  rank: string | null;
  leadScore: string | null;
  sfLeadId: string | null;
  sfStatus: string;
};

type SubmissionsResponse = {
  submissions: SubmissionRow[];
  total: number;
  page: number;
  hasMore: boolean;
};

// ---------------------------------------------------------------------------
// Helpers — relative time, badge colors, SF link
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function exactTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function rankBadgeClass(rank: string | null): string {
  switch (rank) {
    case "A":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "B+":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "B":
      return "bg-slate-200 text-slate-800 border-slate-300";
    case "C":
      return "bg-slate-100 text-slate-700 border-slate-200";
    case "N/A":
      return "bg-slate-50 text-slate-500 border-slate-200";
    default:
      return "bg-slate-50 text-slate-400 border-slate-200 italic";
  }
}

function sfStatusBadgeClass(status: string): string {
  switch (status) {
    case "sent":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "error":
      return "bg-red-100 text-red-800 border-red-200";
    case "pending":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "skipped":
      return "bg-slate-100 text-slate-600 border-slate-200";
    case "held":
      return "bg-orange-100 text-orange-800 border-orange-200";
    case "releasing":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "discarded":
      return "bg-slate-200 text-slate-500 border-slate-300 line-through";
    default:
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

function sourceBadgeClass(source: string): string {
  switch (source) {
    case "federal":
      return "bg-indigo-100 text-indigo-800 border-indigo-200";
    case "internal":
      return "bg-violet-100 text-violet-800 border-violet-200";
    case "fnn":
      return "bg-teal-100 text-teal-800 border-teal-200";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

export const SF_LEAD_URL = (id: string) =>
  `https://cjcwealth.lightning.force.com/lightning/r/Lead/${id}/view`;

// ---------------------------------------------------------------------------
// URL-state contract — every filter is encoded as a query param so refresh
// preserves it. Empty / default values are stripped to keep URLs tidy.
// ---------------------------------------------------------------------------

type Filters = {
  page: number;
  source: string;
  sf_status: string;
  rank: string;
  start_date: string;
  end_date: string;
  search: string;
};

const DEFAULTS: Filters = {
  page: 1,
  source: "all",
  sf_status: "all",
  rank: "all",
  start_date: "",
  end_date: "",
  search: "",
};

function readFilters(params: URLSearchParams): Filters {
  return {
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
    source: params.get("source") ?? "all",
    sf_status: params.get("sf_status") ?? "all",
    rank: params.get("rank") ?? "all",
    start_date: params.get("start_date") ?? "",
    end_date: params.get("end_date") ?? "",
    search: params.get("search") ?? "",
  };
}

function writeFilters(prev: URLSearchParams, next: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (next.page > 1) params.set("page", String(next.page));
  if (next.source && next.source !== "all") params.set("source", next.source);
  if (next.sf_status && next.sf_status !== "all") params.set("sf_status", next.sf_status);
  if (next.rank && next.rank !== "all") params.set("rank", next.rank);
  if (next.start_date) params.set("start_date", next.start_date);
  if (next.end_date) params.set("end_date", next.end_date);
  if (next.search) params.set("search", next.search);
  // Preserve any other params (e.g., from heatmap deep-link).
  for (const [k, v] of prev.entries()) {
    if (!params.has(k) && !["page", "source", "sf_status", "rank", "start_date", "end_date", "search"].includes(k)) {
      params.set(k, v);
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchSubmissions(filters: Filters): Promise<SubmissionsResponse> {
  const qs = new URLSearchParams();
  qs.set("page", String(filters.page));
  qs.set("limit", "50");
  if (filters.source !== "all") qs.set("source", filters.source);
  if (filters.sf_status !== "all") qs.set("sf_status", filters.sf_status);
  if (filters.rank !== "all") qs.set("rank", filters.rank);
  if (filters.start_date) qs.set("start_date", filters.start_date);
  if (filters.end_date) qs.set("end_date", filters.end_date);
  if (filters.search) qs.set("search", filters.search);
  const res = await fetch(`/api/submissions?${qs.toString()}`, {
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`/api/submissions returned ${res.status}`);
  }
  return (await res.json()) as SubmissionsResponse;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminSubmissions() {
  return (
    <AdminLayout>
      <SubmissionsPage />
    </AdminLayout>
  );
}

function SubmissionsPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [openId, setOpenId] = useState<string | null>(null);

  // Re-sync the search draft if URL changes from elsewhere (browser back/forward).
  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  const updateFilters = useCallback(
    (next: Partial<Filters>) => {
      const merged: Filters = { ...filters, ...next };
      // Any filter change other than `page` resets to page 1.
      if (Object.keys(next).some((k) => k !== "page")) merged.page = 1;
      setParams(writeFilters(params, merged), { replace: true });
    },
    [filters, params, setParams],
  );

  const reset = useCallback(() => {
    setParams(writeFilters(params, DEFAULTS), { replace: true });
  }, [params, setParams]);

  const query = useQuery({
    queryKey: ["submissions", filters],
    queryFn: () => fetchSubmissions(filters),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
  });

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateFilters({ search: searchDraft.trim() });
  };

  const hasFilters =
    filters.source !== "all" ||
    filters.sf_status !== "all" ||
    filters.rank !== "all" ||
    filters.start_date !== "" ||
    filters.end_date !== "" ||
    filters.search !== "";

  return (
    <div className="min-h-screen pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-white">Submissions</h1>
          <p className="text-sm text-white/75 mt-1">
            Every intake-form submission, scored and pushed to Salesforce. Click any
            row for the full pipeline trace.
          </p>
        </header>

        <FilterBar
          filters={filters}
          searchDraft={searchDraft}
          setSearchDraft={setSearchDraft}
          onSearchSubmit={onSearchSubmit}
          onChange={updateFilters}
          onReset={reset}
          hasFilters={hasFilters}
        />

        <div className="mt-6 bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 overflow-hidden">
          {query.isLoading && !query.data ? (
            <TableSkeleton />
          ) : query.isError ? (
            <ErrorState onRetry={() => query.refetch()} />
          ) : query.data && query.data.submissions.length === 0 ? (
            <EmptyState hasFilters={hasFilters} onReset={reset} />
          ) : query.data ? (
            <ResultsTable
              data={query.data}
              isFetching={query.isFetching}
              onOpen={setOpenId}
              onPageChange={(p) => updateFilters({ page: p })}
            />
          ) : null}
        </div>
      </div>

      <SubmissionDetailModal
        id={openId}
        open={openId !== null}
        onClose={() => setOpenId(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  filters,
  searchDraft,
  setSearchDraft,
  onSearchSubmit,
  onChange,
  onReset,
  hasFilters,
}: {
  filters: Filters;
  searchDraft: string;
  setSearchDraft: (v: string) => void;
  onSearchSubmit: (e: React.FormEvent) => void;
  onChange: (next: Partial<Filters>) => void;
  onReset: () => void;
  hasFilters: boolean;
}) {
  return (
    <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-4 flex flex-wrap items-end gap-3">
      <FilterField label="Channel">
        <Select
          value={filters.source}
          onValueChange={(v) => onChange({ source: v })}
        >
          <SelectTrigger className="w-[140px]" data-testid="filter-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="federal">Federal</SelectItem>
            <SelectItem value="internal">Internal</SelectItem>
            <SelectItem value="fnn">FNN</SelectItem>
          </SelectContent>
        </Select>
      </FilterField>

      <FilterField label="SF status">
        <Select
          value={filters.sf_status}
          onValueChange={(v) => onChange({ sf_status: v })}
        >
          <SelectTrigger className="w-[140px]" data-testid="filter-sf-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="held">Held</SelectItem>
            <SelectItem value="discarded">Discarded</SelectItem>
            <SelectItem value="skipped">Skipped</SelectItem>
          </SelectContent>
        </Select>
      </FilterField>

      <FilterField label="Rank">
        <Select value={filters.rank} onValueChange={(v) => onChange({ rank: v })}>
          <SelectTrigger className="w-[120px]" data-testid="filter-rank">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="A">A</SelectItem>
            <SelectItem value="B+">B+</SelectItem>
            <SelectItem value="B">B</SelectItem>
            <SelectItem value="C">C</SelectItem>
            <SelectItem value="N/A">N/A</SelectItem>
            <SelectItem value="unscored">Unscored</SelectItem>
          </SelectContent>
        </Select>
      </FilterField>

      <FilterField label="From">
        <input
          type="date"
          value={filters.start_date}
          onChange={(e) => onChange({ start_date: e.target.value })}
          className="h-10 rounded-md border border-slate-300 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          data-testid="filter-start-date"
        />
      </FilterField>

      <FilterField label="To">
        <input
          type="date"
          value={filters.end_date}
          onChange={(e) => onChange({ end_date: e.target.value })}
          className="h-10 rounded-md border border-slate-300 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          data-testid="filter-end-date"
        />
      </FilterField>

      <form onSubmit={onSearchSubmit} className="flex flex-col gap-1.5 flex-1 min-w-[220px]">
        <label className="text-xs font-medium text-slate-600">Search</label>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <Input
            type="search"
            placeholder="Email or name"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            className="pl-9"
            data-testid="filter-search"
          />
        </div>
      </form>

      <Button
        type="button"
        variant="outline"
        onClick={onReset}
        disabled={!hasFilters}
        className="h-10"
        data-testid="filter-reset"
      >
        <RotateCcw className="w-4 h-4" />
        Reset
      </Button>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-slate-600">{label}</label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

function ResultsTable({
  data,
  isFetching,
  onOpen,
  onPageChange,
}: {
  data: SubmissionsResponse;
  isFetching: boolean;
  onOpen: (id: string) => void;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(data.total / 50));
  return (
    <>
      <div className="relative">
        {isFetching && (
          <div className="absolute right-3 top-3 z-10">
            <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          </div>
        )}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50 hover:bg-slate-50">
                <TableHead>Date</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Rank</TableHead>
                <TableHead>Lead Score</TableHead>
                <TableHead>SF Status</TableHead>
                <TableHead>SF Lead</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.submissions.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={() => onOpen(row.id)}
                  className="cursor-pointer hover:bg-slate-50/80"
                  data-testid={`submission-row-${row.id}`}
                >
                  <TableCell>
                    <span
                      title={exactTime(row.createdAt)}
                      className="text-sm text-slate-700"
                    >
                      {relativeTime(row.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Chip className={sourceBadgeClass(row.source)}>{row.source}</Chip>
                  </TableCell>
                  <TableCell className="text-sm text-slate-900">
                    {row.firstName} {row.lastName}
                  </TableCell>
                  <TableCell className="text-sm text-slate-700">{row.email}</TableCell>
                  <TableCell>
                    <Chip className={rankBadgeClass(row.rank)}>
                      {row.rank ?? "unscored"}
                    </Chip>
                  </TableCell>
                  <TableCell className="text-sm text-slate-700 whitespace-nowrap">
                    {row.leadScore ?? <span className="text-slate-400">—</span>}
                  </TableCell>
                  <TableCell>
                    <Chip className={sfStatusBadgeClass(row.sfStatus)}>{row.sfStatus}</Chip>
                  </TableCell>
                  <TableCell>
                    {row.sfLeadId ? (
                      <a
                        href={SF_LEAD_URL(row.sfLeadId)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-700 hover:underline"
                      >
                        {row.sfLeadId.slice(0, 8)}…
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="text-slate-400 text-sm">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-slate-50">
        <div className="text-sm text-slate-600">
          {data.total === 0 ? (
            "No results"
          ) : (
            <>
              Page <span className="font-medium">{data.page}</span> of{" "}
              <span className="font-medium">{totalPages}</span>{" "}
              <span className="text-slate-400">·</span>{" "}
              <span className="font-medium">{data.total}</span> total
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={data.page <= 1}
            onClick={() => onPageChange(data.page - 1)}
            data-testid="page-prev"
          >
            <ChevronLeft className="w-4 h-4" />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data.hasMore}
            onClick={() => onPageChange(data.page + 1)}
            data-testid="page-next"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border " +
        (className ?? "")
      }
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// State views
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function EmptyState({
  hasFilters,
  onReset,
}: {
  hasFilters: boolean;
  onReset: () => void;
}) {
  if (hasFilters) {
    return (
      <div className="py-16 text-center">
        <p className="text-slate-600">No submissions match these filters.</p>
        <Button variant="link" onClick={onReset} className="text-indigo-600">
          Reset filters
        </Button>
      </div>
    );
  }
  return (
    <div className="py-16 text-center">
      <p className="text-slate-600 font-medium">No submissions yet.</p>
      <p className="text-sm text-slate-500 mt-1">
        Once intake forms are submitted, they'll appear here.
      </p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="py-16 text-center">
      <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
      <p className="text-slate-700 font-medium">Couldn't load submissions.</p>
      <p className="text-sm text-slate-500 mt-1">
        Network or server error. Try again in a moment.
      </p>
      <Button variant="outline" onClick={onRetry} className="mt-4">
        Retry
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny copy-to-clipboard utility used by the detail modal.
// ---------------------------------------------------------------------------

export async function copyToClipboard(value: string, label = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(label);
  } catch {
    toast.error("Couldn't copy");
  }
}

// Re-export helpers consumed by SubmissionDetailModal so it can stay in a
// single colocated file.
export {
  Chip,
  exactTime,
  rankBadgeClass,
  relativeTime,
  sfStatusBadgeClass,
  sourceBadgeClass,
};
export type { SubmissionRow };
