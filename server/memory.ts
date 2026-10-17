import type { UserGraph } from './graph.ts';
import { upsertNodes, link, linkAny, loadDictionary, mentionsIn } from './ingest.ts';
import { publish } from './bus.ts';
import { uid } from './util.ts';
import type { Card } from './tools.ts';
import { scheduleEmbed } from './semantic.ts';

/**
 * Agent memory, all in the user's graph:
 *  - Dots (agents) are MEMBER_OF conversations: their direct chat with you,
 *    group chats, and dot↔dot exchanges.
 *  - Episodic: every message is an :Episode IN a conversation, BY a dot,
 *    chained with NEXT and linked to the entities it MENTIONS — so "what did
 *    we say about Brightwave" is a traversal, across every dot.
 *  - Answers: provenance for each reply (USED → the nodes it was built from).
 * Facts and Procedures (semantic / procedural memory) come from the remember tool.
 */

export type Role = 'user' | 'assistant' | 'system' | 'agent';
export type Message = { uid: string; conv: string; role: Role; text: string; cards?: Card[]; at: number; answer?: string; dot?: string; proactive?: boolean };

export const DOT_PRESETS = [
  { name: 'Ziv', avatar: 'ziv', color: '#ff7a1a', role: 'Chief of staff — triages everything, decides what to act on, and coordinates the other dots' },
  { name: 'Forge', avatar: 'forge', color: '#22d3ee', role: 'Engineering lead — turns tickets into fixes with your coding-agent subscriptions' },
  { name: 'Scout', avatar: 'scout', color: '#a78bfa', role: 'Researcher — answers questions from the company graph and the web, writes briefs' },
  { name: 'Ledger', avatar: 'ledger', color: '#34d399', role: 'Customer & finance — keeps customers happy, invoices right, and investors updated' },
];

export async function listDots(g: UserGraph) {
  return g.q(
    `MATCH (d:Dot)
     OPTIONAL MATCH (d)-[:MEMBER_OF]->(c:Conversation {kind:'direct'})
     OPTIONAL MATCH (c)-[:LAST]->(e:Episode)
     RETURN d.uid AS uid, d.name AS name, d.avatar AS avatar, d.role AS role, d.stage AS stage, d.color AS color, d.createdAt AS createdAt,
            c.uid AS conv, e.text AS lastText, e.at AS lastAt
     ORDER BY d.createdAt`,
    {},
    '~list dots',
  );
}

export async function listConversations(g: UserGraph) {
  return g.q(
    `MATCH (c:Conversation) WHERE c.kind IN ['direct','group']
     MATCH (d:Dot)-[:MEMBER_OF]->(c)
     WITH c, collect(d) AS ds
     OPTIONAL MATCH (c)-[:LAST]->(l:Episode)
     WITH c, ds, max(l.at) AS lastAt
     OPTIONAL MATCH (c)-[:LAST]->(e:Episode) WHERE e.at = lastAt
     OPTIONAL MATCH (e)-[:BY]->(by:Dot)
     UNWIND ds AS d
     WITH c, e, by, collect({uid: d.uid, name: d.name, avatar: d.avatar, color: d.color, stage: d.stage}) AS dots
     RETURN c.uid AS uid, c.kind AS kind, c.name AS name, c.createdAt AS createdAt, dots, e.text AS lastText, e.at AS lastAt, e.role AS lastRole, by.name AS lastBy, coalesce(c.unread, 0) AS unread
     ORDER BY coalesce(e.at, c.createdAt) DESC`,
    {},
    'list conversations',
  );
}

export async function createDot(g: UserGraph, p: { name: string; avatar: string; role: string; color?: string; stage?: string }) {
  const d = uid('dot');
  const c = uid('conv');
  await upsertNodes(g, 'Dot', [{ uid: d, props: { name: p.name, avatar: p.avatar, role: p.role, color: p.color, stage: p.stage || 'ready', createdAt: Date.now() }, search: `${p.name} dot agent ${p.role}` }]);
  await upsertNodes(g, 'Conversation', [{ uid: c, props: { name: p.name, kind: 'direct', createdAt: Date.now() } }], false);
  await link(g, 'Dot', 'MEMBER_OF', 'Conversation', [{ from: d, to: c }]);
  return { dot: d, conv: c };
}

