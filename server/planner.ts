import type { UserGraph, Row } from './graph.ts';
import { loadDictionary, mentionsIn } from './ingest.ts';
import { toolByName, search, type Card, type Ctx, type ToolResult } from './tools.ts';
import { ago, when } from './util.ts';
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
  let remembered = '';
  const done = (text: string): PlanResult => ({ text: remembered ? `${remembered}\n\n${text}` : text, cards, tools: used });
  const ents = await entities(ctx.g, t);
  const first = (...labels: string[]) => ents.find((e) => labels.includes(e.label));
  // what you told me comes first: a question about someone or something I hold a memory on gets it back
  if (ents.length && !/^(remember|note( that)?|from now on|always|never|i prefer|prefer|keep in mind)\b/i.test(t)) {
    const mem = await ctx.g.q(
      `MATCH (m)-[:ABOUT]->(x) WHERE (m:Fact OR m:Procedure) AND m.status = 'active' AND x.uid IN $u RETURN m.text AS text, m.at AS at ORDER BY m.at DESC LIMIT 5`,
      { u: ents.map((e) => e.uid) },
      'what you told me about them',
    );
    const words = new Set(low.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3).map((w) => w.replace(/(ing|ed|s)$/, '')));
    const hit = mem.filter((m) => String(m.text).toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.length > 3 && words.has(w.replace(/(ing|ed|s)$/, '')) && !ents.some((e) => e.uid.toLowerCase().includes(w))));
    if (hit.length) { used.push('recall'); remembered = `**You told me** (${ago(hit[0].at)}): “${hit[0].text}”${hit.length > 1 ? ` — and ${hit.length - 1} more note${hit.length > 2 ? 's' : ''} about this.` : ''}`; }
  }
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
  if (/\bwhen (is|are|will|does|do)\b|\b(date|deadline|due|eta|ship date|launch date)\b/.test(low) && first('Project')) {
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
    if (x.label === 'Person') return done((await call('workload', { person: x.uid })).text);
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
    if ((r.data as any)?.hits?.length) return done(r.text);
    // nothing close by meaning: tell the story of what they named, or try the words themselves
    if (ents[0]) return done((await call('timeline', { ref: ents[0].uid })).text);
    // only things with names worth opening, only real matches, and only for short asks —
    // a long sentence that matched nothing by meaning is not rescued by one shared word
    const content = t.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 3 && !/^(anything|about|what|which|does|have|there|their|this|that|with|from|when|where|tell|show|please|could|would|should)$/.test(w));
    const words = content.length > 2 ? [] : (await search(ctx.g, t.replace(/\b(anything|about|the|a|an|is|are|what|who|any|has|have|on|of|for|did|do|does|our|we|my|last|this|week|plan)\b/gi, ' '), ['Doc', 'Ticket', 'Project', 'System', 'Decision', 'Org', 'Person', 'Team'], 6)).filter((h: Row) => h.score >= 1);
    used.push('search_graph');
    if (words.length) {
      cards.push({ type: 'options', question: 'Ask about one of these', options: words.slice(0, 4).map((h: Row, i: number) => ({ key: String.fromCharCode(65 + i), label: `${h.label}: ${String(h.name).slice(0, 48)}`, value: `Tell me about ${h.name}` })) });
      return done(`Nothing matches that closely, but these mention the same words:\n${words.map((h: Row) => `- ${h.label} **${h.name}**`).join('\n')}`);
    }
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
