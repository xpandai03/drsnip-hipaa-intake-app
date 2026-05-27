import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileDown,
  FileText,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Chip,
  copyToClipboard,
  exactTime,
  formTypeBadgeClass,
  formTypeLabel,
  n8nStatusBadgeClass,
  n8nStatusLabel,
} from "./Submissions";

// ---------------------------------------------------------------------------
// Types — mirror /api/submissions/[id] (Phase 2 — DrSnip).
// The CJC scoring-trace / Salesforce sections were removed; the detail view
// now renders the dedicated patient columns plus the full raw_payload.
// ---------------------------------------------------------------------------

type DetailSubmission = {
  id: string;
  createdAt: string;
  updatedAt: string;
  formType: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string | null;
  stateResidence: string | null;
  insuranceCardFrontFilename: string | null;
  insuranceCardBackFilename: string | null;
  hasInsuranceCards: boolean;
  // Phase 3 n8n bridge fields. NULL while pending.
  n8nStatus: "success" | "manual_review" | "failed" | null;
  n8nPatientId: number | null;
  n8nResponseAt: string | null;
  n8nResponseBody: Record<string, unknown> | null;
  rawPayload: Record<string, unknown>;
};

type DetailResponse = { submission: DetailSubmission };

async function fetchDetail(id: string): Promise<DetailResponse> {
  const res = await fetch(`/api/submissions/${id}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`/api/submissions/${id} returned ${res.status}`);
  return (await res.json()) as DetailResponse;
}

// ---------------------------------------------------------------------------
// raw_payload rendering helpers
// ---------------------------------------------------------------------------

// camelCase → "Camel Case"
function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    return v.map((item) => formatValue(item)).join(", ");
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.filename === "string") {
      return typeof o.size === "number"
        ? `${o.filename} (${o.size} bytes)`
        : o.filename;
    }
    return Object.entries(o)
      .map(([k, val]) => `${humanize(k)}: ${formatValue(val)}`)
      .join("; ");
  }
  return String(v);
}

// Keys already shown in the dedicated patient/insurance sections — skipped in
// the generic Form Data list to avoid duplication.
const PROMOTED_KEYS = new Set([
  "formType",
  "firstName",
  "lastName",
  "legalFirstName",
  "legalLastName",
  "email",
  "phone",
  "mobileNumber",
  "dateOfBirth",
  "stateResidence",
  "state",
  "insuranceCardFront",
  "insuranceCardBack",
]);

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function SubmissionDetailModal({
  id,
  open,
  onClose,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["submission-detail", id],
    queryFn: () => fetchDetail(id as string),
    enabled: open && id !== null,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Submission detail</DialogTitle>
        </DialogHeader>

        {query.isLoading ? (
          <div className="py-16 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : query.isError ? (
          <div className="py-12 text-center">
            <AlertCircle className="w-7 h-7 text-red-500 mx-auto mb-2" />
            <p className="text-sm text-slate-600">
              Couldn't load this submission.
            </p>
          </div>
        ) : query.data ? (
          <DetailBody submission={query.data.submission} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailBody({ submission }: { submission: DetailSubmission }) {
  const s = submission;
  const raw = s.rawPayload ?? {};
  const formEntries = Object.entries(raw).filter(
    ([k]) => !PROMOTED_KEYS.has(k),
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-slate-900">
            {s.firstName} {s.lastName}
          </p>
          <p className="text-xs text-slate-500">
            Submitted {exactTime(s.createdAt)}
          </p>
        </div>
        <Chip className={formTypeBadgeClass(s.formType)}>
          {formTypeLabel(s.formType)}
        </Chip>
      </div>

      {/* Download PDF — generated on-demand by GET /api/submissions/:id/pdf. */}
      <button
        type="button"
        onClick={() =>
          window.open(`/api/submissions/${s.id}/pdf`, "_blank", "noopener")
        }
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-white font-medium hover:bg-primary/90 transition-colors"
      >
        <FileDown className="w-4 h-4" />
        Download PDF
      </button>

      {/* Patient */}
      <Section title="Patient">
        <KeyValue label="Email" value={s.email} />
        <KeyValue label="Phone" value={s.phone} />
        <KeyValue label="Date of Birth" value={s.dateOfBirth ?? "—"} />
        <KeyValue label="State" value={s.stateResidence ?? "—"} />
      </Section>

      {/* n8n bridge outcome — Phase 3 wire to DrChrono. */}
      <N8nOutcomeSection submission={s} />

      {/* Insurance cards (stub) */}
      <Section title="Insurance Cards">
        <KeyValue
          label="Cards provided"
          value={s.hasInsuranceCards ? "Yes" : "No"}
        />
        <KeyValue
          label="Front"
          value={s.insuranceCardFrontFilename ?? "—"}
        />
        <KeyValue label="Back" value={s.insuranceCardBackFilename ?? "—"} />
        <p className="text-xs text-slate-400 mt-1">
          Demo mode — only filenames are stored; no file bytes are persisted.
        </p>
      </Section>

      {/* Full form answers from raw_payload */}
      <Section title="Form Data" icon>
        {formEntries.length === 0 ? (
          <p className="text-sm text-slate-500">No additional fields.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {formEntries.map(([k, v]) => (
              <KeyValue key={k} label={humanize(k)} value={formatValue(v)} />
            ))}
          </div>
        )}
      </Section>

      {/* Submission ID */}
      <div className="pt-2 border-t border-slate-100">
        <button
          type="button"
          onClick={() => void copyToClipboard(s.id, "Submission ID copied")}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-mono text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors"
          title="Copy submission ID"
        >
          ID: {s.id}
          <Copy className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// Phase 3 n8n bridge — surfaces the bridge outcome (status, DrChrono patient
// link, response timestamp) plus a collapsible raw-JSON view for debugging.
function N8nOutcomeSection({ submission }: { submission: DetailSubmission }) {
  const s = submission;
  const [open, setOpen] = useState(false);
  return (
    <Section title="n8n / DrChrono">
      <div className="py-2 flex items-center justify-between gap-3">
        <span className="text-sm text-slate-500 shrink-0">Status</span>
        <Chip className={n8nStatusBadgeClass(s.n8nStatus)}>
          {n8nStatusLabel(s.n8nStatus)}
        </Chip>
      </div>
      <div className="py-2 flex items-start justify-between gap-6 border-t border-slate-100">
        <span className="text-sm text-slate-500 shrink-0">DrChrono patient</span>
        <span className="text-sm font-medium text-slate-900 text-right">
          {s.n8nPatientId != null ? (
            <a
              href={`https://app.drchrono.com/patients/${s.n8nPatientId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {s.n8nPatientId}
              <ExternalLink className="w-3 h-3" />
            </a>
          ) : (
            "—"
          )}
        </span>
      </div>
      <div className="py-2 flex items-start justify-between gap-6 border-t border-slate-100">
        <span className="text-sm text-slate-500 shrink-0">Last response</span>
        <span className="text-sm font-medium text-slate-900 text-right">
          {s.n8nResponseAt ? exactTime(s.n8nResponseAt) : "—"}
        </span>
      </div>
      {s.n8nResponseBody !== null && (
        <div className="py-2 border-t border-slate-100">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
          >
            {open ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            Raw response
          </button>
          {open && (
            <pre className="mt-2 text-[11px] font-mono text-slate-700 bg-white border border-slate-200 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-words">
              {JSON.stringify(s.n8nResponseBody, null, 2)}
            </pre>
          )}
        </div>
      )}
    </Section>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 mb-2">
        {icon && <FileText className="w-4 h-4 text-primary" />}
        {title}
      </h3>
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-1">
        {children}
      </div>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2">
      <span className="text-sm text-slate-500 shrink-0">{label}</span>
      <span className="text-sm font-medium text-slate-900 text-right break-words">
        {value}
      </span>
    </div>
  );
}
