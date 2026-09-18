// The insurance-follow-up demonstration must be (a) structurally incapable of
// touching live data or sending anything, and (b) internally consistent — every
// figure it shows has to reconcile with the records it claims to summarise.
//
// Part (a) reads the SOURCE of the demo page and its fixture module, with
// comments stripped first, so a comment explaining the rule cannot satisfy the
// test. Part (b) imports the fixture module and checks the arithmetic.
//
// No PHI, no DB, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as F from "../../artifacts/intake-form/src/pages/admin/insurance-demo/demo-fixtures";

const DEMO_DIR = "../../artifacts/intake-form/src/pages/admin/insurance-demo";
const PAGE = `${DEMO_DIR}/InsuranceDemo.tsx`;
const FIXTURES = `${DEMO_DIR}/demo-fixtures.ts`;

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/**
 * Strip comments and string literals before scanning for forbidden calls, so
 * neither a comment nor a piece of on-screen copy can make the test pass or
 * fail by accident.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("demo isolation — the page cannot reach live data", () => {
  const pageCode = code(read(PAGE));
  const fixtureCode = code(read(FIXTURES));

  it("makes no network call", () => {
    for (const [name, src] of [
      ["InsuranceDemo.tsx", pageCode],
      ["demo-fixtures.ts", fixtureCode],
    ] as const) {
      for (const forbidden of [
        "fetch(",
        "XMLHttpRequest",
        "EventSource",
        "navigator.sendBeacon",
        "WebSocket",
      ]) {
        assert.ok(
          !src.includes(forbidden),
          `${name} must not use ${forbidden}`,
        );
      }
    }
  });

  it("uses no query client, so it cannot join the app's data layer", () => {
    for (const forbidden of ["useQuery", "useMutation", "queryClient", "invalidateQueries"]) {
      assert.ok(
        !pageCode.includes(forbidden),
        `InsuranceDemo.tsx must not use ${forbidden}`,
      );
      assert.ok(
        !fixtureCode.includes(forbidden),
        `demo-fixtures.ts must not use ${forbidden}`,
      );
    }
  });

  it("imports no database, schema or mail module", () => {
    for (const forbidden of [
      "@workspace/db",
      "drizzle",
      "nodemailer",
      "patientmail",
      "lib/n8n",
      "api/",
    ]) {
      assert.ok(
        !pageCode.includes(forbidden),
        `InsuranceDemo.tsx must not import ${forbidden}`,
      );
      assert.ok(
        !fixtureCode.includes(forbidden),
        `demo-fixtures.ts must not import ${forbidden}`,
      );
    }
  });

  it("schedules nothing — no timer, interval or worker keeps running", () => {
    for (const forbidden of [
      "setInterval",
      "setTimeout",
      "requestIdleCallback",
      "new Worker",
    ]) {
      assert.ok(
        !pageCode.includes(forbidden),
        `InsuranceDemo.tsx must not use ${forbidden}`,
      );
    }
  });

  it("the fixture module imports nothing at all", () => {
    // A zero-dependency module cannot acquire a live source later by accident.
    assert.ok(
      !/^\s*import\s/m.test(fixtureCode),
      "demo-fixtures.ts must have no imports",
    );
  });

  it("the page imports only the shell, the chart and its own fixtures", () => {
    const imports = [...read(PAGE).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    const allowed = new Set([
      "react",
      "wouter",
      "lucide-react",
      "../AdminLayout",
      "../PageHeader",
      "@/components/ui/waterfall-chart",
      "./demo-fixtures",
    ]);
    for (const spec of imports) {
      assert.ok(allowed.has(spec), `unexpected import in InsuranceDemo.tsx: ${spec}`);
    }
    assert.ok(imports.includes("./demo-fixtures"), "must read its own fixtures");
  });

  it("uses no randomness or live clock, so the demo is byte-stable", () => {
    // A figure that changes between the rehearsal and the meeting is a figure
    // nobody can check.
    assert.ok(!fixtureCode.includes("Math.random"), "no Math.random in fixtures");
    assert.ok(!fixtureCode.includes("Date.now"), "no Date.now in fixtures");
    assert.ok(!fixtureCode.includes("new Date()"), "no live clock in fixtures");
  });
});

describe("demo labelling", () => {
  const page = read(PAGE);

  it("carries the required banner text", () => {
    assert.equal(
      F.DEMO_BANNER,
      "Demo data — illustrative workflow. No patient messages are sent.",
    );
    assert.ok(page.includes("DEMO_BANNER"), "the page must render the banner");
  });

  it("labels every major panel, not just the page", () => {
    // DemoTag is the per-panel chip; it must appear in more than one place.
    const uses = (page.match(/<DemoTag/g) ?? []).length;
    assert.ok(uses >= 3, `expected several per-panel Demo labels, found ${uses}`);
  });

  it("says approval is required and that nothing is sent", () => {
    // JSX wraps prose across lines, so compare on collapsed whitespace.
    const flat = page.replace(/\s+/g, " ");
    assert.match(flat, /Nothing is sent from this screen/);
    assert.match(flat, /A named staff member approves before anything is sent/);
    assert.match(flat, /Approved in demo/);
    assert.match(flat, /not sent/);
  });

  it("avoids implementation jargon in the interface", () => {
    for (const word of ["AI worker", "harness", "agentic", "LLM prompt"]) {
      assert.ok(!page.includes(word), `interface copy should not say "${word}"`);
    }
  });
});

describe("demo fixtures — the cohort reconciles", () => {
  it("has the stated number of records", () => {
    assert.equal(F.RECORDS.length, 75);
  });

  it("every record id is unique and obviously fictional", () => {
    const ids = new Set(F.RECORDS.map((r) => r.id));
    assert.equal(ids.size, F.RECORDS.length);
    for (const r of F.RECORDS) {
      assert.match(r.id, /^Demo inquiry \d{2}$/);
    }
  });

  it("holds no contact details of any kind", () => {
    const blob = JSON.stringify(F.RECORDS) + JSON.stringify(F.QUEUE);
    assert.ok(!/@/.test(blob), "no email-shaped value anywhere in the fixtures");
    assert.ok(
      !/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(blob),
      "no phone-shaped value anywhere in the fixtures",
    );
  });

  it("stage counts are COUNTED off the records, and are nested", () => {
    const counts = F.stageCounts();
    for (const { stage, count } of counts) {
      const manual = F.RECORDS.filter(
        (r) => F.STAGE_ORDER.indexOf(r.reached) >= F.STAGE_ORDER.indexOf(stage),
      ).length;
      assert.equal(count, manual, `${stage} must equal its own record count`);
    }
    // A subset cannot exceed its superset.
    for (let i = 1; i < counts.length; i += 1) {
      assert.ok(
        counts[i].count <= counts[i - 1].count,
        `${counts[i].stage} (${counts[i].count}) exceeds ${counts[i - 1].stage} (${counts[i - 1].count})`,
      );
    }
    // The first stage is the whole cohort.
    assert.equal(counts[0].count, F.RECORDS.length);
  });

  it("every event log is chronological and starts with the inquiry", () => {
    for (const r of F.RECORDS) {
      assert.equal(r.events[0]?.stage, "inquiry");
      assert.equal(r.events[0]?.day, r.entryDay);
      for (let i = 1; i < r.events.length; i += 1) {
        assert.ok(
          r.events[i].day >= r.events[i - 1].day,
          `${r.id} has events out of order`,
        );
      }
      // The log must go exactly as far as `reached`, no further and no shorter.
      assert.equal(
        r.events[r.events.length - 1].stage,
        r.reached,
        `${r.id} log does not end at its furthest stage`,
      );
      assert.equal(
        r.events.length,
        F.STAGE_ORDER.indexOf(r.reached) + 1,
        `${r.id} is missing an intermediate event`,
      );
    }
  });

  it("nothing happens after the observation cutoff", () => {
    for (const r of F.RECORDS) {
      for (const e of r.events) {
        assert.ok(
          e.day <= F.OBSERVED_DAY,
          `${r.id} has an event on day ${e.day}, past the cutoff ${F.OBSERVED_DAY}`,
        );
      }
    }
  });

  it("every inquiry falls inside the stated entry window", () => {
    for (const r of F.RECORDS) {
      assert.ok(r.entryDay >= 0 && r.entryDay < F.COHORT.entryWindowDays, r.id);
    }
    assert.equal(F.dayToDate(0), F.COHORT.firstEntryDay);
    assert.equal(F.dayToDate(F.OBSERVED_DAY), F.COHORT.observedThrough);
  });
});

describe("demo fixtures — conversions are honest", () => {
  it("the first stage has no conversion (nothing precedes it)", () => {
    assert.equal(F.conversionFromPrev("inquiry"), null);
  });

  it("each conversion is the stage over the one before it", () => {
    for (let i = 1; i < F.STAGE_ORDER.length; i += 1) {
      const stage = F.STAGE_ORDER[i];
      const cur = F.stageCount(stage);
      const prev = F.stageCount(F.STAGE_ORDER[i - 1]);
      const expected = `${(Math.round((cur / prev) * 1000) / 10).toFixed(1)}%`;
      assert.equal(F.conversionFromPrev(stage), expected, stage);
    }
  });

  it("no conversion exceeds 100% — that would mean the stages are not nested", () => {
    for (const stage of F.STAGE_ORDER.slice(1)) {
      const pct = Number((F.conversionFromPrev(stage) ?? "0%").replace("%", ""));
      assert.ok(pct <= 100, `${stage} conversion is ${pct}%`);
    }
  });

  it("a zero denominator yields null, never 0%", () => {
    assert.equal(F.conversionFromPrev("booked", []), null);
    assert.equal(F.inquiryToBooked([]), null);
  });

  it("a real zero numerator over a real denominator IS 0.0%", () => {
    // Records that got no further than the inquiry: verified must read 0.0%.
    const inquiryOnly = F.RECORDS.filter((r) => r.reached === "inquiry");
    assert.ok(inquiryOnly.length > 0);
    assert.equal(F.conversionFromPrev("verified", inquiryOnly), "0.0%");
    assert.equal(F.inquiryToBooked(inquiryOnly), 0);
  });

  it("time-to-estimate averages only over records that got an estimate", () => {
    const t = F.meanDaysToEstimate();
    assert.equal(t.n, F.stageCount("estimate"));
    assert.ok(t.n < F.RECORDS.length, "some records never got an estimate");
    assert.ok(t.mean !== null && t.mean > 0);
    // Recompute independently.
    const spans = F.RECORDS.map((r) => {
      const a = F.dayOf(r, "inquiry");
      const b = F.dayOf(r, "estimate");
      return a !== null && b !== null ? b - a : null;
    }).filter((x): x is number => x !== null);
    const mean = Math.round((spans.reduce((x, y) => x + y, 0) / spans.length) * 10) / 10;
    assert.equal(t.mean, mean);
  });

  it("an empty set yields no mean rather than a zero", () => {
    assert.deepEqual(F.meanDaysToEstimate([]), { mean: null, n: 0 });
  });
});

describe("demo fixtures — cohort maturity is separated from weekly activity", () => {
  it("matured and maturing partition the cohort", () => {
    const m = F.maturedRecords();
    const g = F.maturingRecords();
    assert.equal(m.length + g.length, F.RECORDS.length);
    assert.equal(new Set([...m, ...g].map((r) => r.id)).size, F.RECORDS.length);
  });

  it("matured records really have had the stated observation time", () => {
    for (const r of F.maturedRecords()) {
      assert.ok(F.OBSERVED_DAY - r.entryDay >= F.COHORT.maturityDays, r.id);
    }
    for (const r of F.maturingRecords()) {
      assert.ok(F.OBSERVED_DAY - r.entryDay < F.COHORT.maturityDays, r.id);
    }
  });

  it("weekly activity counts EVENTS in the week, not cohort members", () => {
    const a = F.weeklyActivity();
    for (const stage of F.STAGE_ORDER) {
      const manual = F.RECORDS.reduce(
        (n, r) =>
          n +
          r.events.filter(
            (e) => e.stage === stage && e.day >= F.WEEK.fromDay && e.day <= F.WEEK.toDay,
          ).length,
        0,
      );
      assert.equal(a[stage], manual, stage);
    }
  });

  it("the week sits inside the observation window", () => {
    assert.ok(F.WEEK.fromDay >= 0);
    assert.equal(F.WEEK.toDay, F.OBSERVED_DAY);
    assert.equal(F.WEEK.toDay - F.WEEK.fromDay, 6);
  });

  it("weekly activity is NOT the cohort funnel — the two must differ", () => {
    // If these ever coincided, someone could divide one week's bookings by the
    // same week's inquiries and believe it meant something.
    const a = F.weeklyActivity();
    assert.notEqual(a.inquiry, F.stageCount("inquiry"));
  });
});

describe("demo queue", () => {
  it("every queue item points at a real fixture record", () => {
    const ids = new Set(F.RECORDS.map((r) => r.id));
    for (const q of F.QUEUE) assert.ok(ids.has(q.recordId), q.recordId);
  });

  it("no record appears twice", () => {
    assert.equal(new Set(F.QUEUE.map((q) => q.recordId)).size, F.QUEUE.length);
  });

  it("shows several distinct situations, including a resolved one", () => {
    const statuses = new Set(F.QUEUE.map((q) => q.status));
    assert.ok(statuses.size >= 4, `expected varied statuses, got ${[...statuses]}`);
    assert.ok(statuses.has("booked"), "the queue should not be only exceptions");
    assert.ok(statuses.has("human_review_required"), "an escalation must be shown");
  });

  it("a clinical question or a call request produces NO draft", () => {
    for (const q of F.QUEUE) {
      if (q.status === "human_review_required" || q.status === "call_requested") {
        assert.equal(q.draft, null, `${q.recordId} must not carry a draft`);
        assert.ok(q.handoff, `${q.recordId} must name a staff handoff`);
      }
    }
  });

  it("no draft gives clinical advice, promises coverage, or offers money off", () => {
    for (const q of F.QUEUE) {
      if (!q.draft) continue;
      const d = q.draft.toLowerCase();
      for (const banned of [
        "covered",
        "discount",
        "guarantee",
        "diagnos",
        "safe",
        "risk-free",
        "% off",
        "$",
        "recommend you",
        "you should",
      ]) {
        assert.ok(!d.includes(banned), `${q.recordId} draft must not say "${banned}"`);
      }
    }
  });

  it("each item's evidence is chronological and marks what is live today", () => {
    for (const q of F.QUEUE) {
      for (let i = 1; i < q.events.length; i += 1) {
        assert.ok(q.events[i].day >= q.events[i - 1].day, q.recordId);
      }
      // Only the inquiry is measurable in the console today.
      const live = q.events.filter((e) => e.live);
      assert.equal(live.length, 1, `${q.recordId} should mark exactly one live event`);
      assert.equal(live[0].label, F.STAGE_LABEL.inquiry);
    }
  });

  it("stall ages are plausible and never negative", () => {
    for (const q of F.QUEUE) {
      assert.ok(q.daysStalled >= 0, q.recordId);
      assert.ok(q.daysStalled <= F.OBSERVED_DAY, q.recordId);
    }
    assert.ok(
      F.QUEUE.some((q) => q.status === "awaiting_response" && q.daysStalled > 0),
      "at least one item should visibly have stalled",
    );
  });
});

describe("demo baseline is illustrative only", () => {
  it("is a labelled band, not a measured rate", () => {
    assert.equal(F.ILLUSTRATIVE_BASELINE.lowPct, 30);
    assert.equal(F.ILLUSTRATIVE_BASELINE.highPct, 40);
  });

  it("the page calls it illustrative and refuses it as a denominator", () => {
    const page = read(PAGE);
    assert.match(page, /Illustrative baseline/);
    assert.match(page, /never used as a denominator/);
  });

  it("shows no money figure and claims no procedure outcome", () => {
    // The word "revenue" DOES appear — in the sentence saying no revenue figure
    // is shown. So test for a figure, not for the word.
    const page = read(PAGE);
    const flat = page.replace(/\s+/g, " ");

    assert.ok(
      !/[$\u00a3\u20ac]\s?\d/.test(page),
      "no currency amount may appear in the demo",
    );
    for (const pattern of [
      /revenue of/i,
      /worth \d/i,
      /\d+\s*(?:k|m)\s+(?:in|of)\s+revenue/i,
      /return on investment/i,
      /procedures? completed/i,
    ]) {
      assert.ok(!pattern.test(flat), `the demo must not assert ${pattern}`);
    }

    // And it must actively draw the distinction rather than stay silent.
    assert.match(
      flat,
      /booked appointment is not an attended appointment/i,
      "the demo should say a booking is not an attendance",
    );
  });
});
