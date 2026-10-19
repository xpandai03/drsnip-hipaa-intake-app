// Reporting-definition tests for the corrections that replaced the misleading
// "Success rate — 92%" tile, the forked Seattle labels and the UTC buckets.
//
// These assert BEHAVIOUR (what the function returns for given counts), not
// source text. The one structural assertion — that the day/week/month
// expressions carry the clinic zone — is checking a value we build, not a
// banned substring.
//
// No PHI, no DB, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DIMENSION_EXPR,
  SUPPRESS_BELOW,
  WRITEBACK_BASIS,
  canonicalLocationSql,
  suppress,
  writebackOutcome,
} from "../_lib/reporting";
import { CLINIC_TZ } from "../_lib/clinic-time";

describe("writebackOutcome — the eligible denominator", () => {
  it("the denominator is resolved outcomes only", () => {
    const o = writebackOutcome({
      success: 900,
      manual_review: 40,
      failed: 20,
      pending: 7,
      not_applicable: 75,
    });
    // 900 + 40 + 20. Not 1042 (which would include pending + skips).
    assert.equal(o.resolved, 960);
    assert.equal(o.succeeded, 900);
    assert.equal(o.rate_pct, 93.8);
  });

  it("a deliberate skip is NOT a failure — not_applicable is out of the denominator", () => {
    const withSkips = writebackOutcome({ success: 90, failed: 10, not_applicable: 500 });
    const withoutSkips = writebackOutcome({ success: 90, failed: 10 });
    assert.equal(withSkips.rate_pct, 90);
    assert.equal(
      withSkips.rate_pct,
      withoutSkips.rate_pct,
      "500 deliberate skips must not move the rate",
    );
    assert.equal(withSkips.resolved, 100);
  });

  it("an in-flight submission is NOT a failure — pending is out of the denominator", () => {
    const busy = writebackOutcome({ success: 90, failed: 10, pending: 400 });
    assert.equal(busy.resolved, 100);
    assert.equal(busy.rate_pct, 90, "a queue backlog must not look like a rate collapse");
  });

  it("manual_review counts against the AUTOMATIC rate but is reported separately", () => {
    const o = writebackOutcome({ success: 50, manual_review: 50 });
    assert.equal(o.resolved, 100);
    assert.equal(o.rate_pct, 50);
    assert.equal(o.manual_review, 50);
  });
});

describe("writebackOutcome — zero versus unavailable", () => {
  it("a zero denominator yields null, never 0%", () => {
    assert.equal(writebackOutcome({}).rate_pct, null);
    assert.equal(writebackOutcome({ pending: 12 }).rate_pct, null);
    assert.equal(writebackOutcome({ not_applicable: 80 }).rate_pct, null);
  });

  it("a measured zero numerator over a real denominator IS 0%", () => {
    const o = writebackOutcome({ success: 0, failed: 10 });
    assert.equal(o.resolved, 10);
    assert.equal(o.rate_pct, 0);
    assert.notEqual(o.rate_pct, null, "0% is a measurement, not an absence");
  });

  it("everything succeeded is 100%", () => {
    assert.equal(writebackOutcome({ success: 33 }).rate_pct, 100);
  });

  it("rate is rounded to one decimal", () => {
    // 2/3 = 66.666..
    assert.equal(writebackOutcome({ success: 2, failed: 1 }).rate_pct, 66.7);
  });

  it("carries its basis so no number ships without a definition", () => {
    assert.equal(writebackOutcome({ success: 1 }).basis, WRITEBACK_BASIS);
    assert.match(WRITEBACK_BASIS, /excludes deliberate skips/);
  });
});

