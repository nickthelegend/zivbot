import type { UserGraph } from './graph.ts';

/**
 * Cross-app identity: the same human shows up as "Priya Raman" in the
 * directory and "priya.r" in Slack. Candidates come from name similarity;
 * the graph confirms them: Jaccard overlap of each person's 2-hop working
 * context (systems, tickets, projects, files, channels, threads, orgs).
 * Merging rewires every relationship onto the canonical node.
 */

export type DupPair = { a: { uid: string; name: string; email?: string; source?: string }; b: { uid: string; name: string; email?: string; source?: string }; nameSim: number; jaccard: number; shared: string[]; score: number };

const tokens = (s: string) => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

function directed(ta: Set<string>, tb: Set<string>) {
  let hit = 0;
  for (const x of ta) {
    if ([...tb].some((y) => x === y || (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))))) hit += 1;
    else if (x.length === 1 && [...tb].some((y) => y.startsWith(x))) hit += 0.5; // an initial: "priya.r" ~ "Priya Raman"
  }
  return hit / Math.max(1, ta.size);
}

function nameSimilarity(a: { name: string; email?: string }, b: { name: string; email?: string }) {
  const ta = new Set([...tokens(a.name), ...tokens((a.email || '').split('@')[0])]);
  const tb = new Set([...tokens(b.name), ...tokens((b.email || '').split('@')[0])]);
  return Math.max(directed(ta, tb), directed(tb, ta));
}

const CONTEXT = `x:System OR x:Ticket OR x:Project OR x:File OR x:Channel OR x:Thread OR x:Org OR x:Repo`;

export async function findDuplicates(g: UserGraph, minScore = 0.45): Promise<DupPair[]> {
  const people = await g.q(`MATCH (p:Person) WHERE NOT coalesce(p.me, false) RETURN p.uid AS uid, p.name AS name, p.email AS email, p.source AS source, p.role AS role`, {}, 'people for identity resolution');
  const cands: [any, any, number][] = [];
  for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
    const a = people[i], b = people[j];
    if (a.role === 'Newsletter' || b.role === 'Newsletter') continue;
    if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) continue; // already the same node by email
    const sim = nameSimilarity(a, b);
    if (sim >= 0.5) cands.push([a, b, sim]);
  }
  if (!cands.length) return [];
  const ctx = await g.q(
    `UNWIND $pairs AS p
     MATCH (a:Person {uid: p.a})-[*1..2]-(x) WHERE ${CONTEXT}
     WITH p, collect(DISTINCT x.uid) AS A
     MATCH (b:Person {uid: p.b})-[*1..2]-(y) WHERE ${CONTEXT.replace(/x:/g, 'y:')}
     WITH p, A, collect(DISTINCT y.uid) AS B
     RETURN p.a AS a, p.b AS b, [u IN A WHERE u IN B] AS shared, size(A) AS na, size(B) AS nb`,
    { pairs: cands.map(([a, b]) => ({ a: a.uid, b: b.uid })) },
    'shared 2-hop working context per candidate pair',
  );
  const names = new Map((await g.q(`UNWIND $u AS x MATCH (n {uid: x}) RETURN n.uid AS uid, n.name AS name`, { u: [...new Set(ctx.flatMap((c) => c.shared))] }, '~context names')).map((r) => [r.uid, r.name]));
  const out: DupPair[] = [];
  for (const c of ctx) {
    const [a, b, sim] = cands.find(([x, y]) => x.uid === c.a && y.uid === c.b)!;
    const union = c.na + c.nb - c.shared.length;
    const jaccard = union ? c.shared.length / union : 0;
    const score = +(0.55 * sim + 0.45 * Math.min(1, jaccard * 2.5)).toFixed(2);
    if (score >= minScore && c.shared.length > 0) out.push({ a, b, nameSim: +sim.toFixed(2), jaccard: +jaccard.toFixed(2), shared: c.shared.map((u: string) => names.get(u) || u).slice(0, 6), score });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Move every relationship from `dup` onto `keep`, keep the alias, delete the duplicate. */
export async function mergePeople(g: UserGraph, keep: string, dup: string) {
  const rels = await g.q(
    `MATCH (d:Person {uid: $dup})-[r]-() RETURN DISTINCT type(r) AS t, startNode(r) = d AS out`,
    { dup },
    'relationship types on the duplicate',
  );
  for (const { t, out } of rels) {
    if (!/^[A-Z_]+$/.test(t)) continue;
    await g.q(
      out
        ? `MATCH (d:Person {uid: $dup})-[r:${t}]->(m), (k:Person {uid: $keep}) WHERE m <> k MERGE (k)-[r2:${t}]->(m) SET r2 += properties(r)`
        : `MATCH (d:Person {uid: $dup})<-[r:${t}]-(m), (k:Person {uid: $keep}) WHERE m <> k MERGE (m)-[r2:${t}]->(k) SET r2 += properties(r)`,
      { dup, keep },
      `move ${out ? 'outgoing' : 'incoming'} ${t}`,
    );
  }
  const r = await g.one(
    `MATCH (k:Person {uid: $keep}), (d:Person {uid: $dup})
     SET k.aliases = coalesce(k.aliases, []) + [d.name] + CASE WHEN d.email IS NULL THEN [] ELSE [d.email] END,
         k.mergedFrom = coalesce(k.mergedFrom, []) + [d.uid],
         k.search = coalesce(k.search, '') + ' ' + coalesce(d.search, '')
     WITH k, d, d.name AS gone
     DETACH DELETE d
     RETURN k.name AS kept, gone`,
    { keep, dup },
    'merge identities',
  );
  return { kept: r?.kept, merged: r?.gone, moved: rels.length };
}
