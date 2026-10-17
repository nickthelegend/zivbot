import { userGraph, withTrace, type Trace, type UserGraph } from './graph.ts';
import { publish } from './bus.ts';
import { config, llmEnabled } from './config.ts';
import { chat, type ChatMsg } from './llm.ts';
import { tools, toolByName as builtinTool, type Card, type Ctx } from './tools.ts';
import { connectorTools } from './connectors/index.ts';
import { plan, triageReply } from './planner.ts';
import {
  postMessage, getDot, getConversation, updateDot, listDots, workingContext, recordAnswer, exchangeBetween, history, type Message,
} from './memory.ts';
import { clip } from './util.ts';

/**
 * Dots think here. Every Cypher statement run while a dot works is captured
 * in a trace; the reply is stored as an Episode linked to an Answer node that
 * USED every graph node the turn touched — the path behind the answer.
 *
 * Dots also talk to each other: message_dot opens (or reuses) an exchange
 * conversation between two dots in the graph, the other dot works on it with
 * the same shared memory, and both of your chats get a "Messaged …" chip.
 */

const allTools = () => [...tools, ...connectorTools];
const toolByName = (n: string) => allTools().find((t) => t.name === n) || builtinTool(n);

type Reply = { text: string; cards: Card[]; tools: string[]; mode: string; answer: string };
export type DotInfo = { uid: string; name: string; role: string; stage?: string; conv?: string; avatar?: string; color?: string };

/** Run one dot over one input and return its reply (does not post it). */
export async function think(userId: string, dot: DotInfo, conv: string, text: string, opts: { from?: string; inGroup?: boolean } = {}): Promise<Reply> {
  const g = await userGraph(userId);
  publish(userId, { type: 'thinking', dot: dot.uid, conv, on: true });
  // stream the steps and every node the Cypher touches, so the UI can draw the dot thinking
  const sent = new Set<string>();
  const trace: Trace = {
    queries: [], touched: new Set(),
    onQuery: (q) => {
      if (q.internal) return;
      const fresh = [...trace.touched].filter((u) => !sent.has(u)).slice(0, 40);
      fresh.forEach((u) => sent.add(u));
      publish(userId, { type: 'step', dot: dot.uid, conv, label: q.label, ms: q.ms, rows: q.rows, touched: fresh });
    },
  };
  const ctx: Ctx = { g, userId, dot: dot.uid };
  const delegated: string[] = [];
  let r: Omit<Reply, 'answer'>;
  try {
    r = await withTrace(trace, async () => {
      if (llmEnabled()) {
        try { const x = await llmTurn(ctx, dot, conv, text, opts.from); delegated.push(...x.delegated); return { text: x.text, cards: x.cards, tools: x.tools, mode: `llm:${config.llm.model}` }; }
        catch (e: any) { console.warn('[llm] falling back to planner:', e.message); }
      }
      return { ...(await plan(ctx, text, { dot, from: opts.from, inGroup: opts.inGroup, delegate: async (to, goal) => { const x = await messageDot(userId, dot, to, goal); if (x.answer) delegated.push(x.answer); return x; } })), mode: 'graph-planner' };
    });
  } catch (e: any) {
    console.error('[turn]', e);
    r = { text: `Something went wrong while I was working on that: ${e.message}`, cards: [], tools: [], mode: 'error' };
  }
  const answer = await recordAnswer(g, { question: text, dot: dot.uid, touched: [...trace.touched], queries: trace.queries, tools: r.tools, mode: r.mode });
  if (delegated.length) await g.q(`MATCH (a:Answer {uid:$a}) UNWIND $d AS x MATCH (b:Answer {uid:x}) MERGE (a)-[:DELEGATED_TO]->(b)`, { a: answer, d: delegated }, '~link delegated answers');
  publish(userId, { type: 'thinking', dot: dot.uid, conv, on: false });
  return { ...r, cards: dedupeCards(r.cards), answer };
}

/** A message from you into a conversation (direct chat or group). */
export async function handleUserMessage(userId: string, convUid: string, text: string) {
  const g = await userGraph(userId);
  const conv = await getConversation(g, convUid);
  if (!conv) throw new Error('unknown conversation');
  await postMessage(userId, g, { conv: convUid, role: 'user', text });
  const dots: DotInfo[] = conv.dots.filter((d: any) => d.uid);

  if (conv.kind === 'direct') {
    const dot = { ...dots[0], conv: convUid };
    if (String(dot.stage || '').startsWith('onboard')) return onboarding(userId, g, dot, text);
    const r = await think(userId, dot, convUid, text);
    return postMessage(userId, g, { conv: convUid, role: 'assistant', dot: dot.uid, text: r.text, cards: r.cards, answer: r.answer });
  }

  // Group chat: the dots whose role fits the message answer; others stay quiet.
  const responders = pickResponders(dots, text);
  publish(userId, { type: 'working', conv: convUid, dots: responders.map((d) => d.name) });
  const replies = await Promise.all(responders.map(async (d) => {
    const r = await think(userId, d, convUid, text, { inGroup: responders.length > 1 });
    return postMessage(userId, g, { conv: convUid, role: 'assistant', dot: d.uid, text: r.text, cards: r.cards, answer: r.answer });
  }));
  publish(userId, { type: 'working', conv: convUid, dots: [] });
  return replies[0];
}

