// Monthly outcomes — the page's pure logic, kept out of the component so it can
// be unit-tested without a DOM (api/_test/outcomes-view.test.ts).
//
// THE RENDERING CONTRACT IS THE API RESPONSE. Nothing here calculates an
// outcome, a total, a share or a rate. A value the server withheld arrives as
// null and stays withheld: it is never shown as zero, never left blank, never
// derived from its neighbours, and never used to size anything on screen.

export type Cohort = "registration" | "insurance";

export const COHORTS: ReadonlyArray<{ id: Cohort; label: string; metric: string }> = [
  { id: "registration", label: "Registration", metric: "outcome_registration" },
  { id: "insurance", label: "Insurance inquiry", metric: "outcome_insurance" },
];

/**
 * The first month intake data exists for (registration and consultation began
 * 2026-06-15; insurance inquiries 2026-08-12). The API accepts from 2026-01,
 * but offering months with no intake at all would only produce empty rows.
 */
export const INTAKE_START_MONTH = "2026-06";
/** The endpoint's own limit on one request. */
export const MAX_MONTHS = 13;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const isMonth = (v: unknown): v is string => typeof v === "string" && MONTH_RE.test(v);

const idx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const fromIdx = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;

/** The current month on the clinic calendar. */
export function clinicMonth(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
  }).format(now).slice(0, 7);
}

/** Every selectable month, oldest first. */
export function monthOptions(current: string, start = INTAKE_START_MONTH): string[] {
  const out: string[] = [];
  for (let i = idx(start); i <= idx(current); i += 1) out.push(fromIdx(i));
  return out;
}

export type ViewState = { cohort: Cohort; from: string; to: string };

/**
 * Read the view from the address bar, repairing anything the endpoint would
 * refuse instead of sending it and showing an error. Order matters: clamp to
 * the selectable months, put the ends the right way round, then cap the span
 * by moving `from` forward, so the most recent months are always kept.
 */
export function parseViewState(search: string, current: string): ViewState {
  const p = new URLSearchParams(search);
  const cohort: Cohort = p.get("cohort") === "insurance" ? "insurance" : "registration";
  const lo = idx(INTAKE_START_MONTH);
  const hi = idx(current);
  const clamp = (m: string | null, dflt: number) => {
    const i = isMonth(m) ? idx(m) : dflt;
    return Math.min(Math.max(i, lo), hi);
  };
  let f = clamp(p.get("from"), lo);
  let t = clamp(p.get("to"), hi);
  if (f > t) [f, t] = [t, f];
  if (t - f + 1 > MAX_MONTHS) f = t - MAX_MONTHS + 1;
  return { cohort, from: fromIdx(f), to: fromIdx(t) };
}

export function toSearch(v: ViewState): string {
  const p = new URLSearchParams();
  p.set("cohort", v.cohort);
  p.set("from", v.from);
  p.set("to", v.to);
  return p.toString();
}

