import { userGraph, type UserGraph } from '../graph.ts';
import { upsertNodes, link } from '../ingest.ts';
import { publish } from '../bus.ts';
import { enrich } from '../analytics.ts';
import { embedPending } from '../semantic.ts';
import { syncFleet, seedRunHistory, AGENT_SPECS } from '../fleet.ts';
import { connectorConfig, saveConnectorConfig, configuredFields } from '../secrets.ts';
import { draftNode, search, type Tool } from '../tools.ts';
import { ingestDirectory, ingestTickets, ingestMail, ingestCalendar, ingestSlack, ingestNotion } from './workspace.ts';
import { prepareDemoRepo, ingestRepo } from './git.ts';
import { publicConnectors } from './public.ts';
import { mcpConnector, callMcpTool, readOnlyTool } from './mcp.ts';
import { MissingConfig, type ConnectorDef, type ConnectorCtx } from './types.ts';

// ------------------------------------------------------------------ catalog

export const demoConnector: ConnectorDef = {
  id: 'demo',
  name: 'Lumen Labs',
  category: 'Workspace',
  description: 'A complete synthetic company — Gmail, Calendar, Slack, Notion, Linear and a real git repo — to see ZivBot work end to end.',
  icon: 'zivbot',
  auth: 'demo',
  recommended: true,
  async sync(ctx) {
    const g = ctx.g;
    const name = (await g.one(`MATCH (p:Profile) RETURN p.name AS n`))?.n || 'You';
    ctx.progress('Google Workspace: directory…');
    const dir = await ingestDirectory(g, { name });
    ctx.progress('Linear: tickets…');
    const t = await ingestTickets(g);
    ctx.progress('Gmail: threads…');
    const m = await ingestMail(g);
    ctx.progress('Calendar: events…');
    const c = await ingestCalendar(g);
    ctx.progress('Slack: channels…');
    const s = await ingestSlack(g);
    ctx.progress('Notion: docs…');
    const n = await ingestNotion(g);
    ctx.progress('Git: lumen-payments…');
    const repoDir = await prepareDemoRepo(ctx.userId);
    const r = await ingestRepo(g, repoDir, { name: 'lumen-payments', implements: 'system:payments-api' });
    ctx.progress('Agents: your subscriptions…');
    await syncFleet(g);
    await seedRunHistory(g);
    for (const id of ['google', 'slack', 'notion', 'linear']) {
      await upsertNodes(g, 'Connector', [{ uid: `connector:${id}`, props: { name: id, status: 'connected', mode: 'demo', lastSync: Date.now() }, search: `${id} connector` }]);
    }
    return { people: dir.people, systems: dir.systems, projects: dir.projects, tickets: t.tickets, emails: m.emails, events: c.events, messages: s.messages, docs: n.docs, files: r.files, commits: r.commits };
  },
};

const AGENT_ICONS: Record<string, string> = { codex: 'openai', 'claude-code': 'claude', cursor: 'cursor', opencode: 'opencode', grok: 'x', antigravity: 'google' };
const INSTALL: Record<string, string> = {
  codex: 'npm i -g @openai/codex', 'claude-code': 'npm i -g @anthropic-ai/claude-code', cursor: 'curl https://cursor.com/install -fsS | bash',
  opencode: 'npm i -g opencode-ai', grok: 'npm i -g @vibe-kit/grok-cli', antigravity: 'see antigravity.google',
};

export const agentConnectors: ConnectorDef[] = AGENT_SPECS.map((s) => ({
  id: `agent-${s.kind}`,
  name: s.name,
  category: 'Agents',
  description: `Your ${s.plan}. ZivBot hands it coding jobs, picks it when the graph says it's the best fit, and fails over when it's out of quota.`,
  icon: AGENT_ICONS[s.kind],
  auth: 'local',
  recommended: s.kind === 'codex' || s.kind === 'claude-code',
  async sync(ctx) {
    const found = (await syncFleet(ctx.g)).find((f) => f.kind === s.kind)!;
    if (!found.path) throw new Error(`${s.name} isn't installed on this computer. Install it with: ${INSTALL[s.kind]}`);
    return { version: found.version || 'installed' };
  },
}));

let liveCache: ConnectorDef[] | null = null;
async function liveConnectors(): Promise<ConnectorDef[]> {
  if (liveCache) return liveCache;
  try {
    const mod: any = await import('./live/index.ts');
    liveCache = mod.liveConnectors || [];
  } catch (e: any) {
    console.warn('[connectors] live connectors unavailable:', e.message);
    liveCache = [];
  }
  return liveCache!;
}

