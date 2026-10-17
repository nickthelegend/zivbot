import type { UserGraph, Row } from './graph.ts';
import { loadDictionary, mentionsIn } from './ingest.ts';
import { toolByName, search, type Card, type Ctx, type ToolResult } from './tools.ts';
import { ago } from './util.ts';
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

export type PlanResult = { text: string; cards: Card[]; tools: string[] };

export type PlanOpts = {
  dot?: { uid: string; name: string; role: string };
  from?: string;
  /** answering inside a group chat alongside other dots: no delegation, stick to your role */
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
  const done = (text: string): PlanResult => ({ text, cards, tools: used });
  const ents = await entities(ctx.g, t);
  const first = (...labels: string[]) => ents.find((e) => labels.includes(e.label));
  const dots = await ctx.g.q(`MATCH (d:Dot) WHERE d.uid <> $me RETURN d.name AS name, d.role AS role`, { me: ctx.dot }, '~other dots');
  const specialist = (re: RegExp) => (opts.from || opts.inGroup || !opts.delegate || (opts.dot && re.test(opts.dot.role)) ? null : dots.find((d) => re.test(d.role)));
  const delegateTo = async (name: string, goal: string, intro?: string) => {
    used.push('message_dot');
    const r = await opts.delegate!(name, goal);
    cards.push(...r.cards.filter((c) => c.type !== 'options'));
    return done(`${intro ?? `I asked **${name}** to take this.`} ${name} got back to me:\n\n${r.text}`);
  };

  // ---- @mentions: "@Forge fix LUM-142", "@Hacker News graph databases"
  if (t.includes('@')) {
    const allDots = await ctx.g.q(`MATCH (d:Dot) RETURN d.uid AS uid, d.name AS name`, {}, '~dots for @mentions');
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
      return done(`**${mp.name}** is ${status?.status || 'available'}. It gives your dots: ${(mp.actions || []).map((a) => `\`${a.name}\`${a.mutates ? ' (asks first)' : ''}`).join(', ') || 'its data in the graph'}.${mp.description ? `\n\n${mp.description}` : ''}`);
    }
  }

  // ---- talk to another dot: "ask Forge to …", "tell Scout …"
  const direct = t.match(/^(?:please\s+)?(?:ask|tell|have|get|message|ping|loop in)\s+(\w+)\s*(?:to|that|:|,)?\s*(.*)$/i);
  if (direct && opts.delegate && !opts.from) {
    const target = dots.find((d) => d.name.toLowerCase() === direct[1].toLowerCase());
    if (target) return delegateTo(target.name, direct[2] || t, `Sure — I messaged **${target.name}**.`);
  }

  if (/^(what can you do|help|what do you do)\??$/i.test(t)) {
    return done(`Here's what I can do with your graph:\n- **Triage** — "what needs me?" ranks mail, incidents, decisions and calendar clashes by who and what they touch\n- **Act** — "fix LUM-142" picks the best coding agent from your subscriptions and runs it once you approve\n- **Trace** — "why did we move to Stripe?", "who knows billing-db?", "what breaks if auth-service goes down?"\n- **Coordinate** — "ask Forge to …" sends work to another dot; they share my memory\n- **Remember** — "remember that Kate prefers calls" — every dot uses it\n\nTap the path icon under any answer to see the Cypher and the nodes behind it.`);
  }

  // ---- memory writes
  if (/^(remember|note( that)?|from now on|always|never|i prefer|prefer|keep in mind)\b/i.test(t)) {
    const r = await call('remember', { text: t.replace(/^(remember( that)?|note( that)?|keep in mind( that)?)[:,]?\s*/i, '') });
    return done(`Got it. ${r.text}`);
  }

  // ---- decisions waiting on me: "confirm Oct 28", "go with the shim"
  const pending = await ctx.g.q(`MATCH (d:Decision {status:'pending'}) RETURN d.uid AS uid, d.text AS text, d.options AS options`, {}, '~pending decisions');
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
  if (/\b(decide|decision)\b/.test(low) && !/\bwhy\b|\bwho\b|trace/.test(low)) {
    const target = pending.find((d) => d.text.toLowerCase().split(/\W+/).some((w: string) => w.length > 4 && low.includes(w))) || pending[0];
    if (target) {
      cards.push({ type: 'options', question: target.text, options: (target.options as string[]).map((o, i) => ({ key: String.fromCharCode(65 + i), label: o, value: `Decide: ${o}` })) });
      const tr = await call('decision_trace', { topic: target.uid });
      const im = await call('decision_impact', { decision: target.uid });
      return done(`Here's what I know about **${target.text}**:\n${tr.text}\n\n${im.text}\n\nWhich way do you want to go? I'll record it and draft the follow-ups.`);
    }
  }

  // ---- act: fix tickets with the coding-agent fleet
  const engineer = !opts.dot || /engineer/i.test(opts.dot.role);
  const isWatch = /^(watch|alert me|tell me|let me know|notify me|ping me|warn me|whenever)\b/.test(low);
  if (!isWatch && /\b(fix|patch|repair|resolve|ship a fix|hand .* to|dispatch)\b/.test(low) && (!opts.inGroup || engineer)) {
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

  // ---- customer health: "which customers are at risk?", "how are our customers doing?"
  if (/\b(customers?|accounts?|clients?)\b.*\b(at risk|risk|health|healthy|churn|happy|unhappy|doing|okay|ok)\b|\b(churn risk|account health|customer health)\b/.test(low) && !first('Org')) {
    return done((await call('customer_health')).text);
  }

  // ---- critical path: "what's blocking the EU launch?", "why is OTA 2.4 stuck?"
  if (/\b(block(ed|ing|ers?)?|stuck|holding .* (up|back)|critical path|unblock|what stands between|when can we (ship|launch))\b/.test(low)) {
    const x = first('Project');
    if (x) return done((await call('critical_path', { project: x.uid })).text);
  }

  // ---- absence simulation: "what if Priya is out next week?", "who covers for Raj?"
  if (/\b(leaves?|leaving|quits?|is out|are out|be out|off sick|on leave|on vacation|on holiday|parental leave|goes away|gets sick|hit by a bus|covers? for|cover for|without)\b/.test(low)) {
    const who = first('Person');
    if (who) return done((await call('what_if_absent', { person: who.uid })).text);
  }

  if (/\b(reassign|rebalance|who should (take|own|handle|pick up)|hand .* to someone|move .* to someone)\b/.test(low)) {
    const key = t.match(/\b([A-Z]{2,6}-\d+)\b/i)?.[1]?.toUpperCase();
    const tk = key ? `ticket:${key}` : first('Ticket')?.uid;
    if (tk) return done((await call('propose_reassign', { ticket: tk })).text);
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

  if (/\b(why did we|why are we|who decided|decid|decision)/.test(low)) {
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

  if (/\b(risks?|risky|insights?|single points? of failure|bus factor|overloaded|stretched|what changed|since yesterday|health ?check|anything (worrying|i should worry))\b/.test(low)) {
    const focus = /bus factor|knows it/.test(low) ? 'bus' : /single point|spof/.test(low) ? 'spof' : /overload|stretched/.test(low) ? 'load' : /what changed|since yesterday/.test(low) ? 'changed' : undefined;
    return done(`Here's what the graph says you should worry about:\n\n${(await call('insights', { focus })).text}`);
  }

  if (/(important|key|central|influential) (people|person|contacts)|who matters|brokers?\b/.test(low)) {
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

  if (/\b(calendar|agenda|meetings?|my day|my week|tomorrow|today)\b/.test(low) && !/\b(reply|email|draft|needs? me|what should|plate|priorit|urgent|attention|triage|important)\b/.test(low)) {
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

  // ---- counts across the graph: "which project has the most open tickets?"
  const most = low.match(/\b(?:which|what|who)\b.*?\b(projects?|systems?|services?|customers?|clients?|accounts?|people|person|teams?|who)\b.*\b(?:most|fewest|biggest|largest)\b\s*(.*)$/);
  if (most) {
    const [, noun, rest] = most;
    const label = /project/.test(noun) ? 'Project' : /system|service/.test(noun) ? 'System' : /customer|client|account/.test(noun) ? 'Org' : /team/.test(noun) ? 'Team' : 'Person';
    const metric = /depend/.test(rest) ? 'dependents' : /customer|client|arr|revenue/.test(rest) ? 'customers' : /people|members|staff|engineers/.test(rest) ? 'people' : /ticket|issue|incident|bug|work|load/.test(rest) ? 'open_tickets' : null;
    if (metric) return done((await call('rank_entities', { label, metric })).text);
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

  // fuzzy, "anything about…" questions go to semantic memory + graph expansion
  if (/^(anything|has anyone|did anyone|what('s| is| has) (the team|everyone|anyone) (said|saying)|any (mention|talk|news))|\b(similar to|related to|reminds)\b/.test(low) || (!ents.length && t.split(/\s+/).length > 3)) {
    const r = await call('semantic_search', { query: t });
    if ((r.data as any)?.hits?.length) return done(r.text);
    return done(fallback(cards));
  }

  // "tell me about X", "who is X", or a bare entity name
  const x = ents[0];
  if (x) return done((await call('describe_entity', { ref: x.uid })).text);
  const hits = await search(ctx.g, t, undefined, 6);
  used.push('search_graph');
  if (hits.length) {
    if (hits[0].score > 1.5 * (hits[1]?.score || 0)) return done((await call('describe_entity', { ref: hits[0].uid })).text);
    return done(`Here's what I found in your graph:\n${hits.map((h: Row) => `- ${h.label} **${h.name}**`).join('\n')}\n\nAsk me about any of them.`);
  }
  return done(fallback(cards));
}

/** Nothing matched: say so plainly and offer questions the graph can answer. */
function fallback(cards: Card[]) {
  cards.push({
    type: 'options', question: 'Try one of these',
    options: [
      { key: 'A', label: 'What needs me today?', value: 'What needs me today?' },
      { key: 'B', label: "What's blocking the EU launch?", value: "What's blocking the EU launch?" },
      { key: 'C', label: 'Which customers are at risk?', value: 'Which customers are at risk?' },
      { key: 'D', label: 'What breaks if payments-api goes down?', value: 'What breaks if payments-api goes down?' },
      { key: 'E', label: 'What if Hana is out next week?', value: 'What if Hana is out next week?' },
    ],
  });
  return `I don't have anything in your graph that answers that, and I'd rather say so than guess. I answer by walking how people, systems, customers, tickets and decisions connect — for example:`;
}

export async function triageReply(ctx: Ctx, call: (n: string, a?: any) => Promise<ToolResult>, cards: Card[]) {
  const r = await call('triage');
  const d = r.data as any;
  const opts: { key: string; label: string; value: string }[] = [];
  // Only offer fixes the fleet can actually do: tickets on a system whose repo is on this computer.
  const fixable = await ctx.g.q(
    `MATCH (t:Ticket {status:'open'})-[:AFFECTS]->(:System)<-[:IMPLEMENTS]-(r:Repo) WHERE r.path IS NOT NULL
     OPTIONAL MATCH (t)-[:FOR]->(o:Org)
     RETURN DISTINCT t.key AS key, t.priority AS p, coalesce(o.arr, 0) AS arr ORDER BY p, arr DESC LIMIT 2`,
    {},
    'tickets my coding agents can fix (repo on this computer)',
  );
  const tick = fixable.map((i: any) => i.key);
  if (tick.length) opts.push({ key: '', label: `Fix ${tick.join(' + ')} with my coding agents`, value: `Fix ${tick.join(' and ')}` });
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
  let body = `Hi ${first},\n\nThanks for the note — I'm on it and will get back to you shortly.\n\nBest,\n${meName}`;
  if (p?.kind === 'customer') {
    const tix = await g.q(
      `MATCH (t:Ticket)-[:FOR]->(:Org {uid:$o}) WHERE t.status <> 'resolved'
       OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person) OPTIONAL MATCH (r:Run {status:'succeeded'})-[:RESOLVES]->(t)
       OPTIONAL MATCH (e:Event)-[:ABOUT]->(:Org {uid:$o}) WHERE e.start > $now
       RETURN t.key AS key, t.title AS title, t.status AS status, a.name AS assignee, count(r) AS fixed, min(e.start) AS next`,
      { o: p.org, now: Date.now() },
      'their open tickets and fixes',
    );
    const fixed = tix.filter((t) => t.fixed > 0 || t.status === 'fix ready');
    const open = tix.filter((t) => !(t.fixed > 0 || t.status === 'fix ready'));
    const lines = [
      ...fixed.map((t) => `- ${t.title.replace(/^.*?:\s*/, '')}: fixed — the change is in review and ships with tomorrow's deploy.`),
      ...open.map((t) => `- ${t.title.replace(/^.*?:\s*/, '')}: ${t.assignee?.split(' ')[0] || 'our team'} is on it today.`),
    ];
    const next = tix.find((t) => t.next)?.next;
    body = `Hi ${first},\n\nSorry this has dragged on — here's where things stand:\n${lines.join('\n')}\n\nYou'll have the corrected invoice before Friday${next ? `, and we can walk through it at our QBR ${ago(next).replace('in ', 'in ')}` : ''}.\n\nBest,\n${meName}`;
  }
  return call('draft_email', { to: person, body });
}
