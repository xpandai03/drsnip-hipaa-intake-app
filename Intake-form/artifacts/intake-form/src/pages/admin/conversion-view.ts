// Conversion by cohort — the page's pure logic (api/_test/conversion-view.test.ts).
//
// THE RENDERING CONTRACT IS THE API RESPONSE. Every count and every share comes
// from /api/reports/conversion-cohorts. Three cell states, never confused:
//   value     — a published share;
//   withheld  — protected small group: says "Withheld", never 0, never blank;
//   not_ended — that period has not finished yet: BLANK, never 0.

export type Form = "registration" | "insurance";
export type Grain = "month" | "week";

export const FORMS: ReadonlyArray<{ id: Form; label: string }> = [
  { id: "registration", label: "Registration" },
  { id: "insurance", label: "Insurance inquiry" },
];
export const GRAINS: ReadonlyArray<{ id: Grain; label: string }> = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
];

export type ViewState = { form: Form; grain: Grain };

export function parseViewState(search: string): ViewState {
  const p = new URLSearchParams(search);
  return {
    form: p.get("form") === "insurance" ? "insurance" : "registration",
    grain: p.get("grain") === "week" ? "week" : "month",
  };
}

export function toSearch(v: ViewState): string {
  const p = new URLSearchParams();
  p.set("form", v.form);
  p.set("grain", v.grain);
  return p.toString();
}

export type FillCell =
  | { state: "value"; count: number; pct: number | null }
  | { state: "withheld"; count: null; pct: null }
  | { state: "not_ended"; count: null; pct: null };

export type PeriodRow = {
  period_start: string;
  period_end: string;
  status: "ok" | "empty" | "suppressed" | "unavailable" | string;
  period_complete: boolean | null;
  withheld: string[];
  forms: number | null;
  not_covered: number | null;
  unlinked_submissions: number | null;
  converted_now: { count: number | null; pct: number | null };
  fill: FillCell[];
  converted_before_entry: number | null;
};

export type CohortsResponse = {
  form: Form;
  grain: Grain;
  label: string;
  rules: { version: string; explanation: string; confirmed_by: string | null; confirmed_on: string | null };
  as_of: { evidence_cutoff: string | null; basis: string | null; evidence_age_minutes: number | null };
  timezone_label: string;
  columns: string[];
  periods: PeriodRow[];
  query_ms: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "July 2026" or "Week of Jul 13, 2026" (weeks start Monday, clinic calendar). */
export function periodLabel(start: string, grain: Grain): string {
  const [y, m, d] = start.split("-").map(Number);
  return grain === "month" ? `${LONG[m - 1]} ${y}` : `Week of ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** The shortest honest text for a share. */
export function pctText(p: number | null): string | null {
  return p === null || p === undefined || !Number.isFinite(p) ? null : `${p.toFixed(1)}%`;
}

/** What one fill cell shows: a share, "Withheld", or nothing at all. */
export function fillText(c: FillCell): { text: string; kind: FillCell["state"] } {
  if (c.state === "not_ended") return { text: "", kind: "not_ended" };
  if (c.state === "withheld") return { text: "Withheld", kind: "withheld" };
  return { text: pctText(c.pct) ?? "Withheld", kind: c.pct === null ? "withheld" : "value" };
}

export function rowNotice(r: PeriodRow): string | null {
  switch (r.status) {
    case "ok": return null;
    case "empty": return "No entries in this period.";
    case "suppressed": return "Too few patients to show without risking identifying someone.";
    case "unavailable": return "Appointment data freshness is unavailable, so nothing is shown.";
    default: return "Figures are not available for this period.";
  }
}

/** One plain-English line per published row, built only from published values. */
export function rowSentence(r: PeriodRow, grain: Grain): string | null {
  if (r.status !== "ok" || r.forms === null) return null;
  const parts = [`${periodLabel(r.period_start, grain)}: ${r.forms.toLocaleString("en-US")} patients`];
  const now = pctText(r.converted_now.pct);
  parts.push(now ? `${now} converted as of today` : "converted share withheld");
  const p0 = r.fill[0];
  if (p0?.state === "value" && p0.pct !== null) {
    parts.push(`${pctText(p0.pct)} by the end of the ${grain === "month" ? "month" : "week"} they came in`);
  } else if (p0?.state === "not_ended") {
    parts.push(`the ${grain} is still running`);
  }
  return parts.join("; ") + ".";
}

export const STALE_AFTER_MINUTES = 180;
export const isStale = (age: number | null) => age !== null && age > STALE_AFTER_MINUTES;
