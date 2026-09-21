// The attendance status review: the contract, the guards, and — the part that
// did not exist before — the calculation.
//
// DB-backed assertions run only when ATTENDANCE_TEST_DATABASE_URL points at a
// disposable database carrying migration 0020 and the synthetic fixtures.
//
// It is a DEDICATED variable rather than DATABASE_URL so the suite skips
// cleanly on a database that has not had 0020 applied, instead of failing with
// "relation does not exist" and looking like a broken feature. Never point it
// at production: these tests write drafts and approvals.
//
// Fixtures are entirely invented. No real patient, appointment or status
// history is used anywhere in this file.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

import {
  CLASSIFICATIONS, labelKey, normalizedKey, displayLabel,
  validateLabelSet, validateProvenance, decidedLabels, summariseLabels,
  establishesEvidence,
} from "../../lib/metrics/attendance-contract.js";
import {
  canApproveDefinitions, canEditDefinitionDraft, canPreviewDefinitions, normalizeRole,
} from "../_lib/permissions.js";
import { enforceDefinitionApprover } from "../_lib/auth.js";
import { makeRes } from "./harness.js";

const require_ = createRequire(import.meta.url);
const URL_ = process.env.ATTENDANCE_TEST_DATABASE_URL;
const live = Boolean(URL_ && !/fly\.dev|flycast|drsnip-intake-db/.test(URL_));
function loadPg() {
  const dbEntry = require_.resolve("@workspace/db");
  return require_(require_.resolve("pg", { paths: [dirname(dbEntry)] }));
}
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ===========================================================================
describe("classification contract", () => {
  it("has the five choices, and remote is one of them — not a flag", () => {
    assert.deepEqual([...CLASSIFICATIONS], [
      "physically_present", "remote_presence", "no_arrival_information",
      "explicit_absence", "undecided",
    ]);
  });

  it("only presence classifications establish anything", () => {
    assert.equal(establishesEvidence("physically_present"), true);
    assert.equal(establishesEvidence("remote_presence"), true);
    // Explicit absence is STORED but drives no published figure yet.
    assert.equal(establishesEvidence("explicit_absence"), false);
    assert.equal(establishesEvidence("no_arrival_information"), false);
    assert.equal(establishesEvidence("undecided"), false);
  });

  it("rejects a remote_presence FLAG — the contradiction is unrepresentable", () => {
    const r = validateLabelSet([{
      source_column: "transition", raw_label: "Checked In Online",
      classification: "physically_present", procedure_signal: false,
      remote_presence: true,
    }]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /classification, not a flag/);
  });

  it("rejects unknown classifications and source columns", () => {
    for (const bad of [
      { source_column: "transition", raw_label: "x", classification: "arrival_confirmed", procedure_signal: false },
      { source_column: "status", raw_label: "x", classification: "undecided", procedure_signal: false },
      { source_column: "transition", raw_label: 7, classification: "undecided", procedure_signal: false },
      { source_column: "transition", raw_label: "x", classification: "undecided", procedure_signal: "yes" },
    ]) {
      assert.equal(validateLabelSet([bad]).ok, false, JSON.stringify(bad));
    }
  });

  it("accepts null as a label and rejects a duplicate of it", () => {
    assert.equal(validateLabelSet([
      { source_column: "current_status", raw_label: null, classification: "undecided", procedure_signal: false },
    ]).ok, true);
    assert.equal(validateLabelSet([
      { source_column: "current_status", raw_label: null, classification: "undecided", procedure_signal: false },
      { source_column: "current_status", raw_label: null, classification: "physically_present", procedure_signal: false },
    ]).ok, false);
  });
});

