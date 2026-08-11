import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Trash2, Download } from "lucide-react";
import { toast } from "sonner";
import { AdminLayout } from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth-context";

// Registration drop-offs (Train 2). People who started registration, entered
// contact info, and left without submitting. Show + export only — no outreach.
// Starts empty and accrues from deploy forward; a completed registration
// removes its own row (conversion cleanup).

type Partial = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  officeLocation: string | null;
  furthestStep: number | null;
  furthestStepLabel: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
};
type PartialsResponse = { partials: Partial[]; total: number };

const LOCATIONS = ["Seattle, WA", "Portland, OR", "Plano, TX"];

const PT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
function pacific(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${PT.format(d)} PT`;
}

async function fetchPartials(
  includeRecent: boolean,
  location: string,
): Promise<PartialsResponse> {
  const qs = new URLSearchParams();
  if (includeRecent) qs.set("include_recent", "1");
  if (location !== "all") qs.set("location", location);
  const res = await fetch(`/api/registration-partials?${qs.toString()}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`registration-partials ${res.status}`);
  return (await res.json()) as PartialsResponse;
}

export default function AdminDropOffs() {
  return (
    <AdminLayout>
      <DropOffsPage />
    </AdminLayout>
  );
}

function DropOffsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role !== "viewer";
  const qc = useQueryClient();
  const [includeRecent, setIncludeRecent] = useState(false);
  const [location, setLocation] = useState("all");

  const query = useQuery({
    queryKey: ["dropoffs", includeRecent, location],
    queryFn: () => fetchPartials(includeRecent, location),
    refetchOnWindowFocus: true,
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/registration-partials/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`delete ${res.status}`);
    },
    onSuccess: () => {
      toast.success("Drop-off deleted");
      void qc.invalidateQueries({ queryKey: ["dropoffs"] });
    },
    onError: () => toast.error("Couldn't delete that row."),
  });

  const exportUrl = useMemo(() => {
    const qs = new URLSearchParams();
    if (includeRecent) qs.set("include_recent", "1");
    if (location !== "all") qs.set("location", location);
    return `/api/registration-partials/export?${qs.toString()}`;
  }, [includeRecent, location]);

  const rows = query.data?.partials ?? [];

  return (
    <div className="min-h-screen pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">
              Registration drop-offs
              {query.data && (
                <span className="ml-3 text-xl font-normal text-white/70">
                  {query.data.total.toLocaleString()}
                </span>
              )}
            </h1>
            <p className="text-sm text-white/75 mt-1">
              Started registration and entered contact info, but didn't submit.
              Recent activity (last 24h) is hidden by default — they may still be
              finishing.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-white/80 bg-white/10 rounded-lg px-3 py-1.5">
              <input
                type="checkbox"
                checked={includeRecent}
                onChange={(e) => setIncludeRecent(e.target.checked)}
                data-testid="include-recent"
              />
              Include last 24h
            </label>
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="bg-white/10 text-white/90 text-sm rounded-lg px-3 py-1.5 border border-white/10"
              data-testid="dropoff-location"
            >
              <option value="all" className="text-slate-900">All locations</option>
              {LOCATIONS.map((l) => (
                <option key={l} value={l} className="text-slate-900">
                  {l}
                </option>
              ))}
            </select>
            {isAdmin && rows.length > 0 && (
              <a href={exportUrl}>
                <Button variant="outline" size="sm" className="bg-white">
                  <Download className="w-4 h-4" />
                  Export CSV
                </Button>
              </a>
            )}
          </div>
        </header>

        <section className="bg-white rounded-3xl shadow-2xl shadow-black/20 border-0 p-5">
          {query.isLoading ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : query.isError ? (
            <div className="py-14 text-center">
              <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
              <p className="text-sm text-slate-500">Couldn't load drop-offs.</p>
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-500 py-14 text-center">
              No drop-offs{location !== "all" ? " for this location" : ""}
              {!includeRecent ? " older than 24h" : ""}. This list accrues as
              people start but don't finish registration.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200">
                    <th className="py-2 pr-3 font-medium">Name</th>
                    <th className="py-2 pr-3 font-medium">Email</th>
                    <th className="py-2 pr-3 font-medium">Phone</th>
                    <th className="py-2 pr-3 font-medium">Location</th>
                    <th className="py-2 pr-3 font-medium">Furthest step</th>
                    <th className="py-2 pr-3 font-medium">Started</th>
                    <th className="py-2 pr-3 font-medium">Last active</th>
                    <th className="py-2 pr-3 font-medium">Source</th>
                    {isAdmin && <th className="py-2 font-medium" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100">
                      <td className="py-2 pr-3 text-slate-900">
                        {[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"}
                      </td>
                      <td className="py-2 pr-3 text-slate-700">{r.email ?? "—"}</td>
                      <td className="py-2 pr-3 text-slate-700">{r.phone ?? "—"}</td>
                      <td className="py-2 pr-3 text-slate-700">{r.officeLocation ?? "—"}</td>
                      <td className="py-2 pr-3 text-slate-700">
                        {r.furthestStep != null
                          ? `Step ${r.furthestStep}${r.furthestStepLabel ? ` · ${r.furthestStepLabel}` : ""}`
                          : "—"}
                      </td>
                      <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{pacific(r.createdAt)}</td>
                      <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{pacific(r.updatedAt)}</td>
                      <td className="py-2 pr-3 text-slate-700">{r.source ?? "—"}</td>
                      {isAdmin && (
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => del.mutate(r.id)}
                            disabled={del.isPending}
                            className="text-slate-400 hover:text-rose-600 transition-colors disabled:opacity-40"
                            aria-label="Delete drop-off"
                            title="Delete this drop-off"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
