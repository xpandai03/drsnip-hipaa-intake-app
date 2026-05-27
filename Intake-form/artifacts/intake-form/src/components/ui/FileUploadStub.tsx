import { useRef, useState } from "react";
import { UploadCloud, FileCheck2, X, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// Phase 3 — insurance card upload. The patient selects an image (JPEG or
// PNG), the browser reads it as a base64 data URL, the prefix is stripped,
// and the captured ref { filename, contentType, size, base64Data } is
// surfaced via onChange. The bytes ride inline in the /api/submit body —
// raw_payload sanitization happens server-side (api/submit.ts) so the DB
// row stays lean; the full body with bytes is what the n8n bridge sends to
// DrChrono.
//
// Phase 4 will replace inline base64 with BAA-covered object storage
// (Cloudflare R2 / S3) — at that point this component shifts to uploading
// the file and capturing a storage key instead of the bytes. The
// `StubFileRef` name is preserved for back-compat with existing imports;
// when storage lands we may rename to `CapturedFileRef`.
//
// HIPAA: card images are PHI. This component never logs file content or
// filenames; consumers should also avoid logging the base64Data or
// filename, which may contain identifiers.

export type StubFileRef = {
  filename: string;
  contentType: string;
  size: number;
  /** Base64 (no `data:...;base64,` prefix). May be empty for legacy
   *  metadata-only references — bridge omits the card cleanly when empty. */
  base64Data: string;
};

interface FileUploadStubProps {
  label?: string;
  /** Defaults to JPEG/PNG. PDF cards are out of scope for Phase 3 (n8n
   *  upload path expects an image mime). */
  accept?: string;
  value?: StubFileRef | null;
  onChange: (file: StubFileRef | null) => void;
  /** Per-file cap. Default 5MB matches the cutover spec and keeps the
   *  combined two-card payload comfortably under typical proxy limits. */
  maxBytes?: number;
}

const DEFAULT_ACCEPT = "image/jpeg,image/png";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readAsBase64(file: File): Promise<{ contentType: string; base64Data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      // result is `data:image/jpeg;base64,<...>` — strip the prefix.
      const commaIdx = result.indexOf(",");
      const base64Data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      resolve({ contentType: file.type || "application/octet-stream", base64Data });
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

export function FileUploadStub({
  label,
  accept = DEFAULT_ACCEPT,
  value,
  onChange,
  maxBytes = DEFAULT_MAX_BYTES,
}: FileUploadStubProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read the file, validate, and emit a captured ref upstream. Validation
  // failures land in the inline error state — patient sees the message; we
  // do not log it (filename / size may be identifying).
  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    setError(null);

    const allowed = accept.split(",").map((m) => m.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(file.type)) {
      setError("Please upload a JPEG or PNG image.");
      return;
    }
    if (file.size > maxBytes) {
      setError(`File is too large. Maximum ${formatSize(maxBytes)}.`);
      return;
    }

    setBusy(true);
    try {
      const { contentType, base64Data } = await readAsBase64(file);
      onChange({
        filename: file.name,
        contentType,
        size: file.size,
        base64Data,
      });
    } catch {
      setError("Couldn't read that file. Try a different image.");
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    onChange(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="space-y-2">
      {label && (
        <span className="block text-sm font-medium text-slate-500 ml-1">
          {label}
        </span>
      )}

      {value ? (
        <div className="flex items-center justify-between gap-3 p-4 border-2 rounded-2xl border-primary/30 bg-primary/5">
          <div className="flex items-center gap-3 min-w-0">
            <FileCheck2 className="w-5 h-5 text-primary shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">
                {value.filename}
              </p>
              <p className="text-xs text-slate-500">
                {formatSize(value.size)}
                {value.contentType ? ` · ${value.contentType.replace(/^image\//, "")}` : ""}
                {value.base64Data ? " · ready" : ""}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={clear}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            aria-label="Remove file"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFile(e.dataTransfer.files?.[0]);
          }}
          disabled={busy}
          className={cn(
            "w-full flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed rounded-2xl transition-colors cursor-pointer",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-slate-300 bg-slate-50 hover:border-primary/50 hover:bg-slate-100",
            busy && "opacity-60 pointer-events-none",
          )}
        >
          <UploadCloud className="w-7 h-7 text-slate-400" />
          <span className="text-sm font-medium text-slate-600">
            {busy ? "Reading file…" : "Click to choose a file, or drag & drop"}
          </span>
          <span className="text-xs text-slate-400">
            JPG or PNG, up to {formatSize(maxBytes)}
          </span>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />

      {error && (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-xs text-rose-700 ml-1"
        >
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
