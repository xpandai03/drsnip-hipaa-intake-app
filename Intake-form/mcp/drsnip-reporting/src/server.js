#!/usr/bin/env node
// DrSnip Reporting MCP — stdio entrypoint (local / Claude Desktop). READ-ONLY,
// AGGREGATE-ONLY. Same tool set as the HTTP entrypoint (see build-server.js).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./env.js";
import { closeDb } from "./db.js";
import { buildServer, activeTools } from "./build-server.js";

loadEnv();

async function main() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the MCP JSON-RPC channel.
  process.stderr.write(
    `[drsnip-reporting] READ-ONLY aggregate-only stdio MCP up. ${activeTools().length} tools.\n`,
  );
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[drsnip-reporting] fatal: ${err.message}\n`);
  process.exit(1);
});
