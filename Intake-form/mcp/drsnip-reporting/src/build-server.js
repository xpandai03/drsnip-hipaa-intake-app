// Shared MCP server factory used by BOTH entrypoints (stdio + HTTP) so the two
// transports expose exactly the same AGGREGATE-ONLY, read-only tool set.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { drsnipTools } from "./drsnip-tools.js";

export function activeTools() {
  // Aggregate-only intake reporting. No Salesforce, no record-level tools,
  // no free-form SQL — see drsnip-tools.js for the PHI posture.
  return [...drsnipTools];
}

export function buildServer() {
  const tools = activeTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "drsnip-reporting", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // Surface to the model; never leak secrets/stack.
      return { isError: true, content: [{ type: "text", text: `Error in ${tool.name}: ${err.message}` }] };
    }
  });

  return server;
}
