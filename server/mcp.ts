/**
 * ZivBot as an MCP server (stdio). Any agent that speaks MCP — Codex, Claude
 * Code, Cursor, Claude Desktop — gets your dots' graph tools: triage,
 * who_knows, blast_radius, decision_trace, connection_path, recall… all
 * running Cypher against your FalkorDB graph.
 *
 *   ZIV_USER=<your user id> npx tsx server/mcp.ts
 *
 * Mutating tools (drafts, fixes, decisions) still only create approval
 * drafts that you approve in the ZivBot app.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { userGraph, withTrace, type Trace } from './graph.ts';
import { tools } from './tools.ts';
import { allUsers } from './users.ts';
import { listDots } from './memory.ts';

const EXPOSED = ['search_graph', 'describe_entity', 'triage', 'who_knows', 'blast_radius', 'connection_path', 'decision_trace', 'customer_history', 'key_people', 'agenda', 'list_agents', 'recall', 'remember', 'run_cypher', 'run_algorithm', 'semantic_search', 'insights', 'decision_impact', 'what_if_absent', 'critical_path', 'customer_health', 'diagnose', 'rank_entities', 'propose_fix', 'draft_email'];

/** JSON-schema property → zod (enough for our tool params). */
function zodFor(p: any): z.ZodTypeAny {
  const base = p.type === 'number' ? z.number() : p.type === 'array' ? z.array(z.string()) : p.type === 'object' ? z.record(z.string(), z.any()) : p.enum ? z.enum(p.enum) : z.string();
  return p.description ? base.describe(p.description) : base;
}

const userId = process.env.ZIV_USER || (await allUsers())[0];
if (!userId) {
  console.error('No ZivBot user yet — open the app once, then set ZIV_USER.');
  process.exit(1);
}
const g = await userGraph(userId);
const dot = (await listDots(g))[0]?.uid || 'dot:mcp';

const server = new McpServer({ name: 'zivbot', version: '0.1.0' });
for (const t of tools.filter((x) => EXPOSED.includes(x.name))) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, p] of Object.entries(t.params.properties)) shape[k] = (t.params.required || []).includes(k) ? zodFor(p) : zodFor(p).optional();
  server.tool(t.name, t.description, shape, async (args: any) => {
    const trace: Trace = { queries: [], touched: new Set() };
    const r = await withTrace(trace, () => t.run({ g, userId, dot }, args));
    const cypher = trace.queries.filter((q) => !q.internal).map((q) => `-- ${q.label} (${q.rows} rows, ${q.ms}ms)\n${q.cypher}`).join('\n\n');
    return { content: [{ type: 'text' as const, text: `${r.text}\n\n---\nCypher behind this answer:\n${cypher}` }] };
  });
}
await server.connect(new StdioServerTransport());
