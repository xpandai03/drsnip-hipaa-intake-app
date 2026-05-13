import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import {
  Chip,
  exactTime,
  relativeTime,
  sfStatusBadgeClass,
  sourceBadgeClass,
} from "./Submissions";

// ---------------------------------------------------------------------------
// Types — mirror the /api/submissions/held response.
// ---------------------------------------------------------------------------

type HeldRow = {
  id: string;
  createdAt: string;
  source: string;
  firstName: string;
  lastName: string;
  email: string;
  federalAgency: string;
  rank: string | null;
  leadScore: string | null;
  sfStatus: string;
  sfLastAttemptAt: string | null;
  sfError: string | null;
};

type HeldResponse = {
  submissions: HeldRow[];
  count: number;
};

type ValveResponse = {
  key: string;
  value: unknown;
  updatedAt: string;
  updatedBy: string;
};

// ---------------------------------------------------------------------------
// Fetchers / mutations
// ---------------------------------------------------------------------------

const VALVE_KEY = "hold_a7_for_review";

async function fetchHeld(): Promise<HeldResponse> {
  const res = await fetch("/api/submissions/held", {
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`/api/submissions/held returned ${res.status}`);
  }
  return (await res.json()) as HeldResponse;
}

async function fetchValve(): Promise<boolean> {
  const res = await fetch(`/api/settings/${VALVE_KEY}`, {
    credentials: "same-origin",
  });
  if (res.status === 404) return false; // unset → default OFF
  if (!res.ok) {
    throw new Error(`/api/settings/${VALVE_KEY} returned ${res.status}`);
  }
  const data = (await res.json()) as ValveResponse;
  return data.value === true;
}

