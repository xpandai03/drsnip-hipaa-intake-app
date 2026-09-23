// Metric contract — what every journey metric must carry with it.
//
// The point of this file is that a number can never travel without the things
// that make it interpretable. A bare "37.3%" is how the earlier reporting went
// wrong: it was an observed-to-date figure that later got relabelled as a
// 14-day conversion rate, which it was not.
//
// Values here are MACHINE-READABLE. Nothing is pre-formatted, rounded or
// percent-signed; display formatting is a separate concern (see `format.ts`),
// so a consumer can never mistake a display string for a computed value.

/** Distinguishes states that a single nullable number would smear together. */
export type MetricStatus =
  /** A real computed result. `value` is meaningful. */
  | "ok"
  /** Computed, and the answer genuinely is zero. Different from "no data". */
  | "zero"
  /** No one was eligible. A rate is undefined, NOT 0%. */
  | "zero_denominator"
  /** Cohort too young for the requested window. Reporting it would flatter it. */
  | "immature"
  /** Real result withheld because the cell is small enough to identify someone. */
  | "suppressed"
  /** Retrieval coverage is not sufficient to state this exactly. */
  | "insufficient_coverage"
  /** Input data required by this metric has not been retrieved at all. */
  | "unavailable"
  /** Blocked on a decision or approval outside the data, e.g. staff sign-off. */
  | "blocked";

/** What is being counted. Mixing these is how double-counting starts. */
export type MetricUnit =
  | "submissions"
  | "distinct_patient_ids"
  | "appointments"
  | "days";

/**
 * Observed-to-date counts every outcome seen up to the as-of time, including
 * for entries that are only days old. It is a LOWER BOUND and it drifts upward
 * as cohorts age; it must never be compared between cohorts of different ages.
 *
 * Mature-window restricts the denominator to entries that have had the full
 * follow-up window available, which is the only mode in which two cohorts are
 * comparable.
 */
export type MetricMode = "observed_to_date" | "mature_window";

/**
 * How a follow-up window is measured.
 *
 * `elapsed_hours` means N x 24 hours from the entry instant. This is the
 * default here because it is DST-safe and identical for every entry, which is
 * what makes cohorts comparable. `clinic_calendar_days` would count Pacific
 * calendar days, where a DST transition makes one "day" 23 or 25 hours long.
 *
 * Entry-period FILTERS are a separate matter and always use Pacific calendar
 * days, because "which month did this patient come in" is a local-calendar
 * question.
 */
export type WindowBasis = "elapsed_hours" | "clinic_calendar_days";

/** Per-metric statement of how well the underlying data covers the question. */
export type CoverageNote = {
  /** Everyone the definition makes eligible, before any coverage discount. */
  eligible: number;
  /** Of those, how many have retrieval good enough to answer exactly. */
  sufficient_coverage: number;
  /** Positive evidence found. A positive match proves existence. */
  positive: number;
  /**
   * Neither positive nor conclusively negative. These must be reported, not
   * quietly dropped into the denominator as if they were negatives.
   */
  unresolved: number;
  /** Bounds on any negative claim: what "not found" is limited by. */
  bounded_by: string;
};

export type MetricResult = {
  /** Stable across versions; the thing a dashboard keys on. */
  id: string;
  /** Bump when the DEFINITION changes, so old numbers stay attributable. */
  definition_version: string;
  label: string;
  unit: MetricUnit;

  status: MetricStatus;
  /** Null unless status is "ok" or "zero". Never a formatted string. */
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  /** numerator/denominator as a fraction in [0,1]; null when undefined. */
  rate: number | null;

  mode: MetricMode;
  window_days: number | null;
  window_basis: WindowBasis | null;

  /** Pacific calendar days, inclusive start / exclusive end. */
  entry_period: { from: string; to_exclusive: string } | null;

  eligibility: string;
  exclusions: string[];
  provider_scope: string;

  coverage: CoverageNote | null;
  /** Instant the underlying data was read. */
  as_of: string;
  /** How stale the inputs are, and why that matters for this metric. */
  freshness: string;
  /** Present whenever status is not "ok"/"zero". Explains what to do about it. */
  reason: string | null;
  /** Things assumed that a human has not yet confirmed. */
  provisional_assumptions: string[];
};

/** Percentile summary for matched completions. Days, as elapsed durations. */
export type DurationSummary = {
  matched: number;
  p50_days: number | null;
  p75_days: number | null;
  p90_days: number | null;
};

export const SUPPRESS_BELOW = 5;

/**
 * Small-cell suppression.
 *
 * Returns the count, or null when it is small enough that publishing it could
 * identify someone. Zero is returned as zero: "nobody did this" is not
 * disclosive, and hiding it would be misleading.
 */
