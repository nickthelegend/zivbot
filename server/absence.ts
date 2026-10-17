// "What if X is out?" — simulate a person disappearing from the graph and
// read what falls through: systems nobody else knows, work that needs a new
// owner, decisions that stall, customers who lose their contact, and the
// colleagues whose only link to the team runs through them.
import type { UserGraph } from './graph.ts';
import { DAY } from './util.ts';

export type OwnerCandidate = {
  uid: string; name: string; role?: string;
  commits: number; docs: number; tickets: number; onProject: boolean; load: number; meetings: number;
  know: number; cost: number; score: number;
};

/** Rank who could own a ticket: knowledge of the systems it affects minus current load. */
export async function rankOwners(g: UserGraph, ticketUid: string, without: string[] = []): Promise<OwnerCandidate[]> {
  const rows = await g.q(
    `MATCH (t:Ticket {uid:$u})-[:AFFECTS]->(s:System)
     MATCH (p:Person) WHERE NOT coalesce(p.external, false) AND NOT coalesce(p.me, false) AND NOT p.uid IN $without
     OPTIONAL MATCH (p)<-[:AUTHORED_BY]-(c:Commit)-[:TOUCHES]->(:File)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(s)
     WITH t, s, p, count(DISTINCT c) AS commits
     OPTIONAL MATCH (p)-[:OWNS]->(d:Doc)-[:ABOUT]->(s)
     WITH t, s, p, commits, count(DISTINCT d) AS docs
     OPTIONAL MATCH (p)<-[:ASSIGNED_TO]-(past:Ticket)-[:AFFECTS]->(s) WHERE past <> t
     WITH t, p, sum(commits) AS commits, sum(docs) AS docs, count(DISTINCT past) AS tickets
     OPTIONAL MATCH (p)-[:WORKS_ON]->(:Project)-[:USES]->(:System)<-[:AFFECTS]-(t)
     WITH p, commits, docs, tickets, count(*) > 0 AS onProject
     OPTIONAL MATCH (p)<-[:ASSIGNED_TO]-(open:Ticket {status:'open'})
     WITH p, commits, docs, tickets, onProject, count(DISTINCT open) AS load
     OPTIONAL MATCH (p)-[:ATTENDS]->(e:Event) WHERE e.start > $now AND e.start < $soon
     RETURN p.uid AS uid, p.name AS name, p.role AS role, commits, docs, tickets, onProject, load, count(DISTINCT e) AS meetings`,
    { u: ticketUid, without, now: Date.now(), soon: Date.now() + 2 * DAY },
    'candidates: knowledge of the affected systems vs current load',
  );
  return rows
    .map((c) => ({ ...c, know: 3 * c.commits + 3 * c.docs + 2 * c.tickets + (c.onProject ? 1 : 0), cost: 2 * c.load + 0.5 * c.meetings }) as OwnerCandidate)
    .map((c) => ({ ...c, score: +(c.know - c.cost).toFixed(1) }))
    .filter((c) => c.know > 0)
    .sort((a, b) => b.score - a.score);
}

export type Absence = {
  person: { uid: string; name: string; role?: string };
  orphaned: { uid: string; name: string; tier?: string; customers: string[] }[];
  fragile: { uid: string; name: string; tier?: string; left: string }[];
  tickets: { uid: string; key: string; title: string; priority?: string; next?: { uid: string; name: string; score: number } }[];
  decisions: { uid: string; title: string; why: string }[];
  customers: { uid: string; name: string; arr?: number; threads: number; via: string[] }[];
  meetings: { uid: string; title: string; start: number; others: number }[];
  isolated: { uid: string; name: string }[];
  cover: { uid: string; name: string; shared: number; overlap: string[] }[];
  severity: number;
};