describe("writebackOutcome — suppression must not distort the rate", () => {
  it("a small failure bucket is hidden for display but still lowers the rate", () => {
    // THE OLD BUG: the browser summed only non-suppressed cells, so hiding a
    // 1..4 `failed` bucket removed it from the denominator and RAISED the
    // displayed rate. Here the rate is computed from true counts first.
    const o = writebackOutcome({ success: 96, failed: 4 });
    assert.equal(o.failed, "<5", "the small cell is still hidden from display");
    assert.equal(o.resolved, 100, "but it is in the denominator");
    assert.equal(o.rate_pct, 96);

    // What the old approach produced from suppressed rows: 96/96 = 100%.
    assert.notEqual(o.rate_pct, 100);
  });

  it("small component counts are suppressed; resolved and succeeded are not", () => {
    const o = writebackOutcome({
      success: 40,
      manual_review: 1,
      failed: 2,
      pending: 3,
      not_applicable: 4,
    });
    assert.equal(o.manual_review, "<5");
    assert.equal(o.failed, "<5");
    assert.equal(o.pending, "<5");
    assert.equal(o.skipped, "<5");
    // The denominator and numerator are window aggregates, like total_submissions.
    assert.equal(o.resolved, 43);
    assert.equal(o.succeeded, 40);
  });

  it("a zero component stays 0, not '<5' — a measured none is not a hidden few", () => {
    const o = writebackOutcome({ success: 10, failed: 0 });
    assert.equal(o.failed, 0);
    assert.equal(suppress(0), 0);
    assert.equal(suppress(SUPPRESS_BELOW - 1), "<5");
    assert.equal(suppress(SUPPRESS_BELOW), SUPPRESS_BELOW);
  });

  it("ignores unknown / malformed status keys rather than inventing a denominator", () => {
    const o = writebackOutcome({ success: 5, unknown: 99 } as Record<string, number>);
    assert.equal(o.resolved, 5);
    assert.equal(o.rate_pct, 100);
  });
});

describe("canonicalLocationSql", () => {
  const expr = canonicalLocationSql("loc");

  it("folds the three clinics' punctuation/case variants", () => {
    assert.match(expr, /'seattlewa' THEN 'Seattle, WA'/);
    assert.match(expr, /'portlandor' THEN 'Portland, OR'/);
    assert.match(expr, /'planotx' THEN 'Plano, TX'/);
  });

  it("strips only non-letters, so spacing/punctuation/case collapse", () => {
    // "Seattle WA", "seattle, wa", "Seattle,WA" all reduce to 'seattlewa'.
    const reduce = (s: string) => s.replace(/[^a-zA-Z]/g, "").toLowerCase();
    assert.equal(reduce("Seattle, WA"), "seattlewa");
    assert.equal(reduce("Seattle WA"), "seattlewa");
    assert.equal(reduce("seattle,wa"), "seattlewa");
    assert.equal(reduce("SEATTLE  WA "), "seattlewa");
    // A bare city name does NOT reduce to a canonical key, so it survives.
    assert.notEqual(reduce("Plano"), "planotx");
  });

  it("blank and whitespace-only values become NULL, not an empty bar", () => {
    assert.match(expr, /NULLIF\(TRIM\(loc\), ''\)/);
  });

  it("passes an unrecognised value through instead of folding away the evidence", () => {
    // The ELSE branch is the raw trimmed value — no catch-all bucket.
    assert.ok(expr.trimEnd().endsWith("ELSE NULLIF(TRIM(loc), '') END)"));
    assert.ok(!/'Other'|'Unknown'/.test(expr));
  });
});

describe("dimension expressions — the clinic calendar", () => {
  it("day, week and month all bucket in the clinic zone, not the session zone", () => {
    for (const unit of ["day", "week", "month"] as const) {
      const expr = DIMENSION_EXPR[unit];
      assert.ok(
        expr.includes(`AT TIME ZONE '${CLINIC_TZ}'`),
        `dimension '${unit}' must bucket in ${CLINIC_TZ}, got: ${expr}`,
      );
      assert.ok(expr.includes(`date_trunc('${unit}'`));
    }
  });

  it("no date dimension relies on the bare session timezone any more", () => {
    for (const unit of ["day", "week", "month"] as const) {
      assert.ok(
        !/date_trunc\('(day|week|month)', created_at\)/.test(DIMENSION_EXPR[unit]),
        `dimension '${unit}' still uses the session timezone`,
      );
    }
  });

  it("the location dimension trims and canonicalises", () => {
    const expr = DIMENSION_EXPR.office_location;
    assert.ok(expr.includes("officeLocation"));
    assert.ok(expr.includes("TRIM"));
    assert.match(expr, /'Seattle, WA'/);
  });

  it("insurance coverage no longer emits an empty-string group", () => {
    assert.match(DIMENSION_EXPR.insurance_coverage, /NULLIF\(TRIM\(/);
  });
});
