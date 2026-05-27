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
  // Phase 3 address-split — the Patient section now renders the address
  // composite (Street / City, State ZIP) from these raw_payload keys, so
  // skip them in the generic Form Data list to avoid duplication.
  "streetAddress",
  "city",
  "postalCode",
  "insuranceCardFront",
  "insuranceCardBack",
]);

/** Compose a multi-line address from raw_payload + dedicated state column.
 *  Returns null when no part of the address is present. */
function composeAddress(
  raw: Record<string, unknown>,
  stateFromColumn: string | null,
): string | null {
  const street = typeof raw.streetAddress === "string" ? raw.streetAddress.trim() : "";
  const city = typeof raw.city === "string" ? raw.city.trim() : "";
  const stateValue =
    (typeof raw.state === "string" && raw.state.trim()) ||
    (stateFromColumn ?? "");
  const zip = typeof raw.postalCode === "string" ? raw.postalCode.trim() : "";
  if (!street && !city && !stateValue && !zip) return null;
  const cityStateZip = [city, [stateValue, zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [street, cityStateZip].filter(Boolean).join("\n");
}

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
        {/* Phase 3 address-split: render the structured address composite
            (Street / City, State ZIP). State falls back to the dedicated
            stateResidence column for legacy rows. */}
        <KeyValue
          label="Address"
          value={composeAddress(raw, s.stateResidence) ?? "—"}
        />
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
// link, response timestamp) plus a structured diagnostic when the bridge
// failed (Phase-3 bridge-fix). Raw JSON response stays collapsible at the
// bottom for low-level debugging.
function N8nOutcomeSection({ submission }: { submission: DetailSubmission }) {
  const s = submission;
  const [open, setOpen] = useState(false);

  // The bridge stores its outcome under n8nResponseBody as:
  //   { bridge_status, error_message?, response?, diagnostic? }
  const body = (s.n8nResponseBody ?? null) as Record<string, unknown> | null;
  const errorMessage =
    body && typeof body.error_message === "string"
      ? (body.error_message as string)
      : null;
  const diagnostic =
    body && body.diagnostic && typeof body.diagnostic === "object"
      ? (body.diagnostic as Record<string, unknown>)
      : null;

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

      {/* Failure diagnostic — visible without expanding raw JSON. */}
      {s.n8nStatus === "failed" && (errorMessage || diagnostic) && (
        <div className="py-2 border-t border-slate-100">
          <p className="text-sm text-rose-700 font-medium mb-1">Failure detail</p>
          {errorMessage && (
            <p className="text-sm text-slate-700 mb-1">
              <span className="text-slate-500">Error:</span> {errorMessage}
            </p>
          )}
          {diagnostic && (
            <dl className="text-xs text-slate-600 space-y-0.5">
              {diagnosticRow(diagnostic, "kind", "Kind")}
              {diagnosticRow(diagnostic, "httpStatus", "HTTP status")}
              {diagnosticRow(diagnostic, "contentType", "Content-Type")}
              {diagnosticRow(diagnostic, "bodyLength", "Body length")}
              {diagnosticRow(diagnostic, "parseError", "Parse error")}
              {diagnosticRow(diagnostic, "errorName", "Error name")}
              {diagnosticRow(diagnostic, "causeMessage", "Cause")}
              {diagnosticRow(diagnostic, "elapsedMs", "Elapsed (ms)")}
              {diagnosticRow(diagnostic, "stackHead", "Stack (head)")}
            </dl>
          )}
          {diagnostic && typeof diagnostic.bodySnippet === "string" &&
            diagnostic.bodySnippet.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-slate-600 cursor-pointer">
                  Body snippet ({String(diagnostic.bodyLength ?? "?")} bytes)
                </summary>
                <pre className="mt-1 text-[11px] font-mono text-slate-700 bg-white border border-slate-200 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-words">
                  {diagnostic.bodySnippet as string}
                </pre>
              </details>
            )}
        </div>
      )}

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

function diagnosticRow(
  diagnostic: Record<string, unknown>,
  key: string,
  label: string,
): React.ReactNode {
  const v = diagnostic[key];
  if (v == null || v === "") return null;
  return (
    <div className="flex items-start gap-2">
      <dt className="text-slate-500 shrink-0">{label}:</dt>
      <dd className="text-slate-800 font-mono break-all">{String(v)}</dd>
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
  // Preserve embedded newlines so the multi-line Address composite renders as
  // Street / City, State ZIP rather than collapsing to one line.
  const hasNewline = value.includes("\n");
  return (
    <div className="flex items-start justify-between gap-6 py-2">
      <span className="text-sm text-slate-500 shrink-0">{label}</span>
      <span
        className={
          "text-sm font-medium text-slate-900 text-right break-words" +
          (hasNewline ? " whitespace-pre-line" : "")
        }
      >
        {value}
      </span>
    </div>
  );
}
