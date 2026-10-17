import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UserGraph } from '../graph.ts';
import { upsertNodes, link } from '../ingest.ts';
import type { ConnectorDef } from './types.ts';

/**
 * "Connect almost everything": any MCP server becomes a connector. Its tools
 * are written into the graph as :Tool nodes PROVIDED_BY the :Connector, so
 * the dot selects tools by querying the graph, and calls them over MCP.
 * Tools whose names look read-only run directly; anything else needs approval.
 */

type Conn = { client: Client; tools: { name: string; description?: string; inputSchema?: any }[] };
const pool = new Map<string, Conn>();

export type McpServerConfig = { name: string; command?: string; url?: string; env?: Record<string, string> };

async function connect(cfg: McpServerConfig): Promise<Conn> {
  const key = `${cfg.name}|${cfg.command || cfg.url}`;
  const hit = pool.get(key);
  if (hit) return hit;
  const client = new Client({ name: 'zivbot', version: '0.1.0' });
  if (cfg.url) {
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url)));
  } else if (cfg.command) {
    const parts = cfg.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)!.map((s) => s.replace(/^["']|["']$/g, ''));
    await client.connect(new StdioClientTransport({ command: parts[0], args: parts.slice(1), env: { ...(process.env as Record<string, string>), ...(cfg.env || {}) }, stderr: 'ignore' } as any));
  } else throw new Error('MCP server needs a command or a URL');
  const { tools } = await client.listTools();
  const conn = { client, tools };
  pool.set(key, conn);
  return conn;
}

export const readOnlyTool = (name: string) => /^(get|list|search|read|fetch|query|find|describe|lookup|echo|show|view)[_-]?/i.test(name);

export async function syncMcp(g: UserGraph, cfg: McpServerConfig) {
  const conn = await connect(cfg);
  const cuid = `connector:mcp:${cfg.name}`;
  await upsertNodes(g, 'Connector', [{ uid: cuid, props: { name: cfg.name, kind: 'mcp', command: cfg.command, url: cfg.url, status: 'connected', lastSync: Date.now() }, search: `${cfg.name} mcp server` }]);
  await upsertNodes(g, 'Tool', conn.tools.map((t) => ({
    uid: `tool:mcp:${cfg.name}:${t.name}`,
    props: { name: t.name, description: (t.description || '').slice(0, 500), server: cfg.name, mutates: !readOnlyTool(t.name), schema: JSON.stringify(t.inputSchema || {}) },
    search: `${t.name.replace(/[_-]/g, ' ')} ${t.description || ''}`,
  })));
  await link(g, 'Tool', 'PROVIDED_BY', 'Connector', conn.tools.map((t) => ({ from: `tool:mcp:${cfg.name}:${t.name}`, to: cuid })));
  return { tools: conn.tools.length };
}

export async function callMcpTool(g: UserGraph, server: string, tool: string, args: Record<string, unknown>) {
  const c = await g.one(`MATCH (c:Connector {uid:$u}) RETURN c.command AS command, c.url AS url`, { u: `connector:mcp:${server}` }, 'load MCP server');
  if (!c) throw new Error(`MCP server ${server} is not connected`);
  const conn = await connect({ name: server, command: c.command, url: c.url });
  const r: any = await conn.client.callTool({ name: tool, arguments: args || {} });
  const text = (r.content || []).map((x: any) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n');
  await g.q(`MATCH (t:Tool {uid:$u}) SET t.calls = coalesce(t.calls, 0) + 1, t.lastCalledAt = $now`, { u: `tool:mcp:${server}:${tool}`, now: Date.now() }, 'count tool call');
  return r.isError ? `error: ${text}` : text;
}

export const mcpConnector: ConnectorDef = {
  id: 'mcp',
  name: 'Any MCP server',
  category: 'Agents',
  description: 'Plug in any Model Context Protocol server — Notion, Linear, Figma, Postgres, filesystem… its tools become your dots’ tools.',
  icon: 'modelcontextprotocol',
  auth: 'none',
  recommended: true,
  fields: [
    { key: 'name', label: 'Name', placeholder: 'everything' },
    { key: 'command', label: 'Command (stdio)', placeholder: 'npx -y @modelcontextprotocol/server-everything', optional: true },
    { key: 'url', label: 'or URL (streamable HTTP)', placeholder: 'https://mcp.example.com/mcp', optional: true },
  ],
  async sync(ctx) {
    if (!ctx.config.name || (!ctx.config.command && !ctx.config.url)) throw new Error('Give the server a name and a command or URL');
    ctx.progress(`Starting ${ctx.config.name}…`);
    return syncMcp(ctx.g, { name: ctx.config.name, command: ctx.config.command, url: ctx.config.url });
  },
};
