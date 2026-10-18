// One definition of "who knows a system", shared by who_knows, the bus-factor
// insight, the what-if simulation and who_could_learn — so they never disagree.
//
// Knowing a system = having done real work on it: commits to its repo (×3),
// docs about it that you own (×3), tickets on it assigned to you (×2).
// Being on a project that uses it, or chatting about it, is "adjacent", not
// knowledge. A chat handle that resolves to a directory person counts as them.
import type { UserGraph } from './graph.ts';
import { findDuplicates } from './identity.ts';

export const ENGINEERING = /engineer|developer|firmware|platform|mobile|backend|frontend|\bsre\b|devops|\bcto\b|architect|\bdata\b|security/i;

export type Knower = { uid: string; name: string; role?: string; commits: number; docs: number; tickets: number; score: number };

/** handle uid → the directory person it belongs to ("priya.r" → Priya Raman) */
export async function aliasMap(g: UserGraph): Promise<Map<string, string>> {
  const pairs = await findDuplicates(g);
  return new Map(pairs.map((p) => (p.a.name.includes(' ') ? [p.b.uid, p.a.uid] : [p.a.uid, p.b.uid]) as [string, string]));
}

/** Every system's knowers, strongest first. */
export async function knowersAll(g: UserGraph): Promise<Map<string, Knower[]>> {
  const [commits, docs, tickets, people, alias] = await Promise.all([
    g.q(`MATCH (p:Person)<-[:AUTHORED_BY]-(c:Commit)-[:TOUCHES]->(:File)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(s:System) RETURN s.uid AS s, p.uid AS p, count(DISTINCT c) AS n`, {}, 'knowledge: commits per system'),
    g.q(`MATCH (p:Person)-[:OWNS]->(d:Doc)-[:ABOUT]->(s:System) RETURN s.uid AS s, p.uid AS p, count(DISTINCT d) AS n`, {}, 'knowledge: owned docs per system'),
    g.q(`MATCH (p:Person)<-[:ASSIGNED_TO]-(t:Ticket)-[:AFFECTS]->(s:System) RETURN s.uid AS s, p.uid AS p, count(DISTINCT t) AS n`, {}, 'knowledge: tickets per system'),
    g.q(`MATCH (p:Person) RETURN p.uid AS uid, p.name AS name, p.role AS role`, {}, '~people'),
    aliasMap(g),
  ]);
  const who = new Map(people.map((p) => [p.uid, p]));
  const out = new Map<string, Map<string, Knower>>();
  const add = (rows: any[], key: 'commits' | 'docs' | 'tickets', w: number) => {
    for (const r of rows) {
      const uid = alias.get(r.p) || r.p;
      const per = out.get(r.s) || new Map<string, Knower>();
      const k = per.get(uid) || { uid, name: who.get(uid)?.name || uid, role: who.get(uid)?.role ?? undefined, commits: 0, docs: 0, tickets: 0, score: 0 };
      k[key] += r.n;
      k.score += w * r.n;
      per.set(uid, k);
      out.set(r.s, per);
    }
  };
  add(commits, 'commits', 3);
  add(docs, 'docs', 3);
  add(tickets, 'tickets', 2);
  return new Map([...out].map(([s, per]) => [s, [...per.values()].sort((a, b) => b.score - a.score)]));
}

export async function knowers(g: UserGraph, systemUid: string): Promise<Knower[]> {
  return (await knowersAll(g)).get(systemUid) || [];
}

export const knowsWhy = (k: Knower) => {
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  return [k.commits && n(k.commits, 'commit'), k.docs && n(k.docs, 'doc'), k.tickets && n(k.tickets, 'ticket')].filter(Boolean).join(', ');
};
