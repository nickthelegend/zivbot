import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, llmEnabled } from './config.ts';
import { llmBudgetLeft } from './llm.ts';
import { falkor, userGraph, listGraphs } from './graph.ts';
import { subscribe, publish } from './bus.ts';
import { ensureUser, ensureTeam, isUser } from './users.ts';
import { buildMcp } from './mcpServer.ts';
import { listBrains, setLocalBase, turnSink } from './brains.ts';
import { startGithubSignIn, accountOf, signOut } from './account.ts';
import { googleClient, saveGoogleClient, startGoogleSignIn } from './google-oauth.ts';
import { enableRelay, relayStatus, resumeRelays, disableRelay } from './relay.ts';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { handleUserMessage, afterConnect } from './agent.ts';
import { listDots, listConversations, history, createDot, createGroup, updateDot, markRead, getConversation, DOT_PRESETS, postMessage } from './memory.ts';
import { catalogFor, connect, disconnect } from './connectors/index.ts';
import { approveDraft, rejectDraft } from './actions.ts';
import { routeJob, syncFleet, refreshSkills } from './fleet.ts';
import { toolByName, search as graphSearch, resolve as resolveRef } from './tools.ts';
import { startProactive, scanUser } from './proactive.ts';
import { LABEL_META } from './schema.ts';
import { insights } from './insights.ts';
import { runAlgorithm, graphSchema, ALGORITHMS } from './algorithms.ts';
import { RULE_KINDS, listRules, createRule, setRuleActive, evaluateRules } from './rules.ts';

// the badge tells the truth: once the day's model budget is spent, it's the planner alone until tomorrow
const brainName = () => (!llmEnabled() || llmBudgetLeft() <= 0 ? 'graph-planner' : config.llm.mode === 'llm' ? `llm:${config.llm.model}` : `hybrid:${config.llm.model}`);
const ROOT = process.env.ZIV_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = new Hono();

// The web app may be served from another origin (Vercel) than this API.
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin) || /^https:\/\/zivbot[a-z0-9-]*\.vercel\.app$/.test(origin));
  if (allowed) {
    c.header('access-control-allow-origin', origin);
    c.header('vary', 'origin');
    c.header('access-control-allow-headers', 'content-type, x-ziv-user');
    c.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    c.header('access-control-max-age', '86400');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, allowed ? 204 : 403);
  await next();
});

const user = (c: Context) => {
  const id = c.req.header('x-ziv-user') || c.req.query('user');
  if (!id || !/^[a-zA-Z0-9_-]{6,64}$/.test(id)) throw new HttpError(401, 'missing user');
  return id;
};
/** Tiny fixed-window rate limiter (per key, in memory — enough for one hosted instance). */
const windows = new Map<string, { n: number; until: number }>();
function limit(key: string, max: number, ms: number) {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.until < now) { windows.set(key, { n: 1, until: now + ms }); return; }
  if (++w.n > max) throw new HttpError(429, 'Slow down a little — try again in a minute.');
}
setInterval(() => { const now = Date.now(); for (const [k, w] of windows) if (w.until < now) windows.delete(k); }, 60_000).unref();
const ip = (c: Context) => (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || c.req.header('x-real-ip') || 'local';

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
app.onError((e, c) => {
  if (!(e instanceof HttpError)) console.error('[api]', e);
  return c.json({ error: e.message }, (e as any).status || 500);
});

// Every user-scoped call must name a registered user: an unknown id never gets a graph made for it.
app.use('/api/*', async (c, next) => {
  const p = c.req.path;
  if (c.req.method === 'OPTIONS' || p === '/api/health' || p === '/api/session') return next();
  const id = c.req.header('x-ziv-user') || c.req.query('user');
  if (!id || !/^[a-zA-Z0-9_-]{6,64}$/.test(id) || !(await isUser(id))) return c.json({ error: 'unknown user — start a session first' }, 401);
  return next();
});

// ------------------------------------------------------------------ session & state

app.get('/api/health', async (c) => {
  let falkordb = 'down';
  try { await (await falkor()).list(); falkordb = 'up'; } catch { /* down */ }
  return c.json({ ok: falkordb === 'up', falkordb, hosted: config.hosted, brain: brainName() });
});

app.post('/api/session', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // new graphs cost real work: cap how fast one address (and everyone together) can create them,
  // whether or not the client suggested an id
  const valid = typeof body.userId === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(body.userId);
  if (config.hosted && !(valid && (await isUser(body.userId)))) { limit(`session:${ip(c)}`, 8, 3_600_000); limit('session:all', 300, 3_600_000); }
  return c.json(await ensureUser(body.userId));
});