export function suppressCount(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 0;
  return n < SUPPRESS_BELOW ? null : n;
}

/**
 * Suppression for a numerator/denominator pair.
 *
 * COMPLEMENTARY DISCLOSURE: publishing a denominator of 6 with a suppressed
 * numerator still reveals that the numerator is 1-4. Worse, publishing both a
 * rate and a denominator lets the numerator be recovered by multiplication. So
 * when either side is small, BOTH sides and the rate are withheld together.
 */
export function suppressPair(
  numerator: number,
  denominator: number,
): { numerator: number | null; denominator: number | null; rate: number | null; suppressed: boolean } {
  const complement = denominator - numerator;
  const risky =
    (numerator > 0 && numerator < SUPPRESS_BELOW) ||
    (complement > 0 && complement < SUPPRESS_BELOW) ||
    (denominator > 0 && denominator < SUPPRESS_BELOW);
  if (risky) {
    return { numerator: null, denominator: null, rate: null, suppressed: true };
  }
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
    suppressed: false,
  };
}

/** Build a result, applying the status rules consistently in one place. */
export function buildResult(
  base: Omit<MetricResult, "status" | "value" | "rate" | "numerator" | "denominator" | "reason"> & {
    numerator: number;
    denominator: number;
    /** Set when the metric cannot be computed at all, regardless of counts. */
    hardStatus?: { status: MetricStatus; reason: string };
  },
): MetricResult {
  const { numerator, denominator, hardStatus, ...rest } = base;

  if (hardStatus) {
    return { ...rest, ...hardStatus, value: null, numerator: null, denominator: null, rate: null };
  }
  if (denominator === 0) {
    return {
      ...rest,
      status: "zero_denominator",
      reason: "No one was eligible under this definition, so a rate is undefined — not zero.",
      value: null, numerator: 0, denominator: 0, rate: null,
    };
  }
  const s = suppressPair(numerator, denominator);
  if (s.suppressed) {
    return {
      ...rest,
      status: "suppressed",
      reason: `A cell is below ${SUPPRESS_BELOW}; numerator, denominator and rate are withheld together so the hidden value cannot be recovered.`,
      value: null, numerator: null, denominator: null, rate: null,
    };
  }
  return {
    ...rest,
    status: numerator === 0 ? "zero" : "ok",
    reason: null,
    value: s.numerator,
    numerator: s.numerator,
    denominator: s.denominator,
    rate: s.rate,
  };
}

/**
 * Suppression across a GROUP of related cells that share a published total.
 *
 * Cell-by-cell suppression is not enough. If a total of 69 is published
 * alongside an "eligible" count of 67, then the suppressed "already
 * registered" cell is recoverable by subtraction: 69 - 67 = 2. That exact
 * disclosure was published in the first version of the metrics report.
 *
 * The rule here: once any part is withheld, keep withholding parts (smallest
 * first) until AT LEAST TWO remain unknown, so no single subtraction recovers
 * a value. If that cannot be achieved, the total itself is withheld too.
 *
 * Returns parts in the original order, with `null` for anything withheld.
 */
export function suppressPartition(
  parts: number[],
  total: number,
): { parts: (number | null)[]; total: number | null; withheld: number } {
  const out: (number | null)[] = parts.slice();
  const risky = (v: number) => v > 0 && v < SUPPRESS_BELOW;

  const order = parts
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v)
    .map((x) => x.i);

  for (const i of order) if (risky(parts[i])) out[i] = null;

  let unknown = out.filter((v) => v === null).length;
  if (unknown === 0) return { parts: out, total, withheld: 0 };

  // One unknown is recoverable from the total. Withhold the next-smallest
  // until two are unknown.
  for (const i of order) {
    if (unknown >= 2) break;
    if (out[i] !== null) { out[i] = null; unknown += 1; }
  }

  // Fewer than two parts exist at all: the total would still give it away.
  if (unknown < 2) return { parts: out.map(() => null), total: null, withheld: parts.length };

  return { parts: out, total, withheld: unknown };
}

/**
 * Percentiles over a small matched set describe individuals.
 *
 * A median of three durations is one person's timing, give or take. Withhold
 * the whole summary rather than the individual percentiles, because publishing
 * p50 while hiding p90 still narrows the distribution.
 */
export function suppressDurations(
  matched: number,
  p50: number | null,
  p75: number | null,
  p90: number | null,
): DurationSummary & { suppressed: boolean } {
  if (matched > 0 && matched < SUPPRESS_BELOW) {
    return { matched: 0, p50_days: null, p75_days: null, p90_days: null, suppressed: true };
  }
  return { matched, p50_days: p50, p75_days: p75, p90_days: p90, suppressed: false };
}
