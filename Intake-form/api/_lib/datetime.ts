// Pacific-time formatting for exports. DST-aware by construction — it uses the
// IANA zone "America/Los_Angeles" via Intl, never a hardcoded UTC offset, so
// dates on either side of a DST transition convert correctly.

const PACIFIC = "America/Los_Angeles";

// en-CA yields ISO-style YYYY-MM-DD; en-US 12-hour clock yields "2:14 PM".
const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: PACIFIC,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** { date: "YYYY-MM-DD", time: "H:MM AM/PM" } in Pacific time, or blanks. */
export function toPacificParts(value: Date | string | null | undefined): {
  date: string;
  time: string;
} {
  if (value == null) return { date: "", time: "" };
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  return { date: DATE_FMT.format(d), time: TIME_FMT.format(d) };
}

/** Single combined Pacific string, e.g. "2026-08-07 2:14 PM", or "". */
export function toPacific(value: Date | string | null | undefined): string {
  const { date, time } = toPacificParts(value);
  return date ? `${date} ${time}` : "";
}
