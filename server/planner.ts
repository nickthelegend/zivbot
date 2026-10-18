import type { UserGraph, Row } from './graph.ts';
import { loadDictionary, mentionsIn } from './ingest.ts';
import { toolByName, search, type Card, type Ctx, type ToolResult } from './tools.ts';
import { ago, when, clip as clipText, DAY } from './util.ts';
import { criticalPath } from './blockers.ts';
import { config } from './config.ts';
import { rankOwners } from './absence.ts';
import { catalog, runConnectorAction } from './connectors/index.ts';
import { connectorConfig } from './secrets.ts';

/**
 * The built-in graph planner. When no LLM is configured (or it fails), ZivBot
 * still works: it maps the request to graph tools with simple intent rules,
 * runs them, and composes the reply from what the graph returned. The answer
 * is just as traceable — the same tools, the same Cypher.
 */

type Ent = { uid: string; label: string };
const labelOf = (u: string) => ({ person: 'Person', system: 'System', project: 'Project', org: 'Org', ticket: 'Ticket', team: 'Team', repo: 'Repo' } as Record<string, string>)[u.split(':')[0]] || 'Node';

async function entities(g: UserGraph, text: string): Promise<Ent[]> {
  const dict = await loadDictionary(g);
  const uids = mentionsIn(dict, text);
  // keep the order they appear in the text
  const pos = (u: string) => {
    const d = dict.find((x) => x.uid === u && x.re.test(text));
    return d ? text.toLowerCase().indexOf(d.term.toLowerCase()) : 999;
  };
  return uids.sort((a, b) => pos(a) - pos(b)).filter((u) => u !== 'person:me').map((u) => ({ uid: u, label: labelOf(u) }));
}

export type PlanResult = { text: string; cards: Card[]; tools: string[]; confident?: boolean };

export type PlanOpts = {
  dot?: { uid: string; name: string; role: string };
  from?: string;
  /** answering inside a group chat alongside other Zivs: no delegation, stick to your role */
  inGroup?: boolean;
  delegate?: (to: string, goal: string) => Promise<{ text: string; cards: Card[]; to?: { name: string } }>;
};