const ROLE_HINTS: [RegExp, RegExp][] = [
  [/engineer|code|fix/i, /\b(fix|bug|ticket|deploy|repo|code|test|agent|codex|claude|cursor|opencode|latency|incident|LUM-\d+|system|service)\b/i],
  [/research|brief/i, /\b(who|why|what|how|research|brief|report|explain|compare|history|decid|connected|path|breaks|knows)\b/i],
  [/customer|finance/i, /\b(customer|invoice|reply|email|investor|arr|churn|brightwave|kestrel|northstar|billing|draft)\b/i],
];

function pickResponders(dots: DotInfo[], text: string): DotInfo[] {
  const named = dots.filter((d) => new RegExp(`\\b${d.name}\\b`, 'i').test(text));
  if (named.length) return named.slice(0, 3);
  const fit = dots.filter((d) => ROLE_HINTS.some(([role, msg]) => role.test(d.role) && msg.test(text)));
  if (fit.length) return fit.slice(0, 2);
  const chief = dots.find((d) => /chief/i.test(d.role)) || dots[0];
  return [chief];
}

function dedupeCards(cards: Card[]) {
  const graphs = cards.filter((c) => c.type === 'graph');
  const rest: Card[] = cards.filter((c) => c.type !== 'graph');
  if (graphs.length) {
    const focus = [...new Set(graphs.flatMap((c) => (c as any).focus || []))].slice(0, 40);
    rest.push({ type: 'graph', title: (graphs[0] as any).title, focus });
  }
  return rest;
}

// ------------------------------------------------------------------ dot ↔ dot

/**
 * `from` messages another dot. The exchange is a Conversation of kind
 * 'exchange' with both dots as members; the recipient thinks with the shared
 * graph and replies there. Both direct chats get a chip that opens the
 * exchange. Returns the recipient's reply (text + cards) to the sender.
 */
export async function messageDot(userId: string, from: DotInfo, toName: string, text: string): Promise<{ text: string; cards: Card[]; to?: DotInfo; answer?: string }> {
  const g = await userGraph(userId);
  const to = (await listDots(g)).find((d) => d.name.toLowerCase() === String(toName).toLowerCase().trim()) as DotInfo | undefined;
  if (!to) return { text: `There's no dot called ${toName}.`, cards: [] };
  if (to.uid === from.uid) return { text: 'That is me.', cards: [] };
  const xchg = await exchangeBetween(g, from.uid, to.uid);
  await postMessage(userId, g, { conv: xchg, role: 'agent', dot: from.uid, text });
  const fromInfo = await getDot(g, from.uid);
  await chip(userId, g, fromInfo.conv, xchg, to, 'messaged');
  const r = await think(userId, to, xchg, text, { from: from.name });
  await postMessage(userId, g, { conv: xchg, role: 'agent', dot: to.uid, text: r.text, cards: r.cards, answer: r.answer });
  await chip(userId, g, to.conv!, xchg, from, 'with');
  return { text: r.text, cards: r.cards, to, answer: r.answer };
}

async function chip(userId: string, g: UserGraph, conv: string | undefined, xchg: string, other: DotInfo, verb: 'messaged' | 'with') {
  if (!conv) return;
  const count = (await g.one(`MATCH (:Conversation {uid:$x})<-[:IN]-(e:Episode) RETURN count(e) AS n`, { x: xchg }))?.n || 0;
  await postMessage(userId, g, {
    conv, role: 'system', text: verb === 'messaged' ? `Messaged ${other.name}` : `${count} messages with ${other.name}`,
    cards: [{ type: 'exchange', conv: xchg, with: { uid: other.uid, name: other.name, avatar: other.avatar, color: other.color }, count, verb }],
  });
}

// ------------------------------------------------------------------ LLM loop

const messageDotTool = {
  name: 'message_dot',
  description: 'Message another of my dots and get their reply. Delegate to the specialist: engineering fixes → the engineering dot, research/briefs → the research dot, customer/finance → that dot. They share the same graph memory.',
  params: { type: 'object', properties: { dot: { type: 'string' }, message: { type: 'string' } }, required: ['dot', 'message'] },
};

