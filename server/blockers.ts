// "What's blocking the EU launch?" — walk BLOCKED_BY upstream, collect the
// open work and pending decisions on every project in the chain plus the
// incidents on the systems they run on (through DEPENDS_ON), then find the
// root blockers: the things that, once done, unblock the most of the chain.
import type { UserGraph } from './graph.ts';

export type Blocker = {
  uid: string; kind: 'decision' | 'ticket' | 'incident'; title: string; key?: string; priority?: string;
  owner?: string; ownerUid?: string; waitsOnMe?: boolean;
  /** Node uids from this blocker down to the project asked about. */
  chain: string[]; chainNames: string[];
  gates: number; score: number;
};

export type CriticalPath = {
  project: { uid: string; name: string; status?: string; owner?: string };
  upstream: { uid: string; name: string; status?: string; depth: number }[];
  blockers: Blocker[];
  customers: { uid: string; name: string; arr: number }[];
  waiting: { uid: string; name: string }[];
};

const PRI: Record<string, number> = { P1: 3, P2: 2, P3: 1 };

export async function criticalPath(g: UserGraph, projectUid: string): Promise<CriticalPath | null> {
  const root = await g.one(
    `MATCH (p:Project {uid:$u}) OPTIONAL MATCH (o:Person)-[:OWNS]->(p) RETURN p.uid AS uid, p.name AS name, p.status AS status, o.name AS owner`,
    { u: projectUid },
    'the project',
  );
  if (!root) return null;

  // Every project this one waits on, with the route back to it.
  const chainRows = await g.q(
    `MATCH path = (r:Project {uid:$u})-[:BLOCKED_BY*1..4]->(x:Project)
     RETURN x.uid AS uid, x.name AS name, x.status AS status, length(path) AS depth, [n IN nodes(path) | n.uid] AS via, [n IN nodes(path) | n.name] AS names`,
    { u: projectUid },
    'projects upstream (BLOCKED_BY, up to 4 hops)',
  );
  const route = new Map<string, { via: string[]; names: string[]; depth: number }>([[root.uid, { via: [root.uid], names: [root.name], depth: 0 }]]);
  for (const r of chainRows) if (!route.has(r.uid) || route.get(r.uid)!.depth > r.depth) route.set(r.uid, { via: r.via, names: r.names, depth: r.depth });
  const ids = [...route.keys()];
  // A blocker on project X gates X and everything downstream of it on the route: depth + 1 projects.
  const toRoot = (uid: string) => { const r = route.get(uid)!; return { chain: [...r.via].reverse(), names: [...r.names].reverse(), gates: r.depth + 1 }; };

  const tickets = await g.q(
    `MATCH (t:Ticket)-[:PART_OF]->(x:Project) WHERE x.uid IN $ids AND t.status = 'open'
     OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person)
     RETURN t.uid AS uid, t.key AS key, t.title AS title, t.priority AS priority, x.uid AS project, a.name AS owner, a.uid AS ownerUid`,
    { ids },
    'open tickets on every project in the chain',
  );

  const incidents = await g.q(
    `MATCH (x:Project)-[:USES]->(s:System) WHERE x.uid IN $ids
     MATCH dp = (s)-[:DEPENDS_ON*0..3]->(d:System)<-[:AFFECTS]-(t:Ticket {status:'open'}) WHERE t.priority IN ['P1', 'P2']
     OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person)
     RETURN t.uid AS uid, t.key AS key, t.title AS title, t.priority AS priority, x.uid AS project, [n IN nodes(dp) WHERE n:System | n.name] AS systems, [n IN nodes(dp) WHERE n:System | n.uid] AS systemUids, a.name AS owner, a.uid AS ownerUid`,
    { ids },
    'open P1/P2 incidents on the systems the chain runs on (DEPENDS_ON 0-3 hops)',
  );

  const ticketUids = [...new Set([...tickets, ...incidents].map((t) => t.uid))];
  const decisions = await g.q(
    `MATCH (d:Decision {status:'pending'})-[:ABOUT]->(n) WHERE n.uid IN $ids OR n.uid IN $tickets
     OPTIONAL MATCH (d)-[:AWAITS]->(w:Person)
     RETURN d.uid AS uid, coalesce(d.text, d.name) AS title, collect(DISTINCT n.uid) AS about, w.name AS owner, w.uid AS ownerUid, coalesce(w.me, false) AS me`,
    { ids, tickets: ticketUids },
    'pending decisions on the chain or its tickets',
  );

  const out = new Map<string, Blocker>();
  const add = (b: Blocker) => { const prev = out.get(b.uid); if (!prev || prev.score < b.score) out.set(b.uid, b); };
  const ticketRoute = new Map<string, { chain: string[]; names: string[]; gates: number }>();

  for (const t of tickets) {
    const r = toRoot(t.project);
    const chain = { chain: [t.uid, ...r.chain], names: [t.key, ...r.names], gates: r.gates };
    if (!ticketRoute.has(t.uid) || ticketRoute.get(t.uid)!.gates < chain.gates) ticketRoute.set(t.uid, chain);
    add({ uid: t.uid, kind: 'ticket', title: t.title, key: t.key, priority: t.priority, owner: t.owner ?? undefined, ownerUid: t.ownerUid ?? undefined, ...chain, chainNames: chain.names, score: chain.gates * 2 + (PRI[t.priority] || 0) });
  }
  // shortest dependency route per ticket
  incidents.sort((a, b) => a.systems.length - b.systems.length);
  for (const t of incidents) {
    if (ticketRoute.has(t.uid)) continue; // already on the chain as planned work, or a shorter route
    const r = toRoot(t.project);
    const sys = [...(t.systems as string[])].reverse();
    const chain = { chain: [t.uid, ...[...(t.systemUids as string[])].reverse(), ...r.chain], names: [t.key, ...sys, ...r.names], gates: r.gates };
    ticketRoute.set(t.uid, chain);
    add({ uid: t.uid, kind: 'incident', title: t.title, key: t.key, priority: t.priority, owner: t.owner ?? undefined, ownerUid: t.ownerUid ?? undefined, ...chain, chainNames: chain.names, score: chain.gates * 2 + (PRI[t.priority] || 0) - 1 });
  }
  for (const d of decisions) {
    // Route a decision through the deepest thing it is about.
    let best: { chain: string[]; names: string[]; gates: number } | null = null;
    for (const a of d.about as string[]) {
      const c = ticketRoute.get(a) || (route.has(a) ? toRoot(a) : null);
      if (c && (!best || c.gates > best.gates || (c.gates === best.gates && c.chain.length > best.chain.length))) best = c;
    }
    if (!best) continue;
    const chain = [d.uid, ...best.chain];
    // a decision sits under the ticket it settles, so it gates everything that ticket gates
    add({ uid: d.uid, kind: 'decision', title: d.title, owner: d.me ? 'you' : d.owner ?? undefined, ownerUid: d.ownerUid ?? undefined, waitsOnMe: d.me, chain, chainNames: ['decision', ...best.names], gates: best.gates, score: best.gates * 2 + 3 + (d.me ? 1 : 0) });
  }

  const customers = await g.q(
    `MATCH (p:Project {uid:$u})-[:USES]->(s:System)
     MATCH (up:System)-[:DEPENDS_ON*0..3]->(s)
     MATCH (o:Org {kind:'customer'})-[:USES]->(up)
     RETURN DISTINCT o.uid AS uid, o.name AS name, coalesce(o.arr, 0) AS arr`,
    { u: projectUid },
    'customers on the systems this project ships to',
  );

  // People who asked about it and are still waiting for an answer.
  const waiting = await g.q(
    `MATCH (p:Project {uid:$u})<-[:MENTIONS]-(e:Email)-[:IN_THREAD]->(th:Thread {awaitingReply:true})
     MATCH (e)-[:FROM]->(w:Person) WHERE NOT coalesce(w.me, false)
     RETURN DISTINCT w.uid AS uid, w.name AS name`,
    { u: projectUid },
    'people waiting to hear about it',
  );

  return {
    project: { uid: root.uid, name: root.name, status: root.status ?? undefined, owner: root.owner ?? undefined },
    upstream: chainRows.map((r) => ({ uid: r.uid, name: r.name, status: r.status ?? undefined, depth: r.depth })).sort((a, b) => a.depth - b.depth),
    blockers: [...out.values()].sort((a, b) => b.score - a.score),
    customers, waiting,
  };
}