export async function absenceImpact(g: UserGraph, personUid: string): Promise<Absence | null> {
  const person = await g.one(`MATCH (p:Person {uid:$u}) RETURN p.uid AS uid, p.name AS name, p.role AS role`, { u: personUid }, 'who is out');
  if (!person) return null;
  const now = Date.now();

  // Who knows each system, from every signal we hold. Remove the person and count who is left.
  const knowers = await g.q(
    `MATCH (s:System)
     OPTIONAL MATCH (a:Person)<-[:AUTHORED_BY]-(:Commit)-[:TOUCHES]->(:File)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(s)
     WITH s, collect(DISTINCT a.uid) AS k1
     OPTIONAL MATCH (s)<-[:ABOUT]-(:Doc)<-[:OWNS]-(b:Person)
     WITH s, k1, collect(DISTINCT b.uid) AS k2
     OPTIONAL MATCH (s)<-[:AFFECTS]-(:Ticket)-[:ASSIGNED_TO]->(c:Person)
     WITH s, k1, k2, collect(DISTINCT c.uid) AS k3
     WITH s, k1 + k2 + k3 AS k
     WHERE $p IN k
     OPTIONAL MATCH (o:Org {kind:'customer'})-[:USES]->(s)
     RETURN s.uid AS uid, s.name AS name, s.tier AS tier, k, collect(DISTINCT o.name) AS customers`,
    { p: personUid },
    'systems this person knows, and who else does',
  );
  const names = new Map((await g.q(`MATCH (p:Person) RETURN p.uid AS uid, p.name AS name`, {}, '~people')).map((r) => [r.uid, r.name]));
  const orphaned: Absence['orphaned'] = [];
  const fragile: Absence['fragile'] = [];
  for (const s of knowers) {
    const left = [...new Set((s.k as string[]).filter((u) => u && u !== personUid))];
    if (!left.length) orphaned.push({ uid: s.uid, name: s.name, tier: s.tier, customers: s.customers });
    else if (left.length === 1) fragile.push({ uid: s.uid, name: s.name, tier: s.tier, left: names.get(left[0]) || left[0] });
  }

  const open = await g.q(
    `MATCH (t:Ticket)-[:ASSIGNED_TO]->(:Person {uid:$p}) WHERE coalesce(t.status, 'open') <> 'done' AND coalesce(t.status, 'open') <> 'closed'
     RETURN t.uid AS uid, t.key AS key, t.title AS title, t.priority AS priority ORDER BY t.priority`,
    { p: personUid },
    'open work assigned to them',
  );
  const tickets: Absence['tickets'] = [];
  for (const t of open) {
    const [best] = await rankOwners(g, t.uid, [personUid]);
    tickets.push({ ...t, next: best ? { uid: best.uid, name: best.name, score: best.score } : undefined });
  }

  const decisions = await g.q(
    `MATCH (d:Decision)-[r:AWAITS|DECIDED_BY|RAISED_BY]->(:Person {uid:$p})
     WHERE type(r) = 'AWAITS' AND coalesce(d.status, 'pending') = 'pending' OR type(r) <> 'AWAITS'
     WITH d, collect(DISTINCT type(r)) AS how
     RETURN d.uid AS uid, coalesce(d.title, d.name) AS title, how, d.status AS status`,
    { p: personUid },
    'decisions waiting on them, or that only they can explain',
  );

  const custRows = await g.q(
    `MATCH (p:Person {uid:$p})-[:WORKS_WITH]->(o:Org {kind:'customer'}) RETURN o.uid AS uid, o.name AS name, o.arr AS arr, 0 AS threads, 'account' AS via
     UNION ALL
     MATCH (p:Person {uid:$p})<-[:TO|FROM]-(:Email)-[:IN_THREAD]->(th:Thread)<-[:IN_THREAD]-(:Email)-[:FROM|TO]->(:Person)-[:WORKS_AT]->(o:Org {kind:'customer'})
     RETURN o.uid AS uid, o.name AS name, o.arr AS arr, count(DISTINCT th) AS threads, 'mail' AS via
     UNION ALL
     MATCH (p:Person {uid:$p})-[:ATTENDS]->(e:Event)-[:ABOUT]->(o:Org {kind:'customer'}) WHERE e.start > $now
     RETURN o.uid AS uid, o.name AS name, o.arr AS arr, 0 AS threads, 'meeting' AS via
     UNION ALL
     MATCH (p:Person {uid:$p})<-[:ASSIGNED_TO]-(t:Ticket)-[:FOR]->(o:Org {kind:'customer'})
     RETURN o.uid AS uid, o.name AS name, o.arr AS arr, 0 AS threads, 'ticket' AS via`,
    { p: personUid, now },
    'customers who talk to them',
  );
  const byOrg = new Map<string, Absence['customers'][number]>();
  for (const r of custRows) {
    const c = byOrg.get(r.uid) || { uid: r.uid, name: r.name, arr: r.arr ?? undefined, threads: 0, via: [] as string[] };
    c.threads += r.threads;
    if (!c.via.includes(r.via)) c.via.push(r.via);
    byOrg.set(r.uid, c);
  }
  const customers = [...byOrg.values()];

  const meetings = await g.q(
    `MATCH (:Person {uid:$p})-[:ATTENDS]->(e:Event) WHERE e.start > $now AND e.start < $week
     OPTIONAL MATCH (o:Person)-[:ATTENDS]->(e) WHERE o.uid <> $p
     RETURN e.uid AS uid, coalesce(e.title, e.name) AS title, e.start AS start, count(DISTINCT o) AS others ORDER BY start`,
    { p: personUid, now, week: now + 7 * DAY },
    'meetings this week they were part of',
  );

  // Colleagues whose every internal collaboration edge goes through this person.
  const isolated = await g.q(
    `MATCH (:Person {uid:$p})-[:COLLABORATES]-(x:Person) WHERE NOT coalesce(x.external, false) AND NOT coalesce(x.me, false)
     OPTIONAL MATCH (x)-[:COLLABORATES]-(y:Person) WHERE y.uid <> $p AND NOT coalesce(y.external, false)
     WITH DISTINCT x, count(DISTINCT y) AS others WHERE others = 0
     RETURN x.uid AS uid, x.name AS name`,
    { p: personUid },
    'colleagues who only connect through them',
  );

  // Who covers best: most shared context (projects, systems, collaborators) — the person's neighbourhood overlap.
  const cover = await g.q(
    `MATCH (p:Person {uid:$p})-[:WORKS_ON|OWNS|COLLABORATES|MEMBER_OF]-(ctx)
     WITH p, collect(DISTINCT ctx) AS mine
     UNWIND mine AS ctx
     WITH p, ctx WHERE NOT coalesce(ctx.me, false)
     MATCH (ctx)-[:WORKS_ON|OWNS|COLLABORATES|MEMBER_OF]-(c:Person)
     WHERE c <> p AND NOT coalesce(c.external, false) AND NOT coalesce(c.me, false)
     WITH c, collect(DISTINCT {name: coalesce(ctx.name, ctx.title), person: ctx:Person}) AS overlap
     RETURN c.uid AS uid, c.name AS name, size(overlap) AS shared, overlap
     ORDER BY shared DESC LIMIT 3`,
    { p: personUid },
    'who shares the most context with them',
  );

  const tierWeight = (t?: string) => (t === 'critical' ? 5 : t === 'high' ? 3 : 1);
  const severity = orphaned.reduce((n, s) => n + 2 * tierWeight(s.tier), 0) + fragile.reduce((n, s) => n + tierWeight(s.tier), 0)
    + tickets.reduce((n, t) => n + (t.priority === 'P1' ? 3 : 1), 0) + decisions.length * 2 + customers.length * 2 + isolated.length * 2;

  return {
    person,
    orphaned, fragile, tickets,
    decisions: decisions.map((d) => ({ uid: d.uid, title: d.title, why: d.how.includes('AWAITS') ? 'waiting on them' : d.how.includes('DECIDED_BY') ? 'they decided it' : 'they raised it' })),
    customers, meetings, isolated, severity,
    // shared projects and teams read better than shared colleagues
    cover: cover.map((c) => ({ uid: c.uid, name: c.name, shared: c.shared, overlap: [...c.overlap].sort((a: any, b: any) => Number(a.person) - Number(b.person)).map((o: any) => o.name).slice(0, 4) })),
  };
}