async function llmTurn(ctx: Ctx, dot: DotInfo, conv: string, text: string, from?: string) {
  const wc = await workingContext(ctx.g, conv, text);
  const others = (await listDots(ctx.g)).filter((d) => d.uid !== dot.uid).map((d) => `${d.name} (${d.role})`);
  const sys = `You are ${dot.name}, a personal agent ("dot") in ZivBot. Your role: ${dot.role}.
You run on your own computer. Everything you know lives in the user's FalkorDB knowledge graph: their apps (mail, calendar, Slack, Notion, Linear, GitHub…), their company (people, teams, customers, systems), their coding-agent subscriptions (Codex, Claude Code, Cursor, OpenCode, Grok, Antigravity), and your memory.
Rules:
- Ground every claim in tool results. Prefer the specific graph tools; use run_cypher only when none fits; use find_tools/use_tool for connected apps.
- Act, don't just answer: when something can be fixed, drafted, scheduled or decided, call the tool that creates the approval card. Nothing is sent or run without approval.
- Delegate to a specialist dot with message_dot when the work is theirs.
- Be brief and warm. Short markdown: bold names, numbered lists for rankings. Never invent people, numbers or tickets.
${from ? `This message is from your colleague dot ${from}, not the user. Do the work and reply to them concisely.` : ''}
Other dots: ${others.join('; ') || 'none'}.
Memories that apply:\n${wc.memories.map((m) => `- (${m.kind}) ${m.text}`).join('\n') || '- none'}
Earlier conversations on these topics:\n${wc.earlier.map((e) => `- ${e.dot || 'you'}/${e.role}: ${clip(e.text, 160)}`).join('\n') || '- none'}
Now: ${new Date().toString()}`;
  const msgs: ChatMsg[] = [
    { role: 'system', content: sys },
    ...wc.recent.slice(-8, -1).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: clip(m.text, 1200) }) as ChatMsg),
    { role: 'user', content: text },
  ];
  const defs = [...allTools().map((t) => ({ name: t.name, description: t.description, params: t.params })), messageDotTool];
  const cards: Card[] = [];
  const used: string[] = [];
  const delegatedLlm: string[] = [];
  for (let step = 0; step < 7; step++) {
    const m = await chat(msgs, defs);
    if (!m.tool_calls?.length) return { text: m.content || '…', cards, tools: used, delegated: delegatedLlm };
    msgs.push({ role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls });
    for (const call of m.tool_calls) {
      let args: any = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* bad args */ }
      used.push(call.function.name);
      publish(ctx.userId, { type: 'tool', dot: ctx.dot, conv, name: call.function.name, args });
      let out: string;
      try {
        if (call.function.name === 'message_dot') {
          const r = await messageDot(ctx.userId, dot, args.dot, args.message);
          if (r.answer) delegatedLlm.push(r.answer);
          cards.push(...r.cards.filter((c) => c.type === 'draft' || c.type === 'file' || c.type === 'run'));
          out = `${args.dot} replied: ${r.text}`;
        } else {
          const tool = toolByName(call.function.name);
          if (!tool) throw new Error(`no tool ${call.function.name}`);
          const r = await tool.run(ctx, args);
          cards.push(...(r.cards || []));
          out = r.text;
        }
      } catch (e: any) { out = `error: ${e.message}`; }
      msgs.push({ role: 'tool', tool_call_id: call.id, content: clip(out, 4000) });
    }
  }
  return { text: 'I ran out of steps — here is what I found so far.', cards, tools: used, delegated: delegatedLlm };
}

// ------------------------------------------------------------------ onboarding (GrokBot-style)

const ABOUT_ME = () => `A little about me:
- I keep everything in a **FalkorDB graph** — your own graph, separate from everyone else's. People, customers, systems, tickets, decisions and my memory are nodes and edges, so I answer by following how they connect.
- I connect to your apps (mail, calendar, Slack, Notion, Linear, GitHub) and to your AI subscriptions (Codex, Claude Code, Cursor, OpenCode).
- Under every answer, **Show path** has the exact Cypher I ran. I only act after you approve.${config.hosted ? '\n- This is the web demo: it runs on a synthetic company, and coding agents run in the desktop app on your own machine.' : ''}`;

export async function startOnboarding(userId: string, dot: DotInfo) {
  const g = await userGraph(userId);
  await updateDot(g, dot.uid, { stage: 'onboard:user' });
  const say = (text: string) => postMessage(userId, g, { conv: dot.conv!, role: 'assistant', dot: dot.uid, text });
  await say("Hey! I'm your new dot.");
  await say("Message me anytime. I'll keep things moving even when we're not talking, and check in with updates or questions.");
  await say('First things first — what should I call you?');
}