describe("label identity", () => {
  it("NULL and empty string are different labels", () => {
    assert.notEqual(labelKey(null), labelKey(""));
    assert.notEqual(displayLabel(null), displayLabel(""));
  });

  it("a label spelled like the null sentinel cannot collide with it", () => {
    assert.notEqual(labelKey("\u0001null"), labelKey(null));
  });

  it("near-duplicates group but do not merge", () => {
    assert.equal(normalizedKey("MD  In"), normalizedKey("md in"));
    // Same normalised key, DIFFERENT identity: each is classified on its own.
    assert.notEqual(labelKey("MD  In"), labelKey("MD In"));
  });

  it("the TypeScript and SQL key derivations agree by construction", () => {
    // Both map NULL to \x01null and prefix real values with 'v:'. If one side
    // changes, this pins the other.
    const sql = read("../../lib/db/migrations/0020_attendance_review.sql");
    assert.match(sql, /E'\\\\x01null' ELSE 'v:' \|\| raw_label/);
    assert.equal(labelKey(null), "\u0001null");
    assert.equal(labelKey("Arrived"), "v:Arrived");
  });
});

describe("approval provenance is required, in full", () => {
  const good = {
    confirmed_by_name: "A Person", confirmed_by_role: "Practice owner",
    confirmed_via: "video_call", confirmed_on: "2026-09-20", confirmed_scope: "Whole practice",
  };
  it("accepts a complete record", () => assert.equal(validateProvenance(good).ok, true));

  it("refuses each missing field", () => {
    for (const k of Object.keys(good)) {
      const bad = { ...good, [k]: "" };
      assert.equal(validateProvenance(bad).ok, false, k);
    }
    assert.equal(validateProvenance(null).ok, false);
    assert.equal(validateProvenance({ ...good, confirmed_via: "telepathy" }).ok, false);
  });

  it("refuses a confirmation dated in the future", () => {
    const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    assert.equal(validateProvenance({ ...good, confirmed_on: future }).ok, false);
  });

  it("trims rather than accepting whitespace as a name", () => {
    assert.equal(validateProvenance({ ...good, confirmed_by_name: "   " }).ok, false);
  });
});

describe("undecided is the absence of a decision", () => {
  const set = [
    { source_column: "transition" as const, raw_label: "Arrived", classification: "physically_present" as const, procedure_signal: false },
    { source_column: "transition" as const, raw_label: "Complete", classification: "undecided" as const, procedure_signal: true },
  ];
  it("is never stored on an approval", () => {
    assert.deepEqual(decidedLabels(set).map((l) => l.raw_label), ["Arrived"]);
  });
  it("is counted for the reviewer", () => {
    assert.equal(summariseLabels(set).undecided, 1);
  });
});

// ===========================================================================
describe("permissions: approval is not inherited from admin", () => {
  it("an ordinary admin cannot approve", () => {
    assert.equal(canApproveDefinitions({ role: "admin", canApproveDefinitions: false }), false);
    assert.equal(canEditDefinitionDraft("admin"), true);
    assert.equal(canPreviewDefinitions("admin"), true);
  });

  it("an admin with the capability can", () => {
    assert.equal(canApproveDefinitions({ role: "admin", canApproveDefinitions: true }), true);
  });

  it("a viewer can do none of it", () => {
    assert.equal(canApproveDefinitions({ role: "viewer", canApproveDefinitions: true }), false);
    assert.equal(canEditDefinitionDraft("viewer"), false);
    assert.equal(canPreviewDefinitions("viewer"), false);
  });

  it("FAILS CLOSED for a malformed or unknown role or capability", () => {
    // normalizeRole resolves junk to 'admin' — deliberate, migration 0007 — so
    // the capability is the thing that must not default open.
    assert.equal(normalizeRole("wizard"), "admin");
    for (const cap of [undefined, null, "true", 1, {}, "yes"]) {
      assert.equal(canApproveDefinitions({ role: "wizard", canApproveDefinitions: cap }), false, String(cap));
    }
  });

  it("the guard writes 401 with no session and 403 for an unauthorised admin", () => {
    const noSession = makeRes();
    assert.equal(enforceDefinitionApprover(null, noSession), false);
    assert.equal(noSession.statusCode, 401);

    const plainAdmin = makeRes();
    const auth = {
      session: {} as never,
      user: { id: "u", email: "a@b.c", name: "A", isActive: true, role: "admin" as const, canApproveDefinitions: false },
    };
    assert.equal(enforceDefinitionApprover(auth, plainAdmin), false);
    assert.equal(plainAdmin.statusCode, 403);

    const approver = makeRes();
    assert.equal(
      enforceDefinitionApprover({ ...auth, user: { ...auth.user, canApproveDefinitions: true } }, approver),
      true,
    );
  });
});

