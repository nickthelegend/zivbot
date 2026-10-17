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
