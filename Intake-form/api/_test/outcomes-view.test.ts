// Monthly outcomes page — the pure logic and the source contract.
//
// The page must not calculate, must not reveal a withheld value by any route
// (zero, blank, a bar segment, a remainder), and must take every definition
// from the API. These tests pin each of those without a browser; the browser
// checks live in the release report.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseViewState, toSearch, monthOptions, clinicMonth, cell, chartable, rowNotice,
  newestFirst, profilesByRole, isStale, observationLabel, withheldReasons,
  INTAKE_START_MONTH, MAX_MONTHS, type MonthRow, type Profile,
} from "../../artifacts/intake-form/src/pages/admin/outcomes-view";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PAGE = read("../../artifacts/intake-form/src/pages/admin/Outcomes.tsx");
const APP = read("../../artifacts/intake-form/src/App.tsx");
const REPORTS = read("../../artifacts/intake-form/src/pages/admin/Reports.tsx");
const code = (src: string) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const row = (o: Partial<MonthRow> & { outcomes?: Partial<MonthRow["outcomes"]> } = {}): MonthRow => ({
  entry_month: "2026-07",
  status: "ok",
  withheld: [],
  observation: { entry_period_complete: true, days_observed_min: 54.2, days_observed_max: 84.9 },
  cohort: { total: 100, covered: 100, not_covered: 0, unlinked_submissions: 0 },
  ...o,
  outcomes: { completed: 50, scheduled: 20, unknown: 10, neither: 20, ...(o.outcomes ?? {}) },
  neither_breakdown: { no_qualifying_record: 15, had_qualifying_record: 5 },
  unknown_reasons: {},
  annotations: {},
});

describe("URL state", () => {
  const NOW = "2026-09";

  it("defaults to registration, from the first intake month to now", () => {
    assert.deepEqual(parseViewState("", NOW), { cohort: "registration", from: INTAKE_START_MONTH, to: NOW });
  });

  it("round-trips through the address bar", () => {
    const v = { cohort: "insurance" as const, from: "2026-07", to: "2026-08" };
    assert.deepEqual(parseViewState(toSearch(v), NOW), v);
  });

  it("repairs what the endpoint would refuse, instead of showing an error", () => {
    assert.deepEqual(parseViewState("from=2025-01&to=2030-01", NOW), { cohort: "registration", from: "2026-06", to: "2026-09" }, "clamped");
    assert.deepEqual(parseViewState("from=2026-09&to=2026-07", NOW), { cohort: "registration", from: "2026-07", to: "2026-09" }, "swapped");
    assert.deepEqual(parseViewState("cohort=anything&from=junk&to=2026-13", NOW), { cohort: "registration", from: "2026-06", to: "2026-09" }, "junk");
  });

  it("caps the span at the endpoint's limit, keeping the most recent months", () => {
    const later = "2027-12";
    const v = parseViewState("from=2026-06&to=2027-12", later);
    assert.equal(v.to, "2027-12");
    const opts = monthOptions(later);
    assert.equal(opts.indexOf(v.to) - opts.indexOf(v.from) + 1, MAX_MONTHS);
  });

  it("offers whole months from the first intake month to the current clinic month", () => {
    assert.deepEqual(monthOptions("2026-09"), ["2026-06", "2026-07", "2026-08", "2026-09"]);
    // 23:30 Pacific on 30 September is still September, although it is October in UTC.
    assert.equal(clinicMonth(new Date("2026-10-01T06:30:00Z")), "2026-09");
  });
});

describe("withheld stays withheld", () => {
  it("a null is a withheld cell — never a zero", () => {
    assert.deepEqual(cell(null), { kind: "withheld" });
    assert.deepEqual(cell(0), { kind: "value", n: 0 }, "a real zero is a value");
  });

  it("draws a bar only when all four outcomes are published and account for the cohort", () => {
    assert.equal(chartable(row()), true);
    for (const k of ["completed", "scheduled", "unknown", "neither"] as const) {
      assert.equal(chartable(row({ outcomes: { [k]: null } })), false, `${k} withheld`);
    }
    assert.equal(chartable(row({ cohort: { total: null, covered: null, not_covered: null, unlinked_submissions: 0 } })), false);
    assert.equal(chartable(row({ outcomes: { neither: 19 } })), false, "parts that do not add up are not drawn");
    assert.equal(chartable(row({ status: "suppressed" })), false);
  });

  it("keeps 'no entries' and 'no evidence' apart", () => {
    const empty = rowNotice(row({ status: "empty" }))!;
    const notStarted = rowNotice(row({ status: "not_started" }))!;
    const small = rowNotice(row({ status: "suppressed" }))!;
    assert.match(empty, /No entries/);
    assert.match(notStarted, /after the data cutoff/);
    assert.match(small, /Too few patients/);
    assert.equal(new Set([empty, notStarted, small]).size, 3);
    assert.equal(rowNotice(row()), null);
  });

  it("explains every withheld reason the API can send", () => {
    for (const w of ["partition_small_cell", "not_covered_small", "covered_cohort_small",
                     "neither_breakdown_small", "unlinked_submissions_small"]) {
      const [text] = withheldReasons(row({ withheld: [w] }));
      assert.ok(text && !/Some values are withheld/.test(text), `${w} has its own explanation`);
    }
  });
});

