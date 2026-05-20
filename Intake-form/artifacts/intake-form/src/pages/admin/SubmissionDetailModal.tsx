import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Copy, FileText, Loader2 } from "lucide-react";
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

      {/* Patient */}
      <Section title="Patient">
        <KeyValue label="Email" value={s.email} />
        <KeyValue label="Phone" value={s.phone} />
        <KeyValue label="Date of Birth" value={s.dateOfBirth ?? "—"} />
        <KeyValue label="State" value={s.stateResidence ?? "—"} />
      </Section>

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
