// Conversion by cohort page — pure logic and source contract (Train 4).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fillText, parseViewState, pctText, periodLabel, rowNotice, rowSentence, toSearch, type PeriodRow,
} from "../../artifacts/intake-form/src/pages/admin/conversion-view";
import { fillCell } from "../reports/conversion-cohorts";
import { pct } from "../reports/outcomes";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PAGE = read("../../artifacts/intake-form/src/pages/admin/Conversion.tsx");
const APP = read("../../artifacts/intake-form/src/App.tsx");
const code = (src: string) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const row = (o: Partial<PeriodRow> = {}): PeriodRow => ({
  period_start: "2026-07-01", period_end: "2026-08-01", status: "ok", period_complete: true, withheld: [],
  forms: 571, not_covered: 0, unlinked_submissions: 0,
  converted_now: { count: 383, pct: 67.1 },
  fill: [
    { state: "value", count: 300, pct: 52.5 },
    { state: "value", count: 360, pct: 63 },
    { state: "value", count: 375, pct: 65.7 },
    { state: "not_ended", count: null, pct: null },
    { state: "not_ended", count: null, pct: null },
  ],
  converted_before_entry: 40, ...o,
});

describe("view state", () => {
  it("defaults to registration by month and round-trips", () => {
    assert.deepEqual(parseViewState(""), { form: "registration", grain: "month" });
    const v = { form: "insurance" as const, grain: "week" as const };
    assert.deepEqual(parseViewState(toSearch(v)), v);
    assert.deepEqual(parseViewState("form=x&grain=day"), { form: "registration", grain: "month" });
  });
});

describe("cells", () => {
  it("a period that has not ended is blank — never 0, never 'Withheld'", () => {
    assert.deepEqual(fillText({ state: "not_ended", count: null, pct: null }), { text: "", kind: "not_ended" });
  });
  it("a protected small group says Withheld", () => {
    assert.deepEqual(fillText({ state: "withheld", count: null, pct: null }), { text: "Withheld", kind: "withheld" });
  });
  it("a value is a one-decimal share", () => {
    assert.deepEqual(fillText({ state: "value", count: 300, pct: 52.5 }), { text: "52.5%", kind: "value" });
    assert.equal(pctText(null), null);
  });
  it("the API marks a cell not-ended before it considers withholding", () => {
    assert.equal(fillCell(null, false, 100).state, "not_ended");
    assert.equal(fillCell(5, false, 100).state, "not_ended");
    assert.equal(fillCell(null, true, 100).state, "withheld");
    assert.deepEqual(fillCell(25, true, 100), { state: "value", count: 25, pct: 25 });
  });
  it("shares are of the covered cohort, one decimal, and never divide by zero", () => {
    assert.equal(pct(383, 571), 67.1);
    assert.equal(pct(1, 3), 33.3);
    assert.equal(pct(5, 0), null);
    assert.equal(pct(null, 10), null);
  });
});

describe("labels", () => {
  it("names months and Monday-start weeks", () => {
    assert.equal(periodLabel("2026-07-01", "month"), "July 2026");
    assert.equal(periodLabel("2026-07-13", "week"), "Week of Jul 13, 2026");
  });
  it("one line per published row, from published values only", () => {
    assert.equal(rowSentence(row(), "month"),
      "July 2026: 571 patients; 67.1% converted as of today; 52.5% by the end of the month they came in.");
    assert.equal(rowSentence(row({ status: "suppressed", forms: null }), "month"), null);
    assert.match(rowNotice(row({ status: "suppressed" }))!, /Too few patients/);
  });
});

describe("source contract", () => {
  const c = code(PAGE);
  it("is routed behind auth", () => {
    assert.match(APP, /<Route path="\/admin\/conversion">\s*<WithAuth>\s*<AdminConversion \/>/);
  });
  it("reads only the cohort endpoint and computes nothing", () => {
    assert.match(c, /\/api\/reports\/conversion-cohorts\?form=/);
    assert.ok(!/\/api\/reports\/(booking|journey|attendance|outcomes)/.test(c));
    assert.ok(!/\*\s*100|\/\s*r\.forms/.test(c), "the page computes a share");
  });
  it("has the two toggles the brief asks for", () => {
    assert.match(c, /testPrefix="form"/);
    assert.match(c, /testPrefix="grain"/);
  });
  it("hard-codes no status label", () => {
    for (const label of ['"Complete"', '"Cancelled"', '"No Show"']) assert.ok(!c.includes(label));
  });
});
