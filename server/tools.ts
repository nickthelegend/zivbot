import type { UserGraph, Row } from './graph.ts';
import { upsertNodes, link, linkAny, loadDictionary, mentionsIn } from './ingest.ts';
import { routeJob, refreshSkills, type RouteChoice } from './fleet.ts';
import { uid, ago, when, clip, DAY, HOUR } from './util.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zivHome } from './connectors/git.ts';
import { semanticSearch, embedPending } from './semantic.ts';
import { insights } from './insights.ts';
import { runAlgorithm, ALGORITHMS, type AlgoName } from './algorithms.ts';
import { RULE_KINDS, kindFromText, createRule, evaluateRules } from './rules.ts';
import { timeline } from './timeline.ts';
import { findDuplicates } from './identity.ts';
import { absenceImpact, rankOwners } from './absence.ts';
import { criticalPath } from './blockers.ts';
import { knowers, knowersAll, aliasMap, knowsWhy, ENGINEERING } from './knowledge.ts';
import { customerHealth } from './health.ts';

/**
 * Graph tools — the agent's hands. The LLM agent, the offline planner and the
 * MCP server all call these. Each runs Cypher through the traced UserGraph,
 * so the queries and touched nodes become the answer's provenance.
 */

export type Card =
  | { type: 'options'; question?: string; options: { key: string; label: string; value: string }[] }
  | { type: 'connectors' }
  | { type: 'list'; title?: string; items: { title: string; subtitle?: string; uid?: string; badge?: string; tone?: 'red' | 'amber' | 'green' | 'blue' | 'gray' }[] }
  | { type: 'draft'; draft: DraftView }
  | { type: 'run'; runUid: string }
  | { type: 'graph'; title?: string; focus?: string[]; exact?: boolean }
  | { type: 'agents' }
  | { type: 'note'; text: string }
  | { type: 'customize' }
  | { type: 'timeline'; title: string; items: { uid: string; at: number; label: string; name: string; who?: string; rel: string; hop: number }[] }
  | { type: 'file'; uid: string; name: string; size: number }
  | { type: 'exchange'; conv: string; with: { uid: string; name: string; avatar?: string; color?: string }; count: number; verb: 'messaged' | 'with' };

export type DraftView = { uid: string; kind: 'email' | 'event' | 'run' | 'decision' | 'mcp' | 'reassign' | 'merge'; status: string; title: string; to?: string; subject?: string; body?: string; when?: string; agent?: string; choices?: RouteChoice[]; detail?: string };

export type Ctx = { g: UserGraph; userId: string; dot: string };
export type ToolResult = { text: string; cards?: Card[]; data?: unknown };
export type Tool = {
  name: string;
  description: string;
  params: { type: 'object'; properties: Record<string, any>; required?: string[] };
  run: (ctx: Ctx, args: any) => Promise<ToolResult>;
};

// ---------------------------------------------------------------- helpers

const ftEscape = (s: string) => s.replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/-/g, ' ').trim();

export async function search(g: UserGraph, text: string, labels?: string[], limit = 8): Promise<Row[]> {
  const words = ftEscape(text).split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
  if (!words.length) return [];
  const run = async (q: string) =>
    g.q(
      `CALL db.idx.fulltext.queryNodes('Searchable', $q) YIELD node, score
       WITH node, score, labels(node) AS ls
       WHERE (size($labels) = 0 AND NOT any(l IN ls WHERE l IN ['Episode','Answer'])) OR any(l IN ls WHERE l IN $labels)
       RETURN node.uid AS uid, node.name AS name, [l IN ls WHERE l <> 'Searchable'][0] AS label, score
       ORDER BY score DESC LIMIT $limit`,
      { q, labels: labels || [], limit },
      `full-text search "${clip(text, 40)}"`,
    );
  let rows = await run(words.join(' '));
  if (!rows.length) rows = await run(words.map((w) => `${w}*`).join(' | '));
  return rows;
}

const STOP = new Set('the a an of to in on for and or is are was were be what who whom whose which with about me my i you your we our it this that these those do does did can could should would will please tell show find give how why when where any some there their them his her has have had from by at as up out if into than then so not no yes'.split(' '));

/** Resolve a free-text mention or uid to one node. Exact name/alias/key first, then full-text. */
export async function resolve(g: UserGraph, ref: string, labels?: string[]): Promise<Row | null> {
  if (!ref) return null;
  const r = ref.trim();
  if (/^[a-z]+:/.test(r)) {
    const hit = await g.one(`MATCH (n {uid:$u}) RETURN n.uid AS uid, n.name AS name, [l IN labels(n) WHERE l <> 'Searchable'][0] AS label`, { u: r }, 'resolve uid');
    if (hit) return hit;
  }
  const exact = await g.q(
    `MATCH (n:Searchable)
     WHERE ((size($labels) = 0 AND NOT n:Episode) OR any(l IN labels(n) WHERE l IN $labels))
       AND (toLower(n.name) = $t OR toLower(n.key) = $t OR toLower(n.first) = $t OR toLower(n.login) = $t OR $t IN [a IN coalesce(n.aliases, []) | toLower(a)])
     RETURN n.uid AS uid, n.name AS name, [l IN labels(n) WHERE l <> 'Searchable'][0] AS label LIMIT 1`,
    { t: r.toLowerCase(), labels: labels || [] },
    `resolve "${clip(r, 30)}"`,
  );
  if (exact[0]) return exact[0];
  return (await search(g, r, labels, 1))[0] || null;
}

const me = async (g: UserGraph) => (await g.one(`MATCH (p:Person {me:true}) RETURN p.uid AS uid, p.name AS name`, {}, '~who am I')) || { uid: 'person:me', name: 'you' };

export async function draftNode(g: UserGraph, d: Omit<DraftView, 'uid' | 'status'> & { payload: Record<string, unknown>; links?: { rel: string; to: string }[]; dot: string }) {
  const u = uid('draft');
  await upsertNodes(g, 'Draft', [{ uid: u, props: { name: d.title, title: d.title, kind: d.kind, status: 'pending', at: Date.now(), to: d.to, subject: d.subject, body: d.body, when: d.when, agent: d.agent, detail: d.detail, payload: JSON.stringify(d.payload) }, search: `${d.title} ${d.subject || ''}` }]);
  await link(g, 'Draft', 'BY', 'Dot', [{ from: u, to: d.dot }]);
  for (const l of d.links || []) await linkAny(g, 'Draft', l.rel, [{ from: u, to: l.to }]);
  return u;
}

const priorityTone = (p: string) => (p === 'P1' ? 'red' : p === 'P2' ? 'amber' : 'gray') as 'red' | 'amber' | 'gray';

// ---------------------------------------------------------------- tools

