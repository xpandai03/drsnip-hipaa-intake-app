// Consultation how-heard: "Radio" renamed to "Podcast / Radio" (client request,
// 2026-11-12). The option label is the stored value, so historical rows keep
// "Radio" and reporting folds them into the new bucket at read time. Synthetic
// fixtures only; the live block runs the real tile SQL against a CTE (no
// writes) and is skipped unless HOWHEARD_TEST_DATABASE_URL is set.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { HOW_HEARD } from "../../artifacts/intake-form/src/lib/how-heard";
import {
  HOW_HEARD_LEGACY_ALIASES,
  canonicalHowHeard,
  canonicalHowHeardList,
  howHeardCountsSql,
} from "../_lib/how-heard";
import { sql } from "@workspace/db";

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const requireFromDb = createRequire(createRequire(import.meta.url).resolve("@workspace/db"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PgDialect } = requireFromDb("drizzle-orm/pg-core") as { PgDialect: new () => { sqlToQuery: (q: any) => { sql: string; params: unknown[] } } };

describe("consultation option set", () => {
  it("reads 'Podcast / Radio' where 'Radio' was; every other option unchanged in number and order", () => {
    assert.deepEqual(HOW_HEARD, [
      "Family / Friend",
      "Medical Professional Referral",
      "Facebook",
      "Instagram",
      "Google",
      "AI Search/Assistant",
      "Brochure",
      "Event",
      "Podcast / Radio",
      "TV Commercial",
      "Streaming Ad",
      "Insurance Directory",
      "Magazine Ad",
      "Other",
    ]);
  });
  it("has no option named exactly 'Radio', and 'Other' stays last", () => {
    assert.ok(!HOW_HEARD.includes("Radio"));
    assert.equal(HOW_HEARD[HOW_HEARD.length - 1], "Other");
  });
  it("Consultation.tsx renders the shared list and carries no option literals of its own", () => {
    const src = read("artifacts/intake-form/src/pages/Consultation.tsx");
    assert.match(src, /import \{ HOW_HEARD \} from "@\/lib\/how-heard";/);
    assert.match(src, /options=\{HOW_HEARD\}/);
    assert.doesNotMatch(src, /"Radio"/);
    assert.doesNotMatch(src, /const HOW_HEARD\b/);
  });
  it("registration and insurance forms are untouched by the rename", () => {
    // Registration is Home.tsx.
    for (const f of ["Home.tsx", "Insurance.tsx"]) {
      const src = read(`artifacts/intake-form/src/pages/${f}`);
      assert.doesNotMatch(src, /lib\/how-heard|Podcast \/ Radio/, f);
    }
  });
});

describe("legacy aliases", () => {
  it("every alias target is a live option and no retired value is still offered", () => {
    for (const [from, to] of Object.entries(HOW_HEARD_LEGACY_ALIASES)) {
      assert.ok(HOW_HEARD.includes(to), `${from} → ${to} must target a live option`);
      assert.ok(!HOW_HEARD.includes(from), `${from} is retired`);
    }
    assert.equal(HOW_HEARD_LEGACY_ALIASES.Radio, "Podcast / Radio");
  });
  it("maps 'Radio' and leaves every live option as-is", () => {
    assert.equal(canonicalHowHeard("Radio"), "Podcast / Radio");
    for (const o of HOW_HEARD) assert.equal(canonicalHowHeard(o), o);
    assert.equal(canonicalHowHeard("constructor"), "constructor");
  });
  it("a row holding both the old and new value yields the bucket once, order kept", () => {
    assert.deepEqual(canonicalHowHeardList(["Google", "Radio", "Podcast / Radio"]), ["Google", "Podcast / Radio"]);
    assert.deepEqual(canonicalHowHeardList(["Radio", "Event"]), ["Podcast / Radio", "Event"]);
  });
  it("the CSV export maps how-heard through the aliases", () => {
    const src = read("api/submissions/export.ts");
    assert.match(src, /header: "How Heard About DrSnip", get: rpHowHeard/);
    assert.match(src, /canonicalHowHeardList\(vals\)/);
  });
});

describe("tile SQL", () => {
  const dialect = new PgDialect();
  it("binds alias values as parameters and DISTINCTs per submission", () => {
    const q = dialect.sqlToQuery(howHeardCountsSql(sql`WHERE submissions.form_type = ${"consultation"}`, 500));
    assert.match(q.sql, /SELECT DISTINCT submissions\.id/);
    assert.doesNotMatch(q.sql, /Radio/);
    assert.deepEqual(q.params, ["Radio", "Podcast / Radio", "consultation", 500]);
  });
  it("the counts handler uses the shared builder", () => {
    const src = read("api/reports/counts.ts");
    assert.match(src, /howHeardCountsSql\(where, LIMIT\)/);
  });
});

const URL_ = process.env.HOWHEARD_TEST_DATABASE_URL;
const live = Boolean(URL_ && !/fly\.dev|flycast|drsnip-intake-db/.test(URL_));

describe(`tile SQL against Postgres (${live ? "live" : "skipped without HOWHEARD_TEST_DATABASE_URL"})`, { skip: !live }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c: any;
  const dialect = new PgDialect();
  before(async () => {
    const require_ = createRequire(import.meta.url);
    const { Client } = require_(require_.resolve("pg", { paths: [dirname(require_.resolve("@workspace/db"))] }));
    c = new Client({ connectionString: URL_ });
    await c.connect();
  });
  after(async () => { await c?.end(); });

  it("folds legacy 'Radio' into 'Podcast / Radio', counts a both-values row once, leaves others alone", async () => {
    // A CTE shadows `submissions`, so nothing is written anywhere.
    const fixture = sql`WITH submissions(id, form_type, raw_payload) AS (VALUES
      (1, 'consultation', ${JSON.stringify({ howHeard: ["Radio"] })}::jsonb),
      (2, 'consultation', ${JSON.stringify({ howHeard: ["Radio", "Google"] })}::jsonb),
      (3, 'consultation', ${JSON.stringify({ howHeard: ["Podcast / Radio"] })}::jsonb),
      (4, 'consultation', ${JSON.stringify({ howHeard: ["Radio", "Podcast / Radio"] })}::jsonb),
      (5, 'consultation', ${JSON.stringify({ howHeard: ["Google", "Event"] })}::jsonb),
      (6, 'consultation', ${JSON.stringify({ howHeard: "Radio" })}::jsonb),
      (7, 'registration', ${JSON.stringify({ howHeard: ["Radio"] })}::jsonb)
    )`;
    const q = dialect.sqlToQuery(sql`${fixture} ${howHeardCountsSql(sql`WHERE submissions.form_type = ${"consultation"}`, 500)}`);
    const r = await c.query(q.sql, q.params);
    const got = Object.fromEntries(r.rows.map((x: { value: string; count: number }) => [x.value, x.count]));
    assert.deepEqual(got, { "Podcast / Radio": 4, Google: 2, Event: 1 });
  });
});
