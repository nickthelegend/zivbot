import { userGraph } from './graph.ts';
import { config } from './config.ts';
import { allUsers } from './users.ts';
import { listDots, postMessage, getDot } from './memory.ts';
import { proactiveTriage } from './agent.ts';
import { runHooks } from './fleet.ts';
import { toolByName } from './tools.ts';
import { clip } from './util.ts';

/**
 * "I keep working while you're away." On a timer, each user's chief dot
 * re-runs triage over the graph and only speaks up when what needs you has
 * changed (a :Notice node remembers the last fingerprint). Finished coding
 * runs report back into the chat of the dot that asked for them.
 */
export function startProactive() {
  if (config.proactiveMs > 0) {
    setInterval(() => void scanAll().catch((e) => console.error('[proactive]', e.message)), config.proactiveMs).unref();
  }
  runHooks.push(async (userId, g, r) => {
    if (!r.dot) return;
    const dot = await getDot(g, r.dot);
    if (!dot?.conv) return;
    const ok = r.status === 'succeeded';
    const files = r.diff.split('\n').filter((l) => l.includes('|')).map((l) => l.split('|')[0].trim());
    const followUp = ok ? await g.one(
      `UNWIND $t AS k MATCH (t:Ticket {uid:k})-[:FOR]->(o:Org)<-[:WORKS_AT]-(p:Person)<-[:FROM]-(e:Email)
       RETURN p.name AS name ORDER BY e.at DESC LIMIT 1`,
      { t: r.tickets },
      'who is waiting on this fix',
    ) : null;
    await postMessage(userId, g, {
      conv: dot.conv, role: 'assistant', dot: r.dot,
      text: ok
        ? `**${r.agent}** finished **${r.goal}**. Tests: ${r.tests}. ${files.length ? `Changed ${files.join(', ')}` : 'No files changed'} on branch \`${r.branch}\`.\n\nI marked the ticket${r.tickets.length > 1 ? 's' : ''} fix-ready in the graph.${followUp ? ` ${followUp.name} is waiting on this — want me to draft the update?` : ''}`
        : `**${r.agent}** couldn't finish **${r.goal}** (tests: ${r.tests}). Last output:\n\n\`\`\`\n${clip(r.log.trim().split('\n').slice(-8).join('\n'), 700)}\n\`\`\`\nWant me to try another agent?`,
      cards: [{ type: 'run', runUid: r.uid }, ...(followUp ? [{ type: 'options' as const, options: [{ key: 'A', label: `Draft the update to ${followUp.name.split(' ')[0]}`, value: `Draft a reply to ${followUp.name}` }] }] : [])],
    });
  });
}

export async function scanAll() {
  for (const userId of await allUsers()) await scanUser(userId).catch((e) => console.error('[proactive]', userId, e.message));
}

export async function scanUser(userId: string, force = false) {
  const g = await userGraph(userId);
  const connected = (await g.one(`MATCH (c:Connector {status:'connected'}) RETURN count(c) AS n`))?.n;
  if (!connected) return;
  const chief = (await listDots(g)).find((d) => d.stage === 'ready');
  if (!chief) return;
  const r = await toolByName('triage')!.run({ g, userId, dot: chief.uid }, {});
  const data = r.data as any;
  const fp = [...data.incidents.map((i: any) => i.uid), ...data.threads.slice(0, 3).map((t: any) => t.uid), ...data.decisions.map((d: any) => d.uid)].join('|');
  const last = await g.one(`MATCH (n:Notice {uid:'notice:triage'}) RETURN n.fp AS fp`);
  if (!force && last?.fp === fp) return;
  await g.q(`MERGE (n:Notice {uid:'notice:triage'}) SET n.fp = $fp, n.at = $now`, { fp, now: Date.now() }, 'remember what I told you');
  if (!fp) return;
  await proactiveTriage(userId, { uid: chief.uid, name: chief.name, role: chief.role, conv: chief.conv });
}
