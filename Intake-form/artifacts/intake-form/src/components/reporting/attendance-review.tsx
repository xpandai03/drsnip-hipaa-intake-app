// Attendance status review — the card on the dashboard, and the panel behind it.
//
// WHAT THIS REPLACES. A card that said attendance was unavailable and left the
// reader with nowhere to go. The blocker was never data; it was a decision
// nobody had a way to record.
//
// THREE THINGS IT REFUSES TO DO
//
// 1. It never pre-answers. Every label starts "not decided", including the ones
//    that look obvious. A bulk "confirm these six" button would be the product
//    making a clinical claim on the clinic's behalf, which is the whole thing
//    this exists to stop.
// 2. It never shows an exact preview. Preview figures are ranges, because exact
//    totals across slightly different answers reveal small groups by
//    subtraction. See the server note in api/attendance-mapping/preview.ts.
// 3. It never promises figures can only rise. More answers can move people out
//    of "not established"; a revision, or a correction at the source, can move
//    them back.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, ChevronDown, Loader2, RefreshCw, ShieldCheck, X,
} from "lucide-react";

// ---------------------------------------------------------------------------
export type Classification =
  | "physically_present" | "remote_presence" | "no_arrival_information"
  | "explicit_absence" | "undecided";

const CHOICES: Array<{ id: Classification; label: string; help: string }> = [
  { id: "physically_present", label: "Patient was physically here",
    help: "This status can only be set once the patient is in the building." },
  { id: "remote_presence", label: "Present, but not in person",
    help: "Online or phone contact. Counted separately — never as being in the clinic." },
  { id: "no_arrival_information", label: "Tells us nothing either way",
    help: "Says nothing about whether the patient came in. NOT the same as saying they did not." },
  { id: "explicit_absence", label: "Patient did not come",
    help: "A deliberate record of non-attendance. We store your answer; no “did not attend” figure is published yet." },
  { id: "undecided", label: "Not decided yet",
    help: "We will not count this status as anything." },
];

type LabelRow = {
  source_column: "current_status" | "transition";
  raw_label: string | null;
  display: string;
  key: string;
  has_near_duplicate: boolean;
  appointments: number | null;
  transitions: number | null;
  offices: number | null;
  providers: number | null;
  first_seen_at: string | null;
  is_new: boolean;
  classification: Classification;
  procedure_signal: boolean;
};

type Inventory = {
  unit: string; note: string; scope_note: string;
  suppression: { threshold: number; note: string };
  mapping: {
    state: "unconfigured" | "draft" | "approved";
    has_draft: boolean; draft_revision: number | null; approved_version: number | null;
    confirmed_by_name: string | null; confirmed_by_role: string | null;
    confirmed_on: string | null; confirmed_via: string | null; confirmed_scope: string | null;
  };
  can: { edit_draft: boolean; approve: boolean };
  labels: LabelRow[];
};

type Band = { low: number; high: number } | null;
type Preview = {
  status: string; previewed_revision: number | null; evidence_as_of: string | null;
  cohort: { total: number; eligible: number; immature: number };
  bands: {
    width: number; evidenced_in_window: Band; evidenced_untimed: Band;
    evidenced_outside_window: Band; not_established: Band; remote_only: Band;
  };
  notes: Record<string, string | null>;
};

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return (await r.json()) as T;
}
async function send<T>(url: string, method: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((json as { error?: string }).error ?? `${r.status}`), { status: r.status, json });
  return json as T;
}

const clinic = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }) : null;

/** A suppressed count is "withheld", never a zero and never a dash that reads as none. */
function Count({ n }: { n: number | null }) {
  if (n === null) return <span className="text-muted-foreground">withheld</span>;
  return <span className="tabular-nums">{n.toLocaleString()}</span>;
}

function bandText(b: Band): string {
  return b === null ? "withheld" : `${b.low}–${b.high}`;
}

