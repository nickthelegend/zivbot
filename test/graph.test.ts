// Integration tests against a real FalkorDB (FALKORDB_URL, default localhost:6379).
// Each run ingests the synthetic workspace into a throwaway graph and drops it after.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { userGraph, falkor, withTrace, type Trace, type UserGraph } from '../server/graph.ts';
import { ensureSchema } from '../server/schema.ts';
import { ingestDirectory, ingestTickets, ingestMail, ingestCalendar, ingestSlack, ingestNotion } from '../server/connectors/workspace.ts';
import { syncFleet, seedRunHistory, routeJob } from '../server/fleet.ts';
import { enrich } from '../server/analytics.ts';
import { toolByName } from '../server/tools.ts';
import { createDot } from '../server/memory.ts';

const USER = `test${Date.now().toString(36)}`;
let g: UserGraph;
let dot: string;
const run = (name: string, args: Record<string, unknown> = {}) => toolByName(name)!.run({ g, userId: USER, dot }, args);

before(async () => {
  g = await userGraph(USER);
  await ensureSchema(g);
  await ingestDirectory(g, { name: 'Test User' });
  await ingestTickets(g);
  await ingestMail(g);
  await ingestCalendar(g);
  await ingestSlack(g);
  await ingestNotion(g);
  await syncFleet(g);
  await seedRunHistory(g);
  await enrich(g);
  dot = (await createDot(g, { name: 'Ziv', avatar: 'ziv', role: 'Chief of staff' })).dot;
});

after(async () => {
  await g.drop();
  await (await falkor()).close();
});

test('blast radius follows DEPENDS_ON multi-hop and prices the customers exposed', async () => {
  const r = await run('blast_radius', { ref: 'billing-db' });
  const d = r.data as any;
  const names = d.dependents.map((x: any) => x.name);
  assert.ok(names.includes('payments-api'));
  assert.ok(names.includes('checkout-web'), 'two hops away');
  assert.equal(d.dependents.find((x: any) => x.name === 'checkout-web').hops, 2);
  assert.equal(d.arr, 184000 + 62000);
});

test('who knows ranks the person with commits, docs and tickets first', async () => {
  const r = await run('who_knows', { ref: 'payments-api' });
  assert.equal((r.data as any)[0].name, 'Priya Raman');
});

test('triage puts the P1 with the most ARR at risk first and finds the calendar clash', async () => {
  const d = (await run('triage')).data as any;
  assert.equal(d.incidents[0].key, 'LUM-142');
  assert.ok(d.threads.some((t: any) => t.sender === 'Kate Morgan'));
  assert.equal(d.conflicts.length, 1);
  assert.equal(d.decisions.length, 2);
});

test('decision trace reaches the Slack message and the Notion RFC', async () => {
  const d = (await run('decision_trace', { topic: 'Stripe Billing' })).data as any[];
  const stripe = d.find((x) => x.text.includes('Chargebee to Stripe'));
  assert.equal(stripe.by, 'Priya Raman');
  assert.equal(stripe.approvedBy, 'Marcus Webb');
  const sources = stripe.sources.map((s: any) => s.source).sort();
  assert.deepEqual(sources, ['notion', 'slack']);
});

test('connection path finds the customer → ticket → engineer chain', async () => {
  const rows = (await run('connection_path', { from: 'Kate Morgan', to: 'Priya Raman' })).data as any[];
  assert.ok(rows.some((r) => r.rels.includes('ASSIGNED_TO')));
});

test('PageRank and label propagation are written onto people', async () => {
  const rows = await g.q(`MATCH (p:Person) WHERE p.rank IS NOT NULL AND p.community IS NOT NULL RETURN count(p) AS n`);
  assert.ok(rows[0].n >= 10);
});

test('routing prefers proven agents and honours a stated preference', async () => {
  const before = await routeJob(g, ['system:payments-api']);
  const claude = before.find((c) => c.kind === 'claude-code')!;
  assert.ok(claude.reasons.some((r) => r.includes('successful run')));
  await run('remember', { text: 'always prefer Grok for backend fixes', kind: 'procedure' });
  const after = await routeJob(g, ['system:payments-api']);
  const grok = after.find((c) => c.kind === 'grok')!;
  assert.ok(grok.reasons.includes('you said you prefer it'));
  assert.ok(grok.score > before.find((c) => c.kind === 'grok')!.score);
});

