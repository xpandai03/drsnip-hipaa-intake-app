// /admin/sources — CRUD for the marketing_sources table.
//
// Functional, not pretty: list of active sources at top, soft-deleted
// "Archived" group collapsed below, an "Add source" button that opens
// an inline form. Edits happen via a per-row dialog. No bulk operations
// (the catalog is small, <~30 rows).
//
// Auth-gated via AdminLayout. All mutations hit /api/admin/marketing-sources.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Archive,
  Edit2,
  Loader2,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Types — mirror /api/admin/marketing-sources
// ---------------------------------------------------------------------------

type Source = {
  id: string;
  sourceKey: string;
  displayName: string;
  leadSource: string;
  defaultMedium: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

const MEDIUM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "none", label: "— none —" },
  { value: "cpc", label: "cpc (paid)" },
  { value: "social", label: "social" },
  { value: "email", label: "email" },
  { value: "organic", label: "organic" },
];

// ---------------------------------------------------------------------------
// Fetch / mutate
// ---------------------------------------------------------------------------

async function fetchAll(): Promise<Source[]> {
  const res = await fetch("/api/admin/marketing-sources?all=1", {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`Failed to load (${res.status})`);
  const data = (await res.json()) as { sources: Source[] };
  return data.sources ?? [];
}

type CreateBody = {
  source_key: string;
  display_name: string;
  lead_source: string;
  default_medium: string | null;
};

async function createSource(body: CreateBody): Promise<Source> {
  const res = await fetch("/api/admin/marketing-sources", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Create failed (${res.status})`);
  }
  const data = (await res.json()) as { source: Source };
  return data.source;
}

type PatchBody = Partial<{
  display_name: string;
  lead_source: string;
  default_medium: string | null;
  is_active: boolean;
}>;

async function patchSource(id: string, body: PatchBody): Promise<Source> {
  const res = await fetch(`/api/admin/marketing-sources/${id}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Update failed (${res.status})`);
  }
  const data = (await res.json()) as { source: Source };
  return data.source;
}

async function deleteSource(id: string): Promise<void> {
  const res = await fetch(`/api/admin/marketing-sources/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Archive failed (${res.status})`);
  }
}

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

function AddSourceDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [sourceKey, setSourceKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [leadSource, setLeadSource] = useState("");
  const [defaultMedium, setDefaultMedium] = useState<string>("none");

  const reset = () => {
    setSourceKey("");
    setDisplayName("");
    setLeadSource("");
    setDefaultMedium("none");
  };

  const create = useMutation({
    mutationFn: () =>
      createSource({
        source_key: sourceKey.trim(),
        display_name: displayName.trim(),
        lead_source: leadSource.trim(),
        default_medium: defaultMedium === "none" ? null : defaultMedium,
      }),
    onSuccess: () => {
      toast.success(`Source "${sourceKey}" added`);
      reset();
      setOpen(false);
      onCreated();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const sourceKeyOk = /^[a-z0-9][a-z0-9-]*$/.test(sourceKey);
  const canSubmit =
    sourceKey.length > 0 &&
    sourceKeyOk &&
    displayName.trim().length > 0 &&
    leadSource.trim().length > 0 &&
    !create.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          className="bg-white text-slate-900 hover:bg-slate-100"
          data-testid="sources-add-btn"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Add source
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-white">
        <DialogHeader>
          <DialogTitle>Add marketing source</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-slate-600">
              Source key
            </Label>
            <Input
              value={sourceKey}
              onChange={(e) => setSourceKey(e.target.value)}
              placeholder="e.g. tiktok"
              autoFocus
              data-testid="sources-add-key"
            />
            <p
              className={
                "text-xs " +
                (sourceKey.length > 0 && !sourceKeyOk
                  ? "text-red-600"
                  : "text-slate-500")
              }
            >
              Lowercase letters, digits, and dashes. Goes in <code>?source=</code>{" "}
              and <code>utm_source=</code>. Cannot be changed later.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-slate-600">
              Display name
            </Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. TikTok"
              data-testid="sources-add-display"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-slate-600">
              Lead source (Salesforce)
            </Label>
            <Input
              value={leadSource}
              onChange={(e) => setLeadSource(e.target.value)}
              placeholder="e.g. TikTok Ads"
              data-testid="sources-add-leadsource"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-slate-600">
              Default medium
            </Label>
            <Select value={defaultMedium} onValueChange={setDefaultMedium}>
              <SelectTrigger data-testid="sources-add-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEDIUM_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => create.mutate()}
            data-testid="sources-add-submit"
            className="bg-primary text-white hover:bg-primary/90"
          >
            {create.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Add source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog
// ---------------------------------------------------------------------------

function EditSourceDialog({
  source,
  onSaved,
}: {
  source: Source;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(source.displayName);
  const [leadSource, setLeadSource] = useState(source.leadSource);
  const [defaultMedium, setDefaultMedium] = useState(
    source.defaultMedium ?? "none",
  );

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) {
      // Reset to current row values when opening (in case parent refetched).
      setDisplayName(source.displayName);
      setLeadSource(source.leadSource);
      setDefaultMedium(source.defaultMedium ?? "none");
    }
  };

  const save = useMutation({
    mutationFn: () =>
      patchSource(source.id, {
        display_name: displayName.trim(),
        lead_source: leadSource.trim(),
        default_medium: defaultMedium === "none" ? null : defaultMedium,
      }),
    onSuccess: () => {
      toast.success("Source updated");
      setOpen(false);
      onSaved();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const canSubmit =
    displayName.trim().length > 0 &&
    leadSource.trim().length > 0 &&
    !save.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-slate-600 hover:text-slate-900"
          data-testid={`sources-edit-${source.sourceKey}`}
        >
          <Edit2 className="w-3.5 h-3.5" />
          <span className="sr-only">Edit</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-white">
        <DialogHeader>
          <DialogTitle>Edit source — {source.sourceKey}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-slate-600">
              Source key
            </Label>
            <Input value={source.sourceKey} disabled />
            <p className="text-xs text-slate-500">
              Source keys are immutable to preserve attribution for any URLs
              already in the wild.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-slate-600">
              Display name
            </Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-slate-600">
              Lead source (Salesforce)
            </Label>
            <Input
              value={leadSource}
              onChange={(e) => setLeadSource(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-slate-600">
              Default medium
            </Label>
            <Select value={defaultMedium} onValueChange={setDefaultMedium}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEDIUM_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => save.mutate()}
            className="bg-primary text-white hover:bg-primary/90"
          >
            {save.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Sources() {
  const qc = useQueryClient();
  const sourcesQuery = useQuery({
    queryKey: ["marketing-sources-all"],
    queryFn: fetchAll,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["marketing-sources-all"] });
    void qc.invalidateQueries({ queryKey: ["marketing-sources"] });
  };

  const archive = useMutation({
    mutationFn: deleteSource,
    onSuccess: () => {
      toast.success("Archived");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const restore = useMutation({
    mutationFn: (id: string) => patchSource(id, { is_active: true }),
    onSuccess: () => {
      toast.success("Restored");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const { active, archived } = useMemo(() => {
    const rows = sourcesQuery.data ?? [];
    return {
      active: rows.filter((r) => r.isActive),
      archived: rows.filter((r) => !r.isActive),
    };
  }, [sourcesQuery.data]);

  return (
    <AdminLayout>
      <div className="min-h-screen pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">
          <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-white">Sources</h1>
              <p className="text-sm text-white/75 mt-1">
                Marketing channels available in the Custom Link tool. Adding
                a row here makes it available in the Source dropdown
                immediately — no deploy needed.
              </p>
            </div>
            <AddSourceDialog onCreated={invalidate} />
          </header>

          <div className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 overflow-hidden">
            {sourcesQuery.isLoading ? (
              <div className="p-6 space-y-3">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : sourcesQuery.isError ? (
              <div className="p-6 text-sm text-red-600">
                Failed to load sources. Refresh the page to retry.
              </div>
            ) : active.length === 0 && archived.length === 0 ? (
              <div className="p-6 text-sm text-slate-600">No sources yet.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source key</TableHead>
                    <TableHead>Display</TableHead>
                    <TableHead>Lead source (Salesforce)</TableHead>
                    <TableHead>Default medium</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {active.map((s) => (
                    <TableRow key={s.id} data-testid={`sources-row-${s.sourceKey}`}>
                      <TableCell className="font-mono text-xs text-slate-900">
                        {s.sourceKey}
                      </TableCell>
                      <TableCell className="text-slate-800">
                        {s.displayName}
                      </TableCell>
                      <TableCell className="text-slate-800">
                        {s.leadSource}
                      </TableCell>
                      <TableCell className="text-slate-600 text-sm">
                        {s.defaultMedium ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <EditSourceDialog source={s} onSaved={invalidate} />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-slate-600 hover:text-red-600"
                            onClick={() => archive.mutate(s.id)}
                            disabled={archive.isPending}
                            data-testid={`sources-archive-${s.sourceKey}`}
                          >
                            <Archive className="w-3.5 h-3.5" />
                            <span className="sr-only">Archive</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {archived.length > 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wide py-2"
                      >
                        Archived — keys still resolve for live URLs, but
                        hidden from the dropdown
                      </TableCell>
                    </TableRow>
                  )}
                  {archived.map((s) => (
                    <TableRow
                      key={s.id}
                      className="opacity-60"
                      data-testid={`sources-row-${s.sourceKey}`}
                    >
                      <TableCell className="font-mono text-xs text-slate-700">
                        {s.sourceKey}
                      </TableCell>
                      <TableCell className="text-slate-700">
                        {s.displayName}
                      </TableCell>
                      <TableCell className="text-slate-700">
                        {s.leadSource}
                      </TableCell>
                      <TableCell className="text-slate-600 text-sm">
                        {s.defaultMedium ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-slate-600 hover:text-slate-900"
                          onClick={() => restore.mutate(s.id)}
                          disabled={restore.isPending}
                          data-testid={`sources-restore-${s.sourceKey}`}
                        >
                          <RotateCcw className="w-3.5 h-3.5 mr-1" />
                          Restore
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