app.get('/api/state', async (c) => {
  const id = user(c);
  const g = await userGraph(id);
  const [dots, conversations, profile, pending] = await Promise.all([
    listDots(g),
    listConversations(g),
    g.one(`MATCH (p:Profile) RETURN p.name AS name`),
    g.q(`MATCH (d:Draft {status:'pending'}) RETURN count(d) AS n`),
  ]);
  return c.json({ dots, conversations, profile: profile || {}, pendingDrafts: pending[0]?.n || 0, hosted: config.hosted, brain: brainName(), presets: DOT_PRESETS, labels: LABEL_META });
});

app.get('/api/events', (c) => {
  const id = user(c);
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'ping', data: '{}' });
    const off = subscribe(id, (e) => void stream.writeSSE({ data: JSON.stringify(e) }).catch(() => {}));
    const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {}), 10_000);
    await new Promise<void>((res) => stream.onAbort(() => res()));
    clearInterval(ping);
    off();
  });
});

// ------------------------------------------------------------------ Zivs & conversations

app.get('/api/conversations/:id/messages', async (c) => {
  const g = await userGraph(user(c));
  const conv = await getConversation(g, c.req.param('id'));
  await markRead(g, c.req.param('id'));
  return c.json({ conversation: conv, messages: await history(g, c.req.param('id')) });
});

app.post('/api/conversations/:id/messages', async (c) => {
  const id = user(c);
  if (config.hosted) limit(`msg:${id}`, 30, 60_000);
  const { text, model } = await c.req.json();
  if (!text?.trim()) throw new HttpError(400, 'empty message');
  const brain = typeof model === 'string' && /^(auto|planner|codex|claude:(sonnet|opus)|or:[\w./:-]{3,100})$/.test(model) ? model : 'auto';
  if (config.hosted && (brain === 'codex' || brain.startsWith('claude:'))) throw new HttpError(400, 'Codex and Claude run on your own subscription in the desktop app.');
  void handleUserMessage(id, c.req.param('id'), String(text).slice(0, 4000), brain).catch((e) => {
    console.error('[turn]', e);
    publish(id, { type: 'error', message: e.message });
  });
  return c.json({ ok: true }, 202);
});

app.post('/api/dots', async (c) => {
  const id = user(c);
  const g = await userGraph(id);
  const body = await c.req.json();
  const preset = DOT_PRESETS.find((p) => p.avatar === body.preset);
  const p = preset || { name: String(body.name || 'New Ziv').slice(0, 24), avatar: body.avatar || 'ziv', color: body.color || '#ff7a1a', role: String(body.role || 'General helper').slice(0, 200) };
  const { dot, conv } = await createDot(g, p);
  await postMessage(id, g, { conv, role: 'assistant', dot, text: `Hi! I'm ${p.name}. ${p.role}.\n\nI share the same graph memory as your other Zivs. What should I start with?` });
  publish(id, { type: 'dots' });
  return c.json({ dot, conv });
});

app.patch('/api/dots/:id', async (c) => {
  const id = user(c);
  const g = await userGraph(id);
  const b = await c.req.json();
  const props: Record<string, string> = {};
  for (const k of ['name', 'avatar', 'role', 'color']) if (typeof b[k] === 'string' && b[k].trim()) props[k] = b[k].trim().slice(0, 200);
  await updateDot(g, c.req.param('id'), props);
  publish(id, { type: 'dots' });
  return c.json({ ok: true });
});

app.post('/api/groups', async (c) => {
  const id = user(c);
  const g = await userGraph(id);
  const { dots, name } = await c.req.json();
  if (!Array.isArray(dots) || dots.length < 2) throw new HttpError(400, 'pick at least two Zivs');
  const conv = await createGroup(g, dots, name);
  await postMessage(id, g, { conv, role: 'system', text: 'Group created. The Zivs whose role fits will answer.' });
  publish(id, { type: 'dots' });
  return c.json({ conv });
});

// ------------------------------------------------------------------ connectors

app.get('/api/connectors', async (c) => c.json(await catalogFor(user(c))));