export const tools: Tool[] = [
  {
    name: 'search_graph',
    description: 'Full-text search across everything in the graph (people, projects, systems, tickets, mail, chat, docs, decisions, files). Use first to find uids.',
    params: { type: 'object', properties: { query: { type: 'string' }, labels: { type: 'array', items: { type: 'string' }, description: 'optional label filter e.g. ["Person","Ticket"]' } }, required: ['query'] },
    async run({ g }, { query, labels }) {
      const rows = await search(g, query, labels, 10);
      return {
        text: rows.length ? rows.map((r) => `- ${r.label} **${r.name}** (\`${r.uid}\`)`).join('\n') : `Nothing in the graph matches "${query}".`,
        data: rows,
      };
    },
  },

  {
    name: 'semantic_search',
    description: 'Search by meaning, not keywords (FalkorDB vector index), then follow the graph from each hit to the people, systems, customers and tickets it is about. Use for fuzzy questions like "anything about slow invoices?" or "what has the team said about the cutover?".',
    params: { type: 'object', properties: { query: { type: 'string' }, labels: { type: 'array', items: { type: 'string' }, description: 'optional: Doc Email ChatMessage Ticket Decision Fact Procedure Episode Thread' } }, required: ['query'] },
    async run({ g }, { query, labels }) {
      const { hits, themes } = await semanticSearch(g, query, { labels, k: 6 });
      if (!hits.length) return { text: `Nothing in memory is close to "${query}" yet.` };
      const line = (h: any) => `- ${h.label} **${clip(h.name, 70)}**${h.text && h.text !== h.name ? ` — ${clip(String(h.text).replace(/\s+/g, ' '), 110)}` : ''}${h.about.length ? `\n  ↳ ${h.about.slice(0, 4).map((a: any) => `${a.name} (${a.rel.toLowerCase().replace(/_/g, ' ')})`).join(', ')}` : ''}`;
      return {
        text: `Closest by meaning:\n${hits.map(line).join('\n')}${themes.length ? `\n\nThese keep coming back: ${themes.map((t) => `**${t.name}**`).join(', ')}.` : ''}`,
        cards: [{ type: 'graph', title: `About “${clip(query, 30)}”`, focus: [...hits.map((h) => h.uid), ...themes.map((t) => t.uid)].slice(0, 14) }],
        data: { hits, themes },
      };
    },
  },

  {
    name: 'describe_entity',
    description: 'Everything directly connected to one entity: its properties and its neighbours grouped by relationship.',
    params: { type: 'object', properties: { ref: { type: 'string', description: 'uid or name' } }, required: ['ref'] },
    async run({ g }, { ref }) {
      const n = await resolve(g, ref);
      if (!n) return { text: `I couldn't find "${ref}" in the graph.` };
      const node = await g.one(`MATCH (n {uid:$u}) RETURN n`, { u: n.uid }, `load ${n.label}`);
      const nb = await g.q(
        `MATCH (n {uid:$u})-[r]-(m)
         WHERE NOT (m:Episode OR m:Answer OR m:Draft OR m:Dot OR m:Conversation OR m:Connector) AND NOT type(r) IN ['COLLABORATES', 'IN_TOUCH', 'CLOSE_TO']
         RETURN type(r) AS rel, startNode(r) = n AS out, m.uid AS uid, m.name AS name, m.status AS status, [l IN labels(m) WHERE l <> 'Searchable'][0] AS label
         LIMIT 60`,
        { u: n.uid },
        `neighbours of ${n.name}`,
      );
      const props = Object.entries(node.n).filter(([k, v]) => !['uid', 'search', 'payload', 'log', '_label', 'aliases', 'emb', 'firstSeen', 'lastSeen', 'community', 'source', 'external', 'broker', 'first', 'me', 'key', 'name', 'criticality', 'rank', 'cost', 'newsletter', 'important'].includes(k) && v !== '' && v !== null).map(([k, v]) => `${k}: ${typeof v === 'number' && v > 1e12 ? when(v) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : clip(String(v), 160)}`);
      const groups = new Map<string, string[]>();
      for (const r of nb) {
        const key = r.out ? `→ ${r.rel}` : `← ${r.rel}`;
        groups.set(key, [...(groups.get(key) || []), `${r.name} (${r.label}${r.status ? `, ${r.status}` : ''})`]);
      }
      return {
        text: `**${n.name}** — ${n.label}${node.n.rank ? ` · PageRank ${Number(node.n.rank).toFixed(3)}` : ''}${node.n.criticality ? ` · dependency PageRank ${Number(node.n.criticality).toFixed(3)}` : ''}\n${props.map((p) => `- ${p}`).join('\n')}\n\nConnections:\n${[...groups].map(([k, v]) => `- ${k}: ${v.slice(0, 8).join(', ')}${v.length > 8 ? ` +${v.length - 8}` : ''}`).join('\n')}`,
        cards: [{ type: 'graph', title: n.name, focus: [n.uid] }],
        data: { node: node.n, neighbours: nb },
      };
    },
  },

  {
    name: 'triage',
    description: 'What needs my attention right now, ranked using the graph: threads waiting on me (weighted by customer ARR, sender importance), open P1/P2 tickets with customer impact, pending decisions, and calendar conflicts.',
    params: { type: 'object', properties: {} },
    async run({ g }) {
      const now = Date.now();
      const threads = await g.q(
        `MATCH (t:Thread {awaitingReply:true})<-[:IN_THREAD]-(e:Email)
         WITH t, max(e.at) AS lastAt
         MATCH (t)<-[:IN_THREAD]-(last:Email)-[:FROM]->(sender:Person) WHERE last.at = lastAt
         OPTIONAL MATCH (sender)-[:WORKS_AT]->(o:Org)
         OPTIONAL MATCH (last)-[:MENTIONS]->(tk:Ticket) WHERE tk.status <> 'resolved'
         RETURN t.uid AS uid, t.subject AS subject, last.at AS at, last.body AS body, last.important AS important,
                sender.name AS sender, sender.uid AS senderUid, coalesce(sender.rank, 0) AS rank,
                o.name AS org, o.kind AS orgKind, coalesce(o.arr, 0) AS arr, collect(DISTINCT tk.key) AS tickets`,
        {},
        'threads waiting on me, with sender org + open tickets',
      );
      const scoredThreads = threads.map((t) => ({
        ...t,
        score: (t.important ? 3 : 0) + t.arr / 60000 + t.rank * 8 + (t.orgKind === 'customer' ? 2 : 0) + (t.orgKind === 'investor' ? 2 : 0) + t.tickets.length + (now - t.at < DAY ? 1 : 0),
      })).sort((a, b) => b.score - a.score);

      const incidents = await g.q(
        `MATCH (t:Ticket {status:'open'})-[:AFFECTS]->(s:System)
         WHERE t.priority IN ['P1','P2']
         OPTIONAL MATCH (t)-[:FOR]->(o:Org)
         OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person)
         OPTIONAL MATCH (dep:System)-[:DEPENDS_ON*1..3]->(s)
         OPTIONAL MATCH (cust:Org {kind:'customer'})-[:USES]->(used:System) WHERE used = s OR used = dep
         WITH t, o, a, collect(DISTINCT s.name) AS systems, count(DISTINCT dep) AS dependents, collect(DISTINCT cust) AS custs
         RETURN t.uid AS uid, t.key AS key, t.title AS title, t.priority AS priority, t.at AS at,
                systems, o.name AS org, a.name AS assignee, dependents,
                [c IN custs | c.name] AS customers, reduce(n = 0, c IN custs | n + coalesce(c.arr, 0)) AS arrAtRisk`,
        {},
        'open P1/P2 tickets with blast radius and customers at risk',
      );
      incidents.sort((a, b) => (a.priority === b.priority ? b.arrAtRisk - a.arrAtRisk : a.priority < b.priority ? -1 : 1));

      const decisions = await g.q(
        `MATCH (d:Decision {status:'pending'})-[:AWAITS]->(:Person {me:true})
         OPTIONAL MATCH (d)-[:RAISED_BY]->(p:Person)
         OPTIONAL MATCH (d)-[:ABOUT]->(x)
         RETURN d.uid AS uid, d.text AS text, d.options AS options, d.at AS at, p.name AS raisedBy, collect(DISTINCT x.name) AS about`,
        {},
        'decisions waiting on me',
      );

      const conflicts = await g.q(
        `MATCH (me:Person {me:true})-[:ATTENDS]->(a:Event), (me)-[:ATTENDS]->(b:Event)
         WHERE a.uid < b.uid AND a.start < b.end AND b.start < a.end AND a.end > $now
         RETURN a.uid AS a, a.title AS aTitle, b.uid AS b, b.title AS bTitle, a.start AS start`,
        { now },
        'calendar conflicts',
      );

      const lines: string[] = [];
      const items: any[] = [];
      for (const i of incidents.slice(0, 2)) {
        lines.push(`**${i.key} (${i.priority})** — ${i.title}. Hits ${i.systems.join(', ')}${i.dependents ? ` and ${i.dependents} dependent system${i.dependents > 1 ? 's' : ''}` : ''}${i.customers.length ? `; customers exposed: ${i.customers.join(', ')} ($${Math.round(i.arrAtRisk / 1000)}k ARR)` : ''}. Assigned to ${i.assignee || 'nobody'}.`);
        items.push({ title: `${i.key} · ${i.title}`, subtitle: `${i.systems.join(', ')} · ${i.customers.join(', ') || 'internal'} · ${i.assignee || 'unassigned'}`, uid: i.uid, badge: i.priority, tone: priorityTone(i.priority) });
      }
      for (const t of scoredThreads.slice(0, 3)) {
        lines.push(`**Reply to ${t.sender}${t.org ? ` (${t.org})` : ''}** — "${t.subject}", ${ago(t.at)}${t.tickets.length ? `; tied to ${t.tickets.join(', ')}` : ''}.`);
        items.push({ title: `Reply: ${t.subject}`, subtitle: `${t.sender}${t.org ? ` · ${t.org}` : ''} · ${ago(t.at)}`, uid: t.uid, badge: t.orgKind === 'customer' ? 'customer' : t.orgKind === 'investor' ? 'investor' : 'mail', tone: t.orgKind === 'customer' ? 'amber' : 'blue' });
      }
      for (const d of decisions) {
        lines.push(`**Decide:** ${d.text} (raised by ${d.raisedBy}, ${ago(d.at)}).`);
        items.push({ title: `Decide: ${d.text}`, subtitle: `${d.raisedBy} · ${d.about.join(', ')}`, uid: d.uid, badge: 'decision', tone: 'amber' });
      }
      for (const c of conflicts) {
        lines.push(`**Calendar clash** ${when(c.start)}: ${c.aTitle} vs ${c.bTitle}.`);
        items.push({ title: `Clash: ${c.aTitle} × ${c.bTitle}`, subtitle: when(c.start), uid: c.a, badge: 'calendar', tone: 'gray' });
      }
      return {
        text: lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : 'Nothing urgent in the graph right now.',
        cards: [{ type: 'list', title: 'Needs you', items }],
        data: { incidents, threads: scoredThreads.slice(0, 5), decisions, conflicts },
      };
    },
  },

  {
    name: 'who_knows',
    description: 'Who knows the most about a system, project, repo, file or customer — ranked from commits, owned docs, assigned tickets, project membership and chat.',
    params: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    async run({ g }, { ref }) {
      const x = await resolve(g, ref, ['System', 'Project', 'Repo', 'File', 'Org', 'Ticket']);
      if (!x) return { text: `I couldn't find "${ref}".` };
      if (x.label === 'System') {
        // the same definition the bus-factor insight and the what-if use (knowledge.ts)
        const ks = await knowers(g, x.uid);
        const alias = await aliasMap(g);
        const known = new Set(ks.map((k) => k.uid));
        const near = (await g.q(
          `MATCH (x:System {uid:$u})
           OPTIONAL MATCH (p:Person)-[:WORKS_ON|OWNS]->(:Project)-[:USES]->(x)
           WITH x, collect(DISTINCT p) AS onProject
           OPTIONAL MATCH (x)<-[:MENTIONS]-(:ChatMessage)<-[:POSTED]-(q:Person)
           WITH onProject, collect(DISTINCT q) AS chat
           WITH onProject + chat AS ps UNWIND ps AS p WITH DISTINCT p WHERE p IS NOT NULL AND NOT coalesce(p.me, false)
           RETURN p.uid AS uid, p.name AS name`,
          { u: x.uid },
          `close to ${x.name} (project or chat), not hands-on`,
        )).filter((p) => !known.has(alias.get(p.uid) || p.uid) && !alias.has(p.uid));
        if (!ks.length) return { text: `Nobody has done hands-on work on **${x.name}** in the graph yet${near.length ? `. Closest: ${near.map((p) => p.name).join(', ')}` : ''}.` };
        const total = ks.reduce((n, k) => n + k.score, 0);
        const top = ks[0];
        const bus = ks.length === 1 ? `\n\nBus factor 1: only ${top.name} has done hands-on work on it.` : top.score / total >= 0.55 ? `\n\nMostly ${top.name} (${Math.round((100 * top.score) / total)}% of the work).` : '';
        return {
          text: `Hands-on with **${x.name}**:\n${ks.slice(0, 5).map((k, i) => `${i + 1}. **${k.name}**${k.role ? ` (${k.role})` : ''} — ${knowsWhy(k)}`).join('\n')}${near.length ? `\n\nClose to it but not hands-on: ${near.slice(0, 4).map((p) => p.name).join(', ')}.` : ''}${bus}`,
          cards: [{ type: 'graph', title: `Who knows ${x.name}`, focus: [x.uid, ...ks.slice(0, 4).map((k) => k.uid)], exact: true }],
          data: ks,
        };
      }
      const signals: [string, number, string][] = [
        ['commits', 3, `MATCH (x {uid:$u}) MATCH (p:Person)<-[:AUTHORED_BY]-(c:Commit)-[:TOUCHES]->(f:File)
          WHERE f = x OR (f)-[:IN_REPO]->(x) OR (f)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(x)
          RETURN p.uid AS uid, p.name AS name, count(DISTINCT c) AS n`],
        ['docs', 3, `MATCH (x {uid:$u})<-[:ABOUT]-(d:Doc)<-[:OWNS]-(p:Person) RETURN p.uid AS uid, p.name AS name, count(d) AS n`],
        ['tickets', 2, `MATCH (x {uid:$u})<-[:AFFECTS|PART_OF|FOR]-(t:Ticket)-[:ASSIGNED_TO]->(p:Person) RETURN p.uid AS uid, p.name AS name, count(t) AS n`],
        ['projects', 1, `MATCH (x {uid:$u}) MATCH (p:Person)-[:WORKS_ON|OWNS]->(pr:Project) WHERE pr = x OR (pr)-[:USES]->(x) RETURN p.uid AS uid, p.name AS name, count(pr) AS n`],
        ['chat', 1, `MATCH (x {uid:$u})<-[:MENTIONS]-(m:ChatMessage)<-[:POSTED]-(p:Person) RETURN p.uid AS uid, p.name AS name, count(m) AS n`],
        ['GitHub contributions', 1, `MATCH (x {uid:$u}) MATCH (p:Person)-[c:CONTRIBUTES_TO]->(r:Repo) WHERE r = x OR (r)-[:IMPLEMENTS]->(x) RETURN p.uid AS uid, p.name AS name, toInteger(c.commits / 25) + 1 AS n`],
      ];
      const score = new Map<string, { name: string; score: number; why: string[] }>();
      for (const [how, w, q] of signals) {
        for (const r of await g.q(q, { u: x.uid }, `who knows ${x.name}: ${how}`)) {
          const s = score.get(r.uid) || { name: r.name as string, score: 0, why: [] as string[] };
          s.score += w * r.n;
          s.why.push(`${r.n} ${r.n === 1 ? how.replace(/s$/, '').replace(/ies$/, 'y') : how}`);
          score.set(r.uid, s);
        }
      }
      const ranked = [...score.entries()].map(([uid, v]) => ({ uid, ...v })).sort((a, b) => b.score - a.score).slice(0, 6);
      // a chat handle ("priya.r") that resolves to a directory name gets labelled, not listed as a second expert
      const dupOf = new Map((await findDuplicates(g)).map((p) => (p.a.name.includes(' ') ? [p.b.uid, p.a.name] : [p.a.uid, p.b.name]) as [string, string]));
      for (const r of ranked) if (dupOf.has(r.uid)) r.why.push(`probably ${dupOf.get(r.uid)} on another app`);
      if (!ranked.length) return { text: `Nobody in the graph is connected to ${x.name} yet.` };
      const bus = ranked.filter((r) => r.score >= ranked[0].score * 0.5).length === 1 && ranked[0].score >= 6;
      return {
        text: `People who know **${x.name}**:\n${ranked.map((r, i) => `${i + 1}. **${r.name}** — ${r.why.join(', ')}`).join('\n')}${bus ? `\n\nHeads up: knowledge of ${x.name} is concentrated in ${ranked[0].name} (bus factor 1).` : ''}`,
        cards: [{ type: 'graph', title: `Who knows ${x.name}`, focus: [x.uid, ...ranked.slice(0, 4).map((r) => r.uid)] }],
        data: ranked,
      };
    },
  },

  {
    name: 'blast_radius',
    description: 'What breaks if a system goes down: dependent systems (multi-hop DEPENDS_ON), projects, customers and ARR exposed, and open tickets.',
    params: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    async run({ g }, { ref }) {
      const s = await resolve(g, ref, ['System', 'Repo']);
      if (!s) return { text: `I couldn't find a system called "${ref}".` };
      const sys = s.label === 'Repo' ? (await g.one(`MATCH (:Repo {uid:$u})-[:IMPLEMENTS]->(s:System) RETURN s.uid AS uid, s.name AS name`, { u: s.uid })) || s : s;
      const deps = await g.q(
        `MATCH p = (d:System)-[:DEPENDS_ON*1..4]->(s:System {uid:$u})
         RETURN d.uid AS uid, d.name AS name, min(length(p)) AS hops ORDER BY hops`,
        { u: sys.uid },
        `systems that depend on ${sys.name} (1-4 hops)`,
      );
      const all = [sys.uid, ...deps.map((d) => d.uid)];
      const impact = await g.q(
        `UNWIND $all AS u MATCH (x:System {uid:u})
         OPTIONAL MATCH (o:Org {kind:'customer'})-[:USES]->(x)
         OPTIONAL MATCH (pr:Project)-[:USES]->(x)
         OPTIONAL MATCH (t:Ticket {status:'open'})-[:AFFECTS]->(x)
         RETURN collect(DISTINCT o.name) AS customers, collect(DISTINCT pr.name) AS projects, collect(DISTINCT t.key) AS tickets,
                collect(DISTINCT o.uid) + collect(DISTINCT pr.uid) + collect(DISTINCT t.uid) AS reached`,
        { all },
        'customers, projects and tickets on the blast radius',
      );
      const own = await g.q(`MATCH (s:System {uid:$u})<-[:USES]-(:Project)<-[:OWNS]-(p:Person) RETURN DISTINCT p.name AS name`, { u: sys.uid }, 'owners to notify');
      const i = impact[0] || { customers: [], projects: [], tickets: [], reached: [] };
      // customers listed per-system, so recompute ARR over distinct orgs
      const arr = (await g.one(`UNWIND $all AS u MATCH (o:Org {kind:'customer'})-[:USES]->(:System {uid:u}) WITH DISTINCT o RETURN sum(o.arr) AS arr`, { all }, 'ARR exposed'))?.arr || 0;
      return {
        text: `If **${sys.name}** goes down:\n- Dependent systems: ${deps.length ? deps.map((d) => `${d.name} (${d.hops} hop${d.hops > 1 ? 's' : ''})`).join(', ') : 'none'}\n- Customers exposed: ${i.customers.join(', ') || 'none'}${arr ? ` — $${Math.round(arr / 1000)}k ARR` : ''}\n- Projects affected: ${i.projects.join(', ') || 'none'}\n- Open tickets already on this path: ${i.tickets.join(', ') || 'none'}\n- Notify: ${own.map((o) => o.name).join(', ') || 'no owner on record'}`,
        cards: [{ type: 'graph', title: `Blast radius: ${sys.name}`, focus: [...all, ...(i.reached || [])], exact: true }],
        data: { system: sys, dependents: deps, ...i, arr },
      };
    },
  },

  {
    name: 'connection_path',
    description: 'How two things are connected: the shortest chains of relationships between them (up to 4 hops).',
    params: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    async run({ g }, { from, to }) {
      const [a, b] = [await resolve(g, from), await resolve(g, to)];
      if (!a || !b) return { text: `I couldn't find ${!a ? from : to}.` };
      const rows = await g.q(
        `MATCH p = (a {uid:$a})-[*1..4]-(b {uid:$b})
         WHERE none(r IN relationships(p) WHERE type(r) IN ['COLLABORATES','IN_TOUCH','CLOSE_TO','IN_THREAD','BY','USED','WRITTEN_BY'])
           AND none(n IN nodes(p) WHERE n:Episode OR n:Answer OR n:Draft OR n:Conversation)
         RETURN [n IN nodes(p) | coalesce(n.name, n.key, n.title)] AS names, [n IN nodes(p) | n.uid] AS uids, [r IN relationships(p) | type(r)] AS rels,
                [i IN range(0, length(p) - 1) | startNode(relationships(p)[i]) = nodes(p)[i]] AS fwd, length(p) AS hops
         ORDER BY hops LIMIT 3`,
        { a: a.uid, b: b.uid },
        `paths ${a.name} ↔ ${b.name}`,
      );
      if (!rows.length) return { text: `No path within 4 hops between ${a.name} and ${b.name}.` };
      // arrows follow the stored edge direction: "LUM-139 —FOR→ Brightwave", not the walk order
      const fmt = (r: Row) => r.names.map((n: string, i: number) => (i < r.rels.length ? `${n} ${r.fwd[i] ? `—${r.rels[i]}→` : `←${r.rels[i]}—`} ` : n)).join('');
      return {
        text: `**${a.name}** ↔ **${b.name}**\n${rows.map((r) => `- ${fmt(r)}`).join('\n')}`,
        cards: [{ type: 'graph', title: `${a.name} ↔ ${b.name}`, focus: [...new Set(rows.flatMap((r) => r.uids as string[]))] }],
        data: rows,
      };
    },
  },

  {
    name: 'decision_trace',
    description: 'Trace decisions about a topic back to their source: who decided, who approved, the message/doc it came from, and what it affects. Also lists decisions still waiting on me.',
    params: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    async run({ g }, { topic }) {
      const x = await resolve(g, topic, ['Project', 'System', 'Org', 'Ticket', 'Decision']);
      const hits = await search(g, topic, ['Decision'], 6);
      const ids = [...new Set([...(x?.label === 'Decision' ? [x.uid] : []), ...hits.map((h) => h.uid)])];
      const rows = await g.q(
        `MATCH (d:Decision)
         WHERE d.uid IN $ids OR ($x IS NOT NULL AND (d)-[:ABOUT]->({uid:$x}))
         OPTIONAL MATCH (d)-[:DECIDED_BY]->(by:Person)
         OPTIONAL MATCH (d)-[:APPROVED_BY]->(ap:Person)
         OPTIONAL MATCH (d)-[:RAISED_BY]->(rb:Person)
         OPTIONAL MATCH (d)-[:SOURCE]->(src)
         OPTIONAL MATCH (d)-[:ABOUT]->(ab)
         RETURN d.uid AS uid, d.text AS text, d.status AS status, d.at AS at, d.choice AS choice, by.name AS by, ap.name AS approvedBy, rb.name AS raisedBy,
                collect(DISTINCT {name: src.name, label: [l IN labels(src) WHERE l <> 'Searchable'][0], at: src.at, source: src.source}) AS sources,
                collect(DISTINCT ab.name) AS about
         ORDER BY d.at DESC`,
        { ids, x: x?.uid ?? null },
        `decisions about ${x?.name || topic}`,
      );
      if (!rows.length) return { text: `I have no recorded decisions about "${topic}".` };
      return {
        text: rows.map((d) => `- **${d.text}** — ${d.status === 'pending' ? `⏳ pending, raised by ${d.raisedBy}` : `decided by ${d.by || 'unknown'}${d.approvedBy ? `, approved by ${d.approvedBy}` : ''}${d.choice ? ` → "${d.choice}"` : ''}`} (${ago(d.at)})\n  Source: ${d.sources.filter((s: any) => s.name).map((s: any) => `${s.label} "${clip(s.name, 70)}" via ${s.source || 'zivbot'}`).join('; ') || 'none'}\n  About: ${d.about.join(', ')}`).join('\n'),
        cards: [{ type: 'graph', title: 'Decision trail', focus: rows.map((r) => r.uid) }],
        data: rows,
      };
    },
  },

  {
    name: 'customer_history',
    description: 'What a customer/org asked for recently and whether it was resolved: their emails, their tickets and status, open issues on systems they use, upcoming meetings.',
    params: { type: 'object', properties: { org: { type: 'string' }, days: { type: 'number' } }, required: ['org'] },
    async run({ g }, { org, days = 45 }) {
      const o = await resolve(g, org, ['Org', 'Person']);
      if (!o) return { text: `I couldn't find "${org}".` };
      const orgUid = o.label === 'Person' ? (await g.one(`MATCH (:Person {uid:$u})-[:WORKS_AT]->(o:Org) RETURN o.uid AS uid, o.name AS name`, { u: o.uid }))?.uid : o.uid;
      const since = Date.now() - days * DAY;
      const mail = await g.q(
        `MATCH (o:Org {uid:$o})<-[:WORKS_AT]-(p:Person)<-[:FROM]-(e:Email) WHERE e.at > $since
         OPTIONAL MATCH (e)-[:MENTIONS]->(t:Ticket)
         RETURN e.uid AS uid, p.uid AS fromUid, e.subject AS subject, e.body AS body, e.at AS at, p.name AS from, collect(DISTINCT t.key) AS tickets ORDER BY e.at`,
        { o: orgUid, since },
        'their emails in the window',
      );
      const tix = await g.q(
        `MATCH (t:Ticket)-[:FOR]->(o:Org {uid:$o}) OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person) OPTIONAL MATCH (r:Run)-[:RESOLVES]->(t)
         RETURN t.uid AS uid, t.key AS key, t.title AS title, t.status AS status, t.priority AS priority, t.at AS at, t.resolvedAt AS resolvedAt, a.name AS assignee, count(r) AS fixes`,
        { o: orgUid },
        'their tickets',
      );
      const meetings = await g.q(`MATCH (e:Event)-[:ABOUT]->(o:Org {uid:$o}) WHERE e.start > $now RETURN e.uid AS uid, e.title AS title, e.start AS start`, { o: orgUid, now: Date.now() }, 'upcoming meetings with them');
      const open = tix.filter((t) => t.status === 'open');
      const ready = tix.filter((t) => t.status === 'fix ready' || (t.fixes > 0 && t.status !== 'resolved'));
      return {
        text: `**${o.label === 'Person' ? o.name + "'s org" : o.name}** — last ${days} days\n\nThey asked:\n${mail.map((m) => `- ${ago(m.at)}: "${m.subject}" — ${clip(m.body, 110)}${m.tickets.length ? ` (${m.tickets.join(', ')})` : ''}`).join('\n') || '- nothing by email'}\n\nTickets:\n${tix.map((t) => `- ${t.key} ${t.title} — **${t.status}**${t.status === 'resolved' ? ` ${ago(t.resolvedAt)}` : `, open ${ago(t.at).replace(' ago', '')}, ${t.assignee}`}`).join('\n') || '- none'}\n\n${open.length ? `**Not resolved:** ${open.map((t) => t.key).join(', ')}.` : ready.length ? `**Fixed, not shipped yet:** ${ready.map((t) => t.key).join(', ')} — tell them it lands with the next deploy.` : 'Everything they raised is resolved.'}${meetings.length ? `\nNext meeting: ${meetings[0].title}, ${when(meetings[0].start)}.` : ''}`,
        cards: [{ type: 'list', title: 'Tickets', items: tix.map((t) => ({ title: `${t.key} · ${t.title}`, subtitle: t.assignee, uid: t.uid, badge: t.status, tone: t.status === 'resolved' ? 'green' : priorityTone(t.priority) })) }],
        data: { mail, tickets: tix, meetings },
      };
    },
  },

  {
    name: 'key_people',
    description: 'The most central people in my working graph (PageRank over collaboration), their working group (label propagation) and the brokers who connect groups (betweenness).',
    params: { type: 'object', properties: { limit: { type: 'number' } } },
    async run({ g }, { limit = 6 }) {
      const rows = await g.q(
        `MATCH (p:Person) WHERE NOT coalesce(p.me,false) AND p.rank IS NOT NULL
         OPTIONAL MATCH (p)-[:WORKS_AT]->(o:Org)
         RETURN p.uid AS uid, p.name AS name, p.role AS role, o.name AS org, p.rank AS rank, p.community AS community, coalesce(p.broker,0) AS broker
         ORDER BY p.rank DESC LIMIT $limit`,
        { limit },
        'PageRank: most central people',
      );
      const brokers = await g.q(`MATCH (p:Person) WHERE NOT coalesce(p.me,false) RETURN p.name AS name, p.broker AS broker ORDER BY p.broker DESC LIMIT 3`, {}, 'betweenness: top brokers');
      return {
        text: `Most central people around you:\n${rows.map((r, i) => `${i + 1}. **${r.name}** — ${r.role}${r.org && r.org !== 'Lumen Labs' ? `, ${r.org}` : ''} (PageRank ${r.rank.toFixed(3)})`).join('\n')}\n\nBrokers between groups: ${brokers.map((b) => b.name).join(', ')}.`,
        cards: [{ type: 'graph', title: 'Key people', focus: rows.map((r) => r.uid) }],
        data: rows,
      };
    },
  },

  {
    name: 'meeting_prep',
    description: 'Prepare me for a meeting: follow the event to its attendees, their organisations, open and fixed tickets, recent mail and what is still unanswered, related decisions, and write a brief with a suggested agenda.',
    params: { type: 'object', properties: { meeting: { type: 'string', description: 'event name/uid, or a person or org I am meeting next' } }, required: ['meeting'] },
    async run({ g, userId, dot }, { meeting }) {
      // a person or org by exact name wins over a fuzzy event match
      const who = await g.one(
        `MATCH (n:Searchable) WHERE (n:Person OR n:Org) AND (toLower(n.name) = $t OR toLower(n.first) = $t OR $t IN [a IN coalesce(n.aliases, []) | toLower(a)]) RETURN n.uid AS uid`,
        { t: String(meeting).toLowerCase().trim() },
        '~is this a person or org',
      );
      let ev = who ? null : await resolve(g, meeting, ['Event']);
      if (!ev) {
        // "prep me for Kate" / "for Brightwave": the next event with them
        const x = await resolve(g, meeting, ['Person', 'Org']);
        if (x) ev = await g.one(
          `MATCH (e:Event) WHERE e.end > $now AND ((e)<-[:ATTENDS]-(:Person {uid:$u}) OR (e)-[:ABOUT]->({uid:$u}) OR (e)<-[:ATTENDS]-(:Person)-[:WORKS_AT]->(:Org {uid:$u}))
           RETURN e.uid AS uid, e.name AS name ORDER BY e.start LIMIT 1`,
          { u: x.uid, now: Date.now() },
          `next meeting with ${x.name}`,
        );
      }
      if (!ev) return { text: `I couldn't find a meeting for "${meeting}".` };
      const head = await g.one(
        `MATCH (e:Event {uid:$u})
         OPTIONAL MATCH (p:Person)-[:ATTENDS]->(e) WHERE NOT coalesce(p.me, false)
         OPTIONAL MATCH (p)-[:WORKS_AT]->(o:Org)
         RETURN e.title AS title, e.start AS start, e.end AS end, collect(DISTINCT {uid: p.uid, name: p.name, role: p.role, org: o.name}) AS people,
                collect(DISTINCT o.uid) AS orgs`,
        { u: ev.uid },
        'the meeting and who is in it',
      );
      const ext = await g.q(
        `UNWIND $orgs AS ou MATCH (o:Org {uid: ou}) WHERE o.kind IN ['customer', 'investor', 'prospect', 'vendor']
         OPTIONAL MATCH (t:Ticket)-[:FOR]->(o)
         OPTIONAL MATCH (r:Run {status:'succeeded'})-[:RESOLVES]->(t)
         WITH o, collect(DISTINCT {key: t.key, title: t.title, status: t.status, fixed: r IS NOT NULL}) AS tickets
         OPTIONAL MATCH (o)<-[:WORKS_AT]-(:Person)<-[:FROM]-(m:Email) WHERE m.at > $since
         WITH o, tickets, m ORDER BY m.at DESC
         WITH o, tickets, collect({subject: m.subject, at: m.at, body: m.body})[0..4] AS mail
         OPTIONAL MATCH (th:Thread {awaitingReply: true})<-[:IN_THREAD]-(:Email)-[:FROM]->(:Person)-[:WORKS_AT]->(o)
         RETURN o.uid AS uid, o.name AS name, o.kind AS kind, o.arr AS arr, tickets, mail, collect(DISTINCT th.subject) AS waiting`,
        { orgs: head.orgs, since: Date.now() - 45 * DAY },
        'their tickets, fixes, recent mail and unanswered threads',
      );
      const topics = await g.q(
        `MATCH (e:Event {uid:$u})
         OPTIONAL MATCH (e)-[:ABOUT]->(x)
         OPTIONAL MATCH (d:Decision)-[:ABOUT]->(x)
         OPTIONAL MATCH (t:Ticket {status:'open'})-[:PART_OF|FOR]->(x)
         RETURN collect(DISTINCT x.name) AS about, collect(DISTINCT {text: d.text, status: d.status, choice: d.choice}) AS decisions, collect(DISTINCT t.key) AS tickets`,
        { u: ev.uid },
        'what the meeting is about: decisions and open work',
      );
      const tp = topics[0] || { about: [], decisions: [], tickets: [] };
      const agenda: string[] = [];
      const lines: string[] = [`# ${head.title}`, `_${when(head.start)} · prepared by ZivBot from your graph_`, '', '## Who', ...head.people.filter((p: any) => p.uid).map((p: any) => `- **${p.name}** — ${p.role || ''}${p.org && p.org !== 'Lumen Labs' ? `, ${p.org}` : ''}`)];
      for (const o of ext) {
        const tickets = (o.tickets as any[]).filter((t) => t.key);
        lines.push('', `## ${o.name}${o.arr ? ` · $${Math.round(o.arr / 1000)}k ARR` : ''}`);
        if (tickets.length) lines.push('**Tickets**', ...tickets.map((t) => `- ${t.key} ${t.title} — ${t.fixed || t.status === 'fix ready' ? 'fixed, shipping next deploy' : t.status}`));
        if ((o.mail as any[]).length) lines.push('**What they wrote recently**', ...(o.mail as any[]).filter((m) => m.subject).map((m) => `- ${ago(m.at)}: "${m.subject}" — ${clip(m.body, 120)}`));
        if ((o.waiting as string[]).length) lines.push(`**Still unanswered:** ${(o.waiting as string[]).join('; ')}`);
        for (const t of tickets) agenda.push(t.fixed || t.status === 'fix ready' ? `Confirm ${t.key} is fixed and when it ships` : t.status === 'open' ? `Status and owner for ${t.key}` : '');
        if ((o.waiting as string[]).length) agenda.unshift(`Close the loop on "${(o.waiting as string[])[0]}"`);
      }
      const ds = (tp.decisions as any[]).filter((d) => d.text);
      if (ds.length) lines.push('', '## Decisions on this', ...ds.map((d) => `- ${d.text} — ${d.status === 'pending' ? 'pending' : `decided${d.choice ? `: ${d.choice}` : ''}`}`));
      for (const d of ds.filter((d) => d.status === 'pending')) agenda.push(`Decide: ${d.text}`);
      const ag = [...new Set(agenda.filter(Boolean))].slice(0, 6);
      lines.push('', '## Suggested agenda', ...(ag.length ? ag.map((a, i) => `${i + 1}. ${a}`) : ['1. Open floor']));
      const file = await writeOutput(g, userId, dot, `${String(head.title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-prep.md`, lines.join('\n'));
      await g.q(`MATCH (d:Doc {uid:$d}), (e:Event {uid:$e}) MERGE (d)-[:PREPARES]->(e)`, { d: file.uid, e: ev.uid }, '~link brief to meeting');
      return {
        text: `**${head.title}** — ${when(head.start)} with ${head.people.filter((p: any) => p.uid).map((p: any) => p.name.split(' ')[0]).join(', ')}.\n\n${ext.map((o) => `**${o.name}**: ${(o.tickets as any[]).filter((t) => t.key).map((t) => `${t.key} ${t.fixed || t.status === 'fix ready' ? 'fixed' : t.status}`).join(', ') || 'no tickets'}${(o.waiting as string[]).length ? `; ${o.waiting.length} thread${o.waiting.length > 1 ? 's' : ''} still unanswered` : ''}.`).join('\n')}\n\nSuggested agenda:\n${(ag.length ? ag : ['Open floor']).map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
        cards: [{ type: 'file', uid: file.uid, name: file.name, size: file.size }, { type: 'graph', title: head.title, focus: [ev.uid, ...head.people.map((p: any) => p.uid).filter(Boolean), ...ext.map((o) => o.uid)] }],
        data: { head, ext, topics: tp, agenda: ag },
      };
    },
  },

  {
    name: 'agenda',
    description: 'My upcoming meetings for the next N days, with conflicts and what each meeting is about.',
    params: { type: 'object', properties: { days: { type: 'number' } } },
    async run({ g }, { days = 3 }) {
      const now = Date.now();
      const rows = await g.q(
        `MATCH (:Person {me:true})-[:ATTENDS]->(e:Event) WHERE e.end > $now AND e.start < $until
         OPTIONAL MATCH (p:Person)-[:ATTENDS]->(e) WHERE NOT coalesce(p.me,false)
         OPTIONAL MATCH (e)-[:ABOUT]->(x)
         RETURN e.uid AS uid, e.title AS title, e.start AS start, e.end AS end, collect(DISTINCT p.name) AS with, collect(DISTINCT x.name) AS about ORDER BY e.start`,
        { now, until: now + days * DAY },
        'my meetings',
      );
      const clash = new Set<string>();
      for (const a of rows) for (const b of rows) if (a.uid !== b.uid && a.start < b.end && b.start < a.end) clash.add(a.uid);
      return {
        text: rows.map((r) => `- ${when(r.start)} — **${r.title}** with ${r.with.slice(0, 4).join(', ')}${clash.has(r.uid) ? ' ⚠️ conflict' : ''}`).join('\n') || 'Nothing on your calendar.',
        cards: [{ type: 'list', title: 'Agenda', items: rows.map((r) => ({ title: r.title, subtitle: `${when(r.start)} · ${r.with.slice(0, 3).join(', ')}`, uid: r.uid, badge: clash.has(r.uid) ? 'conflict' : 'meeting', tone: clash.has(r.uid) ? 'red' : 'green' })) }],
        data: rows,
      };
    },
  },

  {
    name: 'inbox_cleanup',
    description: 'Newsletters and promos I never reply to — unsubscribe candidates.',
    params: { type: 'object', properties: {} },
    async run({ g }) {
      const rows = await g.q(
        `MATCH (p:Person)<-[:FROM]-(e:Email {newsletter:true})
         OPTIONAL MATCH (p)<-[:TO]-(r:Email)-[:FROM]->(:Person {me:true})
         WITH p, count(DISTINCT e) AS n, max(e.at) AS last, count(r) AS replies
         WHERE replies = 0
         RETURN p.uid AS uid, p.name AS name, p.email AS email, n, last ORDER BY n DESC`,
        {},
        'senders I never reply to',
      );
      return {
        text: rows.length ? `You never reply to these senders:\n${rows.map((r) => `- **${r.name}** (${r.email}) — ${r.n} email${r.n > 1 ? 's' : ''}, last ${ago(r.last)}`).join('\n')}` : 'Your inbox is clean.',
        cards: [{ type: 'list', title: 'Unsubscribe candidates', items: rows.map((r) => ({ title: r.name, subtitle: `${r.n} emails · last ${ago(r.last)}`, uid: r.uid, badge: 'newsletter', tone: 'gray' })) }],
        data: rows,
      };
    },
  },

  {
    name: 'find_duplicates',
    description: 'Find people who are probably the same human split across apps (e.g. a Slack handle and a directory entry): name similarity confirmed by overlap of their 2-hop working context in the graph. Proposes merges for approval.',
    params: { type: 'object', properties: {} },
    async run({ g, dot }) {
      const pairs = await findDuplicates(g);
      if (!pairs.length) return { text: 'No duplicate identities found — every person in the graph looks like one human.' };
      const cards: Card[] = [];
      for (const p of pairs.slice(0, 3)) {
        // keep the richer, directory-backed node
        const [keep, dup] = (p.a.email || '').endsWith('lumenlabs.example') || (p.a.name.includes(' ') && !p.b.name.includes(' ')) ? [p.a, p.b] : [p.b, p.a];
        const d = await draftNode(g, {
          kind: 'merge', title: `Merge ${dup.name} into ${keep.name}`, to: keep.name, dot,
          detail: `name match ${Math.round(p.nameSim * 100)}% · shared context ${Math.round(p.jaccard * 100)}%`,
          body: `Both connect to: ${p.shared.join(', ')}`,
          payload: { keep: keep.uid, dup: dup.uid },
          links: [{ rel: 'PROPOSES', to: keep.uid }],
        });
        cards.push({ type: 'draft', draft: { uid: d, kind: 'merge', status: 'pending', title: `Merge ${dup.name} into ${keep.name}`, to: keep.name, detail: `name match ${Math.round(p.nameSim * 100)}% · shared context ${Math.round(p.jaccard * 100)}%`, body: `Both connect to: ${p.shared.join(', ')}` } });
      }
      return {
        text: `These look like the same person in different apps:\n${pairs.slice(0, 3).map((p) => `- **${p.a.name}** and **${p.b.name}** — both work on ${p.shared.slice(0, 4).join(', ')} (score ${p.score})`).join('\n')}\n\nMerging moves every relationship onto one node, so answers stop missing half of what they did.`,
        cards: [...cards, { type: 'graph', title: 'Same person?', focus: pairs.slice(0, 3).flatMap((p) => [p.a.uid, p.b.uid]) }],
        data: pairs,
      };
    },
  },

  {
    name: 'timeline',
    description: 'The story of any entity (ticket, customer, person, system, project, decision): every time-stamped thing one or two hops away — mail, chat, commits, decisions, runs, approvals, meetings — with who acted, in order.',
    params: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    async run({ g }, { ref }) {
      const x = await resolve(g, ref);
      if (!x) return { text: `I couldn't find "${ref}".` };
      const items = await timeline(g, x.uid);
      if (!items.length) return { text: `Nothing time-stamped is connected to ${x.name} yet.` };
      const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return {
        text: `The story of **${x.name}** — ${items.length} moments from your graph:\n${items.slice(-12).map((i) => `- ${day(i.at)} · ${i.label}${i.who ? ` by ${i.who}` : ''}: ${clip(i.name, 90)}`).join('\n')}`,
        cards: [{ type: 'timeline', title: x.name, items }],
        data: items,
      };
    },
  },

  {
    name: 'watch',
    description: `Create a watch rule: a graph pattern I check in the background and act on when it matches. Kinds: ${Object.entries(RULE_KINDS).map(([k, v]) => `${k} (${v.title})`).join('; ')}.`,
    params: { type: 'object', properties: { when: { type: 'string', description: 'what to watch for, in words' }, kind: { type: 'string', enum: Object.keys(RULE_KINDS) }, hours: { type: 'number' }, min: { type: 'number' } }, required: ['when'] },
    async run({ g, userId, dot }, { when: what, kind, hours, min }) {
      const k = kind || kindFromText(what);
      if (!k) return { text: `I can watch for: ${Object.values(RULE_KINDS).map((v) => v.title.toLowerCase()).join('; ')}. Which one?` };
      const params: Record<string, number> = {};
      if (hours) params.hours = hours;
      if (min) params.min = min;
      const ru = await createRule(g, k, { dot, params, text: what });
      const fired = await evaluateRules(userId, g, ru);
      const n = fired.reduce((a, f) => a + f.matches.length, 0);
      const r = RULE_KINDS[k];
      return { text: `Watching ${r.says.replace(/\{(\w+)\}/g, (_, x) => String(params[x] ?? r.defaults[x]))}. ${n ? `It already matches ${n} thing${n > 1 ? 's' : ''} — I posted them above.` : 'Nothing matches right now; I’ll tell you the moment something does.'}`, data: { rule: ru, fired } };
    },
  },

  {
    name: 'run_algorithm',
    description: `Run a FalkorDB graph algorithm and get ranked/grouped nodes back. Algorithms: ${Object.entries(ALGORITHMS).map(([k, v]) => `${k} (${v.what}; default ${v.defaults.label || 'any'}/${v.defaults.rel})`).join('; ')}. Labels e.g. Person, System, Project, Org; relationships e.g. COLLABORATES, DEPENDS_ON, WORKS_ON, USES, MENTIONS. reach needs source (direction in = who depends on it); shortest_path needs source and target.`,
    params: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', enum: Object.keys(ALGORITHMS) },
        label: { type: 'string' }, rel: { type: 'string' },
        source: { type: 'string', description: 'name or uid' }, target: { type: 'string', description: 'name or uid' },
        depth: { type: 'number' }, direction: { type: 'string', enum: ['out', 'in'] }, limit: { type: 'number' },
      },
      required: ['algorithm'],
    },
    async run({ g }, args) {
      const src = args.source ? (await resolve(g, args.source))?.uid : undefined;
      const dst = args.target ? (await resolve(g, args.target))?.uid : undefined;
      if (args.source && !src) return { text: `I couldn't find "${args.source}".` };
      if (args.target && !dst) return { text: `I couldn't find "${args.target}".` };
      const r = await runAlgorithm(g, { ...args, algorithm: args.algorithm as AlgoName, source: src, target: dst });
      // grouping algorithms read as groups: biggest first, loners left out of the list
      const grouped = r.rows.some((x) => x.group != null) ? [...r.rows.reduce((m, x) => m.set(x.group!, [...(m.get(x.group!) || []), x]), new Map<number, typeof r.rows>()).values()].filter((xs) => xs.length > 1).sort((a, b) => b.length - a.length) : null;
      const body = r.paths
        ? r.paths.map((p, i) => `${i + 1}. ${p.names.join(' → ')} (cost ${p.weight})`).join('\n')
        : grouped?.length
        ? grouped.slice(0, 6).map((xs, i) => `${i + 1}. ${xs.map((x) => `**${x.name}**`).join(', ')}`).join('\n')
        : r.rows.slice(0, 10).map((x, i) => `${i + 1}. **${x.name}** (${x.label})${x.score != null ? ` — ${Number(x.score).toFixed(3)}` : ''}${x.group != null ? ` — group ${x.group}` : ''}`).join('\n');
      return {
        text: `**${r.title}** over ${r.label ? `:${r.label}` : 'the graph'}${r.rel ? ` via ${r.rel}` : ''} — ${r.what.toLowerCase()}.\n\n${body}\n\n${r.summary}`,
        cards: [{ type: 'graph', title: r.title, focus: [...(src ? [src] : []), ...(dst ? [dst] : []), ...(grouped?.length ? grouped.flat() : r.rows).slice(0, 16).map((x) => x.uid)] }],
        data: r,
      };
    },
  },

  {
    name: 'insights',
    description: 'Graph-wide risk and health check: customers at risk, blocked work, bus factor on critical systems, single points of failure (multi-hop DEPENDS_ON + dependency PageRank), who we can\'t lose, who is overloaded, who is waiting on me, working groups (label propagation), what changed in the last 24h, agent fleet record.',
    params: { type: 'object', properties: { focus: { type: 'string', description: 'optional: customers | blocked | bus | spof | absence | waiting | stale | load | dups | groups | changed | fleet' } } },
    async run({ g }, { focus }) {
      const all = await insights(g);
      const secs = focus ? all.filter((s) => s.key === focus) : all;
      if (!secs.length) return { text: 'Nothing stands out in the graph right now.' };
      return {
        text: secs.map((s) => `**${s.title}**\n${s.items.slice(0, 4).map((i) => `- ${i.severity === 'high' ? '🔴 ' : i.severity === 'medium' ? '🟠 ' : ''}${i.title} — ${i.detail}`).join('\n')}`).join('\n\n'),
        cards: [{ type: 'graph', title: 'Insights', focus: secs.flatMap((s) => s.items.flatMap((i) => i.uids)).slice(0, 30) }],
        data: secs,
      };
    },
  },

  {
    name: 'list_agents',
    description: 'My coding-agent subscriptions (Codex, Claude Code, Cursor, OpenCode, Grok, Antigravity): installed or not, quota state, run record.',
    params: { type: 'object', properties: {} },
    async run({ g }) {
      const rows = await g.q(
        `MATCH (a:Agent) OPTIONAL MATCH (a)<-[:EXECUTED_BY]-(r:Run)
         RETURN a.uid AS uid, a.name AS name, a.plan AS plan, a.installed AS installed, a.version AS version, coalesce(a.limitedUntil,0) AS limitedUntil,
                count(CASE WHEN r.status = 'succeeded' THEN 1 END) AS wins, count(r) AS runs ORDER BY a.installed DESC, wins DESC`,
        {},
        'agent fleet',
      );
      return {
        text: rows.map((r) => `- **${r.name}** (${r.plan}) — ${r.installed ? `installed ${r.version}` : 'not installed'}${r.limitedUntil > Date.now() ? ', out of quota' : ''}; ${r.wins}/${r.runs} runs succeeded`).join('\n'),
        cards: [{ type: 'agents' }],
        data: rows,
      };
    },
  },

  {
    name: 'agent_skills',
    description: 'What each of my coding-agent subscriptions is good at: the skill graph (Agent)-[:SKILLED_IN {wins, losses, score}]->(System) learned from past runs.',
    params: { type: 'object', properties: { agent: { type: 'string' } } },
    async run({ g }, { agent }) {
      await refreshSkills(g);
      const rows = await g.q(
        `MATCH (a:Agent)-[s:SKILLED_IN]->(x:System) WHERE $agent = '' OR toLower(a.name) CONTAINS toLower($agent) OR a.kind = $agent
         RETURN a.uid AS auid, a.name AS agent, x.uid AS suid, x.name AS system, s.wins AS wins, s.losses AS losses, s.score AS score
         ORDER BY agent, score DESC`,
        { agent: agent || '' },
        'agent skill graph',
      );
      if (!rows.length) return { text: 'No finished runs yet — the skill graph fills in as your agents work.' };
      const by = new Map<string, any[]>();
      for (const r of rows) by.set(r.agent, [...(by.get(r.agent) || []), r]);
      return {
        text: [...by].map(([a, rs]) => `**${a}** — ${rs.map((r) => `${r.system} ${r.wins}✓${r.losses ? ` ${r.losses}✗` : ''}`).join(', ')}`).join('\n'),
        cards: [{ type: 'graph', title: 'Agent skill graph', focus: [...new Set(rows.flatMap((r) => [r.auid, r.suid]))] }],
        data: rows,
      };
    },
  },

  {
    name: 'propose_fix',
    description: 'Turn tickets into a coding job: gather graph context (affected systems, implementing repo, related chat/mail diagnosis, sibling tickets), pick the best agent from my subscriptions with the graph router, and create an approval card. Nothing runs until I approve.',
    params: { type: 'object', properties: { tickets: { type: 'array', items: { type: 'string' }, description: 'ticket keys/uids, or a customer/system name to fix its open tickets' }, agent: { type: 'string', description: 'optional agent kind the user asked for: codex, claude-code, cursor, opencode, grok, antigravity' } }, required: ['tickets'] },
    async run({ g, dot }, { tickets, agent }) {
      const uids: string[] = [];
      for (const t of tickets as string[]) {
        const n = await resolve(g, t, ['Ticket', 'Org', 'System']);
        if (!n) continue;
        if (n.label === 'Ticket') uids.push(n.uid);
        else {
          const rel = n.label === 'Org' ? 'FOR' : 'AFFECTS';
          for (const r of await g.q(`MATCH (t:Ticket)-[:${rel}]->({uid:$u}) WHERE t.status = 'open' AND (t)-[:AFFECTS]->(:System)<-[:IMPLEMENTS]-(:Repo) RETURN t.uid AS uid`, { u: n.uid }, `open tickets for ${n.name}`)) uids.push(r.uid);
        }
      }
      if (!uids.length) return { text: `I couldn't find open tickets for ${tickets.join(', ')}.` };
      const ctx = await g.q(
        `MATCH (t:Ticket) WHERE t.uid IN $uids
         MATCH (t)-[:AFFECTS]->(s:System)
         OPTIONAL MATCH (repo:Repo)-[:IMPLEMENTS]->(s)
         OPTIONAL MATCH (t)-[:FOR]->(o:Org)
         RETURN t.uid AS uid, t.key AS key, t.title AS title, t.body AS body, collect(DISTINCT s.uid) AS systems, collect(DISTINCT s.name) AS systemNames,
                collect(DISTINCT {uid: repo.uid, name: repo.name, path: repo.path}) AS repos, o.name AS org`,
        { uids },
        'tickets → systems → implementing repo',
      );
      const repo = ctx.flatMap((c) => c.repos).find((r: any) => r.path);
      if (!repo) return { text: `None of these tickets touch a repo I can work in yet. Connect the repo in Connectors → GitHub first.` };
      const systems = [...new Set(ctx.flatMap((c) => c.systems as string[]))];
      const diag = await g.q(
        `MATCH (m)-[:MENTIONS]->(x) WHERE x.uid IN $targets AND (m:ChatMessage OR m:Email) AND m.at > $since
         OPTIONAL MATCH (m)<-[:POSTED]-(p1:Person) OPTIONAL MATCH (m)-[:FROM]->(p2:Person)
         RETURN DISTINCT coalesce(m.text, m.body) AS text, coalesce(p1.name, p2.name) AS by, m.at AS at ORDER BY at DESC LIMIT 6`,
        { targets: [...uids, ...systems], since: Date.now() - 30 * DAY },
        'diagnosis already in chat + mail',
      );
      const files = await g.q(`MATCH (f:File)-[:IN_REPO]->(:Repo {uid:$r}) OPTIONAL MATCH (f)<-[:TOUCHES]-(c:Commit)-[:AUTHORED_BY]->(p:Person) RETURN f.path AS path, collect(DISTINCT p.name) AS authors`, { r: repo.uid }, 'repo files + authors');
      const choices = await routeJob(g, systems);
      const best = choices.find((c) => c.installed && agent && c.kind === agent) || choices.find((c) => c.installed) || choices[0];
      const prompt = [
        `You are fixing ${ctx.map((c) => c.key).join(' and ')} in this repository (${repo.name}, which implements ${ctx[0].systemNames.join(', ')}).`,
        ...ctx.map((c) => `- ${c.key}: ${c.title}. ${c.body}`),
        diag.length ? `What the team already found:\n${diag.map((d) => `- ${d.by}: ${d.text}`).join('\n')}` : '',
        `Files: ${files.map((f) => f.path).join(', ')}.`,
        'Make the smallest correct change, keep the public behaviour, and run `npm test` until it passes. Do not add dependencies. Finish with a two-line summary of the root cause and the fix.',
      ].filter(Boolean).join('\n');
      const goal = `Fix ${ctx.map((c) => c.key).join(' + ')} in ${repo.name}`;
      const d = await draftNode(g, {
        kind: 'run', title: goal, agent: best.kind, detail: `Repo: ${repo.name} · ${ctx.map((c) => c.key).join(', ')}`, dot,
        body: prompt,
        payload: { goal, prompt, dir: repo.path, repo: repo.uid, systems, tickets: uids, kind: best.kind, choices },
        links: [...uids.map((u) => ({ rel: 'FOR_TICKET', to: u })), { rel: 'PROPOSES', to: best.agent }],
      });
      return {
        text: `I can hand ${ctx.map((c) => c.key).join(' and ')} to **${best.name}** — ${best.reasons.join('; ')}. It will work in \`${repo.name}\` on a branch, run the tests, and report back. Approve to start.`,
        cards: [{ type: 'draft', draft: { uid: d, kind: 'run', status: 'pending', title: goal, agent: best.kind, choices, body: prompt, detail: `${repo.name} · ${ctx.flatMap((c) => c.systemNames).join(', ')}` } }],
        data: { draft: d, choices, tickets: ctx },
      };
    },
  },

  {
    name: 'draft_email',
    description: 'Draft an email (reply or new) for my approval. Nothing is sent until I approve.',
    params: { type: 'object', properties: { to: { type: 'string', description: 'person name/uid' }, subject: { type: 'string' }, body: { type: 'string' }, thread: { type: 'string', description: 'thread uid when replying' } }, required: ['to', 'body'] },
    async run({ g, dot }, { to, subject, body, thread }) {
      const p = await resolve(g, to, ['Person']);
      if (!p) return { text: `I couldn't find ${to}.` };
      let th = thread ? await resolve(g, thread, ['Thread']) : null;
      if (!th) th = await g.one(`MATCH (t:Thread)<-[:IN_THREAD]-(:Email)-[:FROM]->(:Person {uid:$p}) RETURN t.uid AS uid, t.subject AS name ORDER BY t.lastAt DESC LIMIT 1`, { p: p.uid }, 'latest thread with them');
      const subj = subject || (th ? `Re: ${String(th.name).replace(/^Re:\s*/i, '')}` : 'Quick note');
      const email = (await g.one(`MATCH (p:Person {uid:$u}) RETURN p.email AS email`, { u: p.uid }))?.email;
      const d = await draftNode(g, { kind: 'email', title: subj, to: `${p.name} <${email}>`, subject: subj, body, dot, payload: { to: p.uid, thread: th?.uid, subject: subj, body }, links: [{ rel: 'TO', to: p.uid }, ...(th ? [{ rel: 'REPLIES_TO', to: th.uid }] : [])] });
      return { text: `Draft to ${p.name} is ready for your approval.`, cards: [{ type: 'draft', draft: { uid: d, kind: 'email', status: 'pending', title: subj, to: `${p.name} <${email}>`, subject: subj, body } }], data: { draft: d } };
    },
  },

  {
    name: 'propose_event',
    description: 'Propose a calendar event with attendees for my approval.',
    params: { type: 'object', properties: { title: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } }, start: { type: 'string', description: 'ISO datetime' }, minutes: { type: 'number' } }, required: ['title', 'attendees'] },
    async run({ g, dot }, { title, attendees, start, minutes = 30 }) {
      const people: Row[] = [];
      for (const a of attendees as string[]) { const p = await resolve(g, a, ['Person']); if (p) people.push(p); }
      let t = start ? Date.parse(start) : NaN;
      if (Number.isNaN(t)) t = await firstFreeSlot(g, [...people.map((p) => p.uid), (await me(g)).uid], minutes);
      const d = await draftNode(g, { kind: 'event', title, when: when(t), to: people.map((p) => p.name).join(', '), dot, payload: { title, attendees: people.map((p) => p.uid), start: t, minutes }, links: people.map((p) => ({ rel: 'INVITES', to: p.uid })) });
      const clash = start ? await g.one(`UNWIND $u AS x MATCH (:Person {uid:x})-[:ATTENDS]->(e:Event) WHERE e.start < $end AND e.end > $start RETURN e.title AS title LIMIT 1`, { u: [...people.map((p) => p.uid), (await me(g)).uid], start: t, end: t + minutes * 60_000 }, 'anything clashing at that time?') : null;
      return { text: `Proposed **${title}** ${when(t)} (${minutes} min) with ${people.map((p) => p.name).join(', ')} — ${start ? (clash ? `heads up, it overlaps **${clash.title}**` : 'the time you asked, and nobody has a clash') : 'the first slot nobody has a clash'}. Approve to send the invite.`, cards: [{ type: 'draft', draft: { uid: d, kind: 'event', status: 'pending', title, to: people.map((p) => p.name).join(', '), when: when(t) } }] };
    },
  },

  {
    name: 'propose_reassign',
    description: 'Rebalance work using the graph: for a ticket, rank people by how well they know the affected systems (commits, docs, tickets, projects) minus their current load (open tickets, meetings in the next 2 days), and propose moving it to the best one. Needs approval.',
    params: { type: 'object', properties: { ticket: { type: 'string' }, draft: { type: 'boolean', description: 'false: just answer who fits, no approval draft' }, to: { type: 'string', description: 'optional: the person you want it moved to' } }, required: ['ticket'] },
    async run({ g, dot }, { ticket, draft = true, to }) {
      const t = await resolve(g, ticket, ['Ticket']);
      if (!t) return { text: `I couldn't find ticket ${ticket}.` };
      const cur = await g.one(`MATCH (t:Ticket {uid:$u}) OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person) RETURN t.key AS key, t.title AS title, a.uid AS who, a.name AS whoName`, { u: t.uid }, 'current owner');
      const scored = (await rankOwners(g, t.uid)).sort((a, b) => b.score - a.score || (a.uid === cur?.who ? -1 : b.uid === cur?.who ? 1 : 0));
      const wanted = to ? await resolve(g, to, ['Person']) : null;
      const best = (wanted && (scored.find((c) => c.uid === wanted.uid) || { uid: wanted.uid, name: wanted.name, commits: 0, docs: 0, tickets: 0, load: 0, meetings: 0, score: 0, know: 0, cost: 0, onProject: false })) || scored.find((c) => c.uid !== cur?.who);
      if (!best) return { text: `Nobody else in the graph knows the systems ${cur?.key} touches — keep it with ${cur?.whoName || 'its owner'}.` };
      const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
      const why = (c: any) => [c.commits && n(c.commits, 'commit'), c.docs && n(c.docs, 'doc'), c.tickets && n(c.tickets, 'past ticket'), `${c.load} open`, n(c.meetings, 'meeting') + ' soon'].filter(Boolean).join(', ');
      const curRow = scored.find((c) => c.uid === cur?.who);
      const d = !draft ? null : await draftNode(g, {
        kind: 'reassign', title: `Reassign ${cur.key} to ${best.name}`, to: best.name, dot,
        detail: `${cur.key} · ${cur.title}`,
        body: `${best.name}: ${why(best)} (score ${best.score})${curRow ? `\n${cur.whoName}: ${why(curRow)} (score ${curRow.score})` : ''}`,
        payload: { ticket: t.uid, from: cur?.who, to: best.uid, key: cur.key },
        links: [{ rel: 'FOR_TICKET', to: t.uid }, { rel: 'PROPOSES', to: best.uid }],
      });
      const ownerBest = !wanted && scored[0]?.uid === cur?.who;
      return {
        text: ownerBest
          ? `**${cur.whoName}** is still the best fit for ${cur.key} (${why(curRow)}). If you want it off their plate, **${best.name}** is next — ${why(best)}.`
          : `**${best.name}** is the best owner for ${cur.key} right now — ${why(best)}.${curRow ? ` ${cur.whoName} has ${why(curRow)}.` : ''}${(best as any).p1s ? (() => { const alt = scored.find((c) => c.uid !== best.uid && c.uid !== cur?.who); return ` Heads up: ${best.name.split(' ')[0]} is already on a P1${alt ? ` — **${alt.name}** is next if you'd rather spread the load (${why(alt)})` : ''}.`; })() : ''}`,
        cards: [
          { type: 'list', title: 'Who could take it', items: scored.slice(0, 4).map((c) => ({ title: `${c.name} · score ${c.score}`, subtitle: why(c), uid: c.uid, badge: c.uid === cur?.who ? 'owner' : c.uid === best.uid ? 'best' : 'option', tone: c.uid === best.uid ? 'green' : 'gray' })) },
          // a question gets an answer and a button; only "reassign X" makes a draft
          d ? { type: 'draft', draft: { uid: d, kind: 'reassign', status: 'pending', title: `Reassign ${cur.key} to ${best.name}`, to: best.name, detail: `${cur.key} · ${cur.title}`, body: `${best.name}: ${why(best)} (score ${best.score})${curRow ? `\n${cur.whoName}: ${why(curRow)} (score ${curRow.score})` : ''}` } }
            : { type: 'options', question: 'Move it?', options: [{ key: 'A', label: `Reassign ${cur.key} to ${best.name}`, value: `Reassign ${cur.key} to ${best.name}` }] },
        ] as Card[],
        data: { best, scored },
      };
    },
  },

  {
    name: 'what_if_absent',
    description: 'Simulate a person being out (leave, sick, quitting): systems only they know, systems left with one knower, open tickets and who should take each, decisions that stall, customers who lose their contact, meetings this week, colleagues who only connect through them, and who covers best.',
    params: { type: 'object', properties: { person: { type: 'string' } }, required: ['person'] },
    async run({ g, dot }, { person }) {
      const p = await resolve(g, person, ['Person']);
      if (!p) return { text: `I couldn't find a person called "${person}".` };
      const a = await absenceImpact(g, p.uid);
      if (!a) return { text: `I couldn't find ${person}.` };
      const first = a.person.name.split(' ')[0];
      const money = (n?: number) => (n ? ` ($${Math.round(n / 1000)}k ARR)` : '');
      const lines: string[] = [];
      if (a.orphaned.length) lines.push(`- **Nobody else knows** ${a.orphaned.map((s) => `${s.name}${s.tier ? ` (${s.tier})` : ''}`).join(', ')}${a.orphaned.some((s) => s.customers.length) ? ` — used by ${[...new Set(a.orphaned.flatMap((s) => s.customers))].join(', ')}` : ''}`);
      if (a.fragile.length) lines.push(`- **Down to one person:** ${a.fragile.map((s) => `${s.name} → only ${s.left}`).join('; ')}`);
      if (a.tickets.length) lines.push(`- **${a.tickets.length} open ticket${a.tickets.length > 1 ? 's need' : ' needs'} an owner:** ${a.tickets.map((t) => `${t.key}${t.priority ? ` ${t.priority}` : ''} → ${t.next ? `**${t.next.name}**` : 'nobody qualified'}`).join(', ')}`);
      if (a.decisions.length) lines.push(`- **Decisions:** ${a.decisions.map((d) => `${d.title} (${d.why})`).join('; ')}`);
      if (a.customers.length) lines.push(`- **Customers who talk to ${first}:** ${a.customers.map((c) => `${c.name}${money(c.arr)} via ${c.via.join(' + ')}`).join(', ')}`);
      if (a.meetings.length) lines.push(`- **This week:** ${a.meetings.map((m) => `${m.title} (${when(m.start)})${m.others === 0 ? ' — only them' : ''}`).join(', ')}`);
      if (a.isolated.length) lines.push(`- **Only connected through ${first}:** ${a.isolated.map((x) => x.name).join(', ')}`);
      const cover = a.cover[0];
      const level = a.severity >= 20 ? 'a big hole' : a.severity >= 8 ? 'a real gap' : 'manageable';
      const text = lines.length
        ? `If **${a.person.name}** is out, it's ${level}:\n${lines.join('\n')}${cover ? `\n\nBest cover: **${cover.name}** — shares ${cover.overlap.join(', ')}.` : ''}`
        : `If ${a.person.name} is out, nothing in the graph depends on them alone.`;
      const handoff = a.tickets.filter((t) => t.next);
      const cards: Card[] = [
        { type: 'graph', title: `Without ${first}`, focus: [a.person.uid, ...a.orphaned.map((s) => s.uid), ...a.tickets.map((t) => t.uid), ...a.customers.map((c) => c.uid), ...(cover ? [cover.uid] : [])].slice(0, 14) },
      ];
      if (handoff.length || a.orphaned.length) {
        cards.push({
          type: 'options', question: 'Want me to start the handoff?',
          options: [
            ...handoff.slice(0, 2).map((t, i) => ({ key: String.fromCharCode(65 + i), label: `Move ${t.key} to ${t.next!.name}`, value: `Reassign ${t.key}` })),
            ...(a.orphaned[0] ? [{ key: String.fromCharCode(65 + Math.min(handoff.length, 2)), label: `Who else could learn ${a.orphaned[0].name}?`, value: `Who else could learn ${a.orphaned[0].name}?` }] : []),
          ],
        });
      }
      void dot;
      return { text, cards, data: a };
    },
  },

  {
    name: 'critical_path',
    description: "What's blocking a project or launch: walks BLOCKED_BY upstream, collects open tickets and pending decisions on every project in the chain plus P1/P2 incidents on the systems they run on (through DEPENDS_ON), and ranks the root blockers by how much of the chain each one gates.",
    params: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
    async run({ g }, { project }) {
      const p = await resolve(g, project, ['Project']);
      if (!p) return { text: `I couldn't find a project called "${project}".` };
      const c = await criticalPath(g, p.uid);
      if (!c) return { text: `I couldn't find ${project}.` };
      if (!c.blockers.length) return { text: `Nothing in the graph is blocking **${c.project.name}**${c.project.status ? ` (status: ${c.project.status})` : ''}.` };
      const arrow = (b: (typeof c.blockers)[number]) => b.chainNames.slice(1).join(' → ');
      const label = (b: (typeof c.blockers)[number]) =>
        b.kind === 'decision' ? `**Decision${b.waitsOnMe ? ' waiting on you' : b.owner ? ` waiting on ${b.owner}` : ''}:** ${b.title}`
          : `**${b.key}** ${b.priority || ''}${b.kind === 'incident' ? ` on ${b.chainNames[1]}` : ''} — ${clip(b.title, 60)}${b.owner ? ` (${b.owner})` : ''}`;
      const top = c.blockers.slice(0, 5);
      const first = top[0];
      const upstream = c.upstream.length ? ` It waits on ${c.upstream.map((u) => `**${u.name}**${u.status ? ` (${u.status})` : ''}`).join(' → ')}.` : '';
      const arr = c.customers.reduce((n, o) => n + o.arr, 0);
      const blockedHard = c.blockers.some((b) => b.kind === 'decision' || b.priority === 'P1') || c.upstream.length > 0;
      const text = [
        `${blockedHard ? `**Not on track** — ${c.blockers.length} thing${c.blockers.length > 1 ? 's' : ''} stand${c.blockers.length > 1 ? '' : 's'} in the way.` : `**On track, with ${c.blockers.length} open item${c.blockers.length > 1 ? 's' : ''} to watch.**`} **${c.project.name}**${c.project.status ? ` is ${/^(beta|alpha|review)$/.test(c.project.status) ? `in ${c.project.status}` : c.project.status}` : ''}.${upstream}`,
        '',
        'Root blockers, most of the chain first:',
        ...top.map((b, i) => `${i + 1}. ${label(b)}\n   ↳ ${arrow(b)}`),
        '',
        `**Unblock first:** ${first.kind === 'decision' ? `the decision "${first.title}"` : first.key} — it gates ${first.gates} project${first.gates > 1 ? 's' : ''}.`,
        c.customers.length ? `Customers on the line: ${c.customers.map((o) => o.name).join(', ')}${arr ? ` ($${Math.round(arr / 1000)}k ARR)` : ''}.` : '',
        c.waiting.length ? `Waiting to hear: ${c.waiting.map((w) => w.name).join(', ')}.` : '',
      ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim();
      const options = top.slice(0, 3).map((b, i) => ({
        key: String.fromCharCode(65 + i),
        label: b.kind === 'decision' ? `Help me decide: ${clip(b.title, 50)}` : b.priority === 'P1' ? `Fix ${b.key} with a coding agent` : `Who should take ${b.key}?`,
        value: b.kind === 'decision' ? `Help me decide: ${b.title}` : b.priority === 'P1' ? `Fix ${b.key}` : `Who should take ${b.key}?`,
      }));
      return {
        text,
        cards: [
          { type: 'graph', title: `What blocks ${c.project.name}`, focus: [...new Set(top.flatMap((b) => b.chain))].slice(0, 16), exact: true },
          { type: 'options', question: 'Where do you want to start?', options },
        ],
        data: c,
      };
    },
  },

  {
    name: 'customer_health',
    description: 'Rank every customer by risk from graph signals: their open tickets and age, P1/P2 incidents on systems they use (through DEPENDS_ON), threads waiting on us, repeated follow-ups and escalation language, how many people on our side they connect to, and an imminent meeting. Weighted by ARR, with the next action for each.',
    params: { type: 'object', properties: { org: { type: 'string', description: 'optional: one customer' } } },
    async run({ g }, { org }) {
      let rows = await customerHealth(g);
      if (org) {
        const o = await resolve(g, org, ['Org', 'Person']);
        const ou = o?.label === 'Person' ? (await g.one(`MATCH (:Person {uid:$u})-[:WORKS_AT]->(o:Org) RETURN o.uid AS uid`, { u: o.uid }))?.uid : o?.uid;
        const one = rows.find((r) => r.uid === ou);
        if (!one) return { text: `${o?.name || org} isn't a customer in the graph, so I don't have a health read on them.` };
        const verdict = one.level === 'at risk' ? 'At risk' : one.level === 'watch' ? 'Not at risk yet — but worth watching' : 'Healthy by everything the graph shows';
        return {
          text: `**${verdict}** (${one.name}: risk ${one.risk}${one.arr ? `, $${Math.round(one.arr / 1000)}k ARR` : ''}).${one.signals.length ? `\n${one.signals.map((x) => `- ${x.what}`).join('\n')}` : '\nNothing open, nobody waiting.'}${one.next ? `\n\nNext: ${one.next.label}.` : ''}`,
          cards: [{ type: 'graph', title: one.name, focus: [one.uid, ...one.signals.flatMap((x) => x.uids)].slice(0, 12) }, ...(one.next ? [{ type: 'options' as const, question: 'Do it?', options: [{ key: 'A', label: one.next.label, value: one.next.ask }] }] : [])],
          data: [one],
        };
      }
      if (!rows.length) return { text: 'There are no customers in the graph yet.' };
      const k = (n: number) => `$${Math.round(n / 1000)}k`;
      const atRisk = rows.filter((r) => r.level === 'at risk');
      const text = [
        atRisk.length ? `**${atRisk.length} customer${atRisk.length > 1 ? 's' : ''} at risk** (${k(atRisk.reduce((n, r) => n + r.arr, 0))} ARR):` : 'No customer is at risk right now:',
        ...rows.map((r) => `- **${r.name}** — ${r.level}, risk ${r.risk}${r.arr ? ` · ${k(r.arr)} ARR` : ''}${r.signals.length ? `\n  ${r.signals.slice(0, 4).map((s) => s.what).join(' · ')}` : ''}${r.next ? `\n  Next: ${r.next.label}` : ''}`),
      ].join('\n');
      const options = rows.filter((r) => r.next && r.level !== 'healthy').slice(0, 3).map((r, i) => ({ key: String.fromCharCode(65 + i), label: `${r.name}: ${r.next!.label}`, value: r.next!.ask }));
      return {
        text,
        cards: [
          { type: 'list', title: 'Customer health', items: rows.map((r) => ({ title: `${r.name} · risk ${r.risk}`, subtitle: r.signals.slice(0, 2).map((s) => s.what).join(' · ') || 'nothing open', uid: r.uid, badge: r.level, tone: r.level === 'at risk' ? 'red' : r.level === 'watch' ? 'amber' : 'green' })) },
          ...(options.length ? [{ type: 'options' as const, question: 'Want me to start on one?', options }] : []),
        ],
        data: rows,
      };
    },
  },

  {
    name: 'rank_entities',
    description: 'Rank projects, systems, customers, people or teams by a graph count: open tickets, dependents (multi-hop DEPENDS_ON), customers exposed, or people. Answers "which project has the most open tickets?", "which system has the most dependents?".',
    params: { type: 'object', properties: { label: { type: 'string', enum: ['Project', 'System', 'Org', 'Person', 'Team'] }, metric: { type: 'string', enum: ['open_tickets', 'dependents', 'customers', 'people', 'systems'] }, engineers: { type: 'boolean', description: 'people: engineering roles only' } }, required: ['label', 'metric'] },
    async run({ g }, { label, metric, engineers }) {
      const Q: Record<string, Record<string, string>> = {
        open_tickets: {
          Project: `MATCH (x:Project) OPTIONAL MATCH (t:Ticket {status:'open'})-[:PART_OF]->(x) RETURN x.uid AS uid, x.name AS name, count(DISTINCT t) AS n, collect(DISTINCT t.key)[0..4] AS ex`,
          System: `MATCH (x:System) OPTIONAL MATCH (t:Ticket {status:'open'})-[:AFFECTS]->(x) RETURN x.uid AS uid, x.name AS name, count(DISTINCT t) AS n, collect(DISTINCT t.key)[0..4] AS ex`,
          Org: `MATCH (x:Org {kind:'customer'}) OPTIONAL MATCH (t:Ticket {status:'open'})-[:FOR]->(x) RETURN x.uid AS uid, x.name AS name, count(DISTINCT t) AS n, collect(DISTINCT t.key)[0..4] AS ex`,
          Person: `MATCH (x:Person) WHERE NOT coalesce(x.external, false) AND NOT coalesce(x.me, false) OPTIONAL MATCH (t:Ticket {status:'open'})-[:ASSIGNED_TO]->(x) RETURN x.uid AS uid, x.name AS name, x.role AS role, count(DISTINCT t) AS n, collect(DISTINCT t.key)[0..4] AS ex`,
        },
        dependents: {
          System: `MATCH (x:System) OPTIONAL MATCH (d:System)-[:DEPENDS_ON*1..4]->(x) RETURN x.uid AS uid, x.name AS name, count(DISTINCT d) AS n, collect(DISTINCT d.name)[0..4] AS ex`,
        },
        customers: {
          System: `MATCH (x:System) OPTIONAL MATCH (o:Org {kind:'customer'})-[:USES]->(:System)-[:DEPENDS_ON*0..3]->(x) RETURN x.uid AS uid, x.name AS name, count(DISTINCT o) AS n, collect(DISTINCT o.name)[0..4] AS ex`,
          Project: `MATCH (x:Project) OPTIONAL MATCH (x)-[:USES]->(:System)<-[:DEPENDS_ON*0..3]-(:System)<-[:USES]-(o:Org {kind:'customer'}) RETURN x.uid AS uid, x.name AS name, count(DISTINCT o) AS n, collect(DISTINCT o.name)[0..4] AS ex`,
        },
        people: {
          Project: `MATCH (x:Project) OPTIONAL MATCH (p:Person)-[:WORKS_ON|OWNS]->(x) RETURN x.uid AS uid, x.name AS name, count(DISTINCT p) AS n, collect(DISTINCT p.name)[0..4] AS ex`,
          Team: `MATCH (x:Team) OPTIONAL MATCH (p:Person)-[:MEMBER_OF]->(x) RETURN x.uid AS uid, x.name AS name, count(DISTINCT p) AS n, collect(DISTINCT p.name)[0..4] AS ex`,
          Org: `MATCH (x:Org) OPTIONAL MATCH (p:Person)-[:WORKS_AT]->(x) RETURN x.uid AS uid, x.name AS name, count(DISTINCT p) AS n, collect(DISTINCT p.name)[0..4] AS ex`,
        },
        systems: {
          Org: `MATCH (x:Org {kind:'customer'}) OPTIONAL MATCH (x)-[:USES]->(:System)-[:DEPENDS_ON*0..3]->(s:System) RETURN x.uid AS uid, x.name AS name, count(DISTINCT s) AS n, collect(DISTINCT s.name)[0..10] AS ex`,
          Project: `MATCH (x:Project) OPTIONAL MATCH (x)-[:USES]->(s:System) RETURN x.uid AS uid, x.name AS name, count(DISTINCT s) AS n, collect(DISTINCT s.name)[0..5] AS ex`,
        },
      };
      const q = Q[metric]?.[label];
      if (!q) return { text: `I can rank ${Object.entries(Q).map(([m, ls]) => `${Object.keys(ls).join('/')} by ${m.replace('_', ' ')}`).join('; ')}.` };
      const rows = (await g.q(`${q} ORDER BY n DESC LIMIT 40`, {}, `rank ${label} by ${metric}${engineers ? ' (engineers)' : ''}`))
        .filter((r) => r.n > 0 && (!engineers || ENGINEERING.test(r.role || ''))).slice(0, 6);
      const what = metric === 'systems' ? 'systems in use' : metric.replace('_', ' ');
      const noun = label === 'Org' ? 'customer' : engineers ? 'engineer' : label.toLowerCase();
      if (!rows.length) return { text: `No ${noun} has any ${what} right now.` };
      return {
        text: `${rows.filter((r) => r.n === rows[0].n).length > 1 ? `It's a tie: ${rows.filter((r) => r.n === rows[0].n).map((r) => `**${r.name}**`).join(', ')} each have ${rows[0].n} ${rows[0].n === 1 ? what.replace(/s$/, '') : what}.` : `**${rows[0].name}** has the most ${what} (${rows[0].n}).`}\n${rows.map((r, i) => `${i + 1}. **${r.name}** — ${r.n} ${r.n === 1 ? what.replace(/s$/, '') : what}${r.ex.length ? `: ${r.ex.join(', ')}` : ''}`).join('\n')}`,
        cards: [{ type: 'graph', title: `${noun}s by ${what}`, focus: rows.slice(0, 4).map((r) => r.uid) }],
        data: rows,
      };
    },
  },

  {
    name: 'diagnose',
    description: 'A system looks slow or broken: walk DEPENDS_ON upstream (0-4 hops) to find open incidents on it or anything it relies on, nearest first, plus who reported the symptom and who owns the likely cause.',
    params: { type: 'object', properties: { system: { type: 'string' } }, required: ['system'] },
    async run({ g }, { system }) {
      const s = await resolve(g, system, ['System', 'Repo']);
      if (!s) return { text: `I couldn't find a system called "${system}".` };
      const sys = s.label === 'Repo' ? (await g.one(`MATCH (:Repo {uid:$u})-[:IMPLEMENTS]->(x:System) RETURN x.uid AS uid, x.name AS name`, { u: s.uid })) || s : s;
      const causes = await g.q(
        `MATCH p = (s:System {uid:$u})-[:DEPENDS_ON*0..4]->(d:System)<-[:AFFECTS]-(t:Ticket {status:'open'})
         OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person)
         WITH t, a, min(length(p)) - 1 AS hops, collect([n IN nodes(p) WHERE n:System | n.name])[0] AS route, collect([n IN nodes(p) WHERE n:System | n.uid])[0] AS routeUids
         RETURN t.uid AS uid, t.key AS key, t.title AS title, t.priority AS priority, t.body AS body, a.name AS owner, hops, route, routeUids
         ORDER BY hops, t.priority`,
        { u: sys.uid },
        `open incidents on ${sys.name} and everything it depends on`,
      );
      const reports = await g.q(
        `MATCH (s:System {uid:$u})<-[:MENTIONS]-(m)-[:FROM|POSTED]-(p:Person) WHERE (m:Email OR m:ChatMessage) AND NOT coalesce(p.me, false)
         OPTIONAL MATCH (p)-[:WORKS_AT]->(o:Org)
         RETURN DISTINCT p.name AS who, o.name AS org, coalesce(m.subject, m.name) AS said, m.at AS at ORDER BY at DESC LIMIT 3`,
        { u: sys.uid },
        `who has mentioned ${sys.name}`,
      );
      if (!causes.length) return { text: `Nothing open on **${sys.name}** or anything it depends on. If it's misbehaving, this is new — want me to draft a ticket?` };
      const pri = (p?: string) => (p === 'P1' ? 0 : p === 'P2' ? 1 : 2);
      const best = [...causes].sort((a, b) => pri(a.priority) - pri(b.priority) || a.hops - b.hops)[0];
      const where = (c: any) => (c.hops === 0 ? `on ${sys.name} itself` : `on ${c.route[c.route.length - 1]}, ${c.hops} hop${c.hops > 1 ? 's' : ''} upstream (${c.route.join(' → ')})`);
      const text = [
        `**Likely cause:** ${best.key} ${best.priority || ''} — ${best.title}, ${where(best)}.${best.owner ? ` ${best.owner} has it.` : ' Nobody owns it yet.'}`,
        best.body ? `> ${clip(best.body, 160)}` : '',
        causes.length > 1 ? `\nAlso open on the path:\n${causes.filter((c) => c.uid !== best.uid).slice(0, 4).map((c) => `- ${c.key} ${c.priority || ''} — ${clip(c.title, 60)} (${c.hops ? `${c.route[c.route.length - 1]}, ${c.hops} hop${c.hops > 1 ? 's' : ''} up` : 'here'})`).join('\n')}` : '',
        reports.length ? `\nWho noticed: ${reports.map((r) => `${r.who}${r.org && r.org !== 'Lumen Labs' ? ` (${r.org})` : ''}`).join(', ')}.` : '',
      ].filter(Boolean).join('\n');
      return {
        text,
        cards: [
          { type: 'graph', title: `Why ${sys.name} hurts`, focus: [...new Set([sys.uid, ...causes.slice(0, 4).flatMap((c) => [c.uid, ...c.routeUids])])], exact: true },
          { type: 'options', question: 'Next step?', options: [
            { key: 'A', label: best.priority === 'P1' ? `Fix ${best.key} with a coding agent` : `Who should take ${best.key}?`, value: best.priority === 'P1' ? `Fix ${best.key}` : `Who should take ${best.key}?` },
            { key: 'B', label: `What else breaks if ${best.route[best.route.length - 1]} goes down?`, value: `What breaks if ${best.route[best.route.length - 1]} goes down?` },
          ] },
        ],
        data: { system: sys, causes, reports },
      };
    },
  },

  {
    name: 'workload',
    description: "How loaded a person is, from the graph: open tickets (with priority), meetings in the next 7 days, decisions waiting on them, threads they owe a reply on, and systems only they know. Without a person, ranks everyone by load.",
    params: { type: 'object', properties: { person: { type: 'string', description: 'optional' }, engineers: { type: 'boolean', description: 'only engineering roles' } } },
    async run({ g }, { person, engineers }) {
      const now = Date.now();
      const rows = await g.q(
        `MATCH (p:Person) WHERE NOT coalesce(p.external, false) AND NOT coalesce(p.me, false) AND ($u = '' OR p.uid = $u)
         OPTIONAL MATCH (p)<-[:ASSIGNED_TO]-(t:Ticket {status:'open'})
         WITH p, collect(DISTINCT t.key + ' ' + coalesce(t.priority, '')) AS tickets, sum(CASE t.priority WHEN 'P1' THEN 3 WHEN 'P2' THEN 2 ELSE 1 END) AS tw
         OPTIONAL MATCH (p)-[:ATTENDS]->(e:Event) WHERE e.start > $now AND e.start < $week
         WITH p, tickets, tw, count(DISTINCT e) AS meetings
         OPTIONAL MATCH (d:Decision {status:'pending'})-[:AWAITS]->(p)
         RETURN p.uid AS uid, p.name AS name, p.role AS role, tickets, tw, meetings, count(DISTINCT d) AS decisions`,
        { u: '', now, week: now + 7 * DAY, ...(person ? { u: (await resolve(g, person, ['Person']))?.uid || '__none__' } : {}) },
        person ? `workload of ${person}` : 'workload of everyone',
      );
      if (!rows.length) return { text: `I couldn't find ${person || 'anyone'} in the graph.` };
      const scored = rows.filter((r) => !engineers || ENGINEERING.test(r.role || '')).map((r) => ({ ...r, load: 2 * r.tw + r.meetings + 2 * r.decisions })).sort((a, b) => b.load - a.load);
      const avg = scored.reduce((n, r) => n + r.load, 0) / Math.max(1, scored.length);
      const line = (r: any) => `**${r.name}**${r.role ? ` (${r.role})` : ''} — ${r.tickets.length ? `${r.tickets.length} open ticket${r.tickets.length > 1 ? 's' : ''} (${r.tickets.join(', ')})` : 'no open tickets'}, ${r.meetings} meeting${r.meetings === 1 ? '' : 's'} this week${r.decisions ? `, ${r.decisions} decision${r.decisions > 1 ? 's' : ''} waiting on them` : ''}`;
      if (person) {
        const r = scored[0];
        const everyone = (await toolByName('workload')!.run({ g } as any, {})).data as any[];
        const teamAvg = everyone.reduce((n, x) => n + x.load, 0) / Math.max(1, everyone.length);
        const a = await absenceImpact(g, r.uid);
        // "overloaded" needs real weight: two or more open tickets, or a P1 on top of a full week of meetings
      const p1 = (r.tickets as string[]).some((x) => x.endsWith('P1'));
      const heavy = r.tickets.length >= 2 || (p1 && r.meetings >= 3) || r.decisions >= 2;
      const verdict = heavy ? `**${r.name} is carrying a lot**` : r.load > teamAvg ? `**${r.name} is busier than average, not overloaded**` : `**${r.name} is at or below the team's load**`;
        return {
          text: `${verdict} (load ${r.load} vs team average ${teamAvg.toFixed(1)}).\n${line(r)}.${a?.orphaned.length ? `\nThey are also the only person who knows ${a.orphaned.map((s) => s.name).join(', ')}.` : ''}`,
          cards: [{ type: 'graph', title: `${r.name}'s load`, focus: [r.uid] }],
          data: scored,
        };
      }
      return {
        text: `Busiest first (open tickets weighted by priority, meetings this week, decisions waiting):\n${scored.slice(0, 6).map((r, i) => `${i + 1}. ${line(r)}`).join('\n')}\n\nTeam average load: ${avg.toFixed(1)}.`,
        cards: [{ type: 'graph', title: 'Who is carrying what', focus: scored.slice(0, 5).map((r) => r.uid) }],
        data: scored,
      };
    },
  },

  {
    name: 'recent_from',
    description: 'What a person (or a customer) said recently: their emails and chat messages, newest first, with what each one is about.',
    params: { type: 'object', properties: { who: { type: 'string' }, days: { type: 'number' } }, required: ['who'] },
    async run({ g }, { who, days = 30 }) {
      const x = await resolve(g, who, ['Person', 'Org']);
      if (!x) return { text: `I couldn't find "${who}".` };
      const rows = await g.q(
        `MATCH (p:Person) WHERE p.uid = $u OR (p)-[:WORKS_AT]->(:Org {uid:$u})
         MATCH (p)<-[:FROM]-(m:Email) WHERE m.at > $since
         OPTIONAL MATCH (m)-[:MENTIONS]->(a) WHERE a:Ticket OR a:Project OR a:System
         RETURN m.uid AS uid, p.name AS who, m.subject AS title, m.body AS body, m.at AS at, collect(DISTINCT a.name) AS about
         UNION ALL
         MATCH (p:Person) WHERE p.uid = $u OR (p)-[:WORKS_AT]->(:Org {uid:$u})
         MATCH (p)-[:POSTED]->(m:ChatMessage) WHERE m.at > $since
         OPTIONAL MATCH (m)-[:MENTIONS]->(a) WHERE a:Ticket OR a:Project OR a:System
         RETURN m.uid AS uid, p.name AS who, '#chat' AS title, coalesce(m.text, m.name) AS body, m.at AS at, collect(DISTINCT a.name) AS about`,
        { u: x.uid, since: Date.now() - days * DAY },
        `what ${x.name} said (mail + chat)`,
      );
      rows.sort((a, b) => b.at - a.at);
      if (!rows.length) return { text: `Nothing from ${x.name} in the last ${days} days.` };
      return {
        text: `What **${x.name}** said lately:\n${rows.slice(0, 6).map((r) => `- ${ago(r.at)}${r.who !== x.name ? ` (${r.who})` : ''}${r.title === '#chat' ? ' in chat' : ` — "${r.title}"`}: ${clip(String(r.body).replace(/\s+/g, ' '), 140)}${r.about.length ? ` _(${r.about.join(', ')})_` : ''}`).join('\n')}`,
        cards: [{ type: 'graph', title: `From ${x.name}`, focus: [x.uid, ...rows.slice(0, 6).map((r) => r.uid)] }],
        data: rows,
      };
    },
  },

  {
    name: 'who_could_learn',
    description: 'Who could become the second person on a system: colleagues who already work on projects that use it, touch the systems next to it (DEPENDS_ON either way), and work closely with the current knowers — ranked, excluding the people who already know it.',
    params: { type: 'object', properties: { system: { type: 'string' } }, required: ['system'] },
    async run({ g }, { system }) {
      const s = await resolve(g, system, ['System']);
      if (!s) return { text: `I couldn't find a system called "${system}".` };
      const ks = await knowers(g, s.uid);
      const alias = await aliasMap(g);
      const knownUids = [...ks.map((k) => k.uid), ...[...alias].filter(([, m]) => ks.some((k) => k.uid === m)).map(([d]) => d)];
      const rows = await g.q(
        `MATCH (p:Person) WHERE NOT coalesce(p.external, false) AND NOT coalesce(p.me, false) AND NOT p.uid IN $known AND NOT p.uid IN $aliases
         OPTIONAL MATCH (p)-[:WORKS_ON|OWNS]->(:Project)-[:USES]->(:System {uid:$u})
         WITH p, count(*) AS onProject
         OPTIONAL MATCH (p)<-[:ASSIGNED_TO]-(:Ticket)-[:AFFECTS]->(n:System)-[:DEPENDS_ON]-(:System {uid:$u})
         WITH p, onProject, count(DISTINCT n) AS neighbours
         OPTIONAL MATCH (p)-[c:CLOSE_TO]-(k:Person) WHERE k.uid IN $known
         WITH p, onProject, neighbours, collect(DISTINCT k.name) AS closeTo
         OPTIONAL MATCH (p)<-[:ASSIGNED_TO]-(o:Ticket {status:'open'})
         RETURN p.uid AS uid, p.name AS name, p.role AS role, onProject, neighbours, closeTo, count(DISTINCT o) AS load`,
        { u: s.uid, known: knownUids, aliases: [...alias.keys()] },
        `who is one step from ${s.name}: projects on it, neighbouring systems, close to its knowers`,
      );
      const scored = rows
        .map((r) => ({ ...r, onProject: r.onProject > 0 ? 1 : 0 }))
        .map((r) => ({ ...r, score: 3 * r.onProject + 2 * r.neighbours + 2 * r.closeTo.length - r.load }))
        // systems are technical: the second person should be an engineer
        .filter((r) => (r.onProject || r.neighbours || r.closeTo.length) && ENGINEERING.test(r.role || ''))
        .sort((a, b) => b.score - a.score);
      const known = ks.map((k) => k.name);
      if (!scored.length) return { text: `Nobody is one step from **${s.name}** yet${known.length ? ` — only ${known.join(', ')} know${known.length === 1 ? 's' : ''} it` : ''}.` };
      const why = (r: any) => [r.onProject && 'on a project that uses it', r.neighbours && `works on ${r.neighbours} neighbouring system${r.neighbours > 1 ? 's' : ''}`, r.closeTo.length && `works closely with ${r.closeTo.join(', ')}`, `${r.load} open ticket${r.load === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
      return {
        text: `**${s.name}** is known by ${known.join(', ') || 'nobody'} today. Best second person:\n${scored.slice(0, 4).map((r, i) => `${i + 1}. **${r.name}**${r.role ? ` (${r.role})` : ''} — ${why(r)}`).join('\n')}${known[0] ? `\n\nPair ${scored[0].name} with ${known[0]} on the next ${s.name} ticket.` : ''}`,
        cards: [{ type: 'graph', title: `Who could learn ${s.name}`, focus: [s.uid, ...ks.map((k) => k.uid), ...scored.slice(0, 3).map((r) => r.uid)], exact: true }],
        data: { knowers: ks.map((k) => k.uid), candidates: scored },
      };
    },
  },

  {
    name: 'list_entities',
    description: 'Count and list nodes of one kind with simple filters: tickets (status, priority), projects (status), systems (tier), orgs (kind: customer/vendor/investor/prospect), decisions (status), people, events (upcoming), docs. Also totals customer ARR. Answers "how many open P1s?", "list all open tickets", "what is our total ARR?".',
    params: { type: 'object', properties: {
      label: { type: 'string', enum: ['Ticket', 'Project', 'System', 'Org', 'Decision', 'Person', 'Event', 'Doc', 'Team'] },
      status: { type: 'string' }, priority: { type: 'string' }, kind: { type: 'string' }, tier: { type: 'string' },
      within: { type: 'string', description: 'optional: only those connected to this entity (people on a project, tickets on a system, systems a customer uses…)' },
      olderThanDays: { type: 'number', description: 'optional: created more than N days ago' },
    }, required: ['label'] },
    async run({ g }, { label, status, priority, kind, tier, within, olderThanDays }) {
      const where: string[] = [];
      const params: Record<string, unknown> = { now: Date.now() };
      let scope = '';
      let scopeName = '';
      if (within) {
        const w = await resolve(g, within);
        if (!w) return { text: `I couldn't find "${within}".` };
        const REL: Record<string, string> = {
          'Person|Project': '(n)-[:WORKS_ON|OWNS]->(w)', 'Person|Team': '(n)-[:MEMBER_OF]->(w)', 'Person|Org': '(n)-[:WORKS_AT]->(w)', 'Person|System': '(n)<-[:ASSIGNED_TO]-(:Ticket)-[:AFFECTS]->(w)',
          'Ticket|Project': '(n)-[:PART_OF]->(w)', 'Ticket|System': '(n)-[:AFFECTS]->(w)', 'Ticket|Person': '(n)-[:ASSIGNED_TO]->(w)', 'Ticket|Org': '(n)-[:FOR]->(w)',
          'System|Org': '(w)-[:USES]->(n)', 'System|Project': '(w)-[:USES]->(n)', 'Decision|Project': '(n)-[:ABOUT]->(w)', 'Decision|System': '(n)-[:ABOUT]->(w)', 'Decision|Org': '(n)-[:ABOUT]->(w)',
          'Event|Org': '(n)-[:ABOUT]->(w)', 'Event|Project': '(n)-[:ABOUT]->(w)', 'Event|Person': '(w)-[:ATTENDS]->(n)', 'Doc|System': '(n)-[:ABOUT]->(w)', 'Doc|Project': '(n)-[:ABOUT]->(w)', 'Project|Person': '(w)-[:WORKS_ON|OWNS]->(n)',
        };
        const pat = REL[`${label}|${w.label}`];
        if (!pat) return { text: `I don't have a way to list ${label.toLowerCase()}s of a ${w.label.toLowerCase()} yet.` };
        scope = `MATCH (w {uid:$w}) MATCH ${pat} WITH DISTINCT n `;
        params.w = w.uid;
        scopeName = w.name;
      }
      if (status) { where.push('toLower(coalesce(n.status, "")) = $status'); params.status = String(status).toLowerCase(); }
      if (priority) { where.push('n.priority = $priority'); params.priority = String(priority).toUpperCase(); }
      if (kind) { where.push('n.kind = $kind'); params.kind = kind; }
      if (tier) { where.push('n.tier = $tier'); params.tier = tier; }
      if (label === 'Person') where.push('NOT coalesce(n.me, false) AND coalesce(n.role, "") <> "Newsletter"');
      if (label === 'Event') where.push('n.start > $now');
      if (olderThanDays) { where.push('n.at < $before'); params.before = Date.now() - olderThanDays * DAY; }
      const allowed = ['Ticket', 'Project', 'System', 'Org', 'Decision', 'Person', 'Event', 'Doc', 'Team'];
      if (!allowed.includes(label)) return { text: `I can list ${allowed.join(', ')}.` };
      const rows = await g.q(
        `${scope ? scope.replace('(n)', `(n:${label})`) : `MATCH (n:${label}) `}${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         OPTIONAL MATCH (n)-[:ASSIGNED_TO|AWAITS]->(a:Person)
         RETURN n.uid AS uid, n.at AS at, coalesce(n.key, n.name, n.title) AS name, n.title AS title, n.status AS status, n.priority AS priority, n.kind AS kind, n.tier AS tier, n.arr AS arr, n.role AS role, n.start AS start, CASE WHEN coalesce(a.me, false) THEN 'waiting on you' ELSE a.name END AS owner
         ORDER BY coalesce(n.priority, 'Z'), coalesce(n.start, 0), name LIMIT 60`,
        params,
        `list ${label}${where.length ? ` where ${Object.entries({ status, priority, kind, tier }).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`,
      );
      const what = [status, priority, label === 'Org' ? (kind || 'org') : tier, label === 'Org' ? '' : label.toLowerCase()].filter(Boolean).join(' ');
      const on = `${scopeName ? ` on ${scopeName}` : ''}${olderThanDays ? ` open more than ${olderThanDays} days` : ''}`;
      const plural = (n: number) => (n === 1 ? what : what.replace(/(y)$/, 'ie').replace(/(person)$/, 'people') + (what.endsWith('person') ? '' : 's'));
      if (!rows.length) return { text: `There are no ${plural(0)}${on} in the graph.` };
      const arr = rows.reduce((n, r) => n + (r.arr || 0), 0);
      const line = (r: any) => {
        const bits = [label === 'Ticket' && olderThanDays && r.at ? `${Math.round((Date.now() - r.at) / DAY)}d old` : '', label === 'Ticket' && !priority ? r.priority : '', !status ? r.status : '', !tier ? r.tier : '', !kind ? r.kind : '', r.role, r.arr ? `$${Math.round(r.arr / 1000)}k ARR` : '', r.start ? when(r.start) : '', r.owner ? (r.owner === 'waiting on you' ? r.owner : `→ ${r.owner}`) : ''].filter(Boolean);
        return `- **${r.name}**${r.title && r.title !== r.name ? ` — ${clip(r.title, 70)}` : ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
      };
      return {
        text: `**${rows.length} ${plural(rows.length)}${on}**${arr ? ` · $${Math.round(arr / 1000)}k ARR in total` : ''}:\n${rows.slice(0, 15).map(line).join('\n')}${rows.length > 15 ? `\n…and ${rows.length - 15} more.` : ''}`,
        cards: [{ type: 'graph', title: `${rows.length} ${plural(rows.length)}`, focus: rows.slice(0, 12).map((r) => r.uid) }],
        data: rows,
      };
    },
  },

  {
    name: 'decision_impact',
    description: 'Before deciding: what a pending decision touches in the graph — projects blocked on it, customers and ARR on the affected systems, open tickets, and the people involved.',
    params: { type: 'object', properties: { decision: { type: 'string' } }, required: ['decision'] },
    async run({ g }, { decision }) {
      const d = await resolve(g, decision, ['Decision']);
      if (!d) return { text: `I couldn't find a decision matching "${decision}".` };
      const r = await g.one(
        `MATCH (d:Decision {uid:$u})-[:ABOUT]->(x)
         OPTIONAL MATCH (x)<-[:BLOCKED_BY]-(blocked:Project)
         OPTIONAL MATCH (x)-[:USES|AFFECTS|PART_OF*1..2]-(s:System)
         OPTIONAL MATCH (s)<-[:DEPENDS_ON*0..3]-(:System)<-[:USES]-(o:Org {kind:'customer'})
         OPTIONAL MATCH (t:Ticket {status:'open'})-[:AFFECTS|PART_OF]->(x)
         OPTIONAL MATCH (x)<-[:WORKS_ON|OWNS]-(p:Person)
         RETURN collect(DISTINCT x.name) AS about, collect(DISTINCT blocked.name) AS blocked, collect(DISTINCT s.name) AS systems,
                collect(DISTINCT o) AS customers, collect(DISTINCT t.key) AS tickets, collect(DISTINCT p.name) AS people,
                collect(DISTINCT x.uid) + collect(DISTINCT s.uid) + collect(DISTINCT o.uid) + collect(DISTINCT p.uid) AS uids`,
        { u: d.uid },
        `what "${clip(d.name, 40)}" touches`,
      );
      const arr = (r.customers as any[]).reduce((a, o) => a + (o.properties?.arr ?? o.arr ?? 0), 0);
      const names = (r.customers as any[]).map((o) => o.properties?.name ?? o.name);
      const weighed = await weighOptions(g, d.uid);
      return {
        text: `${weighed ? `${weighed}\n\n` : ''}**What this decision touches**\n- About: ${r.about.join(', ') || '—'}\n${r.blocked.length ? `- Unblocks or delays: ${r.blocked.join(', ')}\n` : ''}- Systems: ${r.systems.join(', ') || '—'}\n- Customers exposed: ${names.join(', ') || 'none'}${arr ? ` ($${Math.round(arr / 1000)}k ARR)` : ''}\n- Open tickets: ${r.tickets.join(', ') || 'none'}\n- People to loop in: ${r.people.join(', ') || 'nobody on record'}`,
        cards: [{ type: 'graph', title: 'Decision stakes', focus: [d.uid, ...r.uids].slice(0, 30) }],
        data: r,
      };
    },
  },

  {
    name: 'decide',
    description: 'Record my decision on a pending decision, then act on it: find everyone the graph says is affected and draft the follow-ups for approval.',
    params: { type: 'object', properties: { decision: { type: 'string' }, choice: { type: 'string' } }, required: ['decision', 'choice'] },
    async run({ g, dot }, { decision, choice }) {
      const d = await resolve(g, decision, ['Decision']);
      if (!d) return { text: `I couldn't find a decision matching "${decision}".` };
      const meNode = await me(g);
      await g.q(`MATCH (d:Decision {uid:$u}), (m:Person {me:true}) SET d.status = 'made', d.choice = $c, d.decidedAt = $now MERGE (d)-[:DECIDED_BY]->(m)`, { u: d.uid, c: choice, now: Date.now() }, 'record decision');
      const stake = await g.q(
        `MATCH (d:Decision {uid:$u})
         OPTIONAL MATCH (d)-[:RAISED_BY]->(r:Person)
         OPTIONAL MATCH (d)-[:ABOUT]->(:Project)<-[:OWNS|WORKS_ON]-(w:Person)
         OPTIONAL MATCH (d)-[:SOURCE]->(:Email)-[:IN_THREAD]->(t:Thread)
         OPTIONAL MATCH (d)-[:ABOUT]->(:Org)<-[:WORKS_AT]-(v:Person) WHERE v.role = 'Vendor'
         OPTIONAL MATCH (d)-[:ABOUT]->(:System)<-[:USES]-(:Org)<-[:WORKS_AT]-(v2:Person)
         RETURN r.uid AS raisedBy, r.name AS raisedName, t.uid AS thread, collect(DISTINCT w.uid) AS team, collect(DISTINCT w.name) AS teamNames, collect(DISTINCT v.uid) AS vendors`,
        { u: d.uid },
        'who is affected by this decision',
      );
      const s = stake[0];
      const cards: Card[] = [];
      if (s?.raisedBy) {
        const r = await tools.find((t) => t.name === 'draft_email')!.run({ g, dot, userId: '' }, { to: s.raisedBy, thread: s.thread, body: `Hi ${String(s.raisedName).split(' ')[0]},\n\nDecision: ${choice}.\n\nI've recorded it and will loop in ${s.teamNames.filter((n: string) => n !== s.raisedName && n !== meNode.name).slice(0, 3).join(', ') || 'the team'}.\n\nThanks,\n${meNode.name}` });
        cards.push(...(r.cards || []));
      }
      for (const v of (s?.vendors || []).slice(0, 1)) {
        const r = await tools.find((t) => t.name === 'draft_email')!.run({ g, dot, userId: '' }, { to: v, body: `Hello,\n\nConfirming: ${choice}.\n\nBest,\n${meNode.name}` });
        cards.push(...(r.cards || []));
      }
      return { text: `Decided: **${d.name} → ${choice}**. I recorded it in the graph and drafted the follow-ups${s?.teamNames?.length ? ` (people on it: ${s.teamNames.join(', ')})` : ''}.`, cards: [{ type: 'note', text: `Decision recorded: ${choice}` }, ...cards] };
    },
  },

  {
    name: 'remember',
    description: 'Save something to long-term memory. kind=fact for things that are true ("Kate prefers calls"), kind=procedure for how I want things done ("prefer Codex for backend fixes", "never book meetings before 10am").',
    params: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['fact', 'procedure'] } }, required: ['text'] },
    async run({ g }, { text, kind }) {
      const k = kind || (/\b(always|never|prefer|don't|do not|use|avoid|whenever)\b/i.test(text) ? 'procedure' : 'fact');
      const u = uid(k);
      const label = k === 'procedure' ? 'Procedure' : 'Fact';
      // A newer memory about the same thing supersedes the old one.
      const dict = await loadDictionary(g);
      const about = mentionsIn(dict, text);
      await upsertNodes(g, label, [{ uid: u, props: { name: clip(text, 80), text, at: Date.now(), status: 'active' }, search: text }]);
      await linkAny(g, label, 'ABOUT', about.map((a) => ({ from: u, to: a })));
      const agents = await g.q(`MATCH (a:Agent) RETURN a.uid AS uid, a.name AS name, a.kind AS kind`, {}, '~agents for preferences');
      for (const a of agents) {
        const re = new RegExp(`\\b${a.name.replace(/\s+/g, '\\s*')}\\b|\\b${a.kind}\\b`, 'i');
        if (k === 'procedure' && re.test(text)) {
          const weight = /\b(avoid|never|don't|do not)\b/i.test(text) ? -1 : 1;
          await g.q(`MATCH (p:Procedure {uid:$p}), (a:Agent {uid:$a}) MERGE (p)-[r:PREFERS]->(a) SET r.weight = $w`, { p: u, a: a.uid, w: weight }, 'procedure → agent preference');
        }
      }
      await embedPending(g, 20).catch(() => {});
      return { text: `Saved as a ${k}${about.length ? `, linked to ${about.length} thing${about.length > 1 ? 's' : ''} in your graph` : ''}. Every Ziv will use it.`, data: { uid: u, about } };
    },
  },

  {
    name: 'recall',
    description: 'Search long-term memory: facts, procedures and past conversation episodes related to a topic.',
    params: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run({ g }, { query }) {
      // nothing to search for (or "me"): everything I've been told, newest first
      if (!String(query || '').trim() || /^\s*(me|us|you|everything)\s*$/i.test(query)) {
        const all = await g.q(`MATCH (m) WHERE (m:Fact OR m:Procedure) AND m.status = 'active' OPTIONAL MATCH (m)-[:ABOUT]->(x) RETURN m.uid AS uid, m.text AS text, labels(m)[0] AS label, m.at AS at, collect(x.name) AS about ORDER BY m.at DESC`, {}, 'everything you told me');
        return { text: all.length ? `What you've told me (${all.length}):\n${all.map((r) => `- ${r.label === 'Procedure' ? '**How you like things:** ' : ''}${r.text} _(${ago(r.at)}${r.about.length ? ` · about ${r.about.join(', ')}` : ''})_`).join('\n')}\n\nSay "forget that …" to drop one.` : 'You haven\'t told me anything to remember yet. Say "remember that …".', data: all };
      }
      const hits = [...(await search(g, query, ['Fact', 'Procedure', 'Episode'], 8)).filter((h: Row) => h.label !== 'Episode' || !String(h.name).toLowerCase().includes(String(query).toLowerCase().trim().slice(0, 30))), ...(await semanticSearch(g, query, { labels: ['Fact', 'Procedure', 'Episode', 'Decision'], k: 5 })).hits];
      const ent = await resolve(g, query);
      const linked = ent ? await g.q(`MATCH (m)-[:ABOUT]->({uid:$u}) WHERE (m:Fact OR m:Procedure) AND m.status = 'active' RETURN m.uid AS uid, m.text AS text, labels(m)[0] AS label`, { u: ent.uid }, `memories about ${ent.name}`) : [];
      const rows = await g.q(`MATCH (m) WHERE m.uid IN $ids RETURN m.uid AS uid, coalesce(m.text, m.name) AS text, [l IN labels(m) WHERE l <> 'Searchable'][0] AS label, m.at AS at`, { ids: [...new Set([...hits.map((h) => h.uid), ...linked.map((l) => l.uid)])] }, 'load memories');
      return { text: rows.length ? rows.map((r) => `- (${r.label}) ${clip(r.text, 160)}`).join('\n') : 'No memories about that yet.', data: rows };
    },
  },

  {
    name: 'forget',
    description: 'Retract a memory that is no longer true ("Raj\'s leave got cancelled", "forget that Kate prefers calls"). Finds the active fact or procedure that best matches and marks it retracted, keeping its history.',
    params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run({ g }, { text }) {
      const dict = await loadDictionary(g);
      const about = mentionsIn(dict, text);
      const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3 && !/^(forget|that|this|about|cancel+ed|scratch|disregard|longer|true|anymore|got|was|is)$/.test(w)).map((w) => w.replace(/(ing|ed|s)$/, ''));
      const mem = await g.q(
        `MATCH (m) WHERE (m:Fact OR m:Procedure) AND m.status = 'active'
         OPTIONAL MATCH (m)-[:ABOUT]->(x)
         RETURN m.uid AS uid, m.text AS text, m.at AS at, collect(x.uid) AS about ORDER BY m.at DESC`,
        {},
        'active memories',
      );
      const score = (m: any) => (m.about as string[]).filter((u) => about.includes(u)).length * 3 + words.filter((w) => String(m.text).toLowerCase().includes(w)).length;
      const best = mem.map((m) => ({ ...m, s: score(m) })).filter((m) => m.s >= 2).sort((a, b) => b.s - a.s)[0];
      if (!best) return { text: `I couldn't find a memory that matches — here's what I hold:\n${mem.slice(0, 5).map((m) => `- ${m.text}`).join('\n') || '- nothing yet'}` };
      await g.q(`MATCH (m {uid:$u}) SET m.status = 'retracted', m.retractedAt = $now, m.retractedBy = $why`, { u: best.uid, now: Date.now(), why: clip(text, 120) }, 'retract the memory (kept for history)');
      return { text: `Done — I've stopped using “${best.text}” (from ${ago(best.at)}). It stays in the graph's history as retracted, and no Ziv will rely on it.`, data: best };
    },
  },

  {
    name: 'write_file',
    description: 'Write a markdown file (a brief, report, plan, changelog) as an output the user can open. It is filed in the graph as a Doc linked to everything it mentions.',
    params: { type: 'object', properties: { name: { type: 'string', description: 'file name, e.g. incident-brief.md' }, content: { type: 'string' } }, required: ['name', 'content'] },
    async run({ g, userId, dot }, { name, content }) {
      const f = await writeOutput(g, userId, dot, name, content);
      return { text: `Wrote ${f.name} (${(f.size / 1024).toFixed(1)}kB).`, cards: [{ type: 'file', uid: f.uid, name: f.name, size: f.size }] };
    },
  },

  {
    name: 'run_cypher',
    description: 'Run a READ-ONLY Cypher query against my graph for questions the other tools do not cover. Labels: Person Team Org Project System Repo File Commit Ticket Email Thread Event Doc ChatMessage Channel Decision Agent Run Fact Procedure Draft. Key rels: MEMBER_OF WORKS_AT WORKS_ON OWNS USES DEPENDS_ON IMPLEMENTS FROM TO IN_THREAD MENTIONS ATTENDS ABOUT POSTED IN ASSIGNED_TO REPORTED_BY AFFECTS FOR PART_OF DECIDED_BY APPROVED_BY SOURCE AUTHORED_BY TOUCHES IN_REPO EXECUTED_BY WORKED_ON RESOLVES COLLABORATES. Every node has uid and name.',
    params: { type: 'object', properties: { cypher: { type: 'string' } }, required: ['cypher'] },
    async run({ g }, { cypher }) {
      if (/\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP|CALL\s+db\.idx\.fulltext\.(create|drop))\b/i.test(cypher)) return { text: 'Only read-only queries are allowed here.' };
      const rows = await g.ro(cypher, {}, 'agent-written Cypher');
      return { text: '```json\n' + JSON.stringify(rows.slice(0, 25), null, 1).slice(0, 3000) + '\n```', data: rows };
    },
  },
];

