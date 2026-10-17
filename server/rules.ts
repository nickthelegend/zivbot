import type { UserGraph } from './graph.ts';
import { upsertNodes, link } from './ingest.ts';
import { postMessage, getDot, listDots } from './memory.ts';
import { publish } from './bus.ts';
import { uid, HOUR } from './util.ts';
import type { Card } from './tools.ts';

/**
 * Watch rules: procedural memory that acts. Each rule is a named graph
 * pattern (Cypher) stored as a :Rule node owned by a dot. The background loop
 * evaluates every active rule; a match the rule hasn't fired on yet becomes a
 * message with a ready-made action, and (:Rule)-[:FIRED_ON]->(entity) makes
 * sure it never repeats.
 */

type Match = { uid: string; text: string; action?: { label: string; value: string } };
type Kind = {
  title: string;
  says: string;
  keywords: RegExp;
  defaults: Record<string, number>;
  cypher: string;
  params?: (p: Record<string, number>) => Record<string, unknown>;
  toMatch: (r: any) => Match;
};

export const RULE_KINDS: Record<string, Kind> = {
  customer_chasing: {
    title: 'A customer chases without a reply',
    says: 'when a customer has written {min}+ times on a thread nobody answered',
    keywords: /\b(customer|client)s?\b.*\b(chas|follow(s|ing)? up|email(s|ed)? (twice|again)|keeps? writing|no reply|unanswered)/i,
    defaults: { min: 2 },
    cypher: `MATCH (t:Thread {awaitingReply: true})<-[:IN_THREAD]-(e:Email)-[:FROM]->(p:Person)-[:WORKS_AT]->(o:Org {kind: 'customer'})
             WITH t, o, p, count(e) AS n WHERE n >= $min
             RETURN t.uid AS uid, t.subject AS subject, o.name AS org, p.name AS who, n`,
    toMatch: (r) => ({ uid: r.uid, text: `${r.org} has written ${r.n} times about "${r.subject}" and nobody replied`, action: { label: `Draft a reply to ${r.who.split(' ')[0]}`, value: `Draft a reply to ${r.who}` } }),
  },
  stale_p1: {
    title: 'A P1 sits with no fix in progress',
    says: 'when a P1 has been open {hours}h+ with no coding run on it',
    keywords: /\b(p1|incident|sev ?1|urgent ticket)s?\b.*\b(sit|stale|open|nobody|no (one|fix)|stuck)/i,
    defaults: { hours: 2 },
    cypher: `MATCH (t:Ticket {status: 'open', priority: 'P1'}) WHERE t.at < $cutoff
             OPTIONAL MATCH (t)<-[:FOR_TICKET]-(r:Run)
             WITH t, count(r) AS runs WHERE runs = 0
             OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person)
             RETURN t.uid AS uid, t.key AS key, t.title AS title, a.name AS who`,
    params: (p) => ({ cutoff: Date.now() - p.hours * HOUR }),
    toMatch: (r) => ({ uid: r.uid, text: `${r.key} (${r.title}) is a P1 with no fix in progress${r.who ? ` — on ${r.who}'s plate` : ''}`, action: { label: `Fix ${r.key} with my agents`, value: `Fix ${r.key}` } }),
  },
  pending_decision: {
    title: 'A decision waits too long',
    says: 'when a decision has waited on me for {hours}h+',
    keywords: /\bdecisions?\b.*\b(wait|pending|stuck|open|too long)/i,
    defaults: { hours: 12 },
    cypher: `MATCH (d:Decision {status: 'pending'})-[:AWAITS]->(:Person {me: true}) WHERE d.at < $cutoff
             OPTIONAL MATCH (d)-[:RAISED_BY]->(p:Person)
             RETURN d.uid AS uid, d.text AS text, p.name AS who`,
    params: (p) => ({ cutoff: Date.now() - p.hours * HOUR }),
    toMatch: (r) => ({ uid: r.uid, text: `"${r.text}" has been waiting on you${r.who ? ` (raised by ${r.who})` : ''}`, action: { label: 'Show me the stakes', value: `Help me decide: ${r.text}` } }),
  },
  failed_run: {
    title: 'A coding run failed and nobody retried',
    says: 'when one of my coding agents fails and no other agent picked it up',
    keywords: /\b(run|agent|codex|claude|build|fix)\b.*\b(fail|break|error)/i,
    defaults: {},
    cypher: `MATCH (r:Run {status: 'failed'})-[:EXECUTED_BY]->(a:Agent) WHERE NOT coalesce(r.synthetic, false)
             OPTIONAL MATCH (r)-[:HANDED_OFF_TO]->(n:Run)
             WITH r, a, count(n) AS retries WHERE retries = 0
             OPTIONAL MATCH (r)-[:FOR_TICKET]->(t:Ticket)
             RETURN r.uid AS uid, r.goal AS goal, a.name AS agent, collect(t.key) AS keys`,
    toMatch: (r) => ({ uid: r.uid, text: `${r.agent} failed "${r.goal}" and nothing retried it`, action: r.keys.length ? { label: 'Retry with OpenCode', value: `Fix ${r.keys.join(' and ')} with OpenCode` } : undefined }),
  },
  customer_on_incident: {
    title: 'An open P1 reaches a customer',
    says: 'when an open P1 is on (or upstream of) a system a customer uses',
    keywords: /\b(p1|incident|outage)\b.*\b(customer|client)/i,
    defaults: {},
    cypher: `MATCH (t:Ticket {status: 'open', priority: 'P1'})-[:AFFECTS]->(s:System)
             MATCH (s)<-[:DEPENDS_ON*0..3]-(:System)<-[:USES]-(o:Org {kind: 'customer'})
             WITH t, collect(DISTINCT o.name) AS customers, sum(DISTINCT o.arr) AS arr
             RETURN t.uid AS uid, t.key AS key, customers, arr`,
    toMatch: (r) => ({ uid: r.uid, text: `${r.key} reaches ${r.customers.join(', ')} ($${Math.round(r.arr / 1000)}k ARR)`, action: { label: `Fix ${r.key}`, value: `Fix ${r.key}` } }),
  },
};

export function kindFromText(text: string): string | null {
  for (const [k, v] of Object.entries(RULE_KINDS)) if (v.keywords.test(text)) return k;
  return null;
}

const describe = (k: Kind, p: Record<string, number>) => k.says.replace(/\{(\w+)\}/g, (_, x) => String(p[x] ?? k.defaults[x]));

export async function createRule(g: UserGraph, kind: string, opts: { dot?: string; params?: Record<string, number>; text?: string } = {}) {
  const k = RULE_KINDS[kind];
  if (!k) throw new Error(`Unknown rule ${kind}. Try: ${Object.keys(RULE_KINDS).join(', ')}`);
  const params = { ...k.defaults, ...(opts.params || {}) };
  const existing = await g.one(`MATCH (r:Rule {kind: $k}) RETURN r.uid AS uid`, { k: kind }, '~existing rule');
  const ru = existing?.uid || uid('rule');
  await upsertNodes(g, 'Rule', [{ uid: ru, props: { name: k.title, kind, params: JSON.stringify(params), says: describe(k, params), text: opts.text, active: true, createdAt: Date.now() }, search: `rule ${k.title} ${opts.text || ''}` }]);
  const dot = opts.dot || (await listDots(g))[0]?.uid;
  if (dot) await link(g, 'Rule', 'OWNED_BY', 'Dot', [{ from: ru, to: dot }]);
  return ru;
}

export async function listRules(g: UserGraph) {
  return g.q(
    `MATCH (r:Rule) OPTIONAL MATCH (r)-[f:FIRED_ON]->() OPTIONAL MATCH (r)-[:OWNED_BY]->(d:Dot)
     RETURN r.uid AS uid, r.kind AS kind, r.name AS title, r.says AS says, r.active AS active, r.createdAt AS createdAt, d.name AS dot, count(f) AS fired, max(f.at) AS lastFired
     ORDER BY r.createdAt`,
    {},
    'watch rules',
  );
}

export async function setRuleActive(g: UserGraph, ruleUid: string, active: boolean) {
  await g.q(`MATCH (r:Rule {uid: $u}) SET r.active = $a`, { u: ruleUid, a: active }, 'toggle rule');
}

/** Evaluate active rules; post new matches into the owning dot's chat. Returns the matches posted. */
export async function evaluateRules(userId: string, g: UserGraph, only?: string, background = false) {
  const rules = await g.q(`MATCH (r:Rule) WHERE r.active AND ($only = '' OR r.uid = $only) OPTIONAL MATCH (r)-[:OWNED_BY]->(d:Dot) RETURN r.uid AS uid, r.kind AS kind, r.params AS params, d.uid AS dot`, { only: only ?? '' }, '~active rules');
  const fired: { rule: string; matches: Match[] }[] = [];
  for (const r of rules) {
    const k = RULE_KINDS[r.kind];
    if (!k) continue;
    const p = { ...k.defaults, ...JSON.parse(r.params || '{}') };
    const rows = await g.q(k.cypher, { ...p, ...(k.params ? k.params(p) : {}) }, `rule: ${k.title}`);
    const seen = new Set((await g.q(`MATCH (:Rule {uid: $u})-[:FIRED_ON]->(x) RETURN x.uid AS uid`, { u: r.uid }, '~already fired')).map((x) => x.uid));
    const fresh = rows.map(k.toMatch).filter((m) => m.uid && !seen.has(m.uid));
    if (!fresh.length) continue;
    await g.q(`MATCH (r:Rule {uid: $u}) UNWIND $m AS x MATCH (n {uid: x}) MERGE (r)-[f:FIRED_ON]->(n) SET f.at = $now`, { u: r.uid, m: fresh.map((m) => m.uid), now: Date.now() }, 'remember what this rule fired on');
    fired.push({ rule: r.uid, matches: fresh });
    const dot = r.dot ? await getDot(g, r.dot) : (await listDots(g))[0];
    if (!dot?.conv) continue;
    const actions = fresh.map((m) => m.action).filter(Boolean) as { label: string; value: string }[];
    const cards: Card[] = [{ type: 'list', title: `Watch rule · ${k.title}`, items: fresh.map((m) => ({ title: m.text, uid: m.uid, badge: 'rule', tone: 'amber' })) }];
    if (actions.length) cards.push({ type: 'options', question: 'Want me to act on it?', options: actions.slice(0, 3).map((a, i) => ({ key: String.fromCharCode(65 + i), label: a.label, value: a.value })) });
    await postMessage(userId, g, { conv: dot.conv, role: 'assistant', dot: dot.uid, proactive: background, text: `Your watch rule fired — ${describe(k, p)}:`, cards });
  }
  if (fired.length) publish(userId, { type: 'rules' });
  return fired;
}