app.post('/api/connectors/:cid/connect', async (c) => {
  const id = user(c);
  const values = await c.req.json().catch(() => ({}));
  const cid = c.req.param('cid');
  const r = await connect(id, cid, values || {});
  if (r.ok && (cid === 'demo' || !cid.startsWith('agent-'))) {
    void (async () => {
      if (cid === 'demo') await ensureTeam(id);
      publish(id, { type: 'dots' });
      await afterConnect(id, r.counts || {});
    })().catch((e) => console.error('[afterConnect]', e));
  }
  return c.json(r, r.ok ? 200 : 400);
});

app.post('/api/connectors/:cid/disconnect', async (c) => {
  await disconnect(user(c), c.req.param('cid'));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ approvals, runs, fleet

app.get('/api/drafts', async (c) => {
  const g = await userGraph(user(c));
  const rows = await g.q(`MATCH (d:Draft) OPTIONAL MATCH (d)-[:BY]->(dot:Dot) RETURN d.uid AS uid, d.kind AS kind, d.status AS status, d.title AS title, d.to AS to, d.when AS when, d.agent AS agent, d.at AS at, d.result AS result, dot.name AS dot ORDER BY d.at DESC LIMIT 60`);
  return c.json(rows);
});
app.post('/api/drafts/:id/approve', async (c) => {
  const id = user(c);
  const g = await userGraph(id);
  return c.json(await approveDraft(id, g, c.req.param('id'), await c.req.json().catch(() => ({}))));
});
app.post('/api/drafts/:id/reject', async (c) => {
  const id = user(c);
  return c.json(await rejectDraft(id, await userGraph(id), c.req.param('id')));
});

app.get('/api/runs', async (c) => {
  const g = await userGraph(user(c));
  return c.json(await g.q(
    `MATCH (r:Run) OPTIONAL MATCH (r)-[:EXECUTED_BY]->(a:Agent) OPTIONAL MATCH (r)-[:ASSIGNED_TO]->(d:Dot) OPTIONAL MATCH (r)-[:FOR_TICKET]->(t:Ticket)
     RETURN r.uid AS uid, r.goal AS goal, r.status AS status, r.startedAt AS startedAt, r.endedAt AS endedAt, r.tests AS tests, r.branch AS branch, r.synthetic AS synthetic, r.kind AS kind,
            coalesce(a.name, d.name) AS agent, coalesce(a.kind, 'dot') AS agentKind, collect(t.key) AS tickets
     ORDER BY r.startedAt DESC LIMIT 40`,
  ));
});
app.get('/api/runs/:id', async (c) => {
  const g = await userGraph(user(c));
  const r = await g.one(`MATCH (r:Run {uid:$u}) OPTIONAL MATCH (r)-[:EXECUTED_BY]->(a:Agent) RETURN r, a.name AS agent`, { u: c.req.param('id') });
  if (!r) throw new HttpError(404, 'no such run');
  return c.json({ ...r.r, agent: r.agent });
});

app.get('/api/fleet/skills', async (c) => {
  const g = await userGraph(user(c));
  await refreshSkills(g);
  const nodes = await g.q(
    `MATCH (a:Agent)-[:SKILLED_IN]->(x:System) WITH collect(DISTINCT a) + collect(DISTINCT x) AS ns UNWIND ns AS n
     RETURN n.uid AS id, [l IN labels(n) WHERE NOT l IN ['Searchable','Memorable']][0] AS label, n.name AS name`,
    {},
    'skill graph nodes',
  );
  const edges = await g.q(`MATCH (a:Agent)-[s:SKILLED_IN]->(x:System) RETURN a.uid AS source, x.uid AS target, 'SKILLED_IN' AS type, s.score AS score, s.wins AS wins, s.losses AS losses`, {}, 'skill graph edges');
  return c.json({ nodes, edges });
});

app.get('/api/fleet', async (c) => {
  const g = await userGraph(user(c));
  await syncFleet(g);
  const agents = (await toolByName('list_agents')!.run({ g, userId: '', dot: '' }, {})).data;
  const systems = (c.req.query('systems') || 'system:payments-api').split(',');
  return c.json({ agents, routing: await routeJob(g, systems) });
});

// ------------------------------------------------------------------ graph, traces, memory

const HIDDEN = ['Episode', 'Answer', 'Notice', 'Profile', 'Conversation', 'Draft', 'Tool', 'Connector', 'Commit'];
const nodeShape = `n.uid AS id, [l IN labels(n) WHERE l <> 'Searchable'][0] AS label, n.name AS name, n.rank AS rank, n.criticality AS criticality, n.status AS status, n.priority AS priority, n.community AS community`;

async function edgesAmong(g: Awaited<ReturnType<typeof userGraph>>, ids: string[], rel?: string) {
  // COLLABORATES is derived and dense, so it only shows when asked for by name
  return g.q(`MATCH (a)-[r]->(b) WHERE a.uid IN $ids AND b.uid IN $ids AND (NOT type(r) IN ['COLLABORATES', 'IN_TOUCH', 'CLOSE_TO'] OR type(r) = $rel) RETURN a.uid AS source, b.uid AS target, type(r) AS type`, { ids, rel: rel ?? '' }, 'edges among nodes');
}

app.get('/api/graph', async (c) => {
  const g = await userGraph(user(c));
  const focus = (c.req.query('focus') || '').split(',').filter(Boolean);
  const limit = Math.min(Number(c.req.query('limit') || 400), 1500);
  const exact = (c.req.query('ids') || '').split(',').filter(Boolean).slice(0, 200);
  let nodes;
  if (exact.length) {
    nodes = await g.q(`MATCH (n) WHERE n.uid IN $ids RETURN ${nodeShape}`, { ids: exact }, 'exact nodes');
  } else if (focus.length) {
    // compact (cards in chat): the focus plus the neighbours that tie it together, readable at a glance
    const compact = c.req.query('compact') === '1';
    const hidden = compact ? [...HIDDEN, 'Email', 'ChatMessage', 'Thread', 'Commit', 'File', 'Episode', 'Answer'] : HIDDEN;
    const fs = await g.q(`MATCH (n) WHERE n.uid IN $focus RETURN ${nodeShape}`, { focus }, 'focus nodes');
    const nb = await g.q(
      `MATCH (f)-[r]-(n) WHERE f.uid IN $focus AND NOT n.uid IN $focus AND NOT any(l IN labels(n) WHERE l IN $hidden) AND NOT type(r) IN ['COLLABORATES', 'IN_TOUCH', 'CLOSE_TO']
       WITH n, count(DISTINCT f) AS ties ORDER BY ties DESC LIMIT $limit
       RETURN ${nodeShape}`,
      { focus, hidden, limit: compact ? Math.max(6, 22 - fs.length) : Math.min(limit, 120) },
      'neighbourhood',
    );
    nodes = [...fs, ...nb];
  } else {
    const labels = (c.req.query('labels') || '').split(',').filter(Boolean);
    nodes = await g.q(
      `MATCH (n) WHERE NOT any(l IN labels(n) WHERE l IN $hidden) AND (size($labels) = 0 OR any(l IN labels(n) WHERE l IN $labels))
       RETURN ${nodeShape} LIMIT $limit`,
      { hidden: HIDDEN, labels, limit },
      'graph overview',
    );
  }
  const ids = nodes.map((n) => n.id).filter(Boolean);
  return c.json({ nodes: nodes.map((n) => ({ ...n, focus: focus.includes(n.id) })), edges: await edgesAmong(g, ids, c.req.query('rel')) });
});

app.get('/api/answers/:id', async (c) => {
  const g = await userGraph(user(c));
  const a = await g.one(`MATCH (a:Answer {uid:$u}) OPTIONAL MATCH (a)-[:BY]->(d:Dot) RETURN a, d.name AS dot`, { u: c.req.param('id') });
  if (!a) throw new HttpError(404, 'no such answer');
  const used = await g.q(`MATCH (:Answer {uid:$u})-[:DELEGATED_TO*0..2]->(:Answer)-[:USED]->(n) WHERE NOT n:Episode WITH DISTINCT n RETURN ${nodeShape} LIMIT 80`, { u: c.req.param('id') });
  const sub = await g.q(`MATCH (:Answer {uid:$u})-[:DELEGATED_TO*1..2]->(b:Answer)-[:BY]->(d:Dot) RETURN b.queries AS queries, d.name AS dot`, { u: c.req.param('id') });
  const queries = [...JSON.parse(a.a.queries || '[]'), ...sub.flatMap((s) => JSON.parse(s.queries || '[]').map((q: any) => ({ ...q, dot: s.dot })))];
  return c.json({ ...a.a, dot: a.dot, delegatedTo: sub.map((s) => s.dot), queries, nodes: used, edges: await edgesAmong(g, used.map((n) => n.id)) });
});

app.get('/api/search', async (c) => {
  const g = await userGraph(user(c));
  const q = (c.req.query('q') || '').trim();
  if (q.length < 2) return c.json([]);
  const rows = await graphSearch(g, q, ['Person', 'Org', 'Project', 'System', 'Ticket', 'Decision', 'Doc', 'Thread', 'Repo', 'Event', 'Agent'], 8);
  return c.json(rows);
});

app.get('/api/entity/:uid', async (c) => {
  const g = await userGraph(user(c));
  const r = await toolByName('describe_entity')!.run({ g, userId: '', dot: '' }, { ref: decodeURIComponent(c.req.param('uid')) });
  return c.json({ text: r.text, ...(r.data as object) });
});

app.get('/api/stats', async (c) => {
  const g = await userGraph(user(c));
  const labels = await g.q(`MATCH (n) WITH [l IN labels(n) WHERE l <> 'Searchable'][0] AS label RETURN label, count(*) AS n ORDER BY n DESC`);
  const rels = await g.q(`MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n ORDER BY n DESC`);
  return c.json({ graph: g.name, labels, rels, nodes: labels.reduce((s, l) => s + l.n, 0), edges: rels.reduce((s, r) => s + r.n, 0), graphs: (await listGraphs()).length });
});

app.get('/api/insights', async (c) => {
  const g = await userGraph(user(c));
  return c.json(await insights(g, Number(c.req.query('since')) || undefined));
});

app.get('/api/algorithms', (c) => c.json(ALGORITHMS));
app.post('/api/algorithms/run', async (c) => {
  const g = await userGraph(user(c));
  const b = await c.req.json();
  for (const k of ['source', 'target'] as const) if (b[k]) { const r = await resolveRef(g, b[k]); if (!r) throw new HttpError(400, `I couldn't find "${b[k]}"`); b[k] = r.uid; }
  try { return c.json(await runAlgorithm(g, b)); } catch (e: any) { throw new HttpError(400, e.message); }
});
app.get('/api/schema', async (c) => c.json(await graphSchema(await userGraph(user(c)))));

app.get('/api/rules', async (c) => {
  const g = await userGraph(user(c));
  return c.json({ rules: await listRules(g), kinds: Object.fromEntries(Object.entries(RULE_KINDS).map(([k, v]) => [k, { title: v.title, says: v.says, defaults: v.defaults }])) });
});
app.post('/api/rules', async (c) => {
  const id = user(c);
  const g = await userGraph(id);
  const b = await c.req.json();
  const ru = await createRule(g, b.kind, { params: b.params, text: b.text });
  const fired = await evaluateRules(id, g, ru);
  return c.json({ uid: ru, fired });
});
app.post('/api/rules/:uid/active', async (c) => {
  await setRuleActive(await userGraph(user(c)), c.req.param('uid'), !!(await c.req.json()).active);
  return c.json({ ok: true });
});
app.post('/api/rules/run', async (c) => {
  const id = user(c);
  return c.json(await evaluateRules(id, await userGraph(id)));
});

app.get('/api/memory', async (c) => {
  const g = await userGraph(user(c));
  return c.json(await g.q(
    `MATCH (m) WHERE (m:Fact OR m:Procedure) OPTIONAL MATCH (m)-[:ABOUT|PREFERS]->(x)
     WITH m, x WHERE coalesce(m.status, 'active') = 'active'
     RETURN m.uid AS uid, [l IN labels(m) WHERE l <> 'Searchable'][0] AS kind, m.text AS text, m.at AS at, m.status AS status, collect(x.name) AS about ORDER BY m.at DESC`,
  ));
});

app.get('/api/outputs', async (c) => {
  const g = await userGraph(user(c));
  return c.json(await g.q(`MATCH (d:Doc {output:true}) OPTIONAL MATCH (d)-[:WRITTEN_BY]->(dot:Dot) RETURN d.uid AS uid, d.name AS name, d.size AS size, d.at AS at, dot.name AS dot ORDER BY d.at DESC LIMIT 30`));
});

app.get('/api/files/:uid', async (c) => {
  const g = await userGraph(user(c));
  const d = await g.one(`MATCH (d:Doc {uid:$u, output:true}) RETURN d.path AS path, d.name AS name`, { u: c.req.param('uid') });
  if (!d || !existsSync(d.path)) throw new HttpError(404, 'no such file');
  return c.body(readFileSync(d.path, 'utf8'), 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `inline; filename="${d.name}"` });
});

app.post('/api/cypher', async (c) => {
  const id = user(c);
  if (config.hosted) limit(`cypher:${id}`, 30, 60_000);
  const g = await userGraph(id);
  const { cypher } = await c.req.json();
  const r = await toolByName('run_cypher')!.run({ g, userId: '', dot: '' }, { cypher });
  return c.json({ rows: r.data ?? [], text: r.text });
});

app.post('/api/scan', async (c) => {
  await scanUser(user(c), true);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ account & anywhere

const localBase = () => `http://127.0.0.1:${config.port}`;
setLocalBase(localBase);
app.get('/api/models', async (c) => { user(c); return c.json({ models: await listBrains() }); });

app.get('/api/account', async (c) => c.json({ account: await accountOf(user(c)), hosted: config.hosted }));
app.post('/api/account/github/start', async (c) => {
  // the redirect lands on a listener on this computer, so sign-in belongs to the desktop / local app
  if (config.hosted) throw new HttpError(400, 'Sign in with GitHub from the desktop app — it runs on your computer.');
  return c.json(await startGithubSignIn(user(c)));
});
app.post('/api/account/signout', async (c) => { await signOut(user(c)); return c.json({ ok: true }); });

// Google: one-click sign-in for the Workspace connector (the OAuth client is set once per computer)
app.get('/api/google', (c) => { user(c); return c.json({ clientReady: !!googleClient(), hosted: config.hosted }); });
app.post('/api/google/client', async (c) => {
  if (config.hosted) throw new HttpError(400, 'Connect Google from the desktop app — your mail stays on your computer.');
  if (c.req.header('x-ziv-via') === 'relay') throw new HttpError(403, 'set this up on the computer');
  user(c);
  const b = await c.req.json();
  try { saveGoogleClient(String(b.clientId || ''), String(b.clientSecret || '')); } catch (e: any) { throw new HttpError(400, e.message); }
  return c.json({ ok: true });
});
app.post('/api/google/signin', async (c) => {
  if (config.hosted) throw new HttpError(400, 'Connect Google from the desktop app — your mail stays on your computer.');
  try { return c.json(await startGoogleSignIn(user(c))); } catch (e: any) { throw new HttpError(e.code === 'NO_CLIENT' ? 409 : 400, e.message); }
});

app.get('/api/relay', (c) => c.json({ ...relayStatus(user(c)), hosted: config.hosted }));
app.post('/api/relay/enable', async (c) => {
  if (config.hosted) throw new HttpError(400, 'Phone anywhere connects your phone to your own computer — turn it on in the desktop app.');
  if (c.req.header('x-ziv-via') === 'relay') throw new HttpError(403, 'not from a relayed phone');
  return c.json(await enableRelay(user(c), localBase));
});
app.post('/api/relay/disable', async (c) => {
  if (c.req.header('x-ziv-via') === 'relay') throw new HttpError(403, 'not from a relayed phone');
  await disableRelay(user(c), true);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ MCP over HTTP

// Any MCP client (Claude Code, Codex, Cursor, Claude Desktop…) can use a user's graph tools:
//   claude mcp add --transport http zivbot "https://<api>/mcp?user=<your id>"
// Stateless: a fresh server + transport per request, scoped to that user's graph.
app.all('/mcp', async (c) => {
  const id = c.req.query('user') || c.req.header('x-ziv-user') || (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!id || !/^[a-zA-Z0-9_-]{6,64}$/.test(id) || !(await isUser(id))) return c.json({ error: 'pass ?user=<your ZivBot id> (Profile → MCP)' }, 401);
  if (config.hosted) limit(`mcp:${id}`, 60, 60_000);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = await buildMcp(id, turnSink(c.req.query('turn'), id));
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// ------------------------------------------------------------------ web app

const dist = join(ROOT, 'dist');
if (existsSync(dist)) {
  const rel = relative(process.cwd(), dist) || '.';
  // hashed assets cache forever; the HTML shell never does (phones keep WebViews around)
  app.use('*', async (c, next) => {
    await next();
    if (!c.req.path.startsWith('/api/')) c.header('cache-control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  });
  app.use('/assets/*', serveStatic({ root: rel }));
  app.use('/*', serveStatic({ root: rel }));
  app.get('*', (c) => c.html(readFileSync(join(dist, 'index.html'), 'utf8')));
}

await falkor();
startProactive();
if (!config.hosted) void resumeRelays(localBase);
serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST || '0.0.0.0' }, (i) => {
  // never log credentials: the FalkorDB URL can carry a password
  const db = config.falkorUrl.replace(/\/\/[^@/]*@/, '//***@');
  console.log(`ZivBot on http://localhost:${i.port} · FalkorDB ${db} · brain: ${brainName()}`);
});
