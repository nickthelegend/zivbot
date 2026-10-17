import type { UserGraph } from './graph.ts';
import { DAY } from './util.ts';

/**
 * Graph-wide insights: the questions nobody asks until it's too late.
 * Each section is one or two Cypher queries (plus FalkorDB algorithms),
 * and every item carries the uids to light up in the graph view.
 */

export type InsightItem = { title: string; detail: string; uids: string[]; severity: 'high' | 'medium' | 'low'; ask?: string };
export type InsightSection = { key: string; title: string; blurb: string; items: InsightItem[] };

export async function insights(g: UserGraph, since = Date.now() - DAY): Promise<InsightSection[]> {
  const [bus, spof, groups, load, waiting, changed, fleet] = await Promise.all([
    busFactor(g), singlePoints(g), workingGroups(g), overloaded(g), waitingOnYou(g), whatChanged(g, since), fleetHealth(g),
  ]);
  return [bus, spof, waiting, load, groups, changed, fleet].filter((s) => s.items.length);
}

/** Systems whose knowledge sits with one person (commits, owned docs, assigned tickets). */
async function busFactor(g: UserGraph): Promise<InsightSection> {
  const rows = await g.q(
    `MATCH (s:System) WHERE s.tier IN ['critical', 'high']
     OPTIONAL MATCH (a:Person)<-[:AUTHORED_BY]-(:Commit)-[:TOUCHES]->(:File)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(s)
     WITH s, collect(a.uid) AS commits
     OPTIONAL MATCH (s)<-[:ABOUT]-(:Doc)<-[:OWNS]-(b:Person)
     WITH s, commits, collect(b.uid) AS docs
     OPTIONAL MATCH (s)<-[:AFFECTS]-(:Ticket)-[:ASSIGNED_TO]->(c:Person)
     RETURN s.uid AS uid, s.name AS name, s.tier AS tier, commits, docs, collect(c.uid) AS tickets`,
    {},
    'knowledge per critical system (commits, docs, tickets)',
  );
  const names = new Map((await g.q(`MATCH (p:Person) RETURN p.uid AS uid, p.name AS name`, {}, '~people names')).map((p) => [p.uid, p.name]));
  const items: InsightItem[] = [];
  for (const r of rows) {
    const score = new Map<string, number>();
    for (const [list, w] of [[r.commits, 3], [r.docs, 3], [r.tickets, 2]] as [string[], number][]) for (const u of list) score.set(u, (score.get(u) || 0) + w);
    const total = [...score.values()].reduce((a, b) => a + b, 0);
    if (total < 5) continue;
    const [top, topScore] = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = topScore / total;
    if (share >= 0.55) {
      items.push({
        title: `${r.name}: only ${names.get(top)} really knows it`,
        detail: `${Math.round(share * 100)}% of the commits, docs and tickets on this ${r.tier} system trace to one person.`,
        uids: [r.uid, top],
        severity: r.tier === 'critical' && share >= 0.7 ? 'high' : 'medium',
        ask: `Who else could learn ${r.name}?`,
      });
    }
  }
  return { key: 'bus', title: 'Knowledge risk', blurb: 'Bus factor of 1 on systems that matter', items };
}

