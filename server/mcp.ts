/**
 * ZivBot as an MCP server (stdio). The same tools are served over Streamable
 * HTTP at /mcp on the API (server/index.ts). Any agent that speaks MCP — Codex, Claude
 * Code, Cursor, Claude Desktop — gets your Zivs' graph tools: triage,
 * who_knows, blast_radius, decision_trace, connection_path, recall… all
 * running Cypher against your FalkorDB graph.
 *
 *   ZIV_USER=<your user id> npx tsx server/mcp.ts
 *
 * Mutating tools (drafts, fixes, decisions) still only create approval
 * drafts that you approve in the ZivBot app.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { allUsers } from './users.ts';
import { buildMcp } from './mcpServer.ts';

const userId = process.env.ZIV_USER || (await allUsers(365 * 86_400_000, 1))[0];
if (!userId) {
  console.error('No ZivBot user yet — open the app once, then set ZIV_USER.');
  process.exit(1);
}
await (await buildMcp(userId)).connect(new StdioServerTransport());