export async function createGroup(g: UserGraph, dots: string[], name?: string) {
  const c = uid('conv');
  const names = await g.q(`MATCH (d:Dot) WHERE d.uid IN $d RETURN d.name AS n`, { d: dots });
  await upsertNodes(g, 'Conversation', [{ uid: c, props: { name: name || names.map((n) => n.n).join(', '), kind: 'group', createdAt: Date.now() } }], false);
  await link(g, 'Dot', 'MEMBER_OF', 'Conversation', dots.map((d) => ({ from: d, to: c })));
  return c;
}

/** The dot↔dot exchange conversation between two dots (created on first contact). */
export async function exchangeBetween(g: UserGraph, a: string, b: string) {
  const hit = await g.one(
    `MATCH (:Dot {uid:$a})-[:MEMBER_OF]->(c:Conversation {kind:'exchange'})<-[:MEMBER_OF]-(:Dot {uid:$b}) RETURN c.uid AS uid`,
    { a, b },
    '~find dot↔dot exchange',
  );
  if (hit) return hit.uid as string;
  const c = uid('xchg');
  await upsertNodes(g, 'Conversation', [{ uid: c, props: { name: 'exchange', kind: 'exchange', createdAt: Date.now() } }], false);
  await link(g, 'Dot', 'MEMBER_OF', 'Conversation', [{ from: a, to: c }, { from: b, to: c }]);
  return c;
}

export async function updateDot(g: UserGraph, dot: string, props: Record<string, unknown>) {
  await g.q(`MATCH (d:Dot {uid:$d}) SET d += $p`, { d: dot, p: props }, '~update dot');
  if (props.name) await g.q(`MATCH (d:Dot {uid:$d})-[:MEMBER_OF]->(c:Conversation {kind:'direct'}) SET c.name = $n`, { d: dot, n: props.name });
}

export async function getDot(g: UserGraph, dot: string) {
  return g.one(
    `MATCH (d:Dot {uid:$d}) OPTIONAL MATCH (d)-[:MEMBER_OF]->(c:Conversation {kind:'direct'})
     RETURN d.uid AS uid, d.name AS name, d.avatar AS avatar, d.role AS role, d.stage AS stage, d.color AS color, c.uid AS conv`,
    { d: dot },
    '~load dot',
  );
}

export async function getConversation(g: UserGraph, conv: string) {
  return g.one(
    `MATCH (c:Conversation {uid:$c}) OPTIONAL MATCH (d:Dot)-[:MEMBER_OF]->(c)
     RETURN c.uid AS uid, c.kind AS kind, c.name AS name, collect({uid: d.uid, name: d.name, role: d.role, stage: d.stage, avatar: d.avatar, color: d.color}) AS dots`,
    { c: conv },
    '~load conversation',
  );
}

/** Appends to one conversation are serialized so the LAST/NEXT chain stays a single list. */
const convLocks = new Map<string, Promise<unknown>>();
export function postMessage(userId: string, g: UserGraph, m: Omit<Message, 'uid' | 'at'> & { at?: number }): Promise<Message> {
  const key = `${g.name}|${m.conv}`;
  const prev = convLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => appendMessage(userId, g, m));
  convLocks.set(key, next);
  void next.finally(() => { if (convLocks.get(key) === next) convLocks.delete(key); }).catch(() => {});
  return next;
}

async function appendMessage(userId: string, g: UserGraph, m: Omit<Message, 'uid' | 'at'> & { at?: number }): Promise<Message> {
  const msg: Message = { ...m, uid: uid('ep'), at: m.at ?? Date.now() };
  const props: Record<string, unknown> = { name: msg.text.slice(0, 80), text: msg.text, role: msg.role, at: msg.at, cards: msg.cards?.length ? JSON.stringify(msg.cards) : undefined, answer: msg.answer, proactive: msg.proactive };
  await g.q(
    `MATCH (c:Conversation {uid:$conv})
     CREATE (e:Episode:Searchable {uid:$uid}) SET e += $props, e.search = $search
     CREATE (e)-[:IN]->(c)`,
    { conv: msg.conv, uid: msg.uid, props: Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)), search: msg.text },
    '~append episode',
  );
  const prev = await g.one(`MATCH (c:Conversation {uid:$c})-[l:LAST]->(p:Episode) DELETE l RETURN p.uid AS uid`, { c: msg.conv }, '~unlink last');
  await g.q(`MATCH (c:Conversation {uid:$c}), (e:Episode {uid:$e}) CREATE (c)-[:LAST]->(e)`, { c: msg.conv, e: msg.uid }, '~link last');
  if (prev?.uid) await g.q(`MATCH (p:Episode {uid:$p}), (e:Episode {uid:$e}) CREATE (p)-[:NEXT]->(e)`, { p: prev.uid, e: msg.uid }, '~chain episode');
  if (msg.dot) await link(g, 'Episode', 'BY', 'Dot', [{ from: msg.uid, to: msg.dot }]);
  if (msg.role !== 'system') {
    const dict = await loadDictionary(g);
    await linkAny(g, 'Episode', 'MENTIONS', mentionsIn(dict, msg.text).map((to) => ({ from: msg.uid, to })));
  }
  if (msg.answer) await link(g, 'Episode', 'ANSWERED_WITH', 'Answer', [{ from: msg.uid, to: msg.answer }]);
  // @mentions of dots and plugins are edges too
  if (msg.role === 'user' && msg.text.includes('@')) {
    await g.q(
      `MATCH (e:Episode {uid:$e})
       MATCH (x) WHERE (x:Dot OR x:Connector) AND toLower($t) CONTAINS ('@' + toLower(x.name))
       MERGE (e)-[:MENTIONS]->(x)`,
      { e: msg.uid, t: msg.text },
      '~link @mentions',
    );
  }
  if (msg.role !== 'user') await g.q(`MATCH (c:Conversation {uid:$c}) SET c.unread = coalesce(c.unread, 0) + 1`, { c: msg.conv });
  publish(userId, { type: 'message', message: msg });
  if (msg.role !== 'system') scheduleEmbed(g);
  return msg;
}