// ===========================================================================
describe("routes are registered and guarded", () => {
  const server = read("../../api-server/index.ts");

  it("every handler under api/reports and api/attendance-mapping is wired", () => {
    for (const dir of ["../reports/", "../attendance-mapping/"]) {
      const base = dir === "../reports/" ? "/api/reports/" : "/api/attendance-mapping/";
      for (const f of readdirSync(new URL(dir, import.meta.url))) {
        if (!f.endsWith(".ts")) continue;
        const name = f.replace(/\.ts$/, "");
        assert.ok(server.includes(`"${base}${name}"`), `${dir}${f} is not registered`);
      }
    }
  });

  it("approve and withdraw use the approver guard, not requireAdmin", () => {
    for (const f of ["../attendance-mapping/approve.ts", "../attendance-mapping/withdraw.ts"]) {
      const src = read(f);
      assert.match(src, /requireDefinitionApprover\(req, res\)/, f);
      assert.ok(!/requireAdmin\(/.test(src), `${f} must not gate on requireAdmin`);
    }
  });

  it("draft and preview enforce their own gate server-side", () => {
    assert.match(read("../attendance-mapping/draft.ts"), /canEditDefinitionDraft\(auth\.user\.role\)/);
    assert.match(read("../attendance-mapping/preview.ts"), /canPreviewDefinitions\(auth\.user\.role\)/);
  });

  it("the published metric never accepts classifications from the caller", () => {
    const src = read("../reports/attendance.ts");
    assert.match(src, /drsnip_attendance_metric\(/);
    // It must not read a label set from the request, and must not reach the
    // preview function, which is the one that takes classifications.
    assert.ok(!/req\.(body|query)[^\n]*labels/.test(src), "the published route reads labels from the request");
    assert.ok(!/drsnip_attendance_preview/.test(src), "the published route calls the preview function");
    assert.ok(!/validateLabelSet/.test(src));
  });

  it("no route emits a rate or a patient-level non-attendance figure", () => {
    for (const f of ["../reports/attendance.ts", "../attendance-mapping/preview.ts"]) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // Response FIELDS, not prose. `no_rate` is a note explaining the absence.
      assert.ok(!/\b(rate|percent|pct|did_not_attend|no_show_rate)\s*:/.test(src), f);
    }
  });
});

// ===========================================================================
describe("the calculation (skipped without a disposable database)", () => {
  let pool: { query: (q: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> };

  const ALL = "2026-07-01";
  const TO = "2026-09-25";
  const call = async (labels: unknown, window = 14) =>
    (await pool.query(
      `SELECT * FROM drsnip_attendance_evidence($1::jsonb, 'attendance_registration', $2::date, $3::date, $4::int)`,
      [JSON.stringify(labels), ALL, TO, window],
    )).rows[0];

  before(async () => {
    if (!live) return;
    const { Pool } = loadPg();
    pool = new Pool({ connectionString: URL_, max: 2 });
  });
  after(async () => { if (live && pool) await pool.end(); });

  it("with nothing classified, nothing is established and nothing is inferred",
    { skip: !live }, async () => {
    const r = await call([]);
    assert.equal(Number(r.arrived_in_window), 0);
    assert.equal(Number(r.arrived_untimed), 0);
    assert.equal(Number(r.arrived_outside), 0);
    // Everyone eligible lands in "not established" — NOT in a non-attendance count.
    assert.equal(Number(r.not_established), Number(r.eligible));
  });

  it("classifying EVERY label 'no arrival information' changes nothing",
    { skip: !live }, async () => {
    const labels = (await pool.query(
      `SELECT source_column, raw_label FROM attendance_status_labels`)).rows
      .map((l) => ({ ...l, classification: "no_arrival_information", procedure_signal: false }));
    const none = await call([]);
    const all = await call(labels);
    // The headline safety property: "tells us nothing" cannot become
    // "did not attend", and cannot become an arrival either.
    assert.deepEqual(
      { w: all.arrived_in_window, u: all.arrived_untimed, n: all.not_established },
      { w: none.arrived_in_window, u: none.arrived_untimed, n: none.not_established },
    );
  });

  it("a timed transition places arrival in the window", { skip: !live }, async () => {
    const r = await call([
      { source_column: "transition", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
    ]);
    assert.ok(Number(r.arrived_in_window) > 0);
  });

  it("current-status-only evidence does NOT fabricate an arrival time",
    { skip: !live }, async () => {
    const r = await call([
      { source_column: "current_status", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
    ]);
    // It is real evidence, and it is untimed. A scheduled time is not proof of
    // when somebody walked in, so it never enters the windowed count.
    assert.equal(Number(r.arrived_in_window), 0);
    assert.ok(Number(r.arrived_untimed) > 0);
  });

  it("an arrival later cancelled still counts as an arrival", { skip: !live }, async () => {
    const withArrival = await call([
      { source_column: "transition", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
    ]);
    const alsoCancelled = await call([
      { source_column: "transition", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
      { source_column: "transition", raw_label: "Cancelled", classification: "explicit_absence", procedure_signal: false },
      { source_column: "current_status", raw_label: "Cancelled", classification: "explicit_absence", procedure_signal: false },
    ]);
    // Classifying the cancellation must not take the arrival away.
    assert.equal(alsoCancelled.arrived_in_window, withArrival.arrived_in_window);
  });

  it("evidence on a deleted record is kept, and counted separately",
    { skip: !live }, async () => {
    const r = await call([
      { source_column: "transition", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
    ]);
    assert.ok(Number(r.in_window_deleted_only) > 0);
  });

  it("remote presence never counts as physical arrival", { skip: !live }, async () => {
    const physicalOnly = await call([
      { source_column: "transition", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
    ]);
    const plusRemote = await call([
      { source_column: "transition", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
      { source_column: "transition", raw_label: "Checked In Online", classification: "remote_presence", procedure_signal: false },
    ]);
    assert.equal(plusRemote.arrived_in_window, physicalOnly.arrived_in_window);
    assert.ok(Number(plusRemote.remote_only) > 0, "remote evidence is reported on its own");
  });

  it("classifying remote as PHYSICAL would count it — proving the classes differ",
    { skip: !live }, async () => {
    const asRemote = await call([
      { source_column: "transition", raw_label: "Checked In Online", classification: "remote_presence", procedure_signal: false },
    ]);
    const asPhysical = await call([
      { source_column: "transition", raw_label: "Checked In Online", classification: "physically_present", procedure_signal: false },
    ]);
    assert.equal(Number(asRemote.arrived_in_window), 0);
    assert.ok(Number(asPhysical.arrived_in_window) > 0);
  });

  it("NULL and empty-string statuses are classified independently",
    { skip: !live }, async () => {
    const nullOnly = await call([
      { source_column: "current_status", raw_label: null, classification: "physically_present", procedure_signal: false },
    ]);
    const emptyOnly = await call([
      { source_column: "current_status", raw_label: "", classification: "physically_present", procedure_signal: false },
    ]);
    const both = await call([
      { source_column: "current_status", raw_label: null, classification: "physically_present", procedure_signal: false },
      { source_column: "current_status", raw_label: "", classification: "physically_present", procedure_signal: false },
    ]);
    // Different patients, so classifying both is strictly more than either.
    assert.ok(Number(both.arrived_untimed) > Number(nullOnly.arrived_untimed));
    assert.ok(Number(both.arrived_untimed) > Number(emptyOnly.arrived_untimed));
    assert.equal(
      Number(both.arrived_untimed),
      Number(nullOnly.arrived_untimed) + Number(emptyOnly.arrived_untimed),
    );
  });

  it("a near-duplicate label is NOT matched by its twin", { skip: !live }, async () => {
    // The fixture records "MD  In" (two spaces). Classifying "MD In" must not
    // pick it up: silent merging is what this refuses to do.
    const twin = await call([
      { source_column: "transition", raw_label: "MD In", classification: "physically_present", procedure_signal: false },
    ]);
    const exact = await call([
      { source_column: "transition", raw_label: "MD  In", classification: "physically_present", procedure_signal: false },
    ]);
    assert.equal(Number(twin.arrived_in_window) + Number(twin.arrived_untimed), 0);
    assert.ok(Number(exact.arrived_in_window) > 0);
  });

  it("a patient with several appointments counts once", { skip: !live }, async () => {
    const r = await call([
      { source_column: "transition", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
    ]);
    const sum = Number(r.arrived_in_window) + Number(r.arrived_untimed)
              + Number(r.arrived_outside) + Number(r.not_established);
    assert.equal(sum, Number(r.eligible), "buckets are mutually exclusive over the eligible cohort");
  });

  it("immature and uncovered patients are excluded, not counted as absences",
    { skip: !live }, async () => {
    const r = await call([]);
    assert.ok(Number(r.immature) > 0, "the fixture has immature patients");
    assert.ok(Number(r.cohort_total) > Number(r.cohort_covered), "and uncovered ones");
    assert.equal(Number(r.eligible) + Number(r.immature), Number(r.cohort_covered));
  });

  it("the window matters: a wider window moves outside-arrivals inside",
    { skip: !live }, async () => {
    const labels = [
      { source_column: "transition", raw_label: "Checked In", classification: "physically_present", procedure_signal: false },
    ];
    const w14 = await call(labels, 14);
    const w30 = await call(labels, 30);
    assert.ok(Number(w14.arrived_outside) > 0);
    assert.ok(Number(w30.arrived_in_window) >= Number(w14.arrived_in_window));
  });
});

// ===========================================================================
describe("lifecycle guarantees enforced by the database", () => {
  let pool: { query: (q: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> };
  before(async () => {
    if (!live) return;
    const { Pool } = loadPg();
    pool = new Pool({ connectionString: URL_, max: 2 });
    await pool.query(`DELETE FROM attendance_review_audit`);
    await pool.query(`DELETE FROM attendance_mappings`);
    // An approver has to exist: the provenance CHECK requires a real user id,
    // which is the point — an approval with no accountable account is refused.
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role, can_approve_definitions)
       VALUES ('approver@example.invalid', 'x', 'Test Approver', 'admin', true)
       ON CONFLICT (email) DO NOTHING`);
  });
  after(async () => {
    if (!live || !pool) return;
    await pool.query(`DELETE FROM attendance_review_audit`);
    await pool.query(`DELETE FROM attendance_mappings`);
    await pool.query(`DELETE FROM users WHERE email = 'approver@example.invalid'`);
    await pool.end();
  });

  it("an approved row without provenance is refused by a CHECK", { skip: !live }, async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO attendance_mappings (scope, state, version, labels) VALUES ('practice','approved',1,'[]'::jsonb)`),
      /provenance_check/,
    );
  });

  it("two approved mappings for one scope are impossible", { skip: !live }, async () => {
    const ok = `INSERT INTO attendance_mappings
      (scope, state, version, labels, approved_at, confirmed_by_name, confirmed_by_role,
       confirmed_via, confirmed_on, confirmed_scope, approved_by_user_id)
      VALUES ('practice','approved',$1,'[]'::jsonb, now(),'N','R','call',current_date,'all',
              (SELECT id FROM users WHERE email = 'approver@example.invalid'))`;
    await pool.query(ok, [1]);
    await assert.rejects(() => pool.query(ok, [2]), /attendance_mappings_one_approved_idx/);
    await pool.query(`DELETE FROM attendance_mappings`);
  });

  it("two drafts for one scope are impossible", { skip: !live }, async () => {
    await pool.query(`INSERT INTO attendance_mappings (scope, state, labels) VALUES ('practice','draft','[]'::jsonb)`);
    await assert.rejects(
      () => pool.query(`INSERT INTO attendance_mappings (scope, state, labels) VALUES ('practice','draft','[]'::jsonb)`),
      /attendance_mappings_one_draft_idx/,
    );
    await pool.query(`DELETE FROM attendance_mappings`);
  });

  it("a stale revision update writes nothing", { skip: !live }, async () => {
    const ins = await pool.query(
      `INSERT INTO attendance_mappings (scope, state, labels) VALUES ('practice','draft','[]'::jsonb) RETURNING id, revision`);
    const id = ins.rows[0].id as string;
    await pool.query(`UPDATE attendance_mappings SET revision = revision + 1 WHERE id = $1`, [id]);
    const stale = await pool.query(
      `UPDATE attendance_mappings SET labels = '[{"x":1}]'::jsonb WHERE id = $1 AND revision = $2 RETURNING id`,
      [id, 1]);
    assert.equal(stale.rows.length, 0, "the optimistic check is what makes 409 correct");
    await pool.query(`DELETE FROM attendance_mappings`);
  });

  it("published attendance is 'unapproved' while only a draft exists",
    { skip: !live }, async () => {
    await pool.query(
      `INSERT INTO attendance_mappings (scope, state, labels) VALUES ('practice','draft',
       '[{"source_column":"transition","raw_label":"Checked In","classification":"physically_present","procedure_signal":false}]'::jsonb)`);
    const r = await pool.query(
      `SELECT status, arrived_in_window FROM drsnip_attendance_metric('attendance_registration','2026-07-01'::date,'2026-09-25'::date,14)`);
    assert.equal(r.rows[0].status, "unapproved");
    assert.equal(r.rows[0].arrived_in_window, null);
    await pool.query(`DELETE FROM attendance_mappings`);
  });

  it("preview and publication agree exactly for the same labels",
    { skip: !live }, async () => {
    const labels = `[{"source_column":"transition","raw_label":"Checked In","classification":"physically_present","procedure_signal":false}]`;
    await pool.query(
      `INSERT INTO attendance_mappings
        (scope, state, version, labels, approved_at, confirmed_by_name, confirmed_by_role,
         confirmed_via, confirmed_on, confirmed_scope, approved_by_user_id)
       VALUES ('practice','approved',1,$1::jsonb, now(),'N','R','call',current_date,'all',
               (SELECT id FROM users WHERE email = 'approver@example.invalid'))`, [labels]);

    const published = (await pool.query(
      `SELECT * FROM drsnip_attendance_metric('attendance_registration','2026-07-01'::date,'2026-09-25'::date,14)`)).rows[0];
    const preview = (await pool.query(
      `SELECT * FROM drsnip_attendance_preview($1::jsonb,'attendance_registration','2026-07-01'::date,'2026-09-25'::date,14)`,
      [labels])).rows[0];

    // One calculation. The preview differs only in how it protects the answer:
    // the published exact figure must fall inside the previewed band.
    const exact = Number(published.arrived_in_window);
    assert.ok(exact >= Number(preview.in_window_low) && exact <= Number(preview.in_window_high),
      `published ${exact} outside band ${preview.in_window_low}-${preview.in_window_high}`);
    assert.equal(Number(published.eligible), Number(preview.eligible));
    assert.equal(String(published.evidence_as_of), String(preview.evidence_as_of));
    await pool.query(`DELETE FROM attendance_mappings`);
  });

  it("a small bucket cannot be recovered by subtracting from the cohort",
    { skip: !live }, async () => {
    // THE FOUR BUCKETS ARE A PARTITION: they sum exactly to `eligible`, so
    // withholding one small cell protects nothing — subtract the other three.
    // (The status inventory is the mirror image: its rows OVERLAP, so partition
    // treatment there would be theatre. The two need opposite primitives.)
    const labels = `[{"source_column":"transition","raw_label":"Checked In","classification":"physically_present","procedure_signal":false},
                     {"source_column":"current_status","raw_label":"Roomed","classification":"physically_present","procedure_signal":false}]`;
    await pool.query(`DELETE FROM attendance_mappings`);
    await pool.query(
      `INSERT INTO attendance_mappings
        (scope, state, version, labels, approved_at, confirmed_by_name, confirmed_by_role,
         confirmed_via, confirmed_on, confirmed_scope, approved_by_user_id)
       VALUES ('practice','approved',1,$1::jsonb, now(),'N','R','call',current_date,'all',
               (SELECT id FROM users WHERE email = 'approver@example.invalid'))`, [labels]);

    const truth = (await pool.query(
      `SELECT * FROM drsnip_attendance_evidence($1::jsonb,'attendance_registration','2026-07-01'::date,'2026-09-25'::date,14)`,
      [labels])).rows[0];
    const pub = (await pool.query(
      `SELECT * FROM drsnip_attendance_metric('attendance_registration','2026-07-01'::date,'2026-09-25'::date,14)`)).rows[0];

    // The fixture deliberately puts exactly 3 patients in the untimed bucket.
    assert.equal(Number(truth.arrived_untimed), 3, "fixture no longer produces a small cell");

    const buckets = ["arrived_in_window", "arrived_untimed", "arrived_outside", "not_established"];
    const hidden = buckets.filter((k) => pub[k] === null);
    assert.ok(hidden.includes("arrived_untimed"), "the small cell must be withheld");
    assert.ok(hidden.length >= 2,
      "one withheld cell is recoverable from the cohort; at least two must be withheld");

    // And prove it concretely: what is published cannot pin the small value.
    const shown = buckets.filter((k) => pub[k] !== null).reduce((a, k) => a + Number(pub[k]), 0);
    const residual = Number(pub.eligible) - shown;
    assert.notEqual(residual, Number(truth.arrived_untimed),
      "the residual equals the withheld cell — it is recoverable");
    await pool.query(`DELETE FROM attendance_mappings`);
  });

  it("no attendance rate is returned by any published field", { skip: !live }, async () => {
    const cols = (await pool.query(
      `SELECT * FROM drsnip_attendance_metric('attendance_registration','2026-07-01'::date,'2026-09-25'::date,14)`)).rows[0];
    for (const k of Object.keys(cols)) {
      assert.ok(!/rate|percent|pct/.test(k), `published column ${k} looks like a rate`);
    }
  });

  it("the preview never returns an exact count", { skip: !live }, async () => {
    const r = (await pool.query(
      `SELECT * FROM drsnip_attendance_preview('[]'::jsonb,'attendance_registration','2026-07-01'::date,'2026-09-25'::date,14)`)).rows[0];
    if (r.status === "banded") {
      assert.equal(Number(r.in_window_high) - Number(r.in_window_low), Number(r.band_width) - 1);
      assert.equal(Number(r.in_window_low) % Number(r.band_width), 0);
    }
  });

  it("a cohort too small to band is withheld outright", { skip: !live }, async () => {
    // A one-day period nobody registered in.
    const r = (await pool.query(
      `SELECT * FROM drsnip_attendance_preview('[]'::jsonb,'attendance_registration','2026-07-02'::date,'2026-07-03'::date,14)`)).rows[0];
    assert.equal(r.status, "withheld_small_cohort");
    assert.equal(r.in_window_low, null);
  });

  it("the inventory suppresses small cells and publishes no total",
    { skip: !live }, async () => {
    const rows = (await pool.query(`SELECT * FROM drsnip_status_inventory()`)).rows;
    assert.ok(rows.length > 0);
    for (const r of rows) {
      if (r.appointments !== null) assert.ok(Number(r.appointments) >= 5, String(r.raw_label));
      // A withheld row withholds its other counts too, so the row gives nothing.
      if (r.appointments === null) {
        assert.equal(r.offices, null);
        assert.equal(r.providers, null);
      }
    }
    // Rows overlap, so there is no total to difference them against.
    assert.ok(!Object.keys(rows[0]).includes("total"));
  });

  it("the inventory keeps NULL and empty string apart", { skip: !live }, async () => {
    const rows = (await pool.query(
      `SELECT raw_label, is_null_label FROM drsnip_status_inventory() WHERE source_column = 'current_status'`)).rows;
    assert.ok(rows.some((r) => r.is_null_label === true), "a NULL status row exists");
    assert.ok(rows.some((r) => r.raw_label === ""), "an empty-string status row exists, separately");
  });
});