export async function plan(ctx: Ctx, input: string, opts: PlanOpts = {}): Promise<PlanResult> {
  const t = input.trim();
  const low = t.toLowerCase();
  const used: string[] = [];
  const cards: Card[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    used.push(name);
    const r = await toolByName(name)!.run(ctx, args);
    cards.push(...(r.cards || []));
    return r;
  };
  let remembered = '';
  const done = (text: string): PlanResult => ({ text: remembered ? `${remembered}\n\n${text}` : text, cards, tools: used });
  // the planner's best guess, not a recognised question: the model may take over (see think())
  // a memory that answers the question beats a guess: say what you were told, skip the dump
  const unsure = (text: string): PlanResult => (remembered ? { text: `${remembered}\n\nAsk me for more on it if you need the details.`, cards: [], tools: used } : { ...done(text), confident: false });
  const ents = await entities(ctx.g, t);
  const first = (...labels: string[]) => ents.find((e) => labels.includes(e.label));
  // what you told me comes first: a question about someone or something I hold a memory on gets it back
  if (!/^(remember|note( that)?|from now on|always|never|i prefer|prefer|keep in mind|forget)\b/i.test(t) && /\?|^(when|what|who|is|are|do|does|how|which|where)\b/.test(low)) {
    // memories about what the question names, plus any memory that shares its words (facts with no entity)
    const mem = [
      ...(ents.length ? await ctx.g.q(
        `MATCH (m)-[:ABOUT]->(x) WHERE (m:Fact OR m:Procedure) AND m.status = 'active' AND x.uid IN $u RETURN m.text AS text, m.at AS at ORDER BY m.at DESC LIMIT 5`,
        { u: ents.map((e) => e.uid) },
        'what you told me about them',
      ) : []),
      ...(await ctx.g.q(`MATCH (m) WHERE (m:Fact OR m:Procedure) AND m.status = 'active' RETURN m.text AS text, m.at AS at ORDER BY m.at DESC LIMIT 30`, {}, '~active memories')),
    ];
    const words = new Set(low.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3).map((w) => w.replace(/(ing|ed|s)$/, '')));
    const hit = mem.filter((m) => String(m.text).toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.length > 3 && words.has(w.replace(/(ing|ed|s)$/, '')) && !ents.some((e) => e.uid.toLowerCase().includes(w))));
    if (hit.length) { used.push('recall'); remembered = `**You told me** (${ago(hit[0].at)}): “${hit[0].text}”${hit.length > 1 ? ` — and ${hit.length - 1} more note${hit.length > 2 ? 's' : ''} about this.` : ''}`; }
  }
  const dots = await ctx.g.q(`MATCH (d:Dot) WHERE d.uid <> $me RETURN d.name AS name, d.role AS role`, { me: ctx.dot }, '~other Zivs');
  const specialist = (re: RegExp) => (opts.from || opts.inGroup || !opts.delegate || (opts.dot && re.test(opts.dot.role)) ? null : dots.find((d) => re.test(d.role)));
  const delegateTo = async (name: string, goal: string, intro?: string) => {
    used.push('message_dot');
    const r = await opts.delegate!(name, goal);
    cards.push(...r.cards.filter((c) => c.type !== 'options'));
    return done(`${intro ?? `I asked **${name}** to take this.`} ${name} got back to me:\n\n${r.text}`);
  };

  // ---- @mentions: "@Forge fix LUM-142", "@Hacker News graph databases"
  if (t.includes('@')) {
    const allDots = await ctx.g.q(`MATCH (d:Dot) RETURN d.uid AS uid, d.name AS name`, {}, '~Zivs for @mentions');
    const byLen = (a: { name: string }, b: { name: string }) => b.name.length - a.name.length;
    const md = allDots.sort(byLen).find((d) => low.includes(`@${d.name.toLowerCase()}`));
    if (md && md.uid !== ctx.dot && opts.delegate && !opts.from) {
      const rest = t.replace(new RegExp(`@${md.name}[,:]?\\s*`, 'i'), '').trim() || 'Can you take a look?';
      return delegateTo(md.name, rest, `I messaged **${md.name}**.`);
    }
    const plugins = (await catalog()).sort((a, b) => b.name.length - a.name.length);
    const mp = plugins.find((c) => low.includes(`@${c.name.toLowerCase()}`));
    if (mp) {
      const rest = t.replace(new RegExp(`@${mp.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,:]?\\s*`, 'i'), '').trim();
      const status = await ctx.g.one(`MATCH (c:Connector {uid:$u}) RETURN c.status AS status`, { u: `connector:${mp.id}` }, `is ${mp.name} connected`);
      const action = (mp.actions || []).find((a) => !a.mutates && (a.params.required || []).length === 1);
      if (status?.status !== 'connected' && mp.auth !== 'none') {
        cards.push({ type: 'connectors' });
        return done(`**${mp.name}** isn't connected yet${mp.auth === 'key' ? ' — it needs a key' : ''}. Add it from Connect apps and I'll use it right away.`);
      }
      if (action && rest) {
        used.push(`${mp.id}.${action.name}`);
        const key = action.params.required![0];
        const out = await runConnectorAction(ctx.userId, ctx.g, mp.id, action.name, { [key]: rest });
        return done(`From **${mp.name}** (${action.name.replace(/_/g, ' ')}):\n\n${out.slice(0, 2500)}`);
      }
      return done(`**${mp.name}** is ${status?.status || 'available'}. It gives your Zivs: ${(mp.actions || []).map((a) => `\`${a.name}\`${a.mutates ? ' (asks first)' : ''}`).join(', ') || 'its data in the graph'}.${mp.description ? `\n\n${mp.description}` : ''}`);
    }
  }

  // ---- talk to another Ziv: "ask Forge to …", "tell Scout …"
  const direct = t.match(/^(?:please\s+)?(?:ask|tell|have|get|message|ping|loop in)\s+(\w+)\s*(?:to|that|:|,)?\s*(.*)$/i);
  if (direct && opts.delegate && !opts.from) {
    const target = dots.find((d) => d.name.toLowerCase() === direct[1].toLowerCase());
    if (target) return delegateTo(target.name, direct[2] || t, `Sure — I messaged **${target.name}**.`);
  }

  if (/^(what can you do|help|what do you do)\??$/i.test(t)) {
    return done(`Here's what I can do with your graph:\n- **Triage** — "what needs me?" ranks mail, incidents, decisions and calendar clashes by who and what they touch\n- **Act** — "fix LUM-142" picks the best coding agent from your subscriptions and runs it once you approve\n- **Trace** — "why did we move to Stripe?", "who knows billing-db?", "what breaks if auth-service goes down?"\n- **Coordinate** — "ask Forge to …" sends work to another Ziv; they share my memory\n- **Remember** — "remember that Kate prefers calls" — every Ziv uses it\n\nTap the path icon under any answer to see the Cypher and the nodes behind it.`);
  }

  // ---- memory: forget / no longer true
  if (/\b(forget|scratch that|disregard|no longer true|isn'?t true|not true any ?more|got cancel+ed|is cancel+ed|was cancel+ed|cancel+ed)\b/.test(low)) {
    const r = await call('forget', { text: t });
    return done(r.text);
  }
  // ---- memory: "what do you remember (about me / about X)?"
  if (/\bwhat (do|did) you (remember|know)( about (me|us))?\??$|\bwhat have i told you\b|\bmy (notes|preferences|memories)\b/.test(low)) {
    return done((await call('recall', { query: '' })).text);
  }

  // ---- memory writes
  if (/^(remember|note( that)?|from now on|always|never|i prefer|prefer|keep in mind)\b/i.test(t)) {
    const r = await call('remember', { text: t.replace(/^(remember( that)?|note( that)?|keep in mind( that)?)[:,]?\s*/i, '') });
    return done(`Got it. ${r.text}`);
  }

  // ---- quick facts the graph holds directly ----------------------------------------------
  // "when is the Brightwave QBR?" — a named meeting
  if (/^when\b|\bwhat time\b/.test(low) && !first('Project') && !/\b(leave|out|off|away|holiday|vacation|renew\w*)\b/.test(low)) {
    const ev = (await search(ctx.g, t.replace(/\b(when|is|the|what|time|our|my|next)\b/gi, ' '), ['Event'], 3)).filter((h: Row) => h.score >= 1)[0];
    if (ev) {
      const e = await ctx.g.one(`MATCH (e:Event {uid:$u}) OPTIONAL MATCH (p:Person)-[:ATTENDS]->(e) WHERE NOT coalesce(p.me, false) RETURN coalesce(e.title, e.name) AS title, e.start AS start, e.end AS end, collect(p.name) AS who`, { u: ev.uid }, 'that meeting');
      if (e) { cards.push({ type: 'graph', title: e.title, focus: [ev.uid] }); return done(`**${e.title}** is ${when(e.start)}${e.end ? ` (${Math.round((e.end - e.start) / 60000)} min)` : ''}${e.who.length ? ` with ${e.who.join(', ')}` : ''}.`); }
    }
  }
  // "who reported LUM-139?", "who owns LUM-142?"
  const tk = t.match(/\b([A-Z]{2,6}-\d+)\b/i)?.[1]?.toUpperCase();
  if (tk && /^who\b.*\b(report|raise|file|open|own|assign|work)/.test(low)) {
    const r = await ctx.g.one(`MATCH (t:Ticket {key:$k}) OPTIONAL MATCH (t)-[:REPORTED_BY]->(r:Person) OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person) RETURN t.title AS title, t.status AS status, t.priority AS priority, r.name AS reporter, a.name AS owner, t.at AS at`, { k: tk }, 'who is on the ticket');
    if (r) return done(`**${tk}** (${r.priority}, ${r.status}) — ${r.title}.\n- Reported by **${r.reporter || 'unknown'}** ${ago(r.at)}\n- Owned by **${r.owner || 'nobody'}**`);
  }
  // "what's Tom working on?"
  const doing = low.match(/\bwhat(?:'s| is| are)\s+(.+?)\s+(working on|doing|up to|busy with)\b/);
  if (doing && first('Person')) {
    const who = first('Person')!;
    const r = await ctx.g.one(
      `MATCH (p:Person {uid:$u})
       OPTIONAL MATCH (p)<-[:ASSIGNED_TO]-(t:Ticket {status:'open'})
       WITH p, collect(DISTINCT t.key + ' ' + t.title) AS tickets
       OPTIONAL MATCH (p)-[:WORKS_ON|OWNS]->(pr:Project)
       WITH p, tickets, collect(DISTINCT pr.name) AS projects
       OPTIONAL MATCH (p)-[:ATTENDS]->(e:Event) WHERE e.start > $now
       WITH p, tickets, projects, collect(DISTINCT coalesce(e.title, e.name))[0..3] AS meetings
       OPTIONAL MATCH (p)-[:POSTED]->(m:ChatMessage)
       WITH p, tickets, projects, meetings, m ORDER BY m.at DESC
       RETURN p.name AS name, p.role AS role, tickets, projects, meetings, collect(m.text)[0..1] AS said`,
      { u: who.uid, now: Date.now() },
      'what they are working on',
    );
    if (r) return done(`**${r.name}**${r.role ? ` (${r.role})` : ''}:\n- Open tickets: ${r.tickets.join('; ') || 'none'}\n- Projects: ${r.projects.join(', ') || 'none'}\n- Coming up: ${r.meetings.join(', ') || 'no meetings'}${r.said[0] ? `\n- Last said in chat: “${clipText(r.said[0], 120)}”` : ''}`);
  }
  // "Brightwave ARR", "how much is Kestrel worth?"
  if (/\b(arr|revenue|worth|pay us|paying|contract value)\b/.test(low) && first('Org') && !first('System')) {
    const o = await ctx.g.one(`MATCH (o:Org {uid:$u}) OPTIONAL MATCH (x:Org {kind:'customer'}) RETURN o.name AS name, coalesce(o.arr, 0) AS arr, o.kind AS kind, o.tier AS tier, sum(coalesce(x.arr, 0)) AS total`, { u: first('Org')!.uid }, 'their ARR and the total');
    if (o) return done(o.arr ? `**${o.name}**: $${Math.round(o.arr / 1000)}k ARR${o.tier ? ` (${o.tier})` : ''} — ${Math.round((100 * o.arr) / Math.max(1, o.total))}% of your $${Math.round(o.total / 1000)}k total.` : `${o.name} is a ${o.kind || 'company'} in the graph, with no ARR recorded.`);
  }
  // "who at Brightwave should I contact?"
  if (/\bwho at\b|\bcontacts? (at|for)\b|\bwho (should i|do i|to) (contact|call|reach)\b/.test(low) && first('Org')) {
    const o = first('Org')!;
    const rows = await ctx.g.q(
      `MATCH (p:Person)-[:WORKS_AT]->(o:Org {uid:$u}) OPTIONAL MATCH (p)<-[:FROM]-(e:Email)
       RETURN p.uid AS uid, p.name AS name, p.role AS role, count(e) AS emails, max(e.at) AS last ORDER BY emails DESC`,
      { u: o.uid },
      'their people and how often they write',
    );
    const ours = await ctx.g.q(`MATCH (o:Org {uid:$u})<-[:FOR]-(:Ticket)-[:ASSIGNED_TO]->(p:Person) RETURN DISTINCT p.name AS name`, { u: o.uid }, 'who on our side works their tickets');
    if (rows.length) return done(`Contact **${rows[0].name}**${rows[0].role ? ` (${rows[0].role})` : ''} — ${rows[0].emails} email${rows[0].emails === 1 ? '' : 's'} from them${rows[0].last ? `, last ${ago(rows[0].last)}` : ''}.${rows.length > 1 ? `\nAlso there: ${rows.slice(1).map((r) => r.name).join(', ')}.` : ''}${ours.length ? `\nOn our side, ${ours.map((r) => r.name).join(', ')} work${ours.length === 1 ? 's' : ''} their tickets.` : ''}`);
  }
  // "do I have meetings with Marcus this week?"
  if (/\bmeetings?\b.*\bwith\b/.test(low) && first('Person') && !/\b(book|schedule|set up|arrange)\b/.test(low)) {
    const who = first('Person')!;
    const days = /\btoday\b/.test(low) ? 1 : /\btomorrow\b/.test(low) ? 2 : 7;
    const rows = await ctx.g.q(`MATCH (:Person {me:true})-[:ATTENDS]->(e:Event)<-[:ATTENDS]-(:Person {uid:$u}) WHERE e.start > $now AND e.start < $until RETURN coalesce(e.title, e.name) AS title, e.start AS start ORDER BY e.start`, { u: who.uid, now: Date.now(), until: Date.now() + days * DAY }, 'meetings you share with them');
    const name = (await ctx.g.one(`MATCH (p:Person {uid:$u}) RETURN p.name AS n`, { u: who.uid }))?.n;
    return done(rows.length ? `**Yes** — ${rows.length} with ${name}:\n${rows.map((r) => `- ${when(r.start)} — ${r.title}`).join('\n')}` : `**No** — no meetings with ${name} in the next ${days === 7 ? 'week' : days === 2 ? 'two days' : 'day'}.`);
  }

  // "what's due this week?" — meetings, decisions waiting, P1s, in one list
  if (/\b(due|deadlines?|on my plate this week|coming up this week|this week'?s)\b/.test(low) && !ents.length) {
    const ev = await ctx.g.q(`MATCH (:Person {me:true})-[:ATTENDS]->(e:Event) WHERE e.start > $now AND e.start < $week RETURN coalesce(e.title, e.name) AS title, e.start AS start ORDER BY e.start`, { now: Date.now(), week: Date.now() + 7 * DAY }, 'meetings this week');
    const dec = await ctx.g.q(`MATCH (d:Decision {status:'pending'})-[:AWAITS]->(:Person {me:true}) RETURN d.text AS text`, {}, 'decisions waiting on me');
    const p1 = await ctx.g.q(`MATCH (t:Ticket {status:'open', priority:'P1'}) OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person) RETURN t.key AS key, t.title AS title, a.name AS who`, {}, 'open P1s');
    const asks = await ctx.g.q(`MATCH (e:Email)-[:IN_THREAD]->(th:Thread {awaitingReply:true}) WHERE e.body CONTAINS 'by ' OR e.body CONTAINS 'before ' WITH th, max(e.at) AS at MATCH (th)<-[:IN_THREAD]-(e:Email)-[:FROM]->(p:Person) WHERE e.at = at RETURN p.name AS who, th.subject AS subject, e.body AS body`, {}, 'asks with a deadline in them');
    return done(`**This week**\n\n**Decisions you owe:** ${dec.map((d) => d.text).join('; ') || 'none'}\n\n**Open P1s:** ${p1.map((x) => `${x.key} (${x.who || 'unowned'})`).join(', ') || 'none'}\n\n**Asks with a deadline:**\n${asks.map((a) => `- ${a.who}: “${clipText(String(a.body).match(/[^.]*\b(by|before)\b[^.]*\./i)?.[0] || a.subject, 110)}”`).join('\n') || '- none'}\n\n**Meetings:**\n${ev.map((e) => `- ${when(e.start)} — ${e.title}`).join('\n') || '- none'}`);
  }
  // "what happened yesterday?"
  if (/\bwhat (happened|changed)\b|\brecap\b|\bwhat did i miss\b/.test(low) && !ents.length) {
    return done(`Here's what happened in your graph:\n\n${(await call('insights', { focus: 'changed' })).text}`);
  }
  // "which docs are out of date?"
  if (/\b(out of date|outdated|stale|old|need(s)? updating)\b/.test(low) && /\b(docs?|documents?|runbooks?|documentation|knowledge|wiki|rfcs?)\b/.test(low)) {
    return done(`Docs written before the latest incidents on their systems:\n\n${(await call('insights', { focus: 'stale' })).text}`);
  }
  // "which systems have no owner?"
  if (/\b(systems?|services?)\b.*\b(no|without an?|missing an?|un)\s*owners?\b|\bunowned\b|\borphan(ed)?\b/.test(low)) {
    const all = await ctx.g.q(`MATCH (s:System) RETURN s.uid AS uid, s.name AS name, s.tier AS tier`, {}, 'all systems');
    const { knowersAll } = await import('./knowledge.ts');
    const k = await knowersAll(ctx.g);
    const none = all.filter((x) => !(k.get(x.uid) || []).length);
    const one = all.filter((x) => (k.get(x.uid) || []).length === 1);
    return done(`${none.length ? `**Nobody has done hands-on work on:** ${none.map((x) => `${x.name}${x.tier ? ` (${x.tier})` : ''}`).join(', ')}.` : 'Every system has at least one person with hands-on work on it.'}${one.length ? `\n\n**Only one person:** ${one.map((x) => `${x.name} → ${k.get(x.uid)![0].name}`).join('; ')}.` : ''}`);
  }
  // "what's our riskiest system?"
  if (/\b(riskiest|most critical|weakest|most fragile|biggest risk)\b.*\b(system|service)\b|\b(system|service)\b.*\b(riskiest|most at risk)\b/.test(low)) {
    const r = (await call('insights', { focus: 'spof' })).data as any[];
    const top = r?.[0]?.items?.[0];
    return done(top ? `**${top.title.split(' holds')[0]}** — ${top.title.replace(/^\S+\s/, '')}. ${top.detail}\n\nAsk "what breaks if ${top.title.split(' ')[0]} goes down?" for the full blast radius.` : 'No system stands out.');
  }
  // "has anyone committed to payments-api recently?"
  if (/\b(commit(ted|s)?|pushed|changed the code|touched the code)\b/.test(low) && first('System', 'Repo')) {
    const x = first('System', 'Repo')!;
    const rows = await ctx.g.q(
      `MATCH (x {uid:$u}) MATCH (c:Commit)-[:TOUCHES]->(f:File)-[:IN_REPO]->(r:Repo) WHERE r = x OR (r)-[:IMPLEMENTS]->(x)
       OPTIONAL MATCH (c)-[:AUTHORED_BY]->(p:Person)
       RETURN DISTINCT c.uid AS uid, c.name AS msg, c.at AS at, p.name AS who ORDER BY at DESC LIMIT 5`,
      { u: x.uid },
      'recent commits on it',
    );
    return done(rows.length ? `**Yes** — latest commits:\n${rows.map((r) => `- ${ago(r.at)} · **${r.who || 'unknown'}** — ${clipText(r.msg, 80)}`).join('\n')}` : 'No commits on it in the graph — its repo may not be connected.');
  }
  // "is the Stripe cutover date locked?"
  if (/\b(locked|decided|confirmed|final|settled|signed off|approved)\b/.test(low) && /^(is|has|have|did|was)\b/.test(low)) {
    const ds = await ctx.g.q(`MATCH (d:Decision) RETURN d.uid AS uid, coalesce(d.text, d.name) AS text, d.status AS status, d.choice AS choice, d.at AS at`, {}, 'decisions');
    const words = low.split(/\W+/).filter((w) => w.length > 4 && !/(locked|decided|confirmed|final|settled|approved)/.test(w));
    const hit = ds.map((d) => ({ ...d, n: words.filter((w) => String(d.text).toLowerCase().includes(w)).length })).filter((d) => d.n > 0).sort((a, b) => b.n - a.n)[0];
    if (hit) return done(hit.status === 'pending' ? `**No — it's still open.** “${hit.text}” is waiting on you (raised ${ago(hit.at)}). Say "help me decide: ${hit.text}" to see the options weighed.` : `**Yes.** “${hit.text}” was decided${hit.choice ? ` → ${hit.choice}` : ''} (${ago(hit.at)}).`);
  }
  // "which emails haven't I replied to?"
  if (/\b(haven'?t|not|never) (i )?(replied|answered|responded)|\bunreplied\b|\bunanswered\b|\bneed(s)? (a |my )?(reply|response)\b|\bwaiting (for me |on me )?to (reply|respond|answer)\b|\bowe (a |an )?(reply|response|answer)\b|\b(emails?|mails?|threads?|messages?)\b.*\b(reply|respond|answer) to\b/.test(low)) {
    return done((await call('insights', { focus: 'waiting' })).text);
  }
  // "is Dev on the critical path?"
  if (/\bcritical path\b/.test(low) && first('Person')) {
    const who = first('Person')!;
    const projects = await ctx.g.q(`MATCH (p:Project) WHERE p.status <> 'planned' RETURN p.uid AS uid`, {}, 'projects in flight');
    const hits: string[] = [];
    const name = (await ctx.g.one(`MATCH (p:Person {uid:$u}) RETURN p.name AS n`, { u: who.uid }))?.n;
    for (const pr of projects) {
      const c = (await call('critical_path', { project: pr.uid })).data as any;
      for (const b of c?.blockers || []) if (b.ownerUid === who.uid) hits.push(`${c.project.name} — ${b.kind === 'decision' ? `decision “${b.title}”` : `${b.key} ${b.priority || ''}`}`);
    }
    cards.length = 0;
    return done(hits.length ? `**Yes** — ${name} owns blockers on:\n${hits.map((h) => `- ${h}`).join('\n')}` : `**No** — ${name} owns nothing that blocks a project right now.`);
  }
  // "which P1 is older?" / "oldest open ticket"
  if (/\b(older|oldest|longest open|been open longest)\b/.test(low) && /\b(p[123]s?|tickets?|issues?|incidents?)\b/.test(low)) {
    const pr = low.match(/\bp([123])\b/)?.[1];
    const rows = await ctx.g.q(`MATCH (t:Ticket {status:'open'}) WHERE $p = '' OR t.priority = $p OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person) RETURN t.key AS key, t.title AS title, t.priority AS priority, t.at AS at, a.name AS who ORDER BY t.at ASC LIMIT 5`, { p: pr ? `P${pr}` : '' }, 'open tickets, oldest first');
    return done(rows.length ? `**${rows[0].key}** is the oldest — open ${Math.round((Date.now() - rows[0].at) / DAY)} days (${rows[0].title}).\n${rows.slice(1).map((r) => `- ${r.key} ${r.priority} — ${Math.round((Date.now() - r.at) / DAY)}d, ${r.who || 'unowned'}`).join('\n')}` : 'No open tickets match.');
  }
  // "what if Hana and Raj are both out?"
  if (/\b(both|together|and)\b.*\b(out|leave|away|off|quit)\b/.test(low) && ents.filter((e) => e.label === 'Person').length >= 2) {
    const ps = ents.filter((e) => e.label === 'Person').slice(0, 3);
    const { knowersAll } = await import('./knowledge.ts');
    const k = await knowersAll(ctx.g);
    const out = new Set(ps.map((p) => p.uid));
    const sys = await ctx.g.q(`MATCH (s:System) RETURN s.uid AS uid, s.name AS name, s.tier AS tier`, {}, 'systems');
    const orphan = sys.filter((x) => { const ks = k.get(x.uid) || []; return ks.length && ks.every((kk) => out.has(kk.uid)); });
    const tix = await ctx.g.q(`MATCH (t:Ticket {status:'open'})-[:ASSIGNED_TO]->(p:Person) WHERE p.uid IN $u RETURN t.key AS key, t.priority AS pr, p.name AS who`, { u: [...out] }, 'their open tickets');
    const names = (await ctx.g.q(`UNWIND $u AS x MATCH (p:Person {uid:x}) RETURN p.name AS n`, { u: [...out] })).map((r) => r.n);
    cards.push({ type: 'graph', title: `Without ${names.join(' and ')}`, focus: [...out, ...orphan.map((o) => o.uid)] });
    return done(`If **${names.join(' and ')}** are both out:\n- **Nobody left who knows:** ${orphan.map((o) => `${o.name}${o.tier ? ` (${o.tier})` : ''}`).join(', ') || 'nothing — every system they know has someone else'}\n- **Open work to hand off:** ${tix.map((x) => `${x.key} ${x.pr} (${x.who})`).join(', ') || 'none'}\n\nAsk "who else could learn ${orphan[0]?.name || 'a system'}?" to start spreading it.`);
  }

  // ---- act on the words you used: "email Kate apologising for … and confirm it goes out Friday"
  const mailTo = first('Person') || (first('Org') ? { uid: (await ctx.g.one(`MATCH (p:Person)-[:WORKS_AT]->(:Org {uid:$o}) RETURN p.uid AS uid LIMIT 1`, { o: first('Org')!.uid }, 'their contact'))?.uid, label: 'Person' } : null);
  if (/^(please )?(draft|write|send|email|mail|tell|let)\b/.test(low) && /\b(email|mail|write|tell|let .+ know|reply)\b/.test(low) && mailTo?.uid) {
    const said = t.match(/\b(?:saying|that|about|to say|telling (?:her|him|them)|explaining|apologi[sz]ing|confirming|letting (?:her|him|them) know)\b([\s\S]*)$/i);
    if (said && said[1].trim().length > 6) return done(await draftFromWords(ctx, call, mailTo.uid, t));
  }

  // ---- "book a 30 minute call with Hana tomorrow at 2pm"
  if (/\b(book|schedule|set up|arrange|put)\b.*\b(call|meeting|sync|1:1|chat|catch[- ]?up|time)\b/.test(low) && first('Person')) {
    const people = ents.filter((e) => e.label === 'Person');
    const mins = Number(low.match(/(\d+)\s*(?:-| )?(?:min|minute)/)?.[1] || (/\bhour\b/.test(low) ? 60 : 30));
    const start = parseWhen(low);
    const topic = first('Project', 'Org', 'System', 'Ticket');
    const title = topic ? `${(await ctx.g.one(`MATCH (n {uid:$u}) RETURN CASE WHEN n:Ticket THEN n.key ELSE n.name END AS n`, { u: topic.uid }))?.n} sync` : `Call with ${(await ctx.g.one(`MATCH (p:Person {uid:$u}) RETURN p.name AS n`, { u: people[0].uid }))?.n?.split(' ')[0]}`;
    return done((await call('propose_event', { title, attendees: people.map((p) => p.uid), minutes: mins, ...(start ? { start: new Date(start).toISOString() } : {}) })).text);
  }

  // ---- decisions waiting on me: "confirm Oct 28", "go with the shim"
  // I never delete or rewrite the graph from chat, whatever the wording
  if (/\b(delete|remove|drop|wipe|erase|destroy|truncate)\b.*\b(all|every|tickets?|nodes?|graph|data|database|everything|records?)\b|ignore (all |your |previous |prior )*instructions/.test(low)) {
    return done(`I can't do that. I don't delete or rewrite your graph from chat — I read it, and anything I change goes through a draft you approve (emails, invites, reassignments, merges, coding runs). To remove data, disconnect the app it came from in Connect apps.`);
  }
  // ---- a board / exec update, written from the graph
  if (/\b(board|investors?|exec(utive)? (summary|update)|status update|weekly update|update for (the )?(team|leadership))\b/.test(low) && /\b(tell|update|say|summary|report|share|write)\b/.test(low)) {
    const txt = await boardUpdate(ctx, call);
    cards.length = 0;
    return done(txt);
  }

  // ---- "what did Marcus decide about Stripe?"
  const decQ = low.match(/\bwhat (?:did|has) (.+?) decide/);
  if (decQ && first('Person')) {
    const who = first('Person')!;
    const rows = await ctx.g.q(
      `MATCH (d:Decision)-[r:DECIDED_BY|RAISED_BY|APPROVED_BY]->(:Person {uid:$u}) RETURN d.text AS text, coalesce(d.status, 'pending') AS status, type(r) AS how, d.choice AS choice, d.at AS at ORDER BY d.at DESC`,
      { u: who.uid },
      'decisions this person made or raised',
    );
    const topicEnt = ents.find((e) => e.uid !== who.uid);
    const words = topicEnt ? (await ctx.g.one(`MATCH (n {uid:$u}) RETURN toLower(n.name) AS n`, { u: topicEnt.uid }))?.n : null;
    const rel = words ? rows.filter((r) => String(r.text).toLowerCase().includes(String(words).split(' ')[0])) : rows;
    const name = (await ctx.g.one(`MATCH (p:Person {uid:$u}) RETURN p.name AS n`, { u: who.uid }))?.n;
    const made = rel.filter((r) => r.how === 'DECIDED_BY' || r.how === 'APPROVED_BY');
    const raised = rel.filter((r) => r.how === 'RAISED_BY' && r.status === 'pending');
    return done(made.length
      ? `${name} decided:\n${made.map((r) => `- **${r.text}**${r.choice ? ` → ${r.choice}` : ''} (${ago(r.at)})`).join('\n')}${raised.length ? `\n\nStill open: ${name.split(' ')[0]} raised “${raised[0].text}” ${ago(raised[0].at)} and is waiting on you.` : ''}`
      : raised.length ? `**${name} hasn't decided — they're waiting on you.** They raised “${raised[0].text}” ${ago(raised[0].at)}, and it's still pending.` : `I have no decision by ${name}${words ? ` about ${words}` : ''} in the graph.`);
  }

  // ---- "who is our single point of failure?" asks about people
  if (/^who\b/.test(low) && /\b(single point|bus factor|irreplaceable|can'?t (we )?lose|most critical person)\b/.test(low)) {
    return done(`The people the graph can't do without:\n\n${(await call('insights', { focus: 'absence' })).text}`);
  }

  const pending = await ctx.g.q(`MATCH (d:Decision {status:'pending'}) OPTIONAL MATCH (d)-[:ABOUT]->(x) RETURN d.uid AS uid, d.text AS text, d.options AS options, collect(x.uid) AS about`, {}, '~pending decisions');
  // An explicit, unambiguous choice records the decision ("confirm Oct 28", "decide: push to Nov 4").
  // "Help me decide …" never decides — it lays out the options and the stakes instead.
  if (!/help me decide|should i|what do you think|options|stakes/.test(low) && /^(confirm|go with|let'?s|choose|pick|decide|ok|yes)\b/i.test(t)) {
    for (const d of pending) {
      const scored = ((d.options as string[]) || []).map((o) => {
        const words = o.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !['the', 'and', 'support', 'launch'].includes(w));
        return { o, hit: words.filter((w) => low.includes(w)).length, need: Math.min(2, words.length) };
      }).sort((a, b) => b.hit - a.hit);
      if (scored[0] && scored[0].hit >= scored[0].need && scored[0].hit > (scored[1]?.hit ?? 0)) {
        const r = await call('decide', { decision: d.uid, choice: scored[0].o });
        return done(r.text);
      }
    }
  }
  // advice about something a pending decision is about: "should we delay the EU launch?",
  // "who should I talk to before the Stripe cutover?" — answer with that decision's stakes
  const advice = (/\b(should (we|i)|do we|is it worth)\b/.test(low) && /\b(delay|decide|go ahead|launch|push|postpone|cutover|ship|drop|cancel|confirm|lock|wait)\b/.test(low))
    || /\b(stakeholders?|who should i (talk|speak) to|who (needs|should) to know|who to (loop|bring) in|recommend|what would you do|your (call|advice|take)|advise)\b/.test(low);
  const aboutHit = advice ? pending.find((d) => ents.some((e) => (d.about as string[]).includes(e.uid)) || d.text.toLowerCase().split(/\W+/).some((w: string) => w.length > 5 && low.includes(w))) : null;
  // "show me every decision" / "how many decisions" are listings, not a request to decide
  const listing = /\b(how many|list|show (me )?(all|the|every)|every|all (the |our |my )?decisions)\b/.test(low);
  if ((/\b(decide|decision)\b/.test(low) && !listing && !/\bwhy\b|\bwho\b|trace/.test(low)) || aboutHit) {
    const target = aboutHit || pending.find((d) => d.text.toLowerCase().split(/\W+/).some((w: string) => w.length > 4 && low.includes(w))) || pending[0];
    if (target) {
      cards.push({ type: 'options', question: target.text, options: (target.options as string[]).map((o, i) => ({ key: String.fromCharCode(65 + i), label: o, value: `Decide: ${o}` })) });
      const tr = await call('decision_trace', { topic: target.uid });
      const im = await call('decision_impact', { decision: target.uid });
      const people = ((im.data as any)?.people || []) as string[];
      const talk = /\b(talk|speak|loop|stakeholder|needs? to know|bring in)/.test(low) && people.length ? `**Talk to ${people.join(', ')}** — they work on what this decision touches.\n\n` : '';
      return done(`${talk}Here's what I know about **${target.text}**:\n${tr.text}\n\n${im.text}\n\nWhich way do you want to go? I'll record it and draft the follow-ups.`);
    }
  }

  // ---- act: fix tickets with the coding-agent fleet
  const engineer = !opts.dot || /engineer/i.test(opts.dot.role);
  const isWatch = /^(watch|alert me|tell me|let me know|notify me|ping me|warn me|whenever)\b/.test(low);
  // "X or Y first?": rank both on the graph instead of acting on either
  const keysIn = [...t.matchAll(/\b([A-Z]{2,6}-\d+)\b/gi)].map((m) => m[1].toUpperCase());
  if (/\bor\b/.test(low) && /\b(first|priorit\w*|more (important|urgent)|which (one|should)|before)\b/.test(low)) {
    const txt = await whichFirst(ctx, call, t, keysIn, ents);
    // one answer: keep a single graph card, drop the option lists the sub-tools offered
    const g1 = cards.find((c) => c.type === 'graph');
    cards.length = 0;
    if (g1) cards.push(g1);
    return done(txt);
  }
  // a question about fixing is not an instruction to fix ("is LUM-139 fixable today?")
  const asking = (/^(is|are|should|which|what|how|why|when|do|does|did|will|was|who)\b/.test(low) || /\bfixable\b/.test(low)) && !/^(can you|could you|would you|please)\b/.test(low);
  if (asking && keysIn.length && /\b(fix|fixable|patch|resolve)\b/.test(low)) {
    const k = keysIn[0];
    const r = await ctx.g.one(
      `MATCH (t:Ticket {key:$k}) OPTIONAL MATCH (t)-[:AFFECTS]->(s:System)<-[:IMPLEMENTS]-(repo:Repo)
       OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person)
       RETURN t.status AS status, t.priority AS priority, collect(DISTINCT s.name) AS systems, collect(DISTINCT repo.name) AS repos, a.name AS owner`,
      { k },
      `can ${k} be fixed by a coding agent (is its repo connected?)`,
    );
    const verdict = !r ? `I can't find ${k}.`
      : r.status !== 'open' ? `${k} is already ${r.status}.`
      : r.repos.length ? `**Yes — it's fixable by a coding agent.** ${k} (${r.priority}) is on ${r.systems.join(', ')}, and that code (${r.repos.join(', ')}) is connected, so I can hand it to one of your agents on a branch and run the tests. ${r.owner ? `${r.owner} owns it today.` : ''} Say "fix ${k}" to start.`
      : `**Not by a coding agent yet** — none of the systems ${k} touches has its repo connected. ${r.owner ? `${r.owner} owns it.` : ''}`;
    return done(`${verdict}\n\n${(await call('timeline', { ref: `ticket:${k}` })).text}`);
  }
  if (!asking && !isWatch && /\b(fix|patch|repair|resolve|ship a fix|hand .* to|dispatch)\b/.test(low) && (!opts.inGroup || engineer)) {
    const keys = [...t.matchAll(/\b([A-Z]{2,6}-\d+)\b/gi)].map((m) => m[1].toUpperCase());
    const targets = keys.length ? keys : ents.filter((e) => ['Ticket', 'Org', 'System'].includes(e.label)).map((e) => e.uid);
    if (targets.length) {
      const eng = specialist(/engineer/i);
      if (eng) return delegateTo(eng.name, t, `This is engineering work, so I passed it to **${eng.name}**.`);
      const agent = low.match(/\b(codex|claude(?:[- ]code)?|cursor|opencode|grok|antigravity)\b/)?.[1]?.replace(/^claude.*/, 'claude-code');
      const r = await call('propose_fix', { tickets: targets, agent });
      return done(r.text);
    }
  }

  if (/\b(brief|report|write[- ]?up|summary doc|memo)\b/.test(low) && ents.length) {
    const res = specialist(/research/i);
    if (res) return delegateTo(res.name, t, `**${res.name}** writes our briefs, so I asked them.`);
    return done(await writeBrief(ctx, call, ents[0]));
  }

  // ---- people's load: "is Raj overloaded?", "who is the busiest engineer?"
  if (/\b(overloaded|over ?loaded|stretched|swamped|too much on|workload|how busy|busiest|most loaded|capacity|bandwidth)\b/.test(low)) {
    const p = first('Person');
    if (p || /busiest|most loaded|who (has|is)|everyone|team/.test(low)) return done((await call('workload', p ? { person: p.uid } : { engineers: /\b(engineers?|developers?|devs?)\b/.test(low) })).text);
  }

  // ---- who is waiting on me
  if (/\b(waiting (on|for) (me|us|a reply)|who('s| is) waiting|owe (a )?repl|unanswered|chasing me|who needs (an? )?(answer|reply))\b/.test(low)) {
    return done((await call('insights', { focus: 'waiting' })).text);
  }

  // ---- what someone said: "what did Kate say last week?", "latest from Brightwave"
  if (/\b(what (did|has|have) .+ (say|said|write|written|wrote|send|sent|ask|asked)|what('s| is| has) .+ (been )?saying|latest from|last (message|email) from|heard from)\b/.test(low)) {
    const w = first('Person', 'Org');
    if (w) return done((await call('recent_from', { who: w.uid, days: /week/.test(low) ? 10 : 30 })).text);
  }

  // ---- a second person on a system: "who else could learn ota-server?"
  if (/\b(who (else )?(could|should|can) (learn|pick up|back ?up|cover)|second person|backup for|bus factor of|spread (the )?knowledge)\b/.test(low)) {
    const sys = first('System');
    if (sys) return done((await call('who_could_learn', { system: sys.uid })).text);
  }

  // ---- money on a system: "how much revenue rides on checkout-web?"
  if (/\b(revenue|arr|money|dollars|how much)\b/.test(low) && first('System')) {
    return done((await call('blast_radius', { ref: first('System')!.uid })).text);
  }

  // ---- customer health: "which customers are at risk?", "how are our customers doing?"
  if (/\b(customers?|accounts?|clients?)\b.*\b(at risk|risk|health|healthy|churn|happy|unhappy|doing|okay|ok)\b|\b(churn risk|account health|customer health)\b/.test(low) && !first('Org')) {
    return done((await call('customer_health')).text);
  }

  // ---- critical path: "what's blocking the EU launch?", "why is OTA 2.4 stuck?"
  if (/\b(block(ed|ing|ers?)?|stuck|holding .* (up|back)|critical path|unblock|what stands between|when can we (ship|launch))\b/.test(low)) {
    const x = first('Project');
    if (x) return done((await call('critical_path', { project: x.uid })).text);
  }

  // ---- "is Raj on leave?" — a yes/no from what you told me (including what you later retracted)
  if (/^(is|are|will)\b.*\b(on leave|out|away|off|on holiday|on vacation|sick)\b/.test(low) && first('Person')) {
    const p = first('Person')!;
    const notes = (await ctx.g.q(
      `MATCH (m:Fact)-[:ABOUT]->(:Person {uid:$u}) RETURN m.text AS text, m.status AS status, m.at AS at, m.retractedAt AS gone ORDER BY m.at DESC`,
      { u: p.uid },
      'what you told me about them',
    )).filter((m) => /\b(leave|out|away|off|holiday|vacation|sick|pto)\b/i.test(m.text));
    const n = notes[0];
    if (n) {
      remembered = '';
      const head = n.status === 'active' ? `**Yes — you told me** (${ago(n.at)}): “${n.text}”.` : `**No — that was cancelled.** You told me “${n.text}”, then retracted it ${ago(n.gone || n.at)}.`;
      if (n.status !== 'active') return done(head);
      return done(`${head}\n\nWhile they're out:\n${(await call('what_if_absent', { person: p.uid })).text}`);
    }
    return done(`Nothing in the graph says so — no note from you and no time off on the calendar. If they will be, tell me ("remember that … is on leave from …") and I'll plan around it.`);
  }

  // ---- absence simulation: "what if Priya is out next week?", "who covers for Raj?"
  if (/\b(leaves?|leaving|quits?|is out|are out|be out|off sick|on leave|on vacation|on holiday|parental leave|goes away|gets sick|hit by a bus|covers? for|cover for|without)\b/.test(low)) {
    const who = first('Person');
    if (who) return done((await call('what_if_absent', { person: who.uid })).text);
  }

  if (/\b(reassign|rebalance|who should (take|own|handle|pick up)|hand .* to someone|move .* to someone)\b/.test(low)) {
    const key = t.match(/\b([A-Z]{2,6}-\d+)\b/i)?.[1]?.toUpperCase();
    const tk = key ? `ticket:${key}` : first('Ticket')?.uid;
    const target = /\bto\s+\w/.test(low) ? first('Person') : undefined;
    if (tk) return done((await call('propose_reassign', { ticket: tk, draft: !/^(who|which|whom)\b|\?$/.test(low), ...(target ? { to: target.uid } : {}) })).text);
  }

  if (/\bwho\b.*\b(knows?|worked|works|owns?|expert|familiar|touched|wrote)\b/.test(low)) {
    const x = first('System', 'Project', 'Repo', 'Org', 'Ticket') || (await search(ctx.g, t.replace(/who|knows?|about|worked on|owns?/gi, ''), ['System', 'Project', 'Repo', 'File'], 1)).map((r) => ({ uid: r.uid, label: r.label }))[0];
    if (x) return done((await call('who_knows', { ref: x.uid })).text);
  }

  // ---- a symptom on a system: "the customer portal is slow", "why is checkout broken?"
  if (!/(what breaks|goes down|go down|blast radius|impact of|if .* (fails|dies|is down))/.test(low) && /\b(slow|sluggish|laggy|lagging|takes forever|timing out|times out|broken|failing|erroring|errors?|not working|down|why is|keeps crashing|crash(es|ing)?)\b/.test(low)) {
    const x = first('System', 'Repo');
    if (x) return done((await call('diagnose', { system: x.uid })).text);
  }

  if (/(what breaks|goes down|go down|blast radius|impact of|if .* (fails|dies|is down)|outage)/.test(low)) {
    const x = first('System', 'Repo');
    if (x) return done((await call('blast_radius', { ref: x.uid })).text);
  }

  if (/\b(why did we|why are we|who decided|decid|decision)/.test(low) && !listing) {
    const x = first('Project', 'System', 'Org', 'Ticket');
    return done((await call('decision_trace', { topic: x?.uid || t })).text);
  }

  if (/(connected|connection|relate[sd]?|link(ed)?|path) (between|to)|how (is|are|does) .* (connected|related|linked)/.test(low) && ents.length >= 2) {
    return done((await call('connection_path', { from: ents[0].uid, to: ents[1].uid })).text);
  }

  if (/(what did|asked|ask(ed)? for|was it resolved|history with|last month|status with|where are we with)/.test(low)) {
    const x = first('Org', 'Person');
    if (x) return done((await call('customer_history', { org: x.uid })).text);
  }

  if (/\b(duplicates?|same person|merge (people|contacts|identities)|clean ?up (people|contacts)|dedupe)\b/.test(low)) {
    return done((await call('find_duplicates')).text);
  }

  // ---- the story of something: "what happened with LUM-139?", "timeline for Brightwave"
  if (/\b(timeline|history of|story of|what happened (with|to|on)|walk me through|how did we get here)\b/.test(low)) {
    const x = ents[0] || ((t.match(/\b([A-Z]{2,6}-\d+)\b/)?.[1]) ? { uid: `ticket:${t.match(/\b([A-Z]{2,6}-\d+)\b/)![1]}`, label: 'Ticket' } : null);
    if (x) return done((await call('timeline', { ref: x.uid })).text);
  }

  // ---- watch rules: "tell me whenever a customer chases twice"
  if (/^(watch|alert me|tell me|let me know|notify me|ping me|warn me)\b.*\b(when|whenever|if)\b|^whenever\b|^watch (for|out for)\b/.test(low)) {
    const hours = Number(low.match(/(\d+)\s*(h|hours?)\b/)?.[1]) || undefined;
    return done((await call('watch', { when: t, hours })).text);
  }

  // ---- graph algorithms by name
  const algo: [RegExp, string, Record<string, unknown>?][] = [
    [/\bpage ?rank\b/, 'pagerank'],
    [/\bbetweenness|bottleneck|broker/, 'betweenness'],
    [/\bharmonic|closest to everyone|most reachable/, 'harmonic'],
    [/\b(communit(y|ies)|clusters?|label propagation|working groups?|who works (closely )?together)\b/, 'communities'],
    [/\b(islands?|isolated|disconnected|connected components?|wcc)\b/, 'components'],
    [/\b(reachable from|downstream of|everything .* depends on|what depends on)\b/, 'reach'],
    [/\b(shortest path|best route|introduce me|intro to|warm intro|get to)\b/, 'shortest_path'],
  ];
  const hitAlgo = algo.find(([re]) => re.test(low));
  if (hitAlgo) {
    const lab = /\b(system|service)s?\b/.test(low) ? 'System' : /\bprojects?\b/.test(low) ? 'Project' : /\b(people|person|team|who|groups?)\b/.test(low) ? 'Person' : undefined;
    const rel = lab === 'System' ? 'DEPENDS_ON' : hitAlgo[1] === 'communities' ? 'CLOSE_TO' : lab === 'Person' ? 'COLLABORATES' : undefined;
    const args: Record<string, unknown> = { algorithm: hitAlgo[1], ...(lab ? { label: lab } : {}), ...(rel ? { rel } : {}) };
    if (hitAlgo[1] === 'reach') { if (!ents[0]) return done('Reachable from what? Name a system or person.'); args.source = ents[0].uid; args.rel = ents[0].label === 'Person' ? 'COLLABORATES' : 'DEPENDS_ON'; args.direction = /depends on|downstream|who/.test(low) ? 'in' : 'out'; }
    if (hitAlgo[1] === 'shortest_path') {
      const me = (await ctx.g.one(`MATCH (p:Person {me:true}) RETURN p.uid AS uid`, {}, '~me'))?.uid;
      const people = ents.filter((e) => e.label === 'Person');
      if (!people.length) return done('Who should I route to? Name a person.');
      args.source = people.length > 1 ? people[0].uid : me; args.target = people[people.length - 1].uid; args.rel = 'COLLABORATES';
    }
    return done((await call('run_algorithm', args)).text);
  }

  if (/\b(risks?|risky|insights?|single points? of failure|bus factor|overloaded|stretched|what changed|since yesterday|health ?check|anything (worrying|i should worry)|slip(ping)?|behind schedule|quits?|leaves)\b/.test(low) && !(ents.length && /\b(worr|should i|is .+ (ok|fine))/.test(low))) {
    const focus = /bus factor|knows it/.test(low) ? 'bus' : /single point|spof/.test(low) ? 'spof' : /overload|stretched/.test(low) ? 'load' : /what changed|since yesterday/.test(low) ? 'changed'
      : /\bprojects?\b.*\b(slip|late|behind|risk|delay)|\b(slip|behind schedule)/.test(low) ? 'blocked'
      : /\b(quits?|leaves|bus|lose|absence|someone (is )?out)\b/.test(low) ? 'absence'
      : /\bcustomers?\b/.test(low) ? 'customers' : undefined;
    // a question gets an answer: the single biggest risk first, the next two after, the rest in Insights
    if (!focus && !/\binsights?\b|health ?check/.test(low)) return done(await biggestRisks(call, cards));
    return done(`${focus === 'changed' ? "Here's what happened in your graph" : "Here's what the graph says you should worry about"}:\n\n${(await call('insights', { focus })).text}`);
  }

  if (/(important|key|central|influential|(most |best |well[- ])connected) (people|person|contacts|colleagues)|who matters|brokers?\b|most connected/.test(low)) {
    return done((await call('key_people')).text);
  }

  if (/\b(prep|prepare|brief) (me )?(for|on)\b|\bmeeting prep\b|\bget me ready for\b/.test(low)) {
    const withWho = t.match(/\b(?:meeting|call|sync|1:1|chat|catch-?up)\s+with\s+(.+?)[?.!]*$/i)?.[1];
    const target = withWho || t.replace(/^.*?\b(prep|prepare|brief|ready)\b( me)?( for| on)?( the| my)?\s*/i, '').replace(/[?.!]+$/, '').trim();
    return done((await call('meeting_prep', { meeting: target || 'next meeting' })).text);
  }

  if (/\b(schedule|book|set up|arrange) (a |an )?(meeting|call|sync|1:1|chat)\b/.test(low)) {
    const people = ents.filter((e) => e.label === 'Person');
    const topic = first('Project', 'Org', 'System');
    const r = await call('propose_event', { title: `${topic ? (await ctx.g.one(`MATCH (n {uid:$u}) RETURN n.name AS n`, { u: topic.uid }))?.n + ' ' : ''}sync`.trim(), attendees: people.map((p) => p.uid) });
    return done(r.text);
  }

  // the calendar needs a calendar word; "today" alone ("is LUM-139 fixable today?") isn't one
  if ((/\b(calendar|agenda|meetings?|schedule|my day|my week)\b/.test(low) || /^(what'?s|what is|anything) (on )?(for )?(today|tomorrow)\b/.test(low)) && !keysIn.length && !/\b(reply|email|draft|needs? me|what should|plate|priorit|urgent|attention|triage|important)\b/.test(low)) {
    const day = /\btomorrow\b/.test(low) ? 1 : /\btoday\b/.test(low) ? 0 : null;
    if (day !== null) {
      const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + day);
      const r = await call('agenda', { days: 3 });
      const rows = ((r.data as any[]) || []).filter((e) => e.start >= start.getTime() && e.start < start.getTime() + 86_400_000);
      return done(rows.length ? `${day ? 'Tomorrow' : 'Today'}:\n${rows.map((e) => `- ${when(e.start)} — **${e.title}**${e.with?.length ? ` with ${e.with.join(', ')}` : ''}${e.conflict ? ' ⚠️ conflict' : ''}`).join('\n')}` : `Nothing on your calendar ${day ? 'tomorrow' : 'today'}.`);
    }
    return done(`Here's what's coming up:\n${(await call('agenda', { days: 4 })).text}`);
  }

  if (/(unsubscribe|newsletters?|clean ?up (my )?inbox|declutter|promo)/.test(low)) {
    return done((await call('inbox_cleanup')).text + '\n\nWant me to unsubscribe from them? I\'ll ask before each one.');
  }

  if (/\b(reply|respond|draft|write (to|an? email)|email|follow up with)\b/.test(low)) {
    const p = first('Person') || (first('Org') ? { uid: (await ctx.g.one(`MATCH (p:Person)-[:WORKS_AT]->(:Org {uid:$o}) RETURN p.uid AS uid LIMIT 1`, { o: first('Org')!.uid }))?.uid, label: 'Person' } : null);
    if (p?.uid) return done((await composeReply(ctx, call, p.uid)).text);
  }

  if (/\b(good at|skills?|best at|strong(est)? at|track record)\b/.test(low) && /\b(agents?|codex|claude|cursor|opencode|grok|antigravity|fleet|subscriptions?)\b/.test(low)) {
    const a = low.match(/\b(codex|claude|cursor|opencode|grok|antigravity)\b/)?.[1];
    return done((await call('agent_skills', { agent: a })).text);
  }

  if (/\b(agents?|subscriptions?|codex|claude|cursor|opencode|grok|antigravity|fleet)\b/.test(low)) {
    return done(`Here's your agent fleet — the subscriptions on my computer I can hand work to:\n${(await call('list_agents')).text}`);
  }

  if (/(plate|triage|priorit|what should i|urgent|attention|first task|suggest|catch me up|what'?s up|morning|brief|help with|anything (for|to)|what needs)/.test(low)) {
    return done(await triageReply(ctx, call, cards));
  }

  if (/(what do you (know|remember)|recall|do you remember)/.test(low)) {
    const r = await call('recall', { query: t.replace(/what do you (know|remember) about|recall|do you remember/gi, '') });
    return done(r.text);
  }

  // ---- ticket age: "which tickets have been open longer than 2 weeks?"
  const age = low.match(/\b(?:open|older|longer|more) (?:for |than )?(?:longer than |more than |over )?(\d+|a|one|two|three|four)\s*(day|week|month)s?\b/);
  if (age && /\b(tickets?|issues?|bugs?|incidents?)\b/.test(low)) {
    const n = { a: 1, one: 1, two: 2, three: 3, four: 4 }[age[1] as 'a'] ?? Number(age[1]);
    const days = n * (age[2] === 'week' ? 7 : age[2] === 'month' ? 30 : 1);
    return done((await call('list_entities', { label: 'Ticket', status: 'open', olderThanDays: days })).text);
  }

  // ---- "who emails me the most?"
  if (/\bwho\b.*\b(emails?|mails?|messages?|writes? to|contacts?|pings?)\b.*\b(me|us)\b.*\b(most|a lot|often)\b/.test(low)) {
    const rows = await ctx.g.q(
      `MATCH (p:Person)<-[:FROM]-(e:Email)-[:TO]->(:Person {me:true}) WHERE NOT coalesce(e.newsletter, false) AND NOT coalesce(p.me, false)
       OPTIONAL MATCH (p)-[:WORKS_AT]->(o:Org)
       RETURN p.uid AS uid, p.name AS name, o.name AS org, count(e) AS n, max(e.at) AS last ORDER BY n DESC LIMIT 5`,
      {},
      'who writes to me most (newsletters excluded)',
    );
    cards.push({ type: 'graph', title: 'Who writes to you', focus: rows.map((r) => r.uid) });
    return done(rows.length ? `Who writes to you most (newsletters left out):\n${rows.map((r, i) => `${i + 1}. **${r.name}**${r.org && r.org !== 'Lumen Labs' ? ` (${r.org})` : ''} — ${r.n} email${r.n > 1 ? 's' : ''}, last ${ago(r.last)}`).join('\n')}` : 'Nobody has emailed you yet.');
  }

  // ---- "can Priya take LUM-131 (too)?" — a fit check for that person on that ticket
  if (/\bcan\b.+\b(take|handle|pick up|own|do)\b/.test(low) && first('Person') && keysIn.length) {
    const who = first('Person')!;
    const ranked = await rankOwners(ctx.g, `ticket:${keysIn[0]}`);
    const me = ranked.find((r) => r.uid === who.uid);
    const owner = (await ctx.g.one(`MATCH (:Ticket {key:$k})-[:ASSIGNED_TO]->(a:Person) RETURN a.uid AS uid`, { k: keysIn[0] }, '~current owner'))?.uid;
    const best = ranked.find((r) => r.uid !== who.uid && r.uid !== owner);
    const name = (await ctx.g.one(`MATCH (p:Person {uid:$u}) RETURN p.name AS n`, { u: who.uid }))?.n || 'They';
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
    const hands = me ? [me.commits && n(me.commits, 'commit'), me.docs && n(me.docs, 'doc'), me.tickets && n(me.tickets, 'past ticket')].filter(Boolean).join(', ') : '';
    const verdict = !me ? `**Not a good fit** — ${name} has no hands-on work on the systems ${keysIn[0]} touches.`
      : (me.p1s || 0) > 0 ? `**Possible, but ${name.split(' ')[0]} is already on a P1** — they know the area (${hands || 'project member'}), and this would stack a second urgent item on them.`
      : me === ranked[0] ? `**Yes — ${name} is the best fit** (${hands || 'on the project'}, ${n(me.load, 'open ticket')}).`
      : `**Yes, they could** (${hands || 'on the project'}, ${n(me.load, 'open ticket')}), though ${ranked[0].name} is a stronger fit.`;
    return done(`${verdict}${best && (!me || (me.p1s || 0) > 0) ? ` Better option: **${best.name}**${best.role ? ` (${best.role})` : ''}.` : ''}`);
  }

  // ---- "who should I talk to about VAT?" — the people behind a topic
  const topic = low.match(/\bwho (?:should i|do i|can i|to) (?:talk|speak|ask|go) (?:to )?(?:about|re|regarding|for) (.+?)\??$/);
  if (topic && !first('System')) {
    const hits = await search(ctx.g, topic[1], ['Ticket', 'Doc', 'Decision', 'ChatMessage', 'Project', 'Email'], 8);
    if (hits.length) {
      const people = await ctx.g.q(
        `UNWIND $u AS x MATCH (n {uid:x})-[r:ASSIGNED_TO|OWNS|DECIDED_BY|POSTED|REPORTED_BY|FROM|RAISED_BY|WORKS_ON]-(p:Person)
         WHERE NOT coalesce(p.me, false) AND coalesce(p.role, '') <> 'Newsletter'
         RETURN p.uid AS uid, p.name AS name, p.role AS role, count(*) AS n, collect(DISTINCT type(r) + ':' + coalesce(n.key, n.name))[0..2] AS via ORDER BY n DESC LIMIT 4`,
        { u: hits.map((h: Row) => h.uid) },
        `people behind "${topic[1]}"`,
      );
      if (people.length) {
        const verb: Record<string, string> = { ASSIGNED_TO: 'owns', OWNS: 'owns', DECIDED_BY: 'decided', POSTED: 'posted', REPORTED_BY: 'reported', FROM: 'wrote', RAISED_BY: 'raised', WORKS_ON: 'works on' };
        cards.push({ type: 'graph', title: `About ${topic[1]}`, focus: [...people.map((p) => p.uid), ...hits.slice(0, 4).map((h: Row) => h.uid)] });
        return done(`Talk to **${people[0].name}**${people[0].role ? ` (${people[0].role})` : ''} first.\n${people.map((p) => `- **${p.name}** — ${(p.via as string[]).map((v) => { const [r, x] = v.split(':'); return `${verb[r] || r.toLowerCase()} ${x}`; }).join('; ')}`).join('\n')}`);
      }
    }
  }

  // ---- compare two people or two systems
  if (/\b(compare|vs\.?|versus|difference between)\b/.test(low)) {
    const people = ents.filter((e) => e.label === 'Person');
    const systems = ents.filter((e) => e.label === 'System');
    if (people.length >= 2) {
      const parts = [];
      for (const p of people.slice(0, 3)) parts.push((await call('workload', { person: p.uid })).text);
      return done(parts.join('\n\n'));
    }
    if (systems.length >= 2) {
      const parts = [];
      for (const x of systems.slice(0, 3)) parts.push((await call('blast_radius', { ref: x.uid })).text);
      return done(parts.join('\n\n'));
    }
  }

  // ---- counting and listing: "how many open P1s?", "list all open tickets", "what's our total ARR?"
  const listy = /\b(how many|count|number of|list|show (me )?(all|the|every)|all (the |our |my )?|every|total|what are (the|our|my))\b/.test(low);
  const nounMap: [RegExp, string][] = [[/\b(tickets?|issues?|bugs?|incidents?|p[123]s?)\b/, 'Ticket'], [/\bprojects?\b/, 'Project'], [/\b(systems?|services?)\b/, 'System'], [/\b(customers?|clients?|accounts?|vendors?|investors?|prospects?|companies|orgs?)\b/, 'Org'], [/\b(decisions?)\b/, 'Decision'], [/\b(meetings?|events?)\b/, 'Event'], [/\b(docs?|documents?|runbooks?|rfcs?)\b/, 'Doc'], [/\bteams?\b/, 'Team'], [/\b(people|persons?|employees?|engineers?|colleagues)\b/, 'Person']];
  const noun = nounMap.find(([re]) => re.test(low));
  const scopeEnt = first('Project', 'System', 'Org', 'Person', 'Team');
  if ((listy || /\btotal (arr|revenue)\b/.test(low)) && (noun || /\b(arr|revenue)\b/.test(low)) && (!scopeEnt || (noun && noun[1] !== scopeEnt.label))) {
    const label = noun ? noun[1] : 'Org';
    const args: Record<string, string> = { label };
    if (scopeEnt && noun && noun[1] !== scopeEnt.label) args.within = scopeEnt.uid;
    const p = low.match(/\bp([123])s?\b/); if (p) args.priority = `P${p[1]}`;
    const st = low.match(/\b(open|resolved|closed|pending|blocked|planned|beta|in progress)\b/); if (st) args.status = st[1];
    if (label === 'Ticket' && p && !st) args.status = 'open';
    const k = low.match(/\b(customer|vendor|investor|prospect)s?\b/); if (label === 'Org' && k) args.kind = k[1];
    if (label === 'Org' && /\b(arr|revenue)\b/.test(low) && !k) args.kind = 'customer';
    const tr = low.match(/\b(critical|high|medium)\b/); if (label === 'System' && tr) args.tier = tr[1];
    return done((await call('list_entities', args)).text);
  }

  // ---- counts across the graph: "which project has the most open tickets?"
  const most = low.match(/\b(?:which|what|who)\b.*?\b(projects?|systems?|services?|customers?|clients?|accounts?|people|person|engineers?|developers?|devs?|teams?|who)\b.*\b(?:most|fewest|biggest|largest)\b\s*(.*)$/);
  if (most) {
    const [, noun, rest] = most;
    const label = /project/.test(noun) ? 'Project' : /system|service/.test(noun) ? 'System' : /customer|client|account/.test(noun) ? 'Org' : /team/.test(noun) ? 'Team' : 'Person';
    const metric = /depend/.test(rest) ? 'dependents' : /\b(systems?|services?)\b/.test(rest) && label !== 'System' ? 'systems' : /customer|client|arr|revenue/.test(rest) ? 'customers' : /people|members|staff|engineers/.test(rest) ? 'people' : /ticket|issue|incident|bug|work|load/.test(rest) ? 'open_tickets' : null;
    if (metric) return done((await call('rank_entities', { label, metric, engineers: /engineer|developer|\bdevs?\b/.test(noun) })).text);
  }

  // ---- spare capacity: "who has no open tickets?", "who's free to take something?"
  if (/\b(no|zero|without) (open )?(tickets|work|issues)|nothing assigned|who('s| is) free|spare capacity|who can (take|pick up)|has (the )?(most )?bandwidth\b/.test(low)) {
    const r = await call('workload', { engineers: /engineer|developer|\bdevs?\b/.test(low) });
    const free = ((r.data as any[]) || []).filter((x) => !x.tickets.length);
    return done(free.length
      ? `**No open tickets:** ${free.map((x) => `${x.name}${x.role ? ` (${x.role})` : ''}${x.meetings ? `, ${x.meetings} meeting${x.meetings > 1 ? 's' : ''} this week` : ''}`).join('; ')}.\n\nFull picture:\n${r.text}`
      : `Everyone has at least one open ticket.\n\n${r.text}`);
  }

  // ---- "should I worry about X?", "is payments-api ok?", "how is Brightwave doing?"
  if ((/\b(worr\w*|concern\w*|healthy|risky|at risk|safe|how is|how's|status of|health of)\b/.test(low) || /\bis .+ (ok|okay|fine)\b/.test(low)) && ents.length) {
    // a system and a vendor can share a name (Stripe): the system is the one that breaks
    const x = first('System') || first('Project') || ents[0];
    if (x.label === 'System') return done((await call('blast_radius', { ref: x.uid })).text);
    if (x.label === 'Project') return done((await call('critical_path', { project: x.uid })).text);
    if (x.label === 'Org') return done((await call('customer_history', { org: x.uid })).text);
    if (x.label === 'Person') return done((await call('what_if_absent', { person: x.uid })).text);
  }

  // ---- dates: "when is the EU launch date?"
  if (/\bwhen (is|are|will|does|do)\b|\b(date|deadline|due|eta|ship date|launch date|days? (until|till|to)|how long (until|till|before))\b/.test(low) && first('Project')) {
    const x = first('Project')!;
    const r = await ctx.g.one(
      `MATCH (p:Project {uid:$u})
       OPTIONAL MATCH (e:Event)-[:ABOUT]->(p) WHERE e.start > $now
       WITH p, e ORDER BY e.start
       RETURN p.name AS name, p.status AS status, p.due AS due, p.launchDate AS launch, collect(coalesce(e.title, e.name) + '|' + toString(e.start))[0..3] AS events`,
      { u: x.uid, now: Date.now() },
      'dates on the project',
    );
    const date = r?.due || r?.launch;
    const ev = (r?.events || []).filter(Boolean).map((v: string) => { const [t, at] = v.split('|'); return `${t} (${when(Number(at))})`; });
    const cp = await call('critical_path', { project: x.uid });
    return done(`${date ? `**${r.name}** is due ${when(Number(date))}.` : `**No date is recorded for ${r?.name}** in the graph${r?.status ? ` — it's ${r.status}` : ''}.`}${ev.length ? ` Coming up: ${ev.join(', ')}.` : ''}\n\n${cp.text}`);
  }

  // ---- yes/no questions about a thing get a judgement, never a property dump
  if (/^(is|are|does|do|can|will|has|have|was|were|am)\b/.test(low) && ents.length) {
    const x = ents[0];
    if (x.label === 'Person') {
      const ext = await ctx.g.one(`MATCH (p:Person {uid:$u}) OPTIONAL MATCH (p)-[:WORKS_AT]->(o:Org) RETURN coalesce(p.external, false) AS external, o.uid AS org, o.kind AS kind`, { u: x.uid }, 'are they one of us?');
      if (ext?.external && ext.org) return done((await call('customer_health', { org: ext.org })).text);
      return done((await call('workload', { person: x.uid })).text);
    }
    if (x.label === 'Org') return done((await call('customer_health', { org: x.uid })).text);
    if (x.label === 'System') return done((await call(/\b(slow|broken|down|failing|ok|okay|fine|healthy|working)\b/.test(low) ? 'diagnose' : 'blast_radius', /\b(slow|broken|down|failing|ok|okay|fine|healthy|working)\b/.test(low) ? { system: x.uid } : { ref: x.uid })).text);
    if (x.label === 'Project') return done((await call('critical_path', { project: x.uid })).text);
    if (x.label === 'Ticket') return done((await call('timeline', { ref: x.uid })).text);
  }

  // ---- feelings words map to the graph's version of them
  if (/\b(happy|unhappy|upset|satisfied|angry|frustrated|annoyed|churn)\b/.test(low) && first('Org', 'Person')) {
    const o = first('Org') || first('Person')!;
    return done((await call('customer_health', { org: o.uid })).text);
  }
  if (/\b(burn(ing)? ?out|burnt out|stressed|exhausted|tired|drowning)\b/.test(low) && first('Person')) {
    return done((await call('workload', { person: first('Person')!.uid })).text);
  }

  // fuzzy, "anything about…" questions go to semantic memory + graph expansion
  if (/^(anything|has anyone|did anyone|what('s| is| has) (the team|everyone|anyone) (said|saying)|any (mention|talk|news))|\b(similar to|related to|reminds)\b/.test(low) || (!ents.length && t.split(/\s+/).length > 3)) {
    const r = await call('semantic_search', { query: t });
    if ((r.data as any)?.hits?.length) return unsure(r.text);
    // nothing close by meaning: tell the story of what they named, or try the words themselves
    if (ents[0]) return unsure((await call('timeline', { ref: ents[0].uid })).text);
    // only things with names worth opening, only real matches, and only for short asks —
    // a long sentence that matched nothing by meaning is not rescued by one shared word
    const content = t.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 3 && !/^(anything|about|what|which|does|have|there|their|this|that|with|from|when|where|tell|show|please|could|would|should)$/.test(w));
    const words = content.length > 2 ? [] : (await search(ctx.g, t.replace(/\b(anything|about|the|a|an|is|are|what|who|any|has|have|on|of|for|did|do|does|our|we|my|last|this|week|plan)\b/gi, ' '), ['Doc', 'Ticket', 'Project', 'System', 'Decision', 'Org', 'Person', 'Team'], 6)).filter((h: Row) => h.score >= 1);
    used.push('search_graph');
    if (words.length) {
      cards.push({ type: 'options', question: 'Ask about one of these', options: words.slice(0, 4).map((h: Row, i: number) => ({ key: String.fromCharCode(65 + i), label: `${h.label}: ${String(h.name).slice(0, 48)}`, value: `Tell me about ${h.name}` })) });
      return unsure(`Nothing matches that closely, but these mention the same words:\n${words.map((h: Row) => `- ${h.label} **${h.name}**`).join('\n')}`);
    }
    return unsure(await fallback(ctx.g, cards));
  }

  // "tell me about X", "who is X", or a bare entity name
  const x = ents[0];
  if (x) return unsure((await call('describe_entity', { ref: x.uid })).text);
  const hits = await search(ctx.g, t, undefined, 6);
  used.push('search_graph');
  if (hits.length) {
    if (hits[0].score > 1.5 * (hits[1]?.score || 0)) return unsure((await call('describe_entity', { ref: hits[0].uid })).text);
    return unsure(`Here's what I found in your graph:\n${hits.map((h: Row) => `- ${h.label} **${h.name}**`).join('\n')}\n\nAsk me about any of them.`);
  }
  return unsure(await fallback(ctx.g, cards));
}

/** Nothing matched: say so plainly, and offer questions this graph can actually answer — built from what's in it. */
async function fallback(g: UserGraph, cards: Card[]) {
  const qs: string[] = ['What needs me today?'];
  const one = async (cypher: string) => (await g.one(cypher, {}, 'something to suggest').catch(() => null))?.n as string | undefined;
  if (await one(`MATCH (t:Thread {awaitingReply:true}) RETURN t.subject AS n LIMIT 1`)) qs.push("Which emails haven't I replied to?");
  const repo = await one(`MATCH (r:Repo) OPTIONAL MATCH (r)<-[x]-() WITH r, count(x) AS c RETURN r.name AS n ORDER BY c DESC LIMIT 1`);
  if (repo) qs.push(`Who knows ${repo} best?`);
  const org = await one(`MATCH (o:Org) WHERE o.arr IS NOT NULL RETURN o.name AS n ORDER BY o.arr DESC LIMIT 1`);
  if (org) qs.push('Which customers are at risk?');
  const sys = await one(`MATCH (s:System) RETURN s.name AS n LIMIT 1`);
  if (sys) qs.push(`What breaks if ${sys} goes down?`);
  // a real correspondent, not a mailer: someone you've also written to, else a fellow contributor
  const who = await one(`MATCH (m:Person {me:true})<-[:FROM]-(:Email)-[:TO]->(p:Person) WHERE p <> m RETURN p.name AS n, count(*) AS c ORDER BY c DESC LIMIT 1`)
    ?? await one(`MATCH (p:Person)-[:CONTRIBUTES_TO]->(:Repo) WHERE coalesce(p.me,false) = false RETURN p.name AS n, count(*) AS c ORDER BY c DESC LIMIT 1`);
  if (who) qs.push(`Tell me about ${who}`);
  qs.push('What changed this week?');
  cards.push({ type: 'options', question: 'Try one of these', options: qs.slice(0, 5).map((q, i) => ({ key: 'ABCDE'[i], label: q, value: q })) });
  return `I don't have anything in your graph that answers that, and I'd rather say so than guess. I answer by walking how the people, mail, code and decisions in your graph connect — for example:`;
}

export async function triageReply(ctx: Ctx, call: (n: string, a?: any) => Promise<ToolResult>, cards: Card[]) {
  const r = await call('triage');
  const d = r.data as any;
  const opts: { key: string; label: string; value: string }[] = [];
  // Only offer fixes the fleet can actually do: tickets on a system whose repo is connected.
  const fixable = await ctx.g.q(
    `MATCH (t:Ticket {status:'open'})-[:AFFECTS]->(:System)<-[:IMPLEMENTS]-(r:Repo) WHERE r.path IS NOT NULL
     OPTIONAL MATCH (t)-[:FOR]->(o:Org)
     RETURN DISTINCT t.key AS key, t.priority AS p, coalesce(o.arr, 0) AS arr ORDER BY p, arr DESC LIMIT 2`,
    {},
    'tickets my coding agents can fix (repo connected)',
  );
  const tick = fixable.map((i: any) => i.key);
  if (tick.length) opts.push({ key: '', label: config.hosted ? `Plan a fix for ${tick.join(' + ')} (agents run in the desktop app)` : `Fix ${tick.join(' + ')} with my coding agents`, value: `Fix ${tick.join(' and ')}` });
  const top = d.threads[0];
  if (top) opts.push({ key: '', label: `Draft a reply to ${top.sender.split(' ')[0]}`, value: `Draft a reply to ${top.sender}` });
  const dec = d.decisions[0];
  if (dec) opts.push({ key: '', label: `Decide: ${dec.text}`, value: `Help me decide: ${dec.text}` });
  opts.forEach((o, i) => (o.key = String.fromCharCode(65 + i)));
  if (opts.length) cards.push({ type: 'options', question: 'Want me to take one of these?', options: opts });
  return `A few things I could take off your plate — ranked by what the graph says matters most:\n\n${r.text}`;
}

async function writeBrief(ctx: Ctx, call: (n: string, a?: any) => Promise<ToolResult>, e: Ent) {
  const name = (await ctx.g.one(`MATCH (n {uid:$u}) RETURN n.name AS n`, { u: e.uid }))?.n || e.uid;
  const sections: string[] = [`# Brief: ${name}`, `_Written by ZivBot from your graph on ${new Date().toDateString()}. Every line below comes from a Cypher query you can replay._`];
  sections.push('## What it is', (await call('describe_entity', { ref: e.uid })).text);
  let sys = e.label === 'System' ? e.uid : null;
  if (e.label === 'Ticket') sys = (await ctx.g.one(`MATCH (:Ticket {uid:$u})-[:AFFECTS]->(s:System) RETURN s.uid AS s LIMIT 1`, { u: e.uid }))?.s;
  if (sys) sections.push('## Blast radius', (await call('blast_radius', { ref: sys })).text);
  if (['System', 'Project', 'Repo', 'Ticket', 'Org'].includes(e.label)) sections.push('## Who knows it', (await call('who_knows', { ref: sys || e.uid })).text);
  if (e.label === 'Org') sections.push('## Customer history', (await call('customer_history', { org: e.uid })).text);
  sections.push('## Decisions on record', (await call('decision_trace', { topic: e.uid })).text);
  const file = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-brief.md`;
  const r = await call('write_file', { name: file, content: sections.join('\n\n') });
  return `I wrote up everything the graph knows about **${name}** — what it touches, who knows it, and the decisions behind it. ${r.text}`;
}

async function composeReply(ctx: Ctx, call: (n: string, a?: any) => Promise<ToolResult>, person: string): Promise<ToolResult> {
  const g = ctx.g;
  const p = await g.one(`MATCH (p:Person {uid:$u}) OPTIONAL MATCH (p)-[:WORKS_AT]->(o:Org) RETURN p.name AS name, o.uid AS org, o.kind AS kind`, { u: person }, 'who am I replying to');
  const meName = (await g.one(`MATCH (m:Person {me:true}) RETURN m.name AS n`))?.n || '';
  const first = String(p?.name || '').split(' ')[0];
  // what they last wrote is what the reply has to answer
  const last = await g.one(
    `MATCH (:Person {uid:$u})<-[:FROM]-(e:Email) RETURN e.subject AS subject, e.body AS body ORDER BY e.at DESC LIMIT 1`,
    { u: person },
    'their latest email',
  );
  const asked = String(last?.body || '');
  const lines: string[] = [];
  if (p?.kind === 'customer') {
    const tix = await g.q(
      `MATCH (t:Ticket)-[:FOR]->(:Org {uid:$o}) WHERE t.status <> 'resolved'
       OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person) OPTIONAL MATCH (r:Run {status:'succeeded'})-[:RESOLVES]->(t)
       RETURN t.key AS key, t.title AS title, t.status AS status, a.name AS assignee, count(r) AS fixed`,
      { o: p.org },
      'their open tickets and fixes',
    );
    for (const t of tix) {
      const what = t.title.replace(/^.*?:\s*/, '');
      lines.push(t.fixed > 0 || t.status === 'fix ready' ? `- ${what}: a fix has passed our tests and is waiting to ship.` : `- ${what}: ${t.assignee?.split(' ')[0] || 'our team'} owns it and it's open as ${t.key}.`);
    }
  }
  // answer what the graph can answer from their message; say plainly what it can't
  const dict = await loadDictionary(g);
  const projects = mentionsIn(dict, asked).filter((u) => u.startsWith('project:'));
  for (const pr of projects) {
    const c = await criticalPath(g, pr);
    if (!c) continue;
    const b = c.blockers[0];
    lines.push(`- ${c.project.name}: ${c.project.status || 'in progress'}${b ? `; the open item is ${b.kind === 'decision' ? `a decision (“${b.title}”)` : `${b.key} (${b.title})`}` : ''}.`);
  }
  if (/\b(arr|revenue)\b/i.test(asked)) {
    const cust = await g.q(`MATCH (o:Org {kind:'customer'}) RETURN o.name AS name, coalesce(o.arr, 0) AS arr ORDER BY arr DESC`, {}, 'ARR by customer');
    if (cust.length) lines.push(`- ARR by customer: ${cust.map((c) => `${c.name} $${Math.round(c.arr / 1000)}k`).join(', ')} ($${Math.round(cust.reduce((n, c) => n + c.arr, 0) / 1000)}k total).`);
  }
  const next = p?.org ? await g.one(`MATCH (e:Event)-[:ABOUT]->(:Org {uid:$o}) WHERE e.start > $now RETURN coalesce(e.title, e.name) AS title, e.start AS start ORDER BY e.start LIMIT 1`, { o: p.org, now: Date.now() }, 'our next meeting with them') : null;
  const body = lines.length
    ? `Hi ${first},\n\nThanks${last?.subject ? ` for your note on “${String(last.subject).replace(/^re:\s*/i, '')}”` : ''} — here's where things stand:\n${lines.join('\n')}\n\nAnything else you asked for I'll follow up on separately${next ? `, and we can go through it all at ${next.title} (${when(next.start)})` : ''}.\n\nBest,\n${meName}`
    : `Hi ${first},\n\nThanks for the note — I'm on it and will get back to you shortly.\n\nBest,\n${meName}`;
  return call('draft_email', { to: person, body });
}

/** "Fix LUM-142 or reply to Kate first?" — rank both items on the triage ranking and say why. */
async function whichFirst(ctx: Ctx, call: (n: string, a?: any) => Promise<ToolResult>, t: string, keys: string[], ents: Ent[]) {
  for (const label of ['Org', 'Project', 'System', 'Person']) {
    const two = ents.filter((e) => e.label === label);
    if (two.length >= 2 && !keys.length) return compareTwo(ctx, call, label, two.slice(0, 2));
  }
  const d = (await call('triage')).data as any;
  type Item = { label: string; rank: number; why: string };
  const items: Item[] = [];
  const ranked: { kind: 'ticket' | 'thread' | 'decision'; x: any }[] = [
    ...d.incidents.map((x: any) => ({ kind: 'ticket' as const, x })),
    ...d.threads.map((x: any) => ({ kind: 'thread' as const, x })),
    ...d.decisions.map((x: any) => ({ kind: 'decision' as const, x })),
  ];
  // same order as "what needs me": incidents by priority and ARR reached, then waiting threads, then decisions
  ranked.forEach((r, i) => {
    if (r.kind === 'ticket' && keys.includes(r.x.key)) items.push({ label: `${r.x.key}`, rank: i + 1, why: `${r.x.priority}${r.x.customers?.length ? `, reaches ${r.x.customers.join(', ')}${r.x.arrAtRisk ? ` ($${Math.round(r.x.arrAtRisk / 1000)}k ARR)` : ''}` : ''}` });
    if (r.kind === 'thread' && t.toLowerCase().includes(String(r.x.sender).split(' ')[0].toLowerCase())) items.push({ label: `reply to ${r.x.sender}`, rank: i + 1, why: `${r.x.org ? `${r.x.org}, ` : ''}waiting since ${ago(r.x.at)}${r.x.tickets?.length ? `, tied to ${r.x.tickets.join(', ')}` : ''}` });
    if (r.kind === 'decision' && t.toLowerCase().includes(String(r.x.text).toLowerCase().split(' ').slice(0, 2).join(' '))) items.push({ label: `decide "${r.x.text}"`, rank: i + 1, why: 'waiting on you' });
  });
  if (items.length < 2) return `${(await call('triage')).text}`;
  items.sort((a, b) => a.rank - b.rank);
  const [a, b] = items;
  return `**${a.label[0].toUpperCase() + a.label.slice(1)} first** — it ranks #${a.rank} on what needs you (${a.why}); ${b.label} is #${b.rank}${b.why ? ` (${b.why})` : ''}.\n\nThe ranking weighs priority, the customers and ARR each item reaches through the graph, and how long people have waited. Want me to start on ${a.label}?`;
}

/** "What's our biggest risk?" — rank every high-severity insight and lead with one. */
async function biggestRisks(call: (n: string, a?: any) => Promise<ToolResult>, cards: Card[]) {
  const secs = ((await call('insights')).data || []) as { key: string; title: string; items: { title: string; detail: string; severity: string; ask?: string; uids: string[] }[] }[];
  // what loses money or a launch first, then what loses people or systems
  const order = ['customers', 'blocked', 'absence', 'bus', 'spof', 'waiting', 'stale', 'load'];
  const sev = (x: string) => (x === 'high' ? 0 : x === 'medium' ? 1 : 2);
  const all = secs.filter((s) => order.includes(s.key)).flatMap((s) => s.items.map((i) => ({ ...i, section: s.title, rank: order.indexOf(s.key) })))
    .sort((a, b) => sev(a.severity) - sev(b.severity) || a.rank - b.rank);
  // one item per section so the top three are three different kinds of risk
  const top: typeof all = [];
  for (const i of all) if (!top.some((t) => t.section === i.section) && top.length < 3) top.push(i);
  cards.length = 0;
  if (!top.length) return 'Nothing in the graph looks risky right now.';
  cards.push({ type: 'graph', title: 'Biggest risks', focus: top.flatMap((t) => t.uids).slice(0, 14) });
  const opts = top.filter((t) => t.ask).map((t, i) => ({ key: String.fromCharCode(65 + i), label: t.ask!, value: t.ask! }));
  if (opts.length) cards.push({ type: 'options', question: 'Dig into one?', options: opts });
  const [a, ...rest] = top;
  return `**Your biggest risk: ${a.title}.** ${a.detail}\n\n${rest.length ? `Next:\n${rest.map((t, i) => `${i + 2}. **${t.title}** (${t.section.toLowerCase()}) — ${t.detail}`).join('\n')}\n\n` : ''}Everything else is in **Graph → Insights**.`;
}

/** "Is Brightwave or Kestrel more important?" — the same measure on both, and which way it points. */
async function compareTwo(ctx: Ctx, call: (n: string, a?: any) => Promise<ToolResult>, label: string, two: Ent[]) {
  if (label === 'Org') {
    const all = ((await call('customer_health')).data || []) as any[];
    const [a, b] = two.map((e) => all.find((r) => r.uid === e.uid));
    if (a && b) {
      const top = a.arr * (1 + a.risk / 100) >= b.arr * (1 + b.risk / 100) ? a : b;
      const other = top === a ? b : a;
      return `**${top.name}** — $${Math.round(top.arr / 1000)}k ARR and risk ${top.risk}${top.signals[0] ? ` (${top.signals[0].what})` : ''}, against ${other.name}'s $${Math.round(other.arr / 1000)}k and risk ${other.risk}.${top.next ? ` First move: ${top.next.label.toLowerCase()}.` : ''}`;
    }
  }
  if (label === 'Project') {
    const cps = [];
    for (const e of two) cps.push((await call('critical_path', { project: e.uid })).data as any);
    const [a, b] = cps;
    const n = (c: any) => c?.blockers?.length || 0;
    const worse = n(a) >= n(b) ? a : b;
    return `**${worse.project.name}** needs you more: ${n(worse)} blocker${n(worse) === 1 ? '' : 's'}, the root one ${worse.blockers[0]?.kind === 'decision' ? `a decision waiting on ${worse.blockers[0].waitsOnMe ? 'you' : worse.blockers[0].owner}` : worse.blockers[0]?.key || 'none'}; ${(worse === a ? b : a).project.name} has ${n(worse === a ? b : a)}.`;
  }
  if (label === 'System') {
    const rs = [];
    for (const e of two) rs.push((await call('blast_radius', { ref: e.uid })).data as any);
    const [a, b] = rs;
    const w = (r: any) => (r.dependents?.length || 0) * 10 + (r.arr || 0) / 10_000;
    const top = w(a) >= w(b) ? a : b;
    const other = top === a ? b : a;
    return `**${top.system.name}** matters more: ${top.dependents.length} dependent systems and $${Math.round((top.arr || 0) / 1000)}k ARR ride on it, against ${other.dependents.length} and $${Math.round((other.arr || 0) / 1000)}k for ${other.system.name}.`;
  }
  const parts = [];
  for (const e of two) parts.push((await call('workload', { person: e.uid })).text);
  return parts.join('\n\n');
}

/** A short board / leadership update, every line from the graph. */
async function boardUpdate(ctx: Ctx, call: (n: string, a?: any) => Promise<ToolResult>) {
  const g = ctx.g;
  const cust = await g.q(`MATCH (o:Org {kind:'customer'}) RETURN o.name AS name, coalesce(o.arr, 0) AS arr ORDER BY arr DESC`, {}, 'ARR by customer');
  const health = ((await call('customer_health')).data || []) as any[];
  const projects = await g.q(`MATCH (p:Project) WHERE p.status <> 'planned' RETURN p.uid AS uid, p.name AS name, p.status AS status ORDER BY p.name`, {}, 'projects in flight');
  const lines: string[] = [];
  for (const p of projects) {
    const c = (await call('critical_path', { project: p.uid })).data as any;
    const b = c?.blockers?.[0];
    lines.push(`- **${p.name}** — ${p.status}${b ? `; first in the way: ${b.kind === 'decision' ? `the decision “${b.title}”` : `${b.key} (${b.title})`}` : ''}`);
  }
  const p1 = await g.q(`MATCH (t:Ticket {status:'open', priority:'P1'}) RETURN t.key AS key, t.title AS title`, {}, 'open P1s');
  const decisions = await g.q(`MATCH (d:Decision {status:'pending'}) RETURN d.text AS text`, {}, 'decisions pending');
  const atRisk = health.filter((h) => h.level === 'at risk');
  return `**Board update — draft from the graph**

**Revenue:** $${Math.round(cust.reduce((n, c) => n + c.arr, 0) / 1000)}k ARR across ${cust.length} customers (${cust.map((c) => `${c.name} $${Math.round(c.arr / 1000)}k`).join(', ')}).${atRisk.length ? ` At risk: ${atRisk.map((h) => `${h.name} (${h.signals[0]?.what || 'see health'})`).join('; ')}.` : ''}

**Projects:**
${lines.join('\n')}

**Incidents:** ${p1.length ? p1.map((t) => `${t.key} ${t.title}`).join('; ') : 'no open P1s'}.

**Decisions we owe:** ${decisions.map((d) => d.text).join('; ') || 'none'}.

_Everything above is read from the graph; Show path has the queries. Churn and pipeline numbers aren't in the graph — add them by hand._`;
}

/** "tomorrow at 2pm", "monday 10:30", "today at 4" → a timestamp (local time), or null. */
function parseWhen(low: string): number | null {
  const d = new Date();
  let day: Date | null = null;
  if (/\btoday\b/.test(low)) day = new Date(d);
  else if (/\btomorrow\b/.test(low)) { day = new Date(d); day.setDate(d.getDate() + 1); }
  else {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const i = days.findIndex((x) => new RegExp(`\\b${x}\\b`).test(low));
    if (i >= 0) { day = new Date(d); day.setDate(d.getDate() + ((i - d.getDay() + 7) % 7 || 7)); }
  }
  const tm = low.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (!day && !tm) return null;
  day = day || new Date(d);
  let h = 10, m = 0;
  if (tm) {
    h = Number(tm[1] ?? tm[4]); m = Number(tm[2] ?? tm[5] ?? 0);
    const ap = tm[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h < 8) h += 12; // "at 2" means the afternoon
  }
  day.setHours(h, m, 0, 0);
  return day.getTime();
}

/** An email in the user's own words, with where things stand from the graph — nothing invented. */
async function draftFromWords(ctx: Ctx, call: (n: string, a?: any) => Promise<ToolResult>, person: string, t: string) {
  const g = ctx.g;
  const p = await g.one(`MATCH (p:Person {uid:$u}) OPTIONAL MATCH (p)-[:WORKS_AT]->(o:Org) RETURN p.name AS name, o.uid AS org, o.kind AS kind`, { u: person }, 'who it is to');
  const meName = (await g.one(`MATCH (m:Person {me:true}) RETURN m.name AS n`))?.n || '';
  const first = String(p?.name || '').split(' ')[0];
  // turn the instruction into sentences: "apologizing for X" → "I'm sorry about X." ; "confirm Y" → "I can confirm Y."
  // drop the instruction ("draft an email to Kate"), keep what to say
  const mk = t.match(/\b(apologi\w*|confirm\w*|thank\w*|saying|that|about|to say|telling (?:her|him|them)|explaining|letting (?:her|him|them) know)\b/i);
  const ask = mk ? (/^(apologi|confirm|thank)/i.test(mk[1]) ? t.slice(mk.index!) : t.slice(mk.index! + mk[0].length)).trim() : t;
  const parts = ask.split(/\s*(?:,|\band\b|;)\s*(?=apologi|confirm|let|say|tell|ask|mention|thank)/i).map((x) => x.trim()).filter(Boolean);
  const sentence = (x: string) => {
    let y = x.replace(/^apologi[sz]\w*\s*(for|about)?\s*/i, "I'm sorry about ").replace(/^confirm\w*\s*(that)?\s*/i, 'I can confirm that ').replace(/^thank\w*\s*(them|her|him)?\s*(for)?\s*/i, 'Thank you for ').replace(/^(let|tell) (her|him|them) know (that )?/i, '').replace(/^ask (her|him|them) (to|if|whether)\s*/i, 'Could you ').replace(/\b(she|he|they)'?(?:ll| will)\b/gi, 'you will');
    y = y.replace(/\bthe (customer|client)\b/gi, 'you').trim();
    return y.charAt(0).toUpperCase() + y.slice(1).replace(/[.!]*$/, '.');
  };
  const lines = parts.map(sentence);
  // where things stand, from the graph: their open tickets and who owns them
  const tix = p?.org ? await g.q(`MATCH (t:Ticket {status:'open'})-[:FOR]->(:Org {uid:$o}) OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person) RETURN t.title AS title, a.name AS who`, { o: p.org }, 'their open tickets') : [];
  const stand = tix.length ? `\n\nWhere things stand: ${tix.map((x) => `${x.title.replace(/^.*?:\s*/, '')} — ${x.who?.split(' ')[0] || 'our team'} is on it`).join('; ')}.` : '';
  const thread = await g.one(`MATCH (:Person {uid:$u})<-[:FROM|TO]-(e:Email)-[:IN_THREAD]->(th:Thread) RETURN th.uid AS uid ORDER BY e.at DESC LIMIT 1`, { u: person }, 'the thread to reply on');
  const body = `Hi ${first},\n\n${lines.join(' ')}${stand}\n\nBest,\n${meName}`;
  return (await call('draft_email', { to: person, body, ...(thread?.uid ? { thread: thread.uid } : {}) })).text;
}