test('every tool call is traced: queries plus the nodes the answer used', async () => {
  const trace: Trace = { queries: [], touched: new Set() };
  await withTrace(trace, () => run('who_knows', { ref: 'billing-db' }));
  assert.ok(trace.queries.filter((q) => !q.internal).length >= 5);
  assert.ok(trace.touched.has('person:priya'));
  assert.ok(trace.touched.has('system:billing-db'));
});

test('run_cypher refuses writes', async () => {
  const r = await run('run_cypher', { cypher: 'MATCH (n) DETACH DELETE n' });
  assert.match(r.text, /read-only/);
  assert.ok((await g.q(`MATCH (n:Person) RETURN count(n) AS n`))[0].n > 0);
});

test('semantic memory: vector search finds meaning, then the graph says what it is about', async () => {
  const { embedPending } = await import('../server/semantic.ts');
  const n = await embedPending(g, 2000);
  assert.ok(n > 30, `embedded ${n} nodes`);
  const r = await run('semantic_search', { query: 'the customer portal invoice page is really slow to load' });
  const d = r.data as any;
  assert.ok(d.hits.length > 0);
  const aboutAll = d.hits.flatMap((h: any) => h.about.map((a: any) => a.name));
  assert.ok(aboutAll.some((x: string) => /LUM-142|LUM-139|Brightwave|checkout-web|payments-api/.test(x)), aboutAll.join(', '));
  const idx = await g.q(`CALL db.indexes() YIELD label, types RETURN label, types`);
  assert.ok(idx.some((i: any) => i.label === 'Memorable'));
});

test('insights: bus factor, single points of failure and who is waiting come from the graph', async () => {
  const { insights } = await import('../server/insights.ts');
  const secs = await insights(g);
  const by = (k: string) => secs.find((s) => s.key === k)!;
  assert.ok(by('bus').items.some((i) => i.title.startsWith('auth-service')), 'auth-service has a bus factor of 1');
  const spof = by('spof').items[0];
  assert.match(spof.title, /auth-service holds up 6 systems/);
  assert.ok(spof.uids.includes('system:mobile-app') && spof.uids.includes('org:kestrel'));
  assert.ok(by('waiting').items.some((i) => i.title.startsWith('Kate Morgan')));
  assert.ok(!by('waiting').items.some((i) => i.title.startsWith('Daniel Ross')), 'a thank-you is not waiting on a reply');
});

test('planner: "help me decide" shows the stakes but never decides; an explicit choice does', async () => {
  const { plan } = await import('../server/planner.ts');
  const ctx = { g, userId: USER, dot };
  const r = await plan(ctx, 'Help me decide: Drop Helios v1 support or delay the EU launch');
  assert.ok(r.cards.some((c) => c.type === 'options'));
  assert.match(r.text, /What this decision touches/);
  assert.equal((await g.one(`MATCH (d:Decision {uid:'decision:d-helios-v1'}) RETURN d.status AS s`)).s, 'pending');
  await plan(ctx, 'Confirm Oct 28');
  assert.equal((await g.one(`MATCH (d:Decision {uid:'decision:d-cutover'}) RETURN d.status AS s, d.choice AS c`)).c, 'Confirm Oct 28');
});

