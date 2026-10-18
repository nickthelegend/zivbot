/**
 * The MCP surface of ZivBot: every graph tool below, for one user's graph.
 * Served two ways — stdio (`npm run mcp`, see mcp.ts) and Streamable HTTP at
 * `/mcp` on the API, so any MCP client can use the hosted demo too.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { userGraph, withTrace, type Trace } from './graph.ts';
import { tools } from './tools.ts';
import { listDots } from './memory.ts';
import { publish } from './bus.ts';
import type { TurnSink } from './brains.ts';

export const EXPOSED = ['search_graph', 'describe_entity', 'triage', 'who_knows', 'blast_radius', 'connection_path', 'decision_trace', 'customer_history', 'key_people', 'agenda', 'list_agents', 'recall', 'remember', 'run_cypher', 'run_algorithm', 'semantic_search', 'insights', 'decision_impact', 'what_if_absent', 'critical_path', 'customer_health', 'diagnose', 'rank_entities', 'workload', 'recent_from', 'who_could_learn', 'list_entities', 'forget', 'propose_fix', 'draft_email'];

/** JSON-schema property → zod (enough for our tool params). */
function zodFor(p: any): z.ZodTypeAny {
  const base = p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : p.type === 'array' ? z.array(z.string()) : p.type === 'object' ? z.record(z.string(), z.any()) : p.enum ? z.enum(p.enum) : z.string();
  return p.description ? base.describe(p.description) : base;
}

/** `turn`: this MCP call is a chat turn's model at work — trace into that turn and hand it the cards. */
export async function buildMcp(userId: string, turn?: TurnSink) {
  const g = await userGraph(userId);
  const dot = turn?.dot || (await listDots(g))[0]?.uid || 'dot:mcp';
  const server = new McpServer({ name: 'zivbot', version: '0.1.0' });
  for (const t of tools.filter((x) => turn || EXPOSED.includes(x.name))) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, p] of Object.entries(t.params.properties)) shape[k] = (t.params.required || []).includes(k) ? zodFor(p) : zodFor(p).optional();
    server.tool(t.name, t.description, shape, async (args: any) => {
      if (turn) {
        turn.tools.push(t.name);
        publish(userId, { type: 'tool', dot, conv: turn.conv, name: t.name, args });
        const r = await withTrace(turn.trace, () => t.run({ g, userId, dot }, args));
        turn.cards.push(...(r.cards || []));
        return { content: [{ type: 'text' as const, text: r.text }] };
      }
      const trace: Trace = { queries: [], touched: new Set() };
      const r = await withTrace(trace, () => t.run({ g, userId, dot }, args));
      const cypher = trace.queries.filter((q) => !q.internal).map((q) => `-- ${q.label} (${q.rows} rows, ${q.ms}ms)\n${q.cypher}`).join('\n\n');
      return { content: [{ type: 'text' as const, text: `${r.text}\n\n---\nCypher behind this answer:\n${cypher}` }] };
    });
  }
  return server;
}
