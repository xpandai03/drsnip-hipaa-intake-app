#!/usr/bin/env node
// Fails (exit 1) unless the production SPA bundle has conversion tracking
// compiled ON. Two independent signals must agree:
//   1. the build-state literal from lib/conversion.ts is the ENABLED one; and
//   2. the sender's compiled guard (`function X(){return!0}` next to
//      "intake_conversion") is not folded to `return!1`.
// Why: the flag is inlined at build time; a deploy without the build arg used
// to produce a working-looking app that silently never sent the event.
// Usage: node scripts/assert-conversion-bundle.mjs [--self-test] [assetsDir]
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = "drsnip-conversion-build:enabled";
const DISABLED = "drsnip-conversion-build:disabled";

export function checkBundle(js) {
  const problems = [];
  if (!js.includes('"intake_conversion"')) problems.push("conversion sender not found in bundle");
  if (!js.includes(ENABLED)) problems.push(`build-state literal "${ENABLED}" missing`);
  if (js.includes(DISABLED)) problems.push(`build-state literal "${DISABLED}" present`);
  const i = js.indexOf('"intake_conversion"');
  if (i >= 0) {
    const m = /function \w+\(\)\{return(!0|!1)\}/.exec(js.slice(i, i + 400));
    if (m && m[1] === "!1") problems.push("sender guard compiled to constant false (return!1)");
  }
  return problems;
}

function selfTest() {
  const folded = `const a="intake_conversion",b=["https://drsnip.com"];function L(){return!1}function k(e){if(!L())return}document.documentElement.setAttribute("data-drsnip-conversion","${DISABLED}")`;
  const enabled = `const a="intake_conversion",b=["https://drsnip.com"];function L(){return!0}function k(e){if(!L())return}document.documentElement.setAttribute("data-drsnip-conversion","${ENABLED}")`;
  const f = checkBundle(folded), e = checkBundle(enabled);
  if (f.length === 0) { console.error("assert-conversion-bundle self-test FAILED: a folded bundle passed"); process.exit(1); }
  if (e.length !== 0) { console.error("assert-conversion-bundle self-test FAILED: an enabled bundle was rejected: " + e.join("; ")); process.exit(1); }
  console.log(`assert-conversion-bundle self-test ok (folded bundle rejected: ${f.length} problems)`);
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--self-test")) { selfTest(); process.exit(0); }
const dir = args[0] ?? join(here, "../artifacts/intake-form/dist/public/assets");
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
const all = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
const problems = checkBundle(all);
if (problems.length) {
  console.error("CONVERSION TRACKING IS COMPILED OFF in this build:\n  - " + problems.join("\n  - ") +
    "\nSet VITE_CONVERSION_TRACKING_ENABLED=true as a BUILD arg (fly.toml [build.args]); a Fly secret does not work.");
  process.exit(1);
}
console.log(`conversion tracking compiled ON (${files.length} JS assets checked)`);
