#!/usr/bin/env node
// Builds the exact text that goes into the n8n "Project Page" Code node, by
// concatenating the tested logic module with the n8n-specific glue.
//
// The point is that the code running in n8n is the code covered by
// api/_test/appointment-sync.test.ts. Hand-copying a subset into the workflow
// is how those two drift apart.
//
//   node lib/sync/build-code-node.mjs          # write the generated file
//   node lib/sync/build-code-node.mjs --check  # fail if it is stale
//
// After regenerating, the new contents must be pasted into the Code node of
// the n8n workflow; nothing syncs it automatically.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MODULE = join(here, "n8n-appointment-sync.code.js");
const GLUE = join(here, "n8n-code-node.glue.js");
export const GENERATED = join(here, "n8n-code-node.generated.js");

export function build() {
  const mod = readFileSync(MODULE, "utf8")
    // The module exports for the test runner; a Code node has no `module`.
    .replace(/\n?if \(typeof module !== "undefined"[\s\S]*$/, "\n");
  const glue = readFileSync(GLUE, "utf8");
  return [
    "// GENERATED FILE — do not edit.",
    "// Built by lib/sync/build-code-node.mjs from:",
    "//   lib/sync/n8n-appointment-sync.code.js  (logic, unit tested)",
    "//   lib/sync/n8n-code-node.glue.js         (n8n wiring)",
    "// Paste the whole file into the n8n workflow's \"Project Page\" Code node.",
    "",
    mod.trimEnd(),
    "",
    glue.trimEnd(),
    "",
  ].join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const built = build();
  if (process.argv.includes("--check")) {
    const current = readFileSync(GENERATED, "utf8");
    if (current !== built) {
      console.error("[build-code-node] STALE: regenerate and re-paste into n8n");
      process.exit(1);
    }
    console.log("[build-code-node] up to date");
  } else {
    writeFileSync(GENERATED, built);
    console.log(`[build-code-node] wrote ${GENERATED} (${built.length} bytes)`);
  }
}