export async function writeOutput(g: UserGraph, userId: string, dot: string, name: string, content: string) {
  const safe = String(name).replace(/[^\w.-]+/g, '-').replace(/^-+/, '').slice(0, 80) || 'output.md';
  const dir = join(zivHome(), 'outputs', userId.replace(/[^a-zA-Z0-9_-]/g, ''));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safe);
  writeFileSync(path, content);
  const u = uid('doc');
  const dict = await loadDictionary(g);
  await upsertNodes(g, 'Doc', [{ uid: u, props: { name: safe, title: safe, body: clip(content, 4000), path, size: Buffer.byteLength(content), at: Date.now(), source: 'zivbot', output: true }, search: `${safe} ${clip(content, 1500)}` }]);
  await link(g, 'Doc', 'WRITTEN_BY', 'Dot', [{ from: u, to: dot }]);
  await linkAny(g, 'Doc', 'MENTIONS', mentionsIn(dict, content).map((to) => ({ from: u, to })));
  return { uid: u, name: safe, size: Buffer.byteLength(content), path };
}

async function firstFreeSlot(g: UserGraph, people: string[], minutes: number) {
  const busy = await g.q(`MATCH (p:Person)-[:ATTENDS]->(e:Event) WHERE p.uid IN $p AND e.end > $now RETURN e.start AS s, e.end AS e`, { p: people, now: Date.now() }, 'everyone’s busy slots');
  const d = new Date(Date.now() + HOUR);
  d.setMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 7; i++, d.setHours(d.getHours() + 1)) {
    const h = d.getHours();
    if (h < 10 || h > 17 || d.getDay() === 0 || d.getDay() === 6) continue;
    const s = d.getTime(), e = s + minutes * 60_000;
    if (!busy.some((b) => s < b.e && b.s < e)) return s;
  }
  return Date.now() + DAY;
}

