// Live US phone-number formatting for tel inputs (Phase 4B / B.1).
//
// `formatPhone` is a pure, idempotent re-mask: it strips to digits (capped at
// 10) and re-lays the (xxx) xxx-xxxx mask from scratch. Because it derives the
// mask only from the digits, feeding it an already-formatted, partial, or
// pasted value never double-formats — the output for "(310) 555-1234" and for
// "3105551234" is identical. Applied only to input as the user types; existing
// stored values are never reformatted.

export function formatPhone(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 10);
  if (digits.length === 0) return "";
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