test('graph algorithms as tools: PageRank, betweenness, WCC, BFS reach, weighted shortest path', async () => {
  const { runAlgorithm } = await import('../server/algorithms.ts');
  const pr = await runAlgorithm(g, { algorithm: 'pagerank', label: 'System', rel: 'DEPENDS_ON' });
  assert.equal(pr.rows[0].name, 'auth-service');
  const bw = await runAlgorithm(g, { algorithm: 'betweenness', label: 'System', rel: 'DEPENDS_ON' });
  assert.equal(bw.rows[0].name, 'payments-api');
  const wcc = await runAlgorithm(g, { algorithm: 'components', label: 'System', rel: 'DEPENDS_ON' });
  assert.ok(wcc.rows.length >= 10);
  const reach = await runAlgorithm(g, { algorithm: 'reach', source: 'system:billing-db', rel: 'DEPENDS_ON', direction: 'in', depth: 4 });
  assert.deepEqual(reach.rows.map((r) => r.name).sort(), ['analytics-pipeline', 'checkout-web', 'data-warehouse', 'mobile-app', 'payments-api']);
  const sp = await runAlgorithm(g, { algorithm: 'shortest_path', source: 'system:mobile-app', target: 'system:billing-db', rel: 'DEPENDS_ON' });
  assert.deepEqual(sp.paths![0].names, ['mobile-app', 'payments-api', 'billing-db']);
  await assert.rejects(runAlgorithm(g, { algorithm: 'pagerank', label: 'Person) DETACH DELETE (x', rel: 'X' }), /Unknown label/);
});

test('graph-driven action: reassign a ticket to whoever knows the system with room to take it', async () => {
  const r = await run('propose_reassign', { ticket: 'LUM-139' });
  const d = r.data as any;
  assert.ok(d.best && d.best.uid !== 'person:raj', `best should not be the current owner, got ${d.best?.name}`);
  const draft = (r.cards || []).find((c: any) => c.type === 'draft') as any;
  const { approveDraft } = await import('../server/actions.ts');
  await approveDraft(USER, g, draft.draft.uid);
  const now = await g.one(`MATCH (:Ticket {uid:'ticket:LUM-139'})-[:ASSIGNED_TO]->(p:Person) RETURN collect(p.uid) AS who`);
  assert.deepEqual(now.who, [d.best.uid]);
  const prev = await g.one(`MATCH (:Ticket {uid:'ticket:LUM-139'})-[:PREVIOUSLY_ASSIGNED_TO]->(p:Person) RETURN p.uid AS uid`);
  assert.equal(prev.uid, 'person:raj');
});

test('meeting prep follows event → attendees → org → tickets, mail and unanswered threads', async () => {
  const { plan } = await import('../server/planner.ts');
  const r = await plan({ g, userId: USER, dot }, 'Prep me for the Brightwave QBR');
  assert.ok(r.tools.includes('meeting_prep'), r.tools.join(','));
  assert.match(r.text, /Brightwave QBR/);
  assert.match(r.text, /LUM-139/);
  assert.match(r.text, /Close the loop on "Duplicate line items on our September invoice"/);
  assert.ok(r.cards.some((c) => c.type === 'file'));
  const linked = await g.one(`MATCH (d:Doc)-[:PREPARES]->(:Event {uid:'event:bw-qbr'}) RETURN count(d) AS n`);
  assert.equal(linked.n, 1);
});

test('watch rules: a graph pattern fires once per match, as procedural memory', async () => {
  const { plan } = await import('../server/planner.ts');
  const { evaluateRules, listRules } = await import('../server/rules.ts');
  const r = await plan({ g, userId: USER, dot }, 'Tell me whenever a customer keeps writing with no reply');
  assert.ok(r.tools.includes('watch'), r.tools.join(','));
  assert.match(r.text, /already matches 1 thing/);
  const again = await evaluateRules(USER, g);
  assert.equal(again.length, 0, 'does not fire twice on the same thread');
  const p1 = await plan({ g, userId: USER, dot }, 'Alert me when a P1 sits with no fix for 1 hour');
  assert.match(p1.text, /P1 has been open 1h\+/);
  const rules = await listRules(g);
  assert.ok(rules.length >= 2 && rules.every((x: any) => x.active));
});

test('timeline: the story of a ticket in order, with who acted', async () => {
  const { timeline } = await import('../server/timeline.ts');
  const items = await timeline(g, 'ticket:LUM-139');
  assert.ok(items.length >= 4);
  for (let i = 1; i < items.length; i++) assert.ok(items[i].at >= items[i - 1].at, 'sorted by time');
  assert.equal(items[0].who, 'Kate Morgan', 'it starts with Kate writing in');
  assert.ok(items.some((i) => i.name.endsWith('— created')));
});