export const toolByName = (n: string) => tools.find((t) => t.name === n);

/**
 * Weigh each option of a pending decision against the graph: what a "delay" holds up downstream
 * (BLOCKED_BY), who a "drop" costs (customers the decision is about, with ARR), who a "confirm" must tell.
 */
async function weighOptions(g: UserGraph, decisionUid: string): Promise<string> {
  const d = await g.one(`MATCH (d:Decision {uid:$u}) RETURN d.options AS options`, { u: decisionUid }, 'the options on the table');
  const options: string[] = d?.options || [];
  if (options.length < 2) return '';
  const dict = await loadDictionary(g);
  const about = await g.q(
    `MATCH (:Decision {uid:$u})-[:ABOUT]->(o:Org {kind:'customer'}) RETURN o.name AS name, coalesce(o.arr, 0) AS arr`,
    { u: decisionUid },
    'customers this decision is about',
  );
  const aboutProjects = await g.q(`MATCH (:Decision {uid:$u})-[:ABOUT]->(p:Project) RETURN p.uid AS uid, p.name AS name`, { u: decisionUid }, 'projects this decision is about');
  const lines: string[] = [];
  const costs: { i: number; arr: number; slipped: number; waiting: number; why: string[] }[] = [];
  // tickets this decision settles: other blockers are what still stand between a project and its date
  const settles = new Set((await g.q(`MATCH (:Decision {uid:$u})-[:ABOUT]->(t:Ticket) RETURN t.uid AS uid`, { u: decisionUid }, '~tickets it settles')).map((r) => r.uid));
  for (const [i, opt] of options.entries()) {
    const low = opt.toLowerCase();
    const ents = mentionsIn(dict, opt);
    const cost = { i, arr: 0, slipped: 0, waiting: 0, why: [] as string[] };
    // projects the option names, else the decision's projects it alludes to ("delay EU" → EU Launch), else all of them
    let projects = ents.filter((u) => u.startsWith('project:'));
    if (!projects.length) projects = aboutProjects.filter((p) => String(p.name).split(/\s+/).some((w: string) => new RegExp(`\\b${w.replace(/[^\w]/g, '')}\\b`, 'i').test(opt) && !/^(the|launch|raise|migration)$/i.test(w))).map((p) => p.uid);
    if (!projects.length && /\b(delay|push|postpone|confirm|lock)\b/.test(low)) projects = aboutProjects.map((p) => p.uid);
    const out: string[] = [];
    if (/\b(delay|push|postpone|hold|slip|later)\b/.test(low) && projects.length) {
      const held = await g.q(
        `UNWIND $p AS u MATCH (x:Project {uid:u})
         OPTIONAL MATCH (down:Project)-[:BLOCKED_BY*1..3]->(x)
         OPTIONAL MATCH (x)<-[:MENTIONS]-(e:Email)-[:IN_THREAD]->(:Thread {awaitingReply:true})
         OPTIONAL MATCH (e)-[:FROM]->(w:Person) WHERE NOT coalesce(w.me, false)
         OPTIONAL MATCH (x)-[:USES]->(:System)<-[:DEPENDS_ON*0..3]-(:System)<-[:USES]-(o:Org {kind:'customer'})
         RETURN x.name AS name, collect(DISTINCT down.name) AS downstream, collect(DISTINCT w.name) AS waiting, collect(DISTINCT o.name) AS customers`,
        { p: projects },
        `what delaying "${clip(opt, 30)}" holds up`,
      );
      for (const h of held) {
        out.push(`${h.name} slips${h.downstream.length ? `, and with it ${h.downstream.join(', ')}` : ''}${h.waiting.length ? `; ${h.waiting.join(', ')} ${h.waiting.length > 1 ? 'are' : 'is'} waiting on a date` : ''}`);
        cost.slipped += 1 + h.downstream.length;
        cost.waiting += h.waiting.length;
        cost.why.push(`${h.name} slips`);
      }
    }
    if (/\b(drop|cancel|remove|stop|deprecate|end|sunset)\b/.test(low)) {
      if (about.length) {
        out.push(`hits ${about.map((o) => `${o.name}${o.arr ? ` ($${Math.round(o.arr / 1000)}k ARR)` : ''}`).join(', ')}, who this decision is about`);
        cost.arr += about.reduce((n, o) => n + o.arr, 0);
        cost.why.push(`risks ${about.map((o) => o.name).join(', ')}`);
      }
      if (/on time|as planned/.test(low)) {
        // only claim "on schedule" if nothing else stands in the way (critical path, minus what this decision settles)
        for (const pu of projects) {
          const cp = await criticalPath(g, pu);
          if (!cp) continue;
          const others = cp.blockers.filter((b) => b.uid !== decisionUid && !settles.has(b.uid));
          out.push(others.length ? `clears this blocker for ${cp.project.name}, which still has ${others.slice(0, 3).map((b) => b.key || b.title).join(', ')} open` : `keeps ${cp.project.name} on schedule`);
        }
      }
    }
    if (/\b(confirm|lock|ship|go with|approve)\b/.test(low) && projects.length) {
      const owners = await g.q(`UNWIND $p AS u MATCH (x:Project {uid:u})<-[:OWNS|WORKS_ON]-(p:Person) RETURN collect(DISTINCT p.name) AS n`, { p: projects }, 'who to tell');
      if (owners[0]?.n.length) out.push(`tell ${owners[0].n.join(', ')}`);
    }
    lines.push(`**${String.fromCharCode(65 + i)}. ${opt}** — ${out.length ? out.join('; ') : 'nothing else in the graph depends on it'}.`);
    costs.push(cost);
  }
  // a lean, from the graph alone: revenue at risk (per $10k) against projects slipping and people kept waiting
  const score = (c: typeof costs[number]) => c.arr / 10_000 + 6 * c.slipped + 1.5 * c.waiting;
  const ranked = [...costs].sort((a, b) => score(a) - score(b));
  const lean = ranked[0];
  const leanText = costs.length > 1 && score(ranked[1]) > score(lean)
    ? `\n\n**The graph leans ${String.fromCharCode(65 + lean.i)}** — it costs less of what the graph can see (${ranked.slice(1).map((c) => `${String.fromCharCode(65 + c.i)} ${c.why.join(' and ') || 'carries more'}`).join('; ')}). It can't see everything — the call is yours.`
    : '';
  return `**Your options, weighed on the graph**\n${lines.join('\n')}${leanText}`;
}
