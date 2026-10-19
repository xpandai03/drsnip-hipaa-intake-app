// Unclassified-appointment export — IDs only, admin only, ledgered, and the
// same rows the page counts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import {
  UNCLASSIFIED_COLUMNS, UNCLASSIFIED_SQL, UNCLASSIFIED_COUNT_SQL,
  buildUnclassifiedCsv, drchronoAppointmentLink,
} from "../_lib/unclassified-export";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const code = (src: string) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("columns and content", () => {
  it("has exactly the eight columns, in order", () => {
    assert.deepEqual([...UNCLASSIFIED_COLUMNS], [
      "appointment_id", "chart_id", "appointment_date", "appointment_status",
      "form_type", "form_month", "patient_has_other_converted_appt", "drchrono_link",
    ]);
  });
  it("reads no identifying or free-text field", () => {
    for (const f of ["first_name", "last_name", "email", "phone", "date_of_birth", "raw_payload", "reason", "notes", "clinical"]) {
      assert.ok(!UNCLASSIFIED_SQL.includes(f), `${f} must not appear in the export query`);
    }
  });
  it("lists the rows that move the numbers first, then by date, and skips deleted appointments", () => {
    assert.match(UNCLASSIFIED_SQL, /ORDER BY \(c\.patient_source_id IS NOT NULL\), u\.scheduled_time NULLS LAST/);
    assert.match(UNCLASSIFIED_SQL, /deleted_flag IS NOT TRUE/);
    assert.match(UNCLASSIFIED_SQL, /WHERE u\.cls = 'unclassified'/);
    assert.match(UNCLASSIFIED_COUNT_SQL, /\$\{UNCLASSIFIED_SQL\}|WITH x AS/);
  });
  it("builds a CSV with a header, escaping, and the DrChrono link", () => {
    const csv = buildUnclassifiedCsv([
      { appointment_id: "123", chart_id: "456", appointment_date: "2026-08-03", appointment_status: "blank",
        form_type: "registration", form_month: "2026-07", patient_has_other_converted_appt: "no" },
      { appointment_id: "124", chart_id: "457", appointment_date: null, appointment_status: 'MD "In", room',
        form_type: "none", form_month: "", patient_has_other_converted_appt: "yes" },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    assert.equal(lines[0], UNCLASSIFIED_COLUMNS.join(","));
    assert.equal(lines[1], "123,456,2026-08-03,blank,registration,2026-07,no,https://app.drchrono.com/appointments/123/");
    assert.equal(lines[2], '124,457,,"MD ""In"", room",none,,yes,https://app.drchrono.com/appointments/124/');
    assert.equal(drchronoAppointmentLink("9"), "https://app.drchrono.com/appointments/9/");
  });
});

describe("access, logging and the link", () => {
  const H = code(read("../admin/unclassified-csv.ts"));
  const C = code(read("../reports/unclassified-count.ts"));
  const SERVER = read("../../api-server/index.ts");
  const PAGE = code(read("../../artifacts/intake-form/src/pages/admin/Conversion.tsx"));
  it("both endpoints are admin-only and time-boxed", () => {
    for (const s of [H, C]) {
      assert.match(s, /requireAdmin\(req, res\)/);
      assert.match(s, /reportQuery/);
      assert.ok(!/\bdb\.execute\b/.test(s));
    }
  });
  it("logs each download with the user id and row count, no content", () => {
    assert.match(H, /kind: "export_unclassified"/);
    assert.match(H, /detail: `user=\$\{auth\.user\.id\} rows=\$\{rows\.length\}`/);
    assert.ok(!/auth\.user\.email/.test(H), "never an address");
  });
  it("is served as a download, never cached", () => {
    assert.match(H, /text\/csv/);
    assert.match(H, /attachment; filename=/);
    assert.match(H, /no-store/);
  });
  it("the CSV route is registered before the SPA fallback", () => {
    const i = SERVER.indexOf('"/admin/conversion/unclassified.csv"');
    assert.ok(i > 0 && i < SERVER.indexOf('serveStatic({ root: STATIC_ROOT })'));
  });
  it("the page shows the link and count to admins only, beside the toggles", () => {
    assert.match(PAGE, /\{isAdmin && <UnclassifiedExport \/>\}/);
    assert.match(PAGE, /Download unclassified appointments \(CSV\)/);
    assert.match(PAGE, /\/api\/reports\/unclassified-count/);
    assert.ok(PAGE.indexOf("<UnclassifiedExport />") > PAGE.indexOf('testPrefix="grain"'));
  });
});

const OWNER = process.env.CONVERSION_TEST_DATABASE_URL;
const live = Boolean(OWNER && !/fly\.dev|flycast|drsnip-intake-db/.test(OWNER));
function loadPg() {
  const require_ = createRequire(import.meta.url);
  return require_(require_.resolve("pg", { paths: [dirname(require_.resolve("@workspace/db"))] }));
}

describe(`against Postgres (${live ? "live" : "skipped without CONVERSION_TEST_DATABASE_URL"})`, { skip: !live }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c: any;
  before(async () => {
    const { Client } = loadPg();
    c = new Client({ connectionString: OWNER });
    await c.connect();
    await c.query("BEGIN");
    await c.query(`DELETE FROM appointment_status_transitions; DELETE FROM appointment_snapshots; DELETE FROM submissions;`);
    const sub = (pid: string, form: string, at: string) => c.query(
      `INSERT INTO submissions (form_type, first_name, last_name, email, phone, raw_payload, n8n_status, n8n_patient_id, created_at)
       VALUES ($1,'T','T','t@example.invalid','0','{}'::jsonb,'success',$2::bigint,$3::timestamptz)`, [form, pid, at]);
    const appt = (id: string, pid: string, status: string, when: string, deleted = false) => c.query(
      `INSERT INTO appointment_snapshots (source_appointment_id, patient_source_id, source_created_at, scheduled_time, source_updated_at, current_status, deleted_flag)
       VALUES ($1,$2,$4::timestamptz,$4::timestamptz,$4::timestamptz,$3,$5)`, [id, pid, status, when, deleted]);
    await sub("9300001", "registration", "2026-07-10T18:00:00Z");
    await sub("9300001", "insurance", "2026-06-10T18:00:00Z");   // both forms -> registration
    await sub("9300002", "insurance", "2026-08-10T18:00:00Z");
    await appt("u1", "9300001", "", "2026-08-20T10:00:00Z");      // blank, no converted on chart -> "no"
    await appt("u2", "9300002", "Arrived", "2026-08-05T10:00:00Z"); // unclassified, chart has a converted one -> "yes"
    await appt("c2", "9300002", "Complete", "2026-08-06T10:00:00Z");
    await appt("u3", "9300003", "", "2026-07-01T10:00:00Z");      // no linked form -> none, "no"
    await appt("d1", "9300003", "", "2026-07-02T10:00:00Z", true); // deleted: not listed
    await appt("n1", "9300003", "No Show", "2026-07-03T10:00:00Z"); // not unclassified: not listed
  });
  after(async () => { await c?.query("ROLLBACK"); await c?.end(); });

  it("lists exactly the unclassified live appointments, 'no' rows first, then by date", async () => {
    const r = (await c.query(UNCLASSIFIED_SQL)).rows;
    assert.deepEqual(r.map((x: { appointment_id: string }) => x.appointment_id), ["u3", "u1", "u2"]);
    const u1 = r.find((x: { appointment_id: string }) => x.appointment_id === "u1");
    assert.deepEqual(u1, { appointment_id: "u1", chart_id: "9300001", appointment_date: "2026-08-20", appointment_status: "blank",
      form_type: "registration", form_month: "2026-07", patient_has_other_converted_appt: "no" });
    const u3 = r.find((x: { appointment_id: string }) => x.appointment_id === "u3");
    assert.equal(u3.form_type, "none");
    assert.equal(u3.form_month, "");
    const u2 = r.find((x: { appointment_id: string }) => x.appointment_id === "u2");
    assert.equal(u2.appointment_status, "Arrived");
    assert.equal(u2.patient_has_other_converted_appt, "yes");
    assert.equal(u2.form_type, "insurance");
  });

  it("the count is the file's row count", async () => {
    const n = (await c.query(UNCLASSIFIED_COUNT_SQL)).rows[0];
    assert.deepEqual({ rows: n.rows, no: n.no_other_converted }, { rows: 3, no: 2 });
  });
});
