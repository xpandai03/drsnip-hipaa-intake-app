// J5 comeback window: the PHI-free timing row written when a completed
// registration clears its drop-off partial, and the admin-only percentiles.
// Synthetic fixtures only.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { COMEBACK_WINDOW_SQL, partialConversionRows } from "../_lib/partials";
import { makeReq, makeRes } from "./harness";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("timing rows", () => {
  const t = (iso: string) => new Date(iso);
  it("session match when the partial is this session's own; email otherwise", () => {
    const rows = partialConversionRows([
      { partialId: "s-1", createdAt: t("2026-11-01T10:00:00Z"), updatedAt: t("2026-11-01T10:05:00Z") },
      { partialId: "s-0", createdAt: "2026-10-29T08:00:00Z", updatedAt: null },
    ], "s-1");
    assert.deepEqual(rows.map((r) => r.matchType), ["session", "email"]);
    assert.equal(rows[1].partialCreatedAt.toISOString(), "2026-10-29T08:00:00.000Z");
    assert.equal(rows[1].partialUpdatedAt, null);
  });
  it("no session id means every cleared partial is an email match", () => {
    assert.deepEqual(partialConversionRows([{ partialId: "x", createdAt: t("2026-11-01T00:00:00Z"), updatedAt: null }], null)
      .map((r) => r.matchType), ["email"]);
  });
  it("a partial with no usable created_at is skipped, never thrown on", () => {
    assert.deepEqual(partialConversionRows([
      { partialId: "a", createdAt: null, updatedAt: null },
      { partialId: "b", createdAt: "not a date", updatedAt: null },
    ], "a"), []);
  });
  it("the table has no identifier column", () => {
    const m = read("../../lib/db/migrations/0026_registration_partial_conversions.sql");
    const cols = m.slice(m.indexOf("CREATE TABLE"), m.indexOf(");")).toLowerCase();
    for (const f of ["name", "email", "phone", "partial_id", "submission_id", "patient", "chart"]) assert.ok(!cols.includes(f), f);
  });
  it("the percentiles use comebacks (email) only", () => {
    assert.equal((COMEBACK_WINDOW_SQL.match(/FILTER \(WHERE x\.match_type = 'email'\)/g) ?? []).length, 4);
  });
});

describe("/api/submit stays fire-and-forget", () => {
  const S = read("../submit.ts");
  const P = read("../_lib/partials.ts");
  it("the cleanup is still called with void, and the insert sits inside it", () => {
    assert.match(S, /void clearRegistrationPartial\(body\);/);
    const fn = S.slice(S.indexOf("async function clearRegistrationPartial"), S.indexOf("async function markBridgeSkipped"));
    assert.match(fn, /\.returning\(\{/);
    assert.match(fn, /await recordPartialConversions\(cleared, partialId\);/);
    assert.match(fn, /\} catch \(err\) \{/);
  });
  it("the insert is its own statement with its own catch, so the delete stands if it fails", () => {
    const fn = P.slice(P.indexOf("export async function recordPartialConversions"), P.indexOf("export const COMEBACK_WINDOW_SQL"));
    assert.match(fn, /try \{/);
    assert.match(fn, /\} catch \(err\) \{/);
    assert.ok(!/throw /.test(fn));
  });
  it("the table is created by the release command", () => {
    assert.match(read("../../api-server/migrate.ts"), /0026_registration_partial_conversions/);
  });
});

describe("route contract", () => {
  it("is admin only and time-boxed", async () => {
    const H = read("../admin/comeback-window.ts");
    assert.match(H, /requireAdmin\(req, res\)/);
    assert.match(H, /reportQuery/);
    const { default: handler } = await import("../admin/comeback-window");
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    assert.equal(res.statusCode, 401);
  });
});

const APPDB = process.env.DATABASE_URL;
const live = Boolean(APPDB && !/fly\.dev|flycast|drsnip-intake-db/.test(APPDB));
function loadPg() {
  const require_ = createRequire(import.meta.url);
  return require_(require_.resolve("pg", { paths: [dirname(require_.resolve("@workspace/db"))] }));
}

describe(`against Postgres (${live ? "live" : "skipped without DATABASE_URL"})`, { skip: !live }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c: any;
  before(async () => {
    const { Client } = loadPg();
    c = new Client({ connectionString: APPDB });
    await c.connect();
    await c.query(readFileSync(new URL("../../lib/db/migrations/0026_registration_partial_conversions.sql", import.meta.url), "utf8"));
    await c.query("DELETE FROM registration_partial_conversions");
  });
  after(async () => { await c?.query("DELETE FROM registration_partial_conversions"); await c?.end(); });

  it("records through the app's own db, then reads p50 / p80 / p90 over comebacks only", async () => {
    const { recordPartialConversions } = await import("../_lib/partials");
    // Ten comebacks, 1..10 hours after the partial; two same-session rows that must not count.
    const now = Date.now();
    for (let h = 1; h <= 10; h++) {
      await recordPartialConversions([{ partialId: `old-${h}`, createdAt: new Date(now - h * 3600_000), updatedAt: null }], "new-session");
    }
    await recordPartialConversions([{ partialId: "same", createdAt: new Date(now - 5 * 60_000), updatedAt: null }], "same");
    await recordPartialConversions([{ partialId: "same2", createdAt: new Date(now - 9 * 60_000), updatedAt: null }], "same2");
    const r = (await c.query(COMEBACK_WINDOW_SQL)).rows[0];
    assert.equal(r.n, 10);
    assert.equal(r.n_same_session, 2);
    assert.ok(Math.abs(Number(r.p50_hours) - 5.5) <= 0.1, String(r.p50_hours));
    assert.ok(Math.abs(Number(r.p80_hours) - 8.2) <= 0.1, String(r.p80_hours));
    assert.ok(Math.abs(Number(r.p90_hours) - 9.1) <= 0.1, String(r.p90_hours));
  });
  it("never throws when the table is missing", async () => {
    const { recordPartialConversions } = await import("../_lib/partials");
    await c.query("ALTER TABLE registration_partial_conversions RENAME TO rpc_hidden");
    try {
      await recordPartialConversions([{ partialId: "x", createdAt: new Date(), updatedAt: null }], null);
    } finally {
      await c.query("ALTER TABLE rpc_hidden RENAME TO registration_partial_conversions");
    }
  });
});