/** Systems everything routes through: betweenness on DEPENDS_ON + how much depends on them. */
async function singlePoints(g: UserGraph): Promise<InsightSection> {
  const between = await g.q(
    `CALL algo.betweenness({nodeLabels: ['System'], relationshipTypes: ['DEPENDS_ON']}) YIELD node, score
     RETURN node.uid AS uid, score`,
    {},
    'betweenness over DEPENDS_ON',
  ).catch(() => []);
  const bw = new Map(between.map((b) => [b.uid, b.score]));
  const rows = await g.q(
    `MATCH (s:System)
     OPTIONAL MATCH (d:System)-[:DEPENDS_ON*1..5]->(s)
     WITH s, collect(DISTINCT d) AS deps
     WITH s, deps, [s] + deps AS radius
     UNWIND radius AS x
     OPTIONAL MATCH (o:Org {kind: 'customer'})-[:USES]->(x)
     WITH s, deps, size(deps) AS dependents, collect(DISTINCT o) AS customers
     RETURN s.uid AS uid, s.name AS name, s.tier AS tier, dependents, [d IN deps | d.uid] AS depUids, [c IN customers | c.uid] AS customerUids, [c IN customers | c.name] AS customers,
            reduce(t = 0, c IN customers | t + coalesce(c.arr, 0)) AS arr
     ORDER BY dependents DESC LIMIT 6`,
    {},
    'dependents and customers per system',
  );
  const items = rows
    .filter((r) => r.dependents >= 2)
    .map((r): InsightItem => ({
      title: `${r.name} holds up ${r.dependents} system${r.dependents > 1 ? 's' : ''}`,
      detail: `${r.customers.length ? `${r.customers.join(', ')} ride on it ($${Math.round(r.arr / 1000)}k ARR). ` : ''}Betweenness ${(bw.get(r.uid) || 0).toFixed(1)} on the dependency graph.`,
      uids: [r.uid, ...r.depUids, ...r.customerUids],
      severity: r.arr > 150000 || r.dependents >= 4 ? 'high' : 'medium',
      ask: `What breaks if ${r.name} goes down?`,
    }));
  return { key: 'spof', title: 'Single points of failure', blurb: 'What everything else leans on', items };
}

/** Label-propagation communities over COLLABORATES, named after their main project. */
async function workingGroups(g: UserGraph): Promise<InsightSection> {
  const rows = await g.q(
    `MATCH (p:Person) WHERE p.community IS NOT NULL AND NOT coalesce(p.external, false)
     OPTIONAL MATCH (p)-[:WORKS_ON|OWNS]->(pr:Project)
     WITH p.community AS community, collect(DISTINCT p) AS people, collect(pr.name) AS projects
     WHERE size(people) > 1
     RETURN community, [x IN people | x.name] AS names, [x IN people | x.uid] AS uids, projects
     ORDER BY size(people) DESC`,
    {},
    'working groups from label propagation',
  );
  const items = rows.map((r): InsightItem => {
    const counts = new Map<string, number>();
    for (const p of r.projects as string[]) counts.set(p, (counts.get(p) || 0) + 1);
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { title: main ? `${main} crew` : 'Working group', detail: (r.names as string[]).join(', '), uids: r.uids, severity: 'low' };
  });
  return { key: 'groups', title: 'Working groups', blurb: 'How people actually cluster (label propagation)', items };
}

async function overloaded(g: UserGraph): Promise<InsightSection> {
  const rows = await g.q(
    `MATCH (p:Person)<-[:ASSIGNED_TO]-(t:Ticket {status: 'open'})
     OPTIONAL MATCH (p)-[:ATTENDS]->(e:Event) WHERE e.start > $now AND e.start < $soon
     WITH p, collect(DISTINCT t) AS tickets, count(DISTINCT e) AS meetings
     WHERE size(tickets) >= 2 OR any(t IN tickets WHERE t.priority = 'P1')
     RETURN p.uid AS uid, p.name AS name, [t IN tickets | t.key] AS keys, [t IN tickets | t.uid] AS tuids, meetings
     ORDER BY size(keys) DESC`,
    { now: Date.now(), soon: Date.now() + 2 * DAY },
    'open tickets and meetings per person',
  );
  const items = rows.map((r): InsightItem => ({
    title: `${r.name} is carrying ${r.keys.join(', ')}`,
    detail: `${r.keys.length} open ticket${r.keys.length > 1 ? 's' : ''} and ${r.meetings} meeting${r.meetings === 1 ? '' : 's'} in the next two days.`,
    uids: [r.uid, ...r.tuids],
    severity: r.keys.length >= 2 ? 'medium' : 'low',
    ask: `Fix ${r.keys[0]}`,
  }));
  return { key: 'load', title: 'Overloaded', blurb: 'People the graph says are stretched', items };
}

