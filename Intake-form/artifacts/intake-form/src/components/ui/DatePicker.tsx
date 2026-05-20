import { useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Date picker — wraps the existing shadcn `calendar.tsx` (react-day-picker) in
// a popover. `captionLayout="dropdown"` gives month/year dropdowns, which makes
// it usable for dates far in the past (e.g. date of birth). Value is an ISO
// `YYYY-MM-DD` string.

interface DatePickerProps {
  value?: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  /** Earliest selectable year. Defaults to 1920 (suitable for DOB). */
  fromYear?: number;
}

function isoToDate(iso?: string): Date | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function formatDisplay(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Select a date",
  fromYear = 1920,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = isoToDate(value);
  const today = new Date();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between px-5 py-4 text-lg bg-white border-2 rounded-2xl border-slate-200 shadow-sm hover:border-slate-300 focus:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 transition-all",
            selected ? "text-slate-900" : "text-slate-400",
          )}
        >
          {selected ? formatDisplay(selected) : placeholder}
          <CalendarIcon className="w-5 h-5 text-slate-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(d) => {
            if (d) {
              onChange(dateToIso(d));
              setOpen(false);
            }
          }}
          captionLayout="dropdown"
          startMonth={new Date(fromYear, 0)}
          endMonth={new Date(today.getFullYear(), 11)}
          disabled={{ after: today }}
          defaultMonth={selected ?? new Date(today.getFullYear() - 30, 0)}
        />
      </PopoverContent>
    </Popover>
  );
}