async function setValve(next: boolean): Promise<void> {
  const res = await fetch(`/api/settings/${VALVE_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ value: next }),
  });
  if (!res.ok) {
    throw new Error(`PUT /api/settings/${VALVE_KEY} returned ${res.status}`);
  }
}

async function releaseOne(id: string): Promise<{ leadId: string }> {
  const res = await fetch(`/api/submissions/${id}/release`, {
    method: "POST",
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as {
    leadId?: string;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return { leadId: body.leadId ?? "" };
}

async function discardOne(id: string): Promise<void> {
  const res = await fetch(`/api/submissions/${id}/discard`, {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
}

type BulkResponse = {
  processed: number;
  results: Array<{
    id: string;
    outcome: "released" | "not_held" | "invalid_row" | "sf_failed";
    leadId?: string;
    message?: string;
  }>;
};

async function releaseAll(): Promise<BulkResponse> {
  const res = await fetch("/api/submissions/release-all", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`POST /api/submissions/release-all returned ${res.status}`);
  }
  return (await res.json()) as BulkResponse;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminHeldLeads() {
  return (
    <AdminLayout>
      <HeldLeadsPage />
    </AdminLayout>
  );
}

function HeldLeadsPage() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);

  const heldQuery = useQuery({
    queryKey: ["held"],
    queryFn: fetchHeld,
    refetchOnWindowFocus: true,
  });
  const valveQuery = useQuery({
    queryKey: ["valve", VALVE_KEY],
    queryFn: fetchValve,
    refetchOnWindowFocus: true,
  });

  // Both list and badge count come from the same endpoint; invalidate together.
  const invalidateAfterAction = () => {
    void qc.invalidateQueries({ queryKey: ["held"] });
    void qc.invalidateQueries({ queryKey: ["held-count"] });
  };

  const valveMutation = useMutation({
    mutationFn: setValve,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["valve", VALVE_KEY] });
      toast.success("Valve setting updated");
    },
    onError: (err: Error) => toast.error(`Couldn't update valve: ${err.message}`),
  });

  const releaseMutation = useMutation({
    mutationFn: releaseOne,
    onSuccess: ({ leadId }) => {
      invalidateAfterAction();
      toast.success(leadId ? `Released — Lead ${leadId}` : "Released");
    },
    onError: (err: Error) => toast.error(`Release failed: ${err.message}`),
  });

  const discardMutation = useMutation({
    mutationFn: discardOne,
    onSuccess: () => {
      invalidateAfterAction();
      toast.success("Discarded");
    },
    onError: (err: Error) => toast.error(`Discard failed: ${err.message}`),
  });

  const bulkMutation = useMutation({
    mutationFn: releaseAll,
    onSuccess: (data) => {
      invalidateAfterAction();
      const ok = data.results.filter((r) => r.outcome === "released").length;
      const fail = data.results.length - ok;
      if (fail === 0) {
        toast.success(`Released ${ok} lead${ok === 1 ? "" : "s"}`);
      } else {
        toast.warning(`Released ${ok}, ${fail} failed — see table`);
      }
    },
    onError: (err: Error) => toast.error(`Bulk release failed: ${err.message}`),
  });

  const heldCount = heldQuery.data?.count ?? 0;
  const rows = heldQuery.data?.submissions ?? [];
  const valveOn = valveQuery.data ?? false;
  const bulkBusy = bulkMutation.isPending;

  const failedById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of bulkMutation.data?.results ?? []) {
      if (r.outcome !== "released" && r.message) m.set(r.id, r.message);
    }
    return m;
  }, [bulkMutation.data]);

  return (
    <div className="min-h-screen pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-white">Held Leads</h1>
            <p className="text-sm text-white/75 mt-1">
              Leads scored 7 are held here when the valve is on. Release sends
              them to Salesforce; discard keeps the row for audit but skips SF.
            </p>
          </div>
          <div className="flex flex-col items-start gap-3 md:flex-row md:items-center">
            <label
              className="flex items-center gap-2 bg-white/95 backdrop-blur rounded-full px-4 py-2 shadow-sm border border-slate-200"
              data-testid="held-valve-toggle"
            >
              <Switch
                checked={valveOn}
                disabled={valveQuery.isLoading || valveMutation.isPending}
                onCheckedChange={(checked) => valveMutation.mutate(checked)}
              />
              <span className="text-sm font-medium text-slate-800">
                Hold 7s for manual review
              </span>
            </label>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  disabled={heldCount === 0 || bulkBusy}
                  data-testid="held-release-all-btn"
                  className="bg-white text-slate-900 hover:bg-slate-100"
                >
                  {bulkBusy ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Releasing…
                    </>
                  ) : (
                    `Release all (${heldCount})`
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Release all held leads?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will send up to 50 held leads to Salesforce
                    sequentially. Each lead is sent one at a time — if any
                    individual lead fails, the rest still go through, and
                    failed ones stay held with the error visible in the table.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => bulkMutation.mutate()}
                    data-testid="held-release-all-confirm"
                  >
                    Release all
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </header>

        <div className="bg-white rounded-xl shadow border border-slate-200 overflow-hidden">
          {heldQuery.isLoading ? (
            <div className="p-6 space-y-3" data-testid="held-loading">
              <Skeleton className="h-6 w-1/3" />
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-6 w-2/5" />
            </div>
          ) : heldQuery.isError ? (
            <div className="p-8 text-center" data-testid="held-error">
              <AlertCircle className="w-8 h-8 mx-auto text-red-500 mb-2" />
              <p className="text-sm text-slate-700">
                Couldn't load held leads — {String(heldQuery.error)}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => heldQuery.refetch()}
              >
                <RotateCcw className="w-4 h-4 mr-2" /> Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center" data-testid="held-empty">
              <p className="text-slate-700 font-medium">No held leads.</p>
              <p className="text-sm text-slate-500 mt-1">
                {valveOn
                  ? "The valve is on — any 7-scored leads will land here."
                  : "The valve is off — 7-scored leads route to Salesforce as usual."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Agency</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const bulkError = failedById.get(row.id);
                  const isBusy =
                    (releaseMutation.isPending &&
                      releaseMutation.variables === row.id) ||
                    (discardMutation.isPending &&
                      discardMutation.variables === row.id);
                  return (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer hover:bg-slate-50"
                      data-testid={`held-row-${row.id}`}
                    >
                      <TableCell
                        title={exactTime(row.createdAt)}
                        onClick={() => setOpenId(row.id)}
                      >
                        {relativeTime(row.createdAt)}
                      </TableCell>
                      <TableCell onClick={() => setOpenId(row.id)}>
                        <Chip className={sourceBadgeClass(row.source)}>
                          {row.source}
                        </Chip>
                      </TableCell>
                      <TableCell onClick={() => setOpenId(row.id)}>
                        {row.firstName} {row.lastName}
                      </TableCell>
                      <TableCell
                        className="text-sm text-slate-600"
                        onClick={() => setOpenId(row.id)}
                      >
                        {row.email}
                      </TableCell>
                      <TableCell
                        className="text-sm text-slate-600 max-w-xs truncate"
                        title={row.federalAgency}
                        onClick={() => setOpenId(row.id)}
                      >
                        {row.federalAgency}
                      </TableCell>
                      <TableCell onClick={() => setOpenId(row.id)}>
                        <code className="text-xs">{row.leadScore ?? "—"}</code>
                      </TableCell>
                      <TableCell onClick={() => setOpenId(row.id)}>
                        <Chip className={sfStatusBadgeClass(row.sfStatus)}>
                          {row.sfStatus}
                        </Chip>
                        {(row.sfError || bulkError) && (
                          <div
                            className="text-xs text-red-600 mt-1 max-w-xs truncate"
                            title={bulkError ?? row.sfError ?? undefined}
                          >
                            {bulkError ?? row.sfError}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-2 justify-end">
                          <Button
                            size="sm"
                            disabled={isBusy || bulkBusy}
                            onClick={(e) => {
                              e.stopPropagation();
                              releaseMutation.mutate(row.id);
                            }}
                            data-testid={`held-release-${row.id}`}
                          >
                            Release
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy || bulkBusy}
                            onClick={(e) => {
                              e.stopPropagation();
                              discardMutation.mutate(row.id);
                            }}
                            data-testid={`held-discard-${row.id}`}
                          >
                            Discard
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
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
