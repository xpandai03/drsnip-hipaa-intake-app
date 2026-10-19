// Train 4 — after the 2026-10-19 outage: every console report query runs under
// a statement timeout with JIT off, and the conversion SQL cannot plan into the
// JIT range again.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const code = (src: string) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the console's report read path", () => {
  const helper = read("../_lib/report-query.ts");
  it("sets a 5s statement timeout and turns JIT off, per transaction", () => {
    assert.match(helper, /REPORT_STATEMENT_TIMEOUT = "5s"/);
    assert.match(helper, /SET LOCAL statement_timeout/);
    assert.match(helper, /SET LOCAL jit = off/);
    assert.match(helper, /db\.transaction/);
  });
  const files = [
    ...readdirSync(new URL("../reports/", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => `../reports/${f}`),
    "../attendance-mapping/preview.ts",
  ];
  for (const f of files) {
    it(`${f} never queries outside reportQuery()`, () => {
      const c = code(read(f));
      assert.ok(!/\bdb\.execute\b|\bpool\.query\b/.test(c), `${f} runs a query without the report timeout`);
    });
  }
});

describe("0023 cannot plan into the JIT range again", () => {
  const m = read("../../lib/db/migrations/0023_jeff_conversion_rules.sql");
  const body = m.split("-- >>> CONVERSION CLASSIFY BODY >>>")[1].split("-- <<< CONVERSION CLASSIFY BODY <<<")[0];
  it("the rules function declares ROWS 1", () => {
    assert.match(m, /FUNCTION public\.drsnip_conversion_rules\(\)[\s\S]*?ROWS 1[\s\S]*?AS \$\$/);
  });
  it("JIT is off on the classifier and the monthly aggregate", () => {
    assert.equal((m.match(/SET jit = off/g) ?? []).length, 2);
  });
  it("classifies distinct labels, not every appointment, and joins the covered set", () => {
    assert.match(body, /SELECT DISTINCT s\.current_status AS st FROM public\.appointment_snapshots s/);
    assert.ok(!/EXISTS \(SELECT 1 FROM covered/.test(body), "a correlated EXISTS re-runs the covered set per row");
    assert.match(body, /LEFT JOIN covered cv ON cv\.pid = fe\.pid/);
  });
});