async function onboarding(userId: string, g: UserGraph, dot: DotInfo, text: string) {
  const say = (t: string, cards?: Card[]) => postMessage(userId, g, { conv: dot.conv!, role: 'assistant', text: t, cards, dot: dot.uid });
  if (dot.stage === 'onboard:user') {
    const name = text.replace(/^(hi|hey|hello)[,!.\s]*/i, '').replace(/^(i'?m|i am|my name is|call me|it'?s)\s+/i, '').replace(/[.!]+$/, '').trim().split(/\s+/).slice(0, 3).join(' ') || 'friend';
    const pretty = name.replace(/\b\w/g, (c) => c.toUpperCase());
    await g.q(`MERGE (p:Profile {uid:'profile'}) SET p.name = $n`, { n: pretty }, 'save profile');
    await g.q(`MATCH (p:Person {me:true}) SET p.name = $n, p.first = $f`, { n: pretty, f: pretty.split(' ')[0] }, 'rename me');
    await updateDot(g, dot.uid, { stage: 'onboard:dot' });
    publish(userId, { type: 'profile' });
    return say(`Nice to meet you, ${pretty.split(' ')[0]}! What would you like to call me? You can always change this.`, [
      { type: 'options', options: [{ key: 'A', label: 'Ziv', value: 'Ziv' }, { key: 'B', label: 'Jojo', value: 'Jojo' }, { key: 'C', label: 'Nova', value: 'Nova' }] },
    ]);
  }
  if (dot.stage === 'onboard:dot') {
    const raw = text.replace(/^(call you|let'?s go with|how about|you'?re)\s+/i, '').replace(/[.!"']+/g, '').trim().split(/\s+/)[0].slice(0, 20) || dot.name;
    const pretty = raw[0].toUpperCase() + raw.slice(1);
    await updateDot(g, dot.uid, { name: pretty, stage: 'onboard:connect' });
    publish(userId, { type: 'dots' });
    await say(`${pretty} it is! Nice to meet you.`, [{ type: 'customize' }]);
    await postMessage(userId, g, { conv: dot.conv!, role: 'system', text: `Renamed to ${pretty}` });
    await say(ABOUT_ME());
    return say("Connect your workspace and I'll find something I can take care of right away. Nothing gets sent without your approval. Or tell me what you need help with.", [{ type: 'connectors' }]);
  }
  // still waiting for a connection: answer anyway if we can, else nudge
  const connected = (await g.one(`MATCH (c:Connector {status:'connected'}) RETURN count(c) AS n`))?.n;
  if (!connected) return say('Connect at least one app first so I have a graph to work from — the demo workspace takes a few seconds.', [{ type: 'connectors' }]);
  await updateDot(g, dot.uid, { stage: 'ready' });
  const r = await think(userId, { ...dot, stage: 'ready' }, dot.conv!, text);
  return postMessage(userId, g, { conv: dot.conv!, role: 'assistant', dot: dot.uid, text: r.text, cards: r.cards, answer: r.answer });
}

/** Called by the connectors API after a connection lands. */
export async function afterConnect(userId: string, counts: Record<string, unknown>) {
  const g = await userGraph(userId);
  const dots = await listDots(g);
  const waiting = dots.find((d) => d.stage === 'onboard:connect');
  if (!waiting) return;
  await updateDot(g, waiting.uid, { stage: 'ready' });
  const summary = Object.entries(counts).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${v} ${k}`).join(', ');
  const say = (t: string, cards?: Card[]) => postMessage(userId, g, { conv: waiting.conv, role: 'assistant', text: t, cards, dot: waiting.uid });
  await say(`You're connected, and I've mapped it all into my graph: ${summary}.\n\nHere's some of what I can do now:\n- Triage what needs you, ranked by who and what it touches\n- Fix tickets by handing them to the best coding agent on your subscriptions\n- Draft replies and record decisions, then loop in everyone affected\n- Show the exact path behind every answer`);
  await say("Want me to find a few things I can help with? I'll just read your graph for ideas. Nothing gets sent, deleted, or changed.", [
    { type: 'options', options: [{ key: 'A', label: 'Suggest a first task', value: 'Suggest a first task' }, { key: 'B', label: 'Something else', value: 'What can you do?' }] },
  ]);
}

/** Proactive check-in posted by the background loop. */
export async function proactiveTriage(userId: string, dot: DotInfo) {
  const g = await userGraph(userId);
  const trace: Trace = { queries: [], touched: new Set() };
  const cards: Card[] = [];
  const ctx: Ctx = { g, userId, dot: dot.uid };
  const text = await withTrace(trace, () => triageReply(ctx, async (n, a) => { const r = await toolByName(n)!.run(ctx, a || {}); cards.push(...(r.cards || [])); return r; }, cards));
  const answer = await recordAnswer(g, { question: '(background scan)', dot: dot.uid, touched: [...trace.touched], queries: trace.queries, tools: ['triage'], mode: 'proactive' });
  return postMessage(userId, g, { conv: dot.conv!, role: 'assistant', text, cards: dedupeCards(cards), answer, dot: dot.uid, proactive: true });
}

export { history };
export type { Message };
