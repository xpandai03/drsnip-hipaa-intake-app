// Smoke + PHI-safety test for the DrSnip Reporting MCP.
// Runs every tool against the live (read-only role) view and asserts that NO
// output contains any PHI, and that no record-level / SQL / include_pii tool
// exists. Requires DRSNIP_INTAKE_DATABASE_URL set to the drsnip_reporting_ro
// connection (e.g. via `fly proxy 15432:5432 -a drsnip-intake-db`).
import { loadEnv } from "../src/env.js";
import { drsnipTools } from "../src/drsnip-tools.js";
import { activeTools } from "../src/build-server.js";
import { closeDb } from "../src/db.js";

loadEnv();

const FORBIDDEN_TOOLS = [
  "intake_readonly_sql", "readonly_sql", "sql", "intake_list", "drsnip_list",
  "list", "intake_duplicates", "sf_soql",
];
// Substrings that must NEVER appear in any tool output (PHI / identifiers).
const PHI_MARKERS = [
  "first_name", "last_name", "date_of_birth", "raw_payload", "patient_id",
  "n8n_patient_id", "@", "phone", "insurance_id", "street", "mh_", "medicalDetails",
];

let failures = 0;
const fail = (m) => { failures++; console.log("  ✗ FAIL:", m); };
const ok = (m) => console.log("  ✓", m);

function scanForPhi(label, obj) {
  const s = JSON.stringify(obj).toLowerCase();
  const hits = PHI_MARKERS.filter((m) => s.includes(m.toLowerCase()));
  if (hits.length) fail(`${label} output contains forbidden marker(s): ${hits.join(", ")}`);
  else ok(`${label}: no PHI markers in output`);
  return s;
}

async function run() {
  console.log("== tool surface ==");
  const names = activeTools().map((t) => t.name);
  console.log("  tools:", names.join(", "));
  if (names.length !== 6) fail(`expected 6 tools, got ${names.length}`); else ok("exactly 6 tools");
  for (const bad of FORBIDDEN_TOOLS)
    if (names.includes(bad)) fail(`forbidden tool present: ${bad}`);
  ok("no record-level / SQL / include_pii tool present");
  // No tool advertises an include_pii or free-form sql input
  for (const t of drsnipTools) {
    const props = Object.keys(t.inputSchema?.properties || {});
    if (props.includes("include_pii")) fail(`${t.name} advertises include_pii`);
    if (props.includes("sql")) fail(`${t.name} advertises a free-form sql input`);
  }
  ok("no tool exposes include_pii or sql inputs");

  const call = async (name, args) => {
    const t = drsnipTools.find((x) => x.name === name);
    const out = await t.handler(args);
    return out;
  };

  console.log("\n== drsnip_data_notes ==");
  scanForPhi("data_notes", await call("drsnip_data_notes", {}));

  console.log("\n== drsnip_overview ==");
  const ov = await call("drsnip_overview", {});
  console.log("  total:", ov.total_submissions, "| by_form:", JSON.stringify(ov.by_form_type),
    "| by_status:", JSON.stringify(ov.by_sync_status), "| by_action:", JSON.stringify(ov.by_action_label));
  scanForPhi("overview", ov);

  console.log("\n== drsnip_counts (each dimension) ==");
  for (const dim of ["form_type", "n8n_status", "action_label", "office_location", "insurance_coverage", "how_heard", "day", "week", "month"]) {
    const r = await call("drsnip_counts", { dimension: dim, limit: 8 });
    console.log(`  ${dim}:`, JSON.stringify(r.rows));
    scanForPhi(`counts:${dim}`, r);
  }

  console.log("\n== drsnip_outcomes ==");
  const oc = await call("drsnip_outcomes", {});
  console.log("  outcomes:", JSON.stringify(oc.outcomes), "| fail_modes:", JSON.stringify(oc.failure_modes));
  scanForPhi("outcomes", oc);

  console.log("\n== drsnip_returning (split_by_form) ==");
  const rt = await call("drsnip_returning", { split_by_form: true });
  console.log("  rows:", JSON.stringify(rt.rows));
  scanForPhi("returning", rt);

  console.log("\n== drsnip_marketing ==");
  const mk = await call("drsnip_marketing", {});
  console.log("  channels:", JSON.stringify(mk.channels));
  scanForPhi("marketing", mk);

  // Cell-suppression evidence: search all outputs for the "<5" token or confirm
  // all group counts are >=5.
  console.log("\n== cell suppression ==");
  const allOutputs = JSON.stringify([ov, oc, rt, mk]);
  console.log(allOutputs.includes("<5")
    ? "  ✓ suppression active — some group counts rendered as '<5'"
    : "  (no group count < 5 in current data; suppression code is exercised in unit path)");

  console.log(`\n${failures === 0 ? "ALL PHI-SAFETY CHECKS PASSED ✅" : failures + " CHECK(S) FAILED ❌"}`);
  await closeDb().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}
run().catch(async (e) => { console.error("smoke error:", e.message); await closeDb().catch(() => {}); process.exit(2); });
