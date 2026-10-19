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
  newestFirst, isStale, pctLabel, withheldReasons,
  INTAKE_START_MONTH, MAX_MONTHS, type MonthRow,
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
  entry_period_complete: true,
  cohort: { total: 100, covered: 100, not_covered: 0, unlinked_submissions: 0 },
  converted_pct: 60,
  converted_before_entry: 7,
  repeat_submitters: 6,
  ...o,
  outcomes: { converted: 60, not_converted: 10, unclassified_only: 5, no_appointment: 25, ...(o.outcomes ?? {}) },
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
    assert.deepEqual(cell(0), { kind: "value", n: 0 });
    assert.equal(pctLabel(null), null);
    assert.equal(pctLabel(64.66), "64.7%");
  });

  it("draws a bar only when all four outcomes are published and account for the cohort", () => {
    assert.equal(chartable(row()), true);
    assert.equal(chartable(row({ outcomes: { not_converted: null } })), false);
    assert.equal(chartable(row({ outcomes: { no_appointment: 24 } })), false, "parts must add up");
    assert.equal(chartable(row({ status: "suppressed" })), false);
  });

  it("keeps 'no entries' and 'no evidence' apart", () => {
    assert.match(rowNotice(row({ status: "empty" }))!, /No entries/);
    assert.match(rowNotice(row({ status: "not_started" }))!, /after the data cutoff/);
    assert.match(rowNotice(row({ status: "unavailable" }))!, /freshness is unavailable/);
    assert.equal(rowNotice(row()), null);
  });

  it("explains every withheld reason the API can send", () => {
    const API = read("../../lib/db/migrations/0023_jeff_conversion_rules.sql");
    const sent = [...API.matchAll(/array_append\(withheld, '([a-z_]+)'\)/g)].map((m) => m[1]);
    assert.ok(sent.length >= 4);
    for (const w of new Set(sent)) {
      assert.ok(!/Some values are withheld/.test(withheldReasons(row({ withheld: [w] }))[0]), w);
    }
  });
});

describe("presentation helpers", () => {
  it("lists the newest entry month first", () => {
    const r = newestFirst([row({ entry_month: "2026-06" }), row({ entry_month: "2026-08" }), row({ entry_month: "2026-07" })]);
    assert.deepEqual(r.map((x) => x.entry_month), ["2026-08", "2026-07", "2026-06"]);
  });

  it("flags data older than three hours as stale", () => {
    assert.equal(isStale(null), false);
    assert.equal(isStale(180), false);
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

  it("reads the one endpoint, by form", () => {
    assert.match(c, /\/api\/reports\/outcomes\?form=/);
    assert.ok(!/\/api\/reports\/(booking|journey|attendance)/.test(c));
  });

  it("has no follow-up window control", () => {
    assert.ok(!/window=|WINDOWS|Follow-up window|filter-window/.test(c));
  });

  it("carries no status label or appointment-type id of its own", () => {
    assert.ok(!/\b\d{6}\b/.test(c), "a profile id is hard-coded");
    for (const label of ["'Complete'", '"Complete"', '"Cancelled"', '"No Show"', '"Rescheduled"']) {
      assert.ok(!c.includes(label), `status ${label} is hard-coded in the page`);
    }
    assert.match(c, /d\.rules\.explanation/);
  });

  it("shows the converted share from the server and never computes one", () => {
    assert.match(c, /row\.converted_pct/);
    assert.ok(!/\/\s*r(ow)?\.cohort\.covered\s*\*\s*100/.test(c.replace(/width: `\$\{\(n \/ covered\) \* 100\}%`/, "")));
  });

  it("renders withheld through the shared cell() rule, and never as 0", () => {
    assert.match(c, /cell\(v\)/);
    assert.ok(!/\?\? 0\b/.test(c), "a withheld value could render as 0");
  });

  it("shows ONE appointment-data timestamp, from the same response as the figures", () => {
    assert.equal((c.match(/data-testid="data-complete-to"/g) ?? []).length, 1);
    assert.match(c, /d\.as_of\.evidence_cutoff/);
  });

  it("offers a retry on error and a skeleton while loading", () => {
    assert.match(c, /data-testid="outcomes-retry"/);
    assert.match(c, /data-testid="outcomes-loading"/);
  });
});

describe("the patient journeys page (after the audit)", () => {
  const J = read("../../artifacts/intake-form/src/pages/admin/Journeys.tsx");
  const cj = code(J);

  it("no longer draws the record-created → advance-booking waterfall", () => {
    assert.ok(!/WaterfallChart|waterfall-chart/.test(cj), "the waterfall is back");
    assert.ok(!/Advance booking recorded/.test(cj), "a record filter is presented as a patient stage");
  });

  it("leads with form progression and links to Monthly outcomes", () => {
    assert.match(cj, /data-testid="link-monthly-outcomes"/);
    assert.match(cj, /See conversion by entry month/);
    assert.match(cj, /href="\/admin\/outcomes"/);
    assert.ok(cj.indexOf('data-testid="form-progression"') < cj.indexOf('data-testid="record-timing"'));
  });

  it("keeps record timing and attendance review reachable, collapsed, and honestly labelled", () => {
    assert.match(cj, /<details[^>]*data-testid="record-timing"/);
    assert.match(cj, /Appointment-record timing \(diagnostic\)/);
    assert.match(cj, /measures record creation, not a booked procedure/);
    assert.ok(!/time to procedure booking/i.test(cj));
    assert.match(cj, /<details[^>]*data-testid="attendance-section"/);
    assert.match(cj, /<AttendanceReviewCard onOpen=\{onOpenReview\} \/>/);
    assert.match(J, /<AttendanceReviewPanel/);
  });

  it("does not repeat the appointment timestamp inside the page", () => {
    assert.ok(!/As at \{snap\}/.test(cj));
    assert.match(cj, /<AppointmentFreshnessBadge query=\{freshness\} \/>/);
  });
});

describe("the reports index copy (after the audit)", () => {
  it("no longer implies a record created is a booking", () => {
    assert.ok(!/booked appointments|reach an appointment/i.test(REPORTS));
    assert.match(REPORTS, /Registration form progression/);
  });
});
