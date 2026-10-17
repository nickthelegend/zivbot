import type { UserGraph } from './graph.ts';

/**
 * The story of anything: every time-stamped node one or two hops from an
 * entity (mail, chat, commits, tickets, decisions, runs, approvals, meetings),
 * with who acted, in order. Two hops go only through "aboutness" edges
 * (MENTIONS, ABOUT, FOR_TICKET, RESOLVES, SOURCE, IN_THREAD) so the story stays on topic.
 */

export type TimelineItem = { uid: string; at: number; label: string; name: string; rel: string; who?: string; detail?: string; hop: number };

const STAMP = `coalesce(n.decidedAt, n.at, n.start, n.startedAt, n.approvedAt)`;
const SKIP = `NOT (n:Episode OR n:Answer OR n:Conversation OR n:Notice OR n:Dot OR n:Agent)`;

export async function timeline(g: UserGraph, uid: string, limit = 40): Promise<TimelineItem[]> {
  const own = await g.one(
    `MATCH (x {uid: $u}) RETURN x.name AS name, [l IN labels(x) WHERE NOT l IN ['Searchable','Memorable']][0] AS label,
            x.at AS at, x.resolvedAt AS resolvedAt, x.decidedAt AS decidedAt, x.status AS status, x.start AS start`,
    { u: uid },
    '~the entity itself',
  );
  if (!own) return [];
  const one = await g.q(
    `MATCH (x {uid: $u})-[r]-(n) WHERE ${SKIP} AND ${STAMP} IS NOT NULL
     RETURN n.uid AS uid, ${STAMP} AS at, [l IN labels(n) WHERE NOT l IN ['Searchable','Memorable']][0] AS label, n.name AS name, type(r) AS rel,
            coalesce(n.status, '') AS status, coalesce(n.body, n.text, n.goal, '') AS detail`,
    { u: uid },
    'timeline: time-stamped neighbours',
  );
  const two = await g.q(
    `MATCH (x {uid: $u})-[:MENTIONS|ABOUT|FOR_TICKET|RESOLVES|SOURCE|IN_THREAD|FOR|AFFECTS]-(m)-[r:MENTIONS|ABOUT|FOR_TICKET|RESOLVES|SOURCE|IN_THREAD|BECAME]-(n)
     WHERE n <> x AND ${SKIP} AND ${STAMP} IS NOT NULL AND (m:Ticket OR m:Thread OR m:Decision OR m:Run OR m:Draft OR m:Email)
     RETURN DISTINCT n.uid AS uid, ${STAMP} AS at, [l IN labels(n) WHERE NOT l IN ['Searchable','Memorable']][0] AS label, n.name AS name, type(r) AS rel,
            coalesce(n.status, '') AS status, coalesce(n.body, n.text, n.goal, '') AS detail
     LIMIT 80`,
    { u: uid },
    'timeline: two hops through what it is about',
  );
  const items = new Map<string, TimelineItem>();
  for (const r of [...one.map((x) => ({ ...x, hop: 1 })), ...two.map((x) => ({ ...x, hop: 2 }))]) {
    if (!items.has(r.uid)) items.set(r.uid, { uid: r.uid, at: r.at, label: r.label, name: r.name, rel: r.rel, detail: r.detail ? String(r.detail).slice(0, 160) : undefined, hop: r.hop });
  }
  // who acted on each item
  const uids = [...items.keys()];
  if (uids.length) {
    const actors = await g.q(
      `UNWIND $u AS id MATCH (n {uid: id})
       OPTIONAL MATCH (n)-[:FROM|AUTHORED_BY|DECIDED_BY|REPORTED_BY|EXECUTED_BY|APPROVED_BY|BY]->(a)
       OPTIONAL MATCH (b:Person)-[:POSTED]->(n)
       RETURN id, coalesce(b.name, a.name) AS who`,
      { u: uids },
      'timeline: who acted',
    );
    for (const a of actors) { const it = items.get(a.id); if (it && a.who && !it.who) it.who = a.who; }
  }
  const out = [...items.values()];
  // the entity's own milestones
  if (own.at) out.push({ uid, at: own.at, label: own.label, name: `${own.name} — created`, rel: 'SELF', hop: 0 });
  if (own.resolvedAt) out.push({ uid, at: own.resolvedAt, label: own.label, name: `${own.name} — resolved`, rel: 'SELF', hop: 0 });
  if (own.decidedAt) out.push({ uid, at: own.decidedAt, label: own.label, name: `${own.name} — decided`, rel: 'SELF', hop: 0 });
  return out.filter((i) => i.at).sort((a, b) => a.at - b.at).slice(-limit);
}
