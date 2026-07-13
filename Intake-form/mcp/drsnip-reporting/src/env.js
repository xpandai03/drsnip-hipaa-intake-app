// Minimal zero-dependency .env loader. Looks for a .env file next to the
// package (or DRSNIP_MCP_ENV_FILE) and folds any KEY=VALUE pairs into
// process.env WITHOUT overwriting values already set by the launcher (the
// MCP client's `env` block always wins). This is only a convenience for
// local demos — in production the credentials are injected by the host, and
// the server never prints or returns them.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  const candidate =
    process.env.DRSNIP_MCP_ENV_FILE || resolve(here, "..", ".env");
  if (!existsSync(candidate)) return;
  for (const line of readFileSync(candidate, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
