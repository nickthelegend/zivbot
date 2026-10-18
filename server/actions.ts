import { config } from './config.ts';
import type { UserGraph } from './graph.ts';
import { upsertNodes, link } from './ingest.ts';
import { dispatchRun, type AgentKind } from './fleet.ts';
import { callMcpTool } from './connectors/mcp.ts';
import { runConnectorAction } from './connectors/index.ts';
import { mergePeople } from './identity.ts';
import { enrich } from './analytics.ts';
import { publish } from './bus.ts';
import { postMessage, getDot } from './memory.ts';
import { uid, when } from './util.ts';

/**
 * Approvals: a Ziv never sends, books, runs or calls anything on its own —
 * it creates a :Draft, and this is what happens when you approve it. Each
 * approved action is written back into the graph, so the next answer sees it.
 */
export async function approveDraft(userId: string, g: UserGraph, draftUid: string, edits: { body?: string; agent?: string } = {}) {
  const d = await g.one(`MATCH (d:Draft {uid:$u}) OPTIONAL MATCH (d)-[:BY]->(dot:Dot) RETURN d, dot.uid AS dot`, { u: draftUid }, 'load draft');
  if (!d) throw new Error('draft not found');
  if (d.d.status !== 'pending') return { status: d.d.status };
  const payload = JSON.parse(d.d.payload || '{}');
  const dot = d.dot as string;
  const conv = dot ? (await getDot(g, dot))?.conv : null;
  let result = '';

  if (d.d.kind === 'email') {
    const body = edits.body ?? payload.body;
    const e = uid('email');
    await upsertNodes(g, 'Email', [{ uid: e, props: { name: payload.subject, subject: payload.subject, body, at: Date.now(), sentBy: 'zivbot', source: 'gmail' }, search: `${payload.subject} ${body}` }]);
    await g.q(`MATCH (e:Email {uid:$e}), (me:Person {me:true}) MERGE (e)-[:FROM]->(me)`, { e }, 'sent email from me');
    await link(g, 'Email', 'TO', 'Person', [{ from: e, to: payload.to }]);
    if (payload.thread) {
      await link(g, 'Email', 'IN_THREAD', 'Thread', [{ from: e, to: payload.thread }]);
      await g.q(`MATCH (t:Thread {uid:$t}) SET t.awaitingReply = false, t.lastAt = $now`, { t: payload.thread, now: Date.now() }, 'thread answered');
    }
    await link(g, 'Draft', 'BECAME', 'Email', [{ from: draftUid, to: e }]);
    result = `Sent "${payload.subject}".`;
  } else if (d.d.kind === 'event') {
    const e = uid('event');
    await upsertNodes(g, 'Event', [{ uid: e, props: { name: payload.title, title: payload.title, start: payload.start, end: payload.start + payload.minutes * 60_000, source: 'gcal', createdBy: 'zivbot' }, search: payload.title }]);
    await g.q(`MATCH (e:Event {uid:$e}), (me:Person {me:true}) MERGE (me)-[:ATTENDS]->(e)`, { e }, 'I attend');
    await link(g, 'Person', 'ATTENDS', 'Event', payload.attendees.map((p: string) => ({ from: p, to: e })));
    await link(g, 'Draft', 'BECAME', 'Event', [{ from: draftUid, to: e }]);
    result = `Booked ${payload.title} for ${when(payload.start)}.`;
  } else if (d.d.kind === 'run' && config.hosted) {
    // Coding agents run on the user's own subscriptions, on the user's own machine.
    result = `Queued "${payload.goal}" for the desktop app — coding agents run on your machine, not on the web demo.`;
    if (conv) await postMessage(userId, g, { conv, role: 'assistant', dot, text: `This is the web demo, so I can't start ${edits.agent || payload.kind} here — your coding agents run on your own machine with your own subscriptions. Open ZivBot desktop and approve **${payload.goal}** there.` });
  } else if (d.d.kind === 'run') {
    const kind = (edits.agent || payload.kind) as AgentKind;
    const run = await dispatchRun(userId, g, { ...payload, kind, dot, answer: undefined });
    await link(g, 'Draft', 'BECAME', 'Run', [{ from: draftUid, to: run }]);
    result = `Started ${kind} on "${payload.goal}".`;
    if (conv) await postMessage(userId, g, { conv, role: 'assistant', dot, text: `On it — **${payload.goal}** is running with ${kind}. I'll report back when the tests finish.`, cards: [{ type: 'run', runUid: run }] });
  } else if (d.d.kind === 'merge') {
    const r = await mergePeople(g, payload.keep, payload.dup);
    await enrich(g);
    result = `Merged ${r.merged} into ${r.kept} (${r.moved} relationship types moved).`;
    if (conv) await postMessage(userId, g, { conv, role: 'system', text: `Merged ${r.merged} into ${r.kept}` });
  } else if (d.d.kind === 'reassign') {
    await g.q(
      `MATCH (t:Ticket {uid:$t}) OPTIONAL MATCH (t)-[old:ASSIGNED_TO]->() DELETE old
       WITH DISTINCT t MATCH (p:Person {uid:$to}) MERGE (t)-[:ASSIGNED_TO {at: $now, by: 'zivbot'}]->(p)
       WITH t, p OPTIONAL MATCH (f:Person {uid:$from}) FOREACH (_ IN CASE WHEN f IS NULL THEN [] ELSE [1] END | MERGE (t)-[:PREVIOUSLY_ASSIGNED_TO]->(f))`,
      { t: payload.ticket, to: payload.to, from: payload.from ?? '', now: Date.now() },
      'move the ticket to its new owner',
    );
    result = `${payload.key} now belongs to ${d.d.to}.`;
    if (conv) await postMessage(userId, g, { conv, role: 'system', text: `Reassigned ${payload.key} to ${d.d.to}` });
  } else if (d.d.kind === 'mcp') {
    const out = payload.mcp === false ? await runConnectorAction(userId, g, payload.server, payload.tool, payload.args) : await callMcpTool(g, payload.server, payload.tool, payload.args);
    result = `Called ${payload.tool}: ${out.slice(0, 300)}`;
    if (conv) await postMessage(userId, g, { conv, role: 'assistant', dot, text: `Done — ${payload.server} › ${payload.tool} returned:\n\n${out.slice(0, 1500)}` });
  }
  await g.q(`MATCH (d:Draft {uid:$u}), (me:Person {me:true}) SET d.status = 'done', d.approvedAt = $now, d.result = $r MERGE (d)-[:APPROVED_BY]->(me)`, { u: draftUid, now: Date.now(), r: result }, 'mark approved');
  publish(userId, { type: 'draft', uid: draftUid, status: 'done', result });
  return { status: 'done', result };
}

export async function rejectDraft(userId: string, g: UserGraph, draftUid: string) {
  await g.q(`MATCH (d:Draft {uid:$u}) SET d.status = 'rejected'`, { u: draftUid }, 'reject draft');
  publish(userId, { type: 'draft', uid: draftUid, status: 'rejected' });
  return { status: 'rejected' };
}
