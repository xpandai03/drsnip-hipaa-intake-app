// Phase 3 — calculated age for the PDF header (see PHASE_3_PLAN.md §5).
//
// Pure, dependency-free. `today` is injectable purely for deterministic tests;
// production callers pass `calculateAge(dob)` and it defaults to now.

/**
 * Whole-years age from a date of birth.
 *
 * @param dob   ISO `YYYY-MM-DD` string (how `date_of_birth` is stored) or a
 *              Date. `null` / `undefined` / `""` / unparseable → returns null.
 * @param today reference "now" — defaults to `new Date()`.
 * @returns integer age, `0` for a future DOB (data error), or `null` when the
 *          DOB is missing or invalid (caller renders "—").
 */
export function calculateAge(
  dob: string | Date | null | undefined,
  today: Date = new Date(),
): number | null {
  if (dob == null || dob === "") return null;

  // Append a time so an ISO date string parses at LOCAL midnight — bare
  // `new Date("YYYY-MM-DD")` parses as UTC and can shift the day in
  // negative-offset timezones.
  const birth =
    typeof dob === "string" ? new Date(`${dob}T00:00:00`) : dob;
  if (Number.isNaN(birth.getTime())) return null;

  let age = today.getFullYear() - birth.getFullYear();
  const monthDelta = today.getMonth() - birth.getMonth();
  // Birthday not yet reached this year → subtract one.
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && today.getDate() < birth.getDate())
  ) {
    age--;
  }

  // Future DOB → clamp to 0 (the template flags it as a data error).
  return age < 0 ? 0 : age;
}
