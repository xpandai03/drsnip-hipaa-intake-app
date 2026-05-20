import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "wouter";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Copy,
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
// Types — mirror the /api/submissions response shape (Phase 2 — DrSnip).
// ---------------------------------------------------------------------------

type SubmissionRow = {
  id: string;
  createdAt: string;
  formType: string;
  firstName: string;
  lastName: string;
  email: string;
};

type SubmissionsResponse = {
  submissions: SubmissionRow[];
  total: number;
  page: number;
  hasMore: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
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

function formTypeLabel(formType: string): string {
  if (formType === "consultation") return "Consultation";
  if (formType === "registration") return "Registration";
  return formType;
}

function formTypeBadgeClass(formType: string): string {
  switch (formType) {
    case "registration":
      return "bg-sky-100 text-sky-800 border-sky-200";
    case "consultation":
      return "bg-teal-100 text-teal-800 border-teal-200";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

// ---------------------------------------------------------------------------
// URL-state contract — filters are encoded as query params so refresh /
// back-forward preserve them.
// ---------------------------------------------------------------------------

type Filters = {
  page: number;
  form_type: string;
  start_date: string;
  end_date: string;
  search: string;
};

const DEFAULTS: Filters = {
  page: 1,
  form_type: "all",
  start_date: "",
  end_date: "",
  search: "",
};

const FILTER_KEYS = ["page", "form_type", "start_date", "end_date", "search"];

function readFilters(params: URLSearchParams): Filters {
  return {
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
    form_type: params.get("form_type") ?? "all",
    start_date: params.get("start_date") ?? "",
    end_date: params.get("end_date") ?? "",
    search: params.get("search") ?? "",
  };
}

function writeFilters(prev: URLSearchParams, next: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (next.page > 1) params.set("page", String(next.page));
  if (next.form_type && next.form_type !== "all")
    params.set("form_type", next.form_type);
  if (next.start_date) params.set("start_date", next.start_date);
  if (next.end_date) params.set("end_date", next.end_date);
  if (next.search) params.set("search", next.search);
  for (const [k, v] of prev.entries()) {
    if (!params.has(k) && !FILTER_KEYS.includes(k)) params.set(k, v);
  }
  return params;
}

async function fetchSubmissions(filters: Filters): Promise<SubmissionsResponse> {
  const qs = new URLSearchParams();
  qs.set("page", String(filters.page));
  qs.set("limit", "50");
  if (filters.form_type !== "all") qs.set("form_type", filters.form_type);
  if (filters.start_date) qs.set("start_date", filters.start_date);
  if (filters.end_date) qs.set("end_date", filters.end_date);
  if (filters.search) qs.set("search", filters.search);
  const res = await fetch(`/api/submissions?${qs.toString()}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`/api/submissions returned ${res.status}`);
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

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  const updateFilters = useCallback(
    (next: Partial<Filters>) => {
      const merged: Filters = { ...filters, ...next };
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
    filters.form_type !== "all" ||
    filters.start_date !== "" ||
    filters.end_date !== "" ||
    filters.search !== "";

  return (
    <div className="min-h-screen pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-white">Submissions</h1>
          <p className="text-sm text-white/75 mt-1">
            Every patient intake submission. Click any row for the full detail.
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
      <FilterField label="Form">
        <Select
          value={filters.form_type}
          onValueChange={(v) => onChange({ form_type: v })}
        >
          <SelectTrigger className="w-[160px]" data-testid="filter-form-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All forms</SelectItem>
            <SelectItem value="registration">Registration</SelectItem>
            <SelectItem value="consultation">Consultation</SelectItem>
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

      <form
        onSubmit={onSearchSubmit}
        className="flex flex-col gap-1.5 flex-1 min-w-[220px]"
      >
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

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
                <TableHead>Form</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Submission ID</TableHead>
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
                    <Chip className={formTypeBadgeClass(row.formType)}>
                      {formTypeLabel(row.formType)}
                    </Chip>
                  </TableCell>
                  <TableCell className="text-sm text-slate-900">
                    {row.firstName} {row.lastName}
                  </TableCell>
                  <TableCell className="text-sm text-slate-700">
                    {row.email}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyToClipboard(row.id, "Submission ID copied");
                      }}
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors"
                      title="Copy full submission ID"
                    >
                      {row.id.slice(0, 8)}…
                      <Copy className="w-3 h-3" />
                    </button>
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

function Chip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
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
        <Button variant="link" onClick={onReset} className="text-primary">
          Reset filters
        </Button>
      </div>
    );
  }
  return (
    <div className="py-16 text-center">
      <p className="text-slate-600 font-medium">No submissions yet.</p>
      <p className="text-sm text-slate-500 mt-1">
        Once patients submit an intake form, they'll appear here.
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
// Copy-to-clipboard utility, shared with the detail modal.
// ---------------------------------------------------------------------------

export async function copyToClipboard(
  value: string,
  label = "Copied",
): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(label);
  } catch {
    toast.error("Couldn't copy");
  }
}

// Re-exports consumed by SubmissionDetailModal.
export { Chip, exactTime, relativeTime, formTypeLabel, formTypeBadgeClass };
export type { SubmissionRow };
