// Copies lib/n8n/pdf-unicode.block.js verbatim into every n8n PDF node file
// between its BEGIN/END markers. api/_test/pdf-unicode.test.ts fails if a node
// file has drifted. Usage: node lib/n8n/sync-pdf-unicode.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BEGIN = "// ==== BEGIN DRSNIP PDF UNICODE";
export const END = "// ==== END DRSNIP PDF UNICODE ====";
export const NODE_FILES = [
  "registration-v2/generate-registration-pdf.js",
  "legacy-jotform/generate-registration-pdf.js",
];
export function blockText() {
  return readFileSync(join(here, "pdf-unicode.block.js"), "utf8").trimEnd();
}
export function withBlock(src, block = blockText()) {
  const b = src.indexOf(BEGIN), e = src.indexOf(END);
  if (b < 0 || e < b) throw new Error("PDF unicode markers not found");
  return src.slice(0, b) + block + src.slice(e + END.length);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of NODE_FILES) {
    const p = join(here, f);
    const before = readFileSync(p, "utf8");
    const after = withBlock(before);
    if (after !== before) writeFileSync(p, after);
    console.log(f, after === before ? "up to date" : "synced");
  }
}