async function waitingOnYou(g: UserGraph): Promise<InsightSection> {
  const now = Date.now();
  const threads = await g.q(
    `MATCH (t:Thread {awaitingReply: true})<-[:IN_THREAD]-(e:Email)
     WITH t, max(e.at) AS lastAt
     MATCH (t)<-[:IN_THREAD]-(last:Email)-[:FROM]->(p:Person) WHERE last.at = lastAt
     OPTIONAL MATCH (p)-[:WORKS_AT]->(o:Org) WHERE o.kind IN ['customer', 'investor']
     WITH t, lastAt, p, o WHERE o IS NOT NULL
     RETURN t.uid AS uid, t.subject AS subject, lastAt, p.name AS who, o.name AS org, o.kind AS kind`,
    {},
    'customers and investors waiting on a reply',
  );
  const decisions = await g.q(`MATCH (d:Decision {status: 'pending'}) RETURN d.uid AS uid, d.text AS text, d.at AS at`, {}, 'pending decisions');
  const items: InsightItem[] = [
    ...threads.map((t): InsightItem => ({ title: `${t.who} (${t.org}) is waiting`, detail: `"${t.subject}" — ${Math.max(1, Math.round((now - t.lastAt) / 3_600_000))}h without a reply.`, uids: [t.uid], severity: t.kind === 'customer' ? 'high' : 'medium', ask: `Draft a reply to ${t.who}` })),
    ...decisions.map((d): InsightItem => ({ title: `Undecided: ${d.text}`, detail: `Open for ${Math.max(1, Math.round((now - d.at) / 3_600_000))}h.`, uids: [d.uid], severity: 'medium', ask: `Help me decide: ${d.text}` })),
  ];
  return { key: 'waiting', title: 'Waiting on you', blurb: 'Customers, investors and decisions', items };
}

async function whatChanged(g: UserGraph, since: number): Promise<InsightSection> {
  const rows = await g.q(
    `MATCH (n:Searchable) WHERE n.firstSeen > $since
     WITH [l IN labels(n) WHERE NOT l IN ['Searchable', 'Memorable']][0] AS label, collect(n.uid) AS uids
     WHERE label <> 'Episode'
     RETURN label, size(uids) AS n, uids[0..8] AS sample ORDER BY n DESC`,
    { since },
    'new in the graph since',
  );
  const acted = await g.q(
    `OPTIONAL MATCH (d:Decision) WHERE d.decidedAt > $since WITH collect(d.uid) AS decided
     OPTIONAL MATCH (r:Run) WHERE r.endedAt > $since AND NOT coalesce(r.synthetic, false) WITH decided, collect(r) AS runs
     OPTIONAL MATCH (x:Draft {status: 'done'}) WHERE x.approvedAt > $since
     RETURN decided, [r IN runs | r.uid] AS runs, size([r IN runs WHERE r.status = 'succeeded']) AS wins, count(x) AS approved`,
    { since },
    'decisions, runs and approvals since',
  );
  const a = acted[0] || { decided: [], runs: [], wins: 0, approved: 0 };
  const items: InsightItem[] = rows.map((r) => ({ title: `+${r.n} ${r.label}${r.n > 1 ? (r.label.endsWith('s') ? 'es' : 's') : ''}`, detail: 'Added in the last 24 hours', uids: r.sample, severity: 'low' }));
  if (a.runs.length) items.unshift({ title: `${a.wins}/${a.runs.length} agent runs succeeded`, detail: `${a.approved} approval${a.approved === 1 ? '' : 's'} and ${a.decided.length} decision${a.decided.length === 1 ? '' : 's'} since yesterday.`, uids: [...a.runs, ...a.decided], severity: 'low' });
  return { key: 'changed', title: 'Last 24 hours', blurb: 'What changed in your graph', items };
}

async function fleetHealth(g: UserGraph): Promise<InsightSection> {
  const rows = await g.q(
    `MATCH (a:Agent)<-[:EXECUTED_BY]-(r:Run)
     RETURN a.uid AS uid, a.name AS name, count(r) AS runs, count(CASE WHEN r.status = 'succeeded' THEN 1 END) AS wins,
            coalesce(a.limitedUntil, 0) AS limitedUntil, a.installed AS installed
     ORDER BY wins DESC`,
    {},
    'agent fleet record',
  );
  const items = rows.map((r): InsightItem => ({
    title: `${r.name}: ${r.wins}/${r.runs} runs succeeded`,
    detail: r.limitedUntil > Date.now() ? 'Out of quota right now — routing skips it.' : r.installed ? 'Installed and available.' : 'Not installed on this computer.',
    uids: [r.uid],
    severity: r.wins < r.runs / 2 ? 'medium' : 'low',
  }));
  return { key: 'fleet', title: 'Agent fleet', blurb: 'How your subscriptions are doing', items };
}
