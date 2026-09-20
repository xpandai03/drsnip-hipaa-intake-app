// The freshness contract, and the rules that stop a loading page from lying.
//
// WHAT WENT WRONG. /admin/journeys got its freshness by reading it off the side
// of a six-second metric response, so for six seconds it rendered
//
//     "Appointment snapshot — last refreshed unknown"
//
// Three separate faults in one sentence: it called an in-flight request
// "unknown"; it gave the reader no way to tell that apart from a genuinely
// missing timestamp; and it said "snapshot" whether or not anything was keeping
// the data current.
//
// These are source-level assertions because the rules live in one component and
// one endpoint, and because a rule this easy to regress deserves a test that
// fails loudly rather than a screenshot somebody has to remember to take.
//
// No PHI, no DB, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/**
 * Source with comments removed.
 *
 * These files DOCUMENT the wording they must never render — "last refreshed
 * unknown" is quoted at the top of both of them as the bug being fixed. An
 * assertion over the raw text would either fail on the explanation or force the
 * explanation out, and the explanation is the more valuable of the two.
 */
function rendered(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const FRESHNESS_API = "../reports/freshness.ts";
const FRESHNESS_UI = "../../artifacts/intake-form/src/components/reporting/freshness.tsx";
const JOURNEYS = "../../artifacts/intake-form/src/pages/admin/Journeys.tsx";
const REPORTS = "../../artifacts/intake-form/src/pages/admin/Reports.tsx";
const SERVER = "../../api-server/index.ts";

describe("the freshness endpoint", () => {
  const src = read(FRESHNESS_API);

  it("is auth-guarded like every other reporting route", () => {
    assert.match(src, /await requireAuth\(req, res\)/);
    assert.match(src, /if \(!auth\) return;/);
  });

  it("goes through the SECURITY DEFINER boundary and touches no table directly", () => {
    assert.match(src, /public\.drsnip_journey_freshness\(\)/);
    assert.match(src, /public\.drsnip_sync_health\(\)/);
    for (const table of ["submissions", "appointment_snapshots", "users"]) {
      assert.ok(
        !new RegExp(`FROM\\s+(public\\.)?${table}\\b`, "i").test(src),
        `freshness must not read ${table} directly`,
      );
    }
  });

  it("is registered in the server", () => {
    assert.ok(read(SERVER).includes('"/api/reports/freshness"'));
  });

  it("every handler in api/reports/ is registered", () => {
    // v82 shipped /api/reports/journey as a 404 because the handler existed and
    // the route did not.
    const server = read(SERVER);
    const dir = new URL("../reports/", import.meta.url);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const name = f.replace(/\.ts$/, "");
      assert.ok(
        server.includes(`"/api/reports/${name}"`),
        `api/reports/${f} has no app.all("/api/reports/${name}") in api-server/index.ts`,
      );
    }
  });

  it("is never cached: freshness that is itself stale is worse than none", () => {
    assert.match(src, /Cache-Control["'\s,]+.*no-store/);
  });

  it("returns counts and timestamps, never an identifier", () => {
    for (const forbidden of ["patient_source_id", "n8n_patient_id", "email", "first_name"]) {
      assert.ok(!src.includes(forbidden), `freshness response mentions ${forbidden}`);
    }
  });

  it("decides 'live' from evidence, not from configuration", () => {
    // A schedule row can say enabled while n8n is down. The classifier must
    // consult whether a run actually succeeded.
    assert.match(src, /appointment_sync_active \? "live" : "late"/);
    assert.match(src, /if \(!f\.sync_schedule_enabled\) return "paused"/);
  });
});

describe("the freshness badge never says 'unknown' while it is loading", () => {
  const ui = read(FRESHNESS_UI);

  it("has a distinct in-flight state", () => {
    assert.match(ui, /freshness-checking/);
    assert.match(ui, /checking how current it is/i);
  });

  it("has a distinct failed state, with a retry", () => {
    assert.match(ui, /freshness-unavailable/);
    assert.match(ui, /freshness-retry/);
    assert.match(ui, /freshness check failed/i);
  });

  it("has a distinct never-synced state", () => {
    assert.match(ui, /freshness-never/);
    assert.match(ui, /no sync has completed yet/i);
  });

  it("distinguishes live, behind, paused and by-hand", () => {
    for (const id of ["freshness-live", "freshness-late", "freshness-paused", "freshness-manual"]) {
      assert.ok(ui.includes(id), `${id} state is missing`);
    }
  });

  it("marks a refresh in progress rather than freezing or blanking", () => {
    assert.match(ui, /isFetching \? " · updating" : ""/);
  });

  it("keeps the last known value on failure and calls it stale, never zero", () => {
    assert.match(ui, /last known \$\{last\} \(may be stale\)/);
    // The words that would turn a failed request into a measurement.
    assert.ok(!/>\s*0\s*</.test(ui), "a zero must never stand in for a failed check");
  });

  it("does not retry for ever: an endless spinner hides a broken thing", () => {
    assert.match(ui, /retry: 1/);
  });

  it("says 'complete to', not 'last refreshed'", () => {
    const shown = rendered(FRESHNESS_UI);
    // A run that could not finish its window does not advance the cursor, so
    // the timestamp means coverage, not activity. "Last refreshed" would be the
    // other, wrong, reading.
    assert.match(shown, /Appointment data complete to/);
    assert.ok(!/last refreshed/i.test(shown));
  });
});

describe("the journeys page", () => {
  const page = read(JOURNEYS);

  it("no longer renders 'unknown' anywhere", () => {
    assert.ok(
      !/unknown/i.test(rendered(JOURNEYS)),
      'the "last refreshed unknown" placeholder is back',
    );
  });

  it("uses the cheap freshness call, not a journey metric, for freshness", () => {
    assert.match(page, /useFreshness\(\)/);
    assert.ok(
      !/queryKey: \["journey-freshness"\]/.test(page),
      "freshness must not be read off the side of a six-second metric again",
    );
  });

  it("draws skeletons, not the word Loading", () => {
    assert.ok(!/>Loading…</.test(page), "an indefinite 'Loading…' is back");
    assert.match(page, /PanelSkeleton/);
    assert.match(page, /aria-busy/);
  });

  it("offers a retry on every failed request", () => {
    assert.match(page, /journey-retry/);
    assert.match(page, /consultation-retry/);
  });

  it("labels a refresh of existing figures as updating", () => {
    assert.match(page, /journey-updating/);
  });

  it("keeps the selected journey, period and window in the URL", () => {
    // A link to "the insurance journey, August, 30-day window" has to exist.
    assert.match(page, /params\.get\("journey"\)/);
    assert.match(page, /params\.get\("period"\)/);
    assert.match(page, /params\.get\("window"\)/);
    assert.match(page, /setParam\("journey", id\)/);
  });

  it("falls back to a valid selection rather than trusting the query string", () => {
    assert.match(page, /function isTab\(/);
    assert.match(page, /function isPeriod\(/);
    assert.match(page, /WINDOWS\.includes\(windowParam/);
  });
});

describe("the reports index", () => {
  const page = read(REPORTS);

  it("links to both real journeys with the tab pre-selected", () => {
    assert.match(page, /\/admin\/journeys\?journey=registration/);
    assert.match(page, /\/admin\/journeys\?journey=insurance/);
  });

  it("keeps the operational pages reachable", () => {
    for (const to of ["/admin/dashboard", "/admin/activity", "/admin/dropoffs"]) {
      assert.ok(page.includes(to), `${to} disappeared from the reports index`);
    }
  });

  it("separates the demonstration and says what it is", () => {
    assert.match(page, /Demonstration — not patient data/);
    assert.match(page, /reports-card-demo/);
    // And it is below the real cards, not among them.
    assert.ok(
      page.indexOf("reports-card-registration") < page.indexOf("reports-card-demo"),
      "the demo must not be ranked above live reporting",
    );
  });

  it("computes nothing: it is an index, not a second dashboard", () => {
    assert.ok(!/useQuery\(/.test(page), "the index must not run its own metric queries");
    assert.ok(!/api\/reports\/journey/.test(page));
    assert.ok(!/api\/reports\/booking/.test(page));
  });
});