export async function catalog(): Promise<ConnectorDef[]> {
  return [demoConnector, ...agentConnectors, mcpConnector, ...publicConnectors, ...(await liveConnectors())];
}

export async function connectorById(id: string) {
  return (await catalog()).find((c) => c.id === id);
}

/** Catalog + this user's status for each connector (never returns secret values). */
export async function catalogFor(userId: string) {
  const g = await userGraph(userId);
  const rows = await g.q(`MATCH (c:Connector) RETURN c.uid AS uid, c.status AS status, c.mode AS mode, c.lastSync AS lastSync, c.counts AS counts, c.error AS error`, {}, 'connector status');
  const st = new Map(rows.map((r) => [r.uid, r]));
  const agents = await g.q(`MATCH (a:Agent) RETURN a.kind AS kind, a.installed AS installed, a.version AS version`, {}, 'fleet status');
  return (await catalog()).map((c) => {
    const s = st.get(`connector:${c.id}`);
    const agent = c.id.startsWith('agent-') ? agents.find((a) => `agent-${a.kind}` === c.id) : null;
    return {
      id: c.id, name: c.name, category: c.category, description: c.description, icon: c.icon, auth: c.auth, recommended: !!c.recommended,
      fields: (c.fields || []).map((f) => ({ key: f.key, label: f.label, secret: !!f.secret, placeholder: f.placeholder, optional: !!f.optional, env: f.env, help: f.help })),
      configured: configuredFields(userId, c.id, c.fields),
      actions: (c.actions || []).map((a) => ({ name: a.name, description: a.description, mutates: a.mutates })),
      status: agent ? (agent.installed ? 'connected' : 'not installed') : s?.status || 'available',
      mode: s?.mode, lastSync: s?.lastSync, counts: s?.counts ? JSON.parse(s.counts) : undefined, error: s?.error, version: agent?.version,
    };
  });
}

// ------------------------------------------------------------------ connect + sync

export async function connect(userId: string, id: string, values: Record<string, string> = {}) {
  const def = await connectorById(id);
  if (!def) throw new Error(`unknown connector ${id}`);
  if (Object.keys(values).length) saveConnectorConfig(userId, id, values);
  const g = await userGraph(userId);
  const cuid = `connector:${id}`;
  const progress = (msg: string) => publish(userId, { type: 'connector.progress', id, msg });
  await upsertNodes(g, 'Connector', [{ uid: cuid, props: { name: def.name, kind: def.category, status: 'syncing', error: '' }, search: `${def.name} connector ${def.category}` }]);
  publish(userId, { type: 'connector', id, status: 'syncing' });
  const ctx: ConnectorCtx = { g, userId, config: connectorConfig(userId, id, def.fields), progress };
  try {
    const counts = def.sync ? await def.sync(ctx) : {};
    await registerActions(g, def);
    progress('Finding the connections…');
    await enrich(g);
    progress('Building semantic memory…');
    await embedPending(g, 2000).catch((e) => console.warn('[embed]', e.message));
    await g.q(`MATCH (c:Connector {uid:$u}) SET c.status = 'connected', c.mode = $mode, c.lastSync = $now, c.counts = $counts, c.error = ''`, { u: cuid, mode: def.auth === 'demo' ? 'demo' : 'live', now: Date.now(), counts: JSON.stringify(counts) }, 'connector connected');
    publish(userId, { type: 'connector', id, status: 'connected', counts });
    return { ok: true, counts };
  } catch (e: any) {
    const missing = e instanceof MissingConfig ? e.fields : undefined;
    await g.q(`MATCH (c:Connector {uid:$u}) SET c.status = $s, c.error = $e`, { u: cuid, s: missing ? 'needs keys' : 'error', e: e.message }, 'connector failed');
    publish(userId, { type: 'connector', id, status: missing ? 'needs keys' : 'error', error: e.message });
    return { ok: false, error: e.message, missing };
  }
}

export async function disconnect(userId: string, id: string) {
  const g = await userGraph(userId);
  const sources = id === 'demo' ? ['google', 'gmail', 'gcal', 'slack', 'notion', 'linear', 'git'] : [id];
  await g.q(`MATCH (n) WHERE n.source IN $s DETACH DELETE n`, { s: sources }, 'remove connector data');
  await g.q(`MATCH (c:Connector) WHERE c.uid IN $u DETACH DELETE c`, { u: [`connector:${id}`, ...(id === 'demo' ? ['connector:google', 'connector:slack', 'connector:notion', 'connector:linear'] : [])] }, 'remove connector');
  if (id === 'demo') await g.q(`MATCH (r:Run {synthetic:true}) DETACH DELETE r`, {}, 'remove demo runs');
  await enrich(g);
  publish(userId, { type: 'connector', id, status: 'available' });
}

