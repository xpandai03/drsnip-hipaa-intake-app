// The read-only agent API (api/agent, docs/AGENT_API.md): its gate and its
// queries. No database: every request here is answered before a query would
// run, and the query checks read the SQL text itself. No PHI.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AGENT_QUERIES, AGENT_ROUTES, agentApi, agentTokenOk } from "../agent";
import { RESOLVED_LOCATION_SQL } from "../_lib/location";

const paths = [...Object.keys(AGENT_ROUTES).map((p) => `/${p}`), "/not-a-route"];
const TOKEN = "t".repeat(64);
const call = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  agentApi.request(path, { method, headers }).then((r) => r.status);

describe("agent API gate", () => {
  beforeEach(() => {
    delete process.env.AGENT_API_TOKEN;
    process.env.N8N_SERVICE_TOKEN = "n".repeat(64);
  });

  it("refuses every method but GET, OPTIONS included, on every route", async () => {
    process.env.AGENT_API_TOKEN = TOKEN;
    for (const p of paths)
      for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        assert.equal(await call(p, m, { Authorization: `Bearer ${TOKEN}` }), 405, `${m} ${p}`);
  });

  it("answers 503 on every route when AGENT_API_TOKEN isn't set (fail closed)", async () => {
    for (const p of paths) assert.equal(await call(p, "GET", { Authorization: `Bearer ${TOKEN}` }), 503, p);
  });

  it("answers 401 without the token, with a wrong or short one, or with another of the console's tokens", async () => {
    process.env.AGENT_API_TOKEN = TOKEN;
    for (const p of paths) {
      assert.equal(await call(p), 401, `none ${p}`);
      assert.equal(await call(p, "GET", { Authorization: `Bearer ${"x".repeat(64)}` }), 401, `wrong ${p}`);
      assert.equal(await call(p, "GET", { Authorization: "Bearer t" }), 401, `short ${p}`);
      assert.equal(await call(p, "GET", { Authorization: `Bearer ${process.env.N8N_SERVICE_TOKEN}`, "x-drsnip-service-token": process.env.N8N_SERVICE_TOKEN! }), 401, `n8n ${p}`);
      assert.equal(await call(p, "GET", { "x-drsnip-service-token": TOKEN }), 401, `wrong header ${p}`);
    }
  });

  it("compares the token exactly", () => {
    assert.equal(agentTokenOk(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(agentTokenOk(`Bearer ${TOKEN}x`, TOKEN), false);
    assert.equal(agentTokenOk(`bearer ${TOKEN}`, TOKEN), false);
    assert.equal(agentTokenOk(`Bearer ${TOKEN}`, ""), false);
    assert.equal(agentTokenOk(undefined, TOKEN), false);
  });

  it("validates ids before any query (400, not a database error)", async () => {
    process.env.AGENT_API_TOKEN = TOKEN;
    const h = { Authorization: `Bearer ${TOKEN}` };
    assert.equal(await call("/submission?id=1;drop", "GET", h), 400);
    assert.equal(await call("/appointments?chart_id=abc", "GET", h), 400);
    assert.equal(await call("/cohorts?grain=year", "GET", h), 400);
  });
});

describe("agent API queries", () => {
  // The location expression reads one key of the raw payload server side and matches registrations by chart id or
  // email inside its own subquery; it returns only the office location. Everything else is checked without it.
  const strip = (s: string) => s.split(RESOLVED_LOCATION_SQL).join(" LOCATION ").replace(/\s+/g, " ");
  for (const [name, sql] of Object.entries(AGENT_QUERIES)) {
    const s = strip(sql);
    it(`${name}: a LIMIT, read-only, no SELECT *`, () => {
      assert.match(s, /\bLIMIT \d+\b/i);
      assert.doesNotMatch(s, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|COPY|VACUUM)\b/i);
      assert.doesNotMatch(s, /SELECT\s+\*|\.\*\s*(,|FROM)/i);
    });
    it(`${name}: no payload, response body, contact, clinical or insurance field, and no files`, () => {
      assert.doesNotMatch(s, /raw_payload|n8n_response_body|submission_files|\bemail\b|\bphone\b|date_of_birth|insurance|mh_|state_residence|utm_|click_id/i);
    });
  }
  it("no route takes an id in its path", () => {
    for (const p of Object.keys(AGENT_ROUTES)) assert.doesNotMatch(p, /[:/]/);
  });
});