export async function markRead(g: UserGraph, conv: string) {
  await g.q(`MATCH (c:Conversation {uid:$c}) SET c.unread = 0`, { c: conv }, '~mark read');
}

export async function history(g: UserGraph, conv: string, limit = 200): Promise<Message[]> {
  const rows = await g.q(
    `MATCH (c:Conversation {uid:$conv})<-[:IN]-(e:Episode)
     OPTIONAL MATCH (e)-[:BY]->(d:Dot)
     RETURN e.uid AS uid, e.role AS role, e.text AS text, e.cards AS cards, e.at AS at, e.answer AS answer, e.proactive AS proactive, d.uid AS dot
     ORDER BY e.at DESC LIMIT $limit`,
    { conv, limit },
    '~conversation history',
  );
  return rows.reverse().map((r) => ({ ...r, conv, cards: r.cards ? JSON.parse(r.cards) : undefined }));
}

/** Recent turns + memories related to what was just said — the dot's working context. */
export async function workingContext(g: UserGraph, conv: string, text: string) {
  const recent = (await history(g, conv, 12)).filter((m) => m.role !== 'system');
  const dict = await loadDictionary(g);
  const about = mentionsIn(dict, text);
  const memories = await g.q(
    `MATCH (m) WHERE (m:Fact OR m:Procedure) AND m.status = 'active'
     OPTIONAL MATCH (m)-[:ABOUT]->(x)
     WITH m, collect(x.uid) AS xs
     WHERE m:Procedure OR any(u IN xs WHERE u IN $about)
     RETURN [l IN labels(m) WHERE l <> 'Searchable'][0] AS kind, m.text AS text ORDER BY m.at DESC LIMIT 12`,
    { about },
    '~memories relevant to this turn',
  );
  const earlier = about.length
    ? await g.q(
      `MATCH (e:Episode)-[:MENTIONS]->(x) WHERE x.uid IN $about AND NOT (e)-[:IN]->(:Conversation {uid:$conv})
       OPTIONAL MATCH (e)-[:BY]->(d:Dot)
       RETURN e.role AS role, e.text AS text, e.at AS at, d.name AS dot ORDER BY e.at DESC LIMIT 5`,
      { about, conv },
      '~earlier conversations about the same things (any dot)',
    )
    : [];
  return { recent, memories, earlier, about };
}

export async function recordAnswer(g: UserGraph, p: { question: string; dot: string; touched: string[]; queries: unknown[]; tools: string[]; mode: string }) {
  const a = uid('answer');
  await upsertNodes(g, 'Answer', [{ uid: a, props: { name: p.question.slice(0, 80), question: p.question, at: Date.now(), queries: JSON.stringify(p.queries), tools: p.tools, mode: p.mode } }], false);
  await link(g, 'Answer', 'BY', 'Dot', [{ from: a, to: p.dot }]);
  const used = p.touched.filter((u) => !/^(ep|answer|conv|xchg):/.test(u)).slice(0, 150);
  if (used.length) {
    await g.q(`MATCH (a:Answer {uid:$a}) UNWIND $u AS x MATCH (n {uid:x}) MERGE (a)-[:USED]->(n)`, { a, u: used }, '~answer provenance');
  }
  return a;
}