/** Connector actions become :Tool nodes the dot can find by querying the graph. */
async function registerActions(g: UserGraph, def: ConnectorDef) {
  if (!def.actions?.length) return;
  const cuid = `connector:${def.id}`;
  await upsertNodes(g, 'Tool', def.actions.map((a) => ({ uid: `tool:${def.id}:${a.name}`, props: { name: `${def.id}.${a.name}`, description: a.description, server: def.id, mutates: a.mutates, schema: JSON.stringify(a.params) }, search: `${def.name} ${a.name.replace(/_/g, ' ')} ${a.description}` })));
  await link(g, 'Tool', 'PROVIDED_BY', 'Connector', def.actions.map((a) => ({ from: `tool:${def.id}:${a.name}`, to: cuid })));
}

export async function runConnectorAction(userId: string, g: UserGraph, connectorId: string, action: string, args: any) {
  const def = await connectorById(connectorId);
  const a = def?.actions?.find((x) => x.name === action);
  if (!def || !a) throw new Error(`no action ${connectorId}.${action}`);
  const out = await a.run({ g, userId, config: connectorConfig(userId, connectorId, def.fields), progress: () => {} }, args);
  await g.q(`MATCH (t:Tool {uid:$u}) SET t.calls = coalesce(t.calls, 0) + 1, t.lastCalledAt = $now`, { u: `tool:${connectorId}:${action}`, now: Date.now() }, 'count tool call');
  return out;
}

// ------------------------------------------------------------------ tools for the agent

/**
 * Tool selection through the graph: the dot asks the graph which connected
 * tools fit the job (full-text over :Tool nodes from connectors and MCP
 * servers), then calls one. Mutating tools turn into approval drafts.
 */
export const connectorTools: Tool[] = [
  {
    name: 'find_tools',
    description: 'Find tools from my connected apps and MCP servers that can do something (e.g. "post to slack", "create a linear issue", "scrape a web page"). Returns tool ids to use with use_tool.',
    params: { type: 'object', properties: { need: { type: 'string' } }, required: ['need'] },
    async run({ g }, { need }) {
      const hits = await search(g, need, ['Tool'], 8);
      const rows = hits.length ? await g.q(
        `MATCH (t:Tool)-[:PROVIDED_BY]->(c:Connector {status:'connected'}) WHERE t.uid IN $ids
         RETURN t.uid AS uid, t.name AS name, t.description AS description, t.mutates AS mutates, t.schema AS schema, c.name AS app`,
        { ids: hits.map((h) => h.uid) },
        'connected tools matching the need',
      ) : [];
      return { text: rows.length ? rows.map((r) => `- \`${r.uid}\` (${r.app}${r.mutates ? ', needs approval' : ''}): ${r.description}\n  args schema: ${r.schema}`).join('\n') : 'No connected tool does that yet — suggest connecting an app in Connect Apps.', data: rows };
    },
  },
  {
    name: 'use_tool',
    description: 'Call a tool found with find_tools by its uid with JSON args. Read-only tools run now; tools that change things create an approval card.',
    params: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] },
    async run({ g, userId, dot }, { tool, args = {} }) {
      const t = await g.one(`MATCH (t:Tool {uid:$u}) RETURN t.name AS name, t.server AS server, t.mutates AS mutates, t.description AS description`, { u: tool }, 'load tool');
      if (!t) return { text: `Unknown tool ${tool}. Use find_tools first.` };
      const isMcp = tool.startsWith('tool:mcp:');
      const action = isMcp ? t.name : t.name.split('.').slice(1).join('.');
      if (t.mutates) {
        const d = await draftNode(g, {
          kind: 'mcp', title: `${t.server} › ${action}`, detail: t.description, body: JSON.stringify(args, null, 2), dot,
          payload: { mcp: isMcp, server: t.server, tool: action, args }, links: [{ rel: 'USES_TOOL', to: tool }],
        });
        return { text: `This changes something in ${t.server}, so I've put it up for your approval.`, cards: [{ type: 'draft', draft: { uid: d, kind: 'mcp', status: 'pending', title: `${t.server} › ${action}`, body: JSON.stringify(args, null, 2), detail: t.description } }] };
      }
      const out = isMcp ? await callMcpTool(g, t.server, action, args) : await runConnectorAction(userId, g, t.server, action, args);
      return { text: out.slice(0, 4000) };
    },
  },
];

export { readOnlyTool };