// ---------------------------------------------------------------------------
export function AttendanceReviewCard({ onOpen }: { onOpen: () => void }) {
  const inv = useQuery({
    queryKey: ["status-inventory"],
    queryFn: () => getJson<Inventory>("/api/reports/status-inventory"),
    staleTime: 30_000, retry: 1,
  });

  const m = inv.data?.mapping;
  const approved = m?.state === "approved";

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="attendance-review-card">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Attendance status review
      </div>

      {inv.isPending && !inv.data ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Checking the status list…
        </p>
      ) : inv.isError ? (
        <p className="mt-2 text-sm" role="alert">
          <span className="font-medium">The status list could not be loaded.</span>{" "}
          <button type="button" onClick={() => void inv.refetch()}
                  className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Try again
          </button>
        </p>
      ) : approved ? (
        <>
          <div className="mt-1 text-base font-medium">Definition confirmed</div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Attendance figures use the definition confirmed by{" "}
            <strong>{m?.confirmed_by_name}</strong>
            {m?.confirmed_by_role ? ` (${m.confirmed_by_role})` : ""}
            {m?.confirmed_on ? ` on ${m.confirmed_on}` : ""}.
            {m?.confirmed_scope ? ` Scope: ${m.confirmed_scope}.` : ""}
          </p>
        </>
      ) : (
        <>
          <div className="mt-1 text-base font-medium">Not published yet</div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Appointment history is available. Confirm which clinic statuses establish physical
            arrival before publishing attendance.
          </p>
        </>
      )}

      {inv.data?.mapping.has_draft && (
        <p className="mt-2 rounded border border-amber-600/30 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
           data-testid="attendance-draft-strip">
          A draft is in progress. Nothing on this dashboard has changed.
        </p>
      )}

      <button
        type="button"
        onClick={onOpen}
        data-testid="attendance-review-open"
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Review statuses
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function AttendanceReviewPanel({
  open, onClose, from, to, windowDays, metric,
}: {
  open: boolean; onClose: () => void;
  from: string; to: string; windowDays: number; metric: string;
}) {
  const qc = useQueryClient();
  const inv = useQuery({
    queryKey: ["status-inventory"],
    queryFn: () => getJson<Inventory>("/api/reports/status-inventory"),
    enabled: open, staleTime: 15_000, retry: 1,
  });

  // Local edits, keyed NULL-safely by the server-supplied key.
  const [edits, setEdits] = useState<Record<string, { classification: Classification; procedure_signal: boolean }>>({});
  const [revision, setRevision] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const rows = inv.data?.labels ?? [];
  const current = useCallback(
    (r: LabelRow) => edits[r.key] ?? { classification: r.classification, procedure_signal: r.procedure_signal },
    [edits],
  );
  const labelPayload = useMemo(
    () => rows.map((r) => ({
      source_column: r.source_column, raw_label: r.raw_label,
      classification: current(r).classification, procedure_signal: current(r).procedure_signal,
    })),
    [rows, current],
  );
  const undecided = labelPayload.filter((l) => l.classification === "undecided").length;
  const decided = labelPayload.length - undecided;
  const effectiveRevision = revision ?? inv.data?.mapping.draft_revision ?? null;

  const saveDraft = useMutation({
    mutationFn: () => send<{ revision: number }>("/api/attendance-mapping/draft", "PUT",
      { labels: labelPayload, revision: effectiveRevision }),
    onSuccess: (d) => { setRevision(d.revision); setSaved("Draft saved. Published reporting has not changed."); setError(null); },
    onError: (e: unknown) => {
      const st = (e as { status?: number }).status;
      setError(st === 409
        ? "Someone else changed this draft while you were editing. Close and reopen to pick up their version."
        : st === 403 ? "This account cannot edit the definition."
        : "The draft could not be saved.");
    },
  });

  const runPreview = useMutation({
    mutationFn: () => send<Preview>("/api/attendance-mapping/preview", "POST",
      { labels: labelPayload, metric, from, to, window: windowDays }),
    onSuccess: (d) => { setPreview(d); setError(null); setSaved(null); },
    onError: (e: unknown) => setError((e as { status?: number }).status === 403
      ? "This account cannot preview." : "The preview could not be produced."),
  });

  const approve = useMutation({
    mutationFn: (form: Record<string, unknown>) =>
      send<{ version: number }>("/api/attendance-mapping/approve", "POST", form),
    onSuccess: () => {
      setConfirming(false); setSaved("Approved. Attendance is now published.");
      void qc.invalidateQueries({ queryKey: ["status-inventory"] });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (e: unknown) => {
      const st = (e as { status?: number }).status;
      setError(st === 409
        ? "The draft changed since you previewed it. Preview again before approving."
        : st === 403 ? "This account is not authorised to approve clinic definitions."
        : ((e as { json?: { message?: string } }).json?.message ?? "The approval was refused."));
    },
  });

  // Escape closes the dialog, and focus moves into it on open and back to the
  // opener on close. A modal that traps a keyboard user is not usable, and the
  // browser gives none of this for free on a div with role="dialog".
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    // Focus the dialog itself rather than a control: a reader lands on the
    // heading and hears what this is before meeting a radio group.
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const visible = showAll ? rows : rows.slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
         role="dialog" aria-modal="true" aria-label="Attendance status review">
      <div className="my-8 w-full max-w-3xl rounded-lg border bg-card p-5 shadow-xl focus:outline-none"
           data-testid="attendance-review-panel"
           ref={dialogRef}
           tabIndex={-1}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Attendance status review</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Tell us what your status labels mean, and we will work out who came in.
              Nothing here changes your records in DrChrono.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {inv.isPending && !inv.data && (
          <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading your status list…
          </p>
        )}
        {inv.isError && (
          <div className="mt-6 rounded border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
            <p className="font-medium">The status list could not be loaded.</p>
            <button type="button" onClick={() => void inv.refetch()}
                    className="mt-2 inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-muted">
              <RefreshCw className="h-3 w-3" aria-hidden="true" /> Try again
            </button>
          </div>
        )}
        {inv.data && rows.length === 0 && (
          <p className="mt-6 text-sm text-muted-foreground">
            No appointment statuses have been recorded yet, so there is nothing to classify.
          </p>
        )}

        {inv.data && rows.length > 0 && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border px-2 py-0.5" data-testid="decided-counter">
                {rows.length} statuses · {decided} decided · {undecided} not decided
              </span>
              {inv.data.mapping.has_draft && (
                <span className="rounded-full border border-amber-600/30 bg-amber-50 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  Draft — published reporting has not changed
                </span>
              )}
            </div>

            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              {inv.data.note} {inv.data.scope_note}
            </p>

            <div className="mt-4 divide-y rounded border">
              {visible.map((r) => {
                const cur = current(r);
                return (
                  <div key={r.key} className="p-3" data-testid={`label-row-${r.source_column}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-medium">{r.display}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {r.source_column === "transition" ? "seen in history" : "seen as a current status"}
                        </span>
                        {r.is_new && (
                          <span className="ml-2 rounded border px-1 text-[10px] uppercase"
                                title="This status has appeared since the definition was confirmed, and is not counted.">
                            new
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        <Count n={r.appointments} /> appointments
                        {r.offices !== null && ` · ${r.offices} office${r.offices === 1 ? "" : "s"}`}
                      </span>
                    </div>

                    {r.has_near_duplicate && (
                      <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                        Another status looks almost identical to this one. They are kept separate —
                        confirm whether they mean the same thing.
                      </p>
                    )}

                    <fieldset className="mt-2" disabled={!inv.data!.can.edit_draft}>
                      <legend className="sr-only">What {r.display} means</legend>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {CHOICES.map((c) => (
                          <label key={c.id} className="flex items-center gap-1.5 text-xs" title={c.help}>
                            <input
                              type="radio"
                              name={`cls-${r.key}`}
                              checked={cur.classification === c.id}
                              onChange={() => setEdits((e) => ({ ...e, [r.key]: { ...cur, classification: c.id } }))}
                              className="h-3 w-3"
                            />
                            <span className={cur.classification === c.id ? "font-medium" : ""}>{c.label}</span>
                          </label>
                        ))}
                      </div>
                      <label className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={cur.procedure_signal}
                          onChange={(ev) => setEdits((e) => ({ ...e, [r.key]: { ...cur, procedure_signal: ev.target.checked } }))}
                          className="h-3 w-3"
                        />
                        Also says something about whether the procedure happened
                        <span className="italic"> (never counted as arrival)</span>
                      </label>
                    </fieldset>
                  </div>
                );
              })}
            </div>

            {rows.length > 8 && (
              <button type="button" onClick={() => setShowAll((v) => !v)}
                      className="mt-2 inline-flex items-center gap-1 text-xs underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown className={`h-3 w-3 transition-transform ${showAll ? "rotate-180" : ""}`} aria-hidden="true" />
                {showAll ? "Show fewer" : `Show all ${rows.length} statuses`}
              </button>
            )}

            {saved && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-800 dark:text-emerald-300"
                 role="status" data-testid="attendance-saved">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> {saved}
              </p>
            )}
            {error && (
              <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive" role="alert"
                 data-testid="attendance-error">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {error}
              </p>
            )}

            {preview && (
              <div className="mt-4 rounded border bg-muted/20 p-3" data-testid="attendance-preview">
                <h3 className="text-sm font-semibold">If this were confirmed</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Patients (not appointments) whose first registration falls in {from} to {to},
                  measured over {windowDays} days, as at {clinic(preview.evidence_as_of) ?? "the last sync"}.
                </p>
                {preview.status === "withheld_small_cohort" ? (
                  <p className="mt-2 text-xs" data-testid="preview-withheld">{preview.notes.withheld}</p>
                ) : (
                  <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                    <div><dt className="inline font-medium">Arrival evidenced, inside the window: </dt>
                      <dd className="inline tabular-nums">{bandText(preview.bands.evidenced_in_window)}</dd></div>
                    <div><dt className="inline font-medium">Evidence with no usable time: </dt>
                      <dd className="inline tabular-nums">{bandText(preview.bands.evidenced_untimed)}</dd></div>
                    <div><dt className="inline font-medium">Arrival evidenced, outside the window: </dt>
                      <dd className="inline tabular-nums">{bandText(preview.bands.evidenced_outside_window)}</dd></div>
                    <div><dt className="inline font-medium">Arrival not established: </dt>
                      <dd className="inline tabular-nums">{bandText(preview.bands.not_established)}</dd></div>
                    <div className="sm:col-span-2">
                      <dt className="inline font-medium">Eligible to measure: </dt>
                      <dd className="inline tabular-nums">{preview.cohort.eligible}</dd>
                      <span className="text-muted-foreground"> · {preview.cohort.immature} still inside their window</span>
                    </div>
                  </dl>
                )}
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{preview.notes.banded}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{preview.notes.untimed}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{preview.notes.movement}</p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" disabled={!inv.data.can.edit_draft || saveDraft.isPending}
                      onClick={() => saveDraft.mutate()}
                      data-testid="attendance-save-draft"
                      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {saveDraft.isPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                Save draft
              </button>
              <button type="button" disabled={!inv.data.can.edit_draft || runPreview.isPending}
                      onClick={() => runPreview.mutate()}
                      data-testid="attendance-preview-btn"
                      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {runPreview.isPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                See the impact
              </button>
              {inv.data.can.approve ? (
                <button type="button" disabled={!preview || decided === 0}
                        onClick={() => setConfirming(true)}
                        data-testid="attendance-approve-btn"
                        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" /> Approve…
                </button>
              ) : (
                <span className="text-xs text-muted-foreground" data-testid="attendance-cannot-approve">
                  Approving a definition needs an authorised account.
                </span>
              )}
            </div>

            {confirming && (
              <ApprovalForm
                entering=""
                previewedRevision={preview?.previewed_revision ?? effectiveRevision}
                onCancel={() => setConfirming(false)}
                onSubmit={(form) => approve.mutate(form)}
                pending={approve.isPending}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * The two people are different people.
 *
 * `confirmed_by_*` is the clinic person whose decision it is. The authenticated
 * approver is recorded separately by the server. A decision made on a call is
 * entered by somebody else, and the record has to say so.
 */
function ApprovalForm({
  entering, previewedRevision, onCancel, onSubmit, pending,
}: {
  entering: string; previewedRevision: number | null;
  onCancel: () => void; onSubmit: (f: Record<string, unknown>) => void; pending: boolean;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [via, setVia] = useState("video_call");
  const [on, setOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [scope, setScope] = useState("The whole practice");
  const [note, setNote] = useState("");
  const ready = name.trim() && role.trim() && scope.trim() && on;

  return (
    <form
      className="mt-4 rounded border bg-muted/20 p-3"
      data-testid="attendance-approval-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          revision: previewedRevision,
          provenance: {
            confirmed_by_name: name, confirmed_by_role: role,
            confirmed_via: via, confirmed_on: on, confirmed_scope: scope,
          },
          note: note || null,
        });
      }}
    >
      <h3 className="text-sm font-semibold">Record the clinic&rsquo;s decision</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        These figures will appear on the dashboard for everyone. We record who confirmed the
        decision and, separately, who entered it{entering ? ` (${entering})` : ""}.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs">
          <span className="mb-1 block font-medium">Who confirmed this?</span>
          <input required value={name} onChange={(e) => setName(e.target.value)}
                 data-testid="confirm-name"
                 className="w-full rounded border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Their role</span>
          <input required value={role} onChange={(e) => setRole(e.target.value)}
                 data-testid="confirm-role"
                 className="w-full rounded border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">How?</span>
          <select value={via} onChange={(e) => setVia(e.target.value)} data-testid="confirm-via"
                  className="w-full rounded border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="video_call">Video call</option>
            <option value="call">Phone call</option>
            <option value="email">Email</option>
            <option value="in_person">In person</option>
            <option value="written">Written</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">On what date?</span>
          <input required type="date" value={on} onChange={(e) => setOn(e.target.value)}
                 data-testid="confirm-on"
                 className="w-full rounded border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block font-medium">What did they confirm it for?</span>
          <input required value={scope} onChange={(e) => setScope(e.target.value)}
                 data-testid="confirm-scope"
                 className="w-full rounded border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block font-medium">Anything to note? (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)}
                 className="w-full rounded border bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onCancel}
                className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Cancel
        </button>
        <button type="submit" disabled={!ready || pending}
                data-testid="attendance-approve-submit"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          Approve
        </button>
      </div>
    </form>
  );
}