export function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 15)).toLocaleString("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// The response, as the page reads it.
// ---------------------------------------------------------------------------
export type Count = number | null;

export type MonthRow = {
  entry_month: string;
  status: "ok" | "empty" | "suppressed" | "not_started" | string;
  withheld: string[];
  observation: { entry_period_complete: boolean | null; days_observed_min: Count; days_observed_max: Count };
  cohort: { total: Count; covered: Count; not_covered: Count; unlinked_submissions: Count };
  outcomes: { completed: Count; scheduled: Count; unknown: Count; neither: Count };
  neither_breakdown: { no_qualifying_record: Count; had_qualifying_record: Count };
  unknown_reasons: Record<string, Count | boolean>;
  annotations: Record<string, Count | boolean>;
};

export type Profile = {
  profile_source_id: string | null;
  exact_name: string | null;
  name_source: string | null;
  name_observed_on: string | null;
  role: string;
  is_stored: boolean;
  stored_appointments: Count;
};

export type OutcomesResponse = {
  metric: string;
  label: string;
  counts_what: string;
  cohort_note: string;
  definition: {
    scope_key: string;
    scope_version: number | null;
    state: string;
    engineering_preview: boolean;
    label: string;
    description: string;
    status_rules: { version: string; state: string; rules: Record<string, string[]>; source: string };
    profiles: Profile[];
    profile_coverage: { stored_profile_ids: number; stored_with_verified_name: number; stored_unknown_meaning: number; note: string };
  };
  as_of: { evidence_cutoff: string | null; evidence_age_minutes: number | null; note: string };
  period: { from_month: string; to_month: string; timezone_label: string };
  buckets: Record<"completed" | "scheduled" | "unknown" | "neither", { label: string; means: string }>;
  role_labels: Record<string, { label: string; means: string }>;
  status_explanations: ReadonlyArray<{ key: string; means: string }>;
  unknown_reasons: Record<string, string>;
  annotations: Record<string, string>;
  no_combined_measure: string;
  months: MonthRow[];
  suppression: { threshold: number; note: string };
};

export const BUCKET_KEYS = ["completed", "scheduled", "unknown", "neither"] as const;

/** Newest entry month first, as Jeff reads it. The API returns oldest first. */
export function newestFirst(rows: MonthRow[]): MonthRow[] {
  return [...rows].sort((a, b) => (a.entry_month < b.entry_month ? 1 : -1));
}

/**
 * What one cell shows. `withheld` is its own state — never zero, never blank —
 * and carries no number for any consumer to read.
 */
export type Cell = { kind: "value"; n: number } | { kind: "withheld" };
export function cell(v: Count): Cell {
  return v === null || v === undefined || !Number.isFinite(v) ? { kind: "withheld" } : { kind: "value", n: v };
}

/**
 * A proportional bar is drawn ONLY when every one of the four outcomes was
 * published and they account for the whole published cohort. Any withheld
 * outcome means no bar at all: the remaining segments, their widths or a
 * "rest" segment would each give the protected values away.
 */
export function chartable(r: MonthRow): boolean {
  if (r.status !== "ok") return false;
  const vals = BUCKET_KEYS.map((k) => r.outcomes[k]);
  if (vals.some((v) => v === null)) return false;
  const covered = r.cohort.covered;
  if (covered === null || covered <= 0) return false;
  return (vals as number[]).reduce((a, b) => a + b, 0) === covered;
}

/** Why a row has no figures, in words. Keeps "no entries" and "no evidence" apart. */
export function rowNotice(r: MonthRow): string | null {
  switch (r.status) {
    case "ok": return null;
    case "empty": return "No entries this month.";
    case "not_started": return "This month begins after the data cutoff — no appointment evidence yet.";
    case "suppressed": return "Too few patients to show without risking identifying someone.";
    default: return "Figures are not available for this month.";
  }
}

const WITHHELD_WHY: Record<string, string> = {
  partition_small_cell:
    "At least one outcome is a small group, so it is withheld together with another outcome — and this month's details — so it cannot be worked out by subtraction.",
  not_covered_small:
    "A small number of patients are still awaiting their first appointment-history read, so that count and the cohort total are withheld.",
  covered_cohort_small: "The whole month is too small to publish.",
  neither_breakdown_small: "The split of “Neither established” is withheld because one part is a small group.",
  unlinked_submissions_small: "The number of unlinked submissions is a small group and is withheld.",
};
export function withheldReasons(r: MonthRow): string[] {
  return r.withheld.map((w) => WITHHELD_WHY[w] ?? "Some values are withheld to protect small groups.");
}

/** "observed 13–44 days", or that the month is still open. */
export function observationLabel(r: MonthRow): string {
  const { entry_period_complete: done, days_observed_min: lo, days_observed_max: hi } = r.observation;
  const d = (n: number) => `${Math.floor(n)} day${Math.floor(n) === 1 ? "" : "s"}`;
  if (r.status === "not_started") return "Not started at the data cutoff";
  if (hi === null) return "—";
  if (!done) return `Still open · entrants observed up to ${d(hi)}`;
  return `Entrants observed ${Math.floor(lo ?? 0)}–${d(hi)}`;
}

/**
 * The staleness line. Appointment data is re-read hourly; a cutoff older than
 * three hours means the scheduled sync has not completed recently.
 */
export const STALE_AFTER_MINUTES = 180;
export function isStale(ageMinutes: number | null): boolean {
  return ageMinutes !== null && ageMinutes > STALE_AFTER_MINUTES;
}

/** Profiles grouped by role, in the order a reader needs them. Names come from the API. */
export const ROLE_ORDER = ["qualifying", "comparison", "inclusion_undecided", "excluded_known", "unknown_profile"] as const;
export function profilesByRole(profiles: Profile[]): Array<{ role: string; profiles: Profile[] }> {
  return ROLE_ORDER
    .map((role) => ({
      role,
      // An unnamed type is only worth listing if it actually occurs.
      profiles: profiles.filter((p) => p.role === role && (role !== "unknown_profile" || p.is_stored)),
    }))
    .filter((g) => g.profiles.length > 0);
}
