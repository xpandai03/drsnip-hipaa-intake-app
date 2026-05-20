import { useRef, useState } from "react";
import { UploadCloud, FileCheck2, X, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// Stubbed file upload (Phase 2). Captures a picked file's name + size and
// surfaces them via onChange. It does NOT upload or persist the file bytes
// anywhere — real, BAA-backed object storage is a later-phase decision.

export type StubFileRef = { filename: string; size: number };

interface FileUploadStubProps {
  label?: string;
  accept?: string;
  value?: StubFileRef | null;
  onChange: (file: StubFileRef | null) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileUploadStub({
  label,
  accept = "image/jpeg,image/png,application/pdf",
  value,
  onChange,
}: FileUploadStubProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Demo stub: capture metadata only. The File object is read for its name
  // and size and then discarded — no bytes leave the browser.
  const handleFile = (file: File | undefined | null) => {
    if (!file) return;
    onChange({ filename: file.name, size: file.size });
  };

  const clear = () => {
    onChange(null);
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
              <p className="text-xs text-slate-500">{formatSize(value.size)}</p>
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
            handleFile(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            "w-full flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed rounded-2xl transition-colors cursor-pointer",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-slate-300 bg-slate-50 hover:border-primary/50 hover:bg-slate-100",
          )}
        >
          <UploadCloud className="w-7 h-7 text-slate-400" />
          <span className="text-sm font-medium text-slate-600">
            Click to choose a file, or drag &amp; drop
          </span>
          <span className="text-xs text-slate-400">JPG, PNG, or PDF</span>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      <p className="flex items-center gap-1.5 text-xs text-slate-400 ml-1">
        <Lock className="w-3 h-3" />
        Demo Mode — secure storage activates on production deploy.
      </p>
    </div>
  );
}