describe("presentation helpers", () => {
  it("lists the newest entry month first", () => {
    const r = newestFirst([row({ entry_month: "2026-06" }), row({ entry_month: "2026-09" }), row({ entry_month: "2026-07" })]);
    assert.deepEqual(r.map((x) => x.entry_month), ["2026-09", "2026-07", "2026-06"]);
  });

  it("says how long a cohort has been observed, and when it is still open", () => {
    assert.equal(observationLabel(row()), "Entrants observed 54–84 days");
    assert.match(observationLabel(row({ observation: { entry_period_complete: false, days_observed_min: 0, days_observed_max: 22.4 } })), /Still open/);
  });

  it("groups appointment types by role in reading order, and lists an unnamed type only if it occurs", () => {
    const p = (id: string | null, role: string, stored = true): Profile => ({
      profile_source_id: id, exact_name: id ? `Name ${id}` : null, name_source: null,
      name_observed_on: null, role, is_stored: stored, stored_appointments: null,
    });
    const g = profilesByRole([
      p("1", "excluded_known"), p("2", "qualifying"), p("3", "comparison"),
      p("4", "unknown_profile", false), p(null, "unknown_profile", true), p("5", "inclusion_undecided"),
    ]);
    assert.deepEqual(g.map((x) => x.role), ["qualifying", "comparison", "inclusion_undecided", "excluded_known", "unknown_profile"]);
    assert.deepEqual(g.at(-1)!.profiles.map((x) => x.profile_source_id), [null]);
  });

  it("flags data older than three hours as stale", () => {
    assert.equal(isStale(null), false);
    assert.equal(isStale(65), false);
    assert.equal(isStale(181), true);
  });
});

describe("the page's source contract", () => {
  const c = code(PAGE);

  it("is routed, and reachable from the Reports index", () => {
    assert.match(APP, /import AdminOutcomes from "@\/pages\/admin\/Outcomes";/);
    assert.match(APP, /<Route path="\/admin\/outcomes">\s*<WithAuth>\s*<AdminOutcomes \/>/);
    assert.match(REPORTS, /to: "\/admin\/outcomes"/);
    assert.ok(REPORTS.indexOf('"/admin/outcomes"') < REPORTS.indexOf('"/admin/journeys?journey=registration"'), "listed first");
  });

  it("reads the one endpoint and no other metric", () => {
    assert.match(c, /\/api\/reports\/outcomes\?metric=/);
    assert.ok(!/\/api\/reports\/(booking|journey|attendance)/.test(c));
  });

  it("has no follow-up window control", () => {
    assert.ok(!/window=|WINDOWS|Follow-up window|filter-window/.test(c));
  });

  it("carries no appointment-type id or name of its own", () => {
    assert.ok(!/\b\d{6}\b/.test(c), "a profile id is hard-coded");
    assert.ok(!/Vasectomy|PVST|Consultation Only|Lab Only/.test(c), "a profile name is hard-coded");
    assert.match(c, /d\.definition\.profiles/);
    assert.match(c, /d\.role_labels/);
    assert.match(c, /d\.buckets\[k\]\.label/);
  });

  it("shows no rate, percentage or combined total", () => {
    assert.ok(!/\brate\b|toFixed|conversion/i.test(c), "a rate or conversion figure is rendered");
    // The ONLY division is the bar-segment width, behind chartable().
    const divisions = c.match(/\/ covered/g) ?? [];
    assert.equal(divisions.length, 1);
    assert.match(c, /if \(!chartable\(row\)\)/);
    assert.ok(!/completed\s*\+\s*.*scheduled|scheduled\s*\+\s*.*completed/.test(c), "a combined total");
  });

  it("renders withheld through the shared cell() rule, and never as 0", () => {
    assert.match(c, /const c = cell\(v\);/);
    assert.ok(!/\?\? 0\b/.test(c), "a withheld value would render as zero");
  });

  it("states the provisional definition and the data cutoff", () => {
    assert.match(c, /data-testid="provisional-banner"/);
    assert.match(c, /d\?\.definition\.engineering_preview/);
    assert.match(c, /Data complete to/);
    assert.match(c, /data-testid="stale-warning"/);
  });

  it("never describes Neither as lost, non-attendance or outreach", () => {
    assert.ok(!/\blost\b|did not attend|no-show|outreach|follow up with/i.test(c));
  });

  it("offers a retry on error and a skeleton while loading", () => {
    assert.match(c, /data-testid="outcomes-retry"/);
    assert.match(c, /data-testid="outcomes-loading"/);
  });
});
