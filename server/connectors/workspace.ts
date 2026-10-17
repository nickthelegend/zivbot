import type { UserGraph } from '../graph.ts';
import { upsertNodes, link, linkAny, loadDictionary, mentionsIn } from '../ingest.ts';
import * as L from '../seed/lumen.ts';

/**
 * Demo-workspace connectors. Each one ingests its slice of the synthetic
 * Lumen Labs workspace exactly the way a live connector would ingest the
 * real app: nodes for the records, edges for who/what they relate to, and
 * MENTIONS edges from entity linking over the text.
 */

const P = (k: string) => `person:${k}`;
const keyToUid = (k: string): string => {
  if (/^LUM-\d+$/.test(k)) return `ticket:${k}`;
  if (L.people.some((p) => p.key === k) || k === 'me') return P(k);
  if (L.projects.some((p) => p.key === k)) return `project:${k}`;
  if (L.systems.some((s) => s.key === k)) return `system:${k}`;
  if (L.orgs.some((o) => o.key === k)) return `org:${k}`;
  return k;
};

export async function ingestDirectory(g: UserGraph, me: { name: string; email?: string }) {
  await upsertNodes(g, 'Org', [
    { uid: 'org:lumen', props: { name: 'Lumen Labs', kind: 'self', aliases: ['Lumen'], source: 'google' }, search: 'Lumen Labs our company' },
    ...L.orgs.map((o) => ({ uid: `org:${o.key}`, props: { name: o.name, kind: o.kind, arr: o.arr, tier: o.tier, aliases: [o.name.split(' ')[0]], source: 'google' }, search: `${o.name} ${o.kind}` })),
  ]);
  await upsertNodes(g, 'Team', L.teams.map((t) => ({ uid: `team:${t.key}`, props: { name: t.name, source: 'google' }, search: `${t.name} team` })));
  await upsertNodes(g, 'Person', [
    { uid: P('me'), props: { name: me.name, first: me.name.split(' ')[0], email: me.email || `me@${L.DOMAIN}`, role: 'Founder & CEO', me: true, source: 'google' }, search: `${me.name} me myself founder` },
    ...L.people.map((p) => ({
      uid: P(p.key),
      props: { name: p.name, first: p.org || p.role === 'Newsletter' || p.role === 'Vendor' ? undefined : p.name.split(' ')[0], email: p.email, role: p.role, external: !!p.org || !p.email.endsWith(L.DOMAIN), source: 'google' },
      search: `${p.name} ${p.role} ${p.email}`,
    })),
  ]);
  await link(g, 'Person', 'MEMBER_OF', 'Team', [{ from: P('me'), to: 'team:leadership' }, ...L.people.filter((p) => p.team).map((p) => ({ from: P(p.key), to: `team:${p.team}` }))]);
  await link(g, 'Person', 'WORKS_AT', 'Org', [
    { from: P('me'), to: 'org:lumen' },
    ...L.people.map((p) => ({ from: P(p.key), to: p.org ? `org:${p.org}` : p.email.endsWith(L.DOMAIN) ? 'org:lumen' : '' })).filter((e) => e.to),
  ]);
  await upsertNodes(g, 'System', L.systems.map((s) => ({ uid: `system:${s.key}`, props: { name: s.name, key: s.key, tier: s.tier, aliases: s.aliases, source: 'google' }, search: `${s.name} ${s.aliases.join(' ')} service system` })));
  await link(g, 'System', 'DEPENDS_ON', 'System', L.deps.map(([a, b]) => ({ from: `system:${a}`, to: `system:${b}` })));
  await link(g, 'Org', 'USES', 'System', L.customersUse.map(([o, s]) => ({ from: `org:${o}`, to: `system:${s}` })));
  await upsertNodes(g, 'Project', L.projects.map((p) => ({ uid: `project:${p.key}`, props: { name: p.name, key: p.key, status: p.status, aliases: p.aliases, source: 'google' }, search: `${p.name} ${p.aliases.join(' ')} project` })));
  await link(g, 'Person', 'OWNS', 'Project', L.projects.map((p) => ({ from: P(p.owner), to: `project:${p.key}` })));
  await link(g, 'Person', 'WORKS_ON', 'Project', L.projects.flatMap((p) => p.members.map((m) => ({ from: P(m), to: `project:${p.key}` }))));
  await link(g, 'Project', 'USES', 'System', L.projects.flatMap((p) => p.uses.map((s) => ({ from: `project:${p.key}`, to: `system:${s}` }))));
  await link(g, 'Project', 'BLOCKED_BY', 'Project', L.projects.flatMap((p) => (p.blockedBy || []).map((b) => ({ from: `project:${p.key}`, to: `project:${b}` }))));
  await link(g, 'Person', 'WORKS_WITH', 'Org', [{ from: P('maya'), to: 'org:lumen' }]);
  return { people: L.people.length + 1, teams: L.teams.length, orgs: L.orgs.length + 1, projects: L.projects.length, systems: L.systems.length };
}

export async function ingestTickets(g: UserGraph) {
  const now = Date.now();
  await upsertNodes(g, 'Ticket', L.tickets.map((t) => ({
    uid: `ticket:${t.key}`,
    props: { key: t.key, name: `${t.key} ${t.title}`, title: t.title, priority: t.priority, status: t.status, body: t.body, at: now + t.at, resolvedAt: t.resolvedAt ? now + t.resolvedAt : undefined, source: 'linear' },
    search: `${t.key} ${t.title} ${t.body}`,
  })));
  await link(g, 'Ticket', 'ASSIGNED_TO', 'Person', L.tickets.map((t) => ({ from: `ticket:${t.key}`, to: P(t.assignee) })));
  await link(g, 'Ticket', 'REPORTED_BY', 'Person', L.tickets.map((t) => ({ from: `ticket:${t.key}`, to: P(t.reporter) })));
  await link(g, 'Ticket', 'AFFECTS', 'System', L.tickets.flatMap((t) => t.affects.map((s) => ({ from: `ticket:${t.key}`, to: `system:${s}` }))));
  await link(g, 'Ticket', 'FOR', 'Org', L.tickets.filter((t) => t.customer).map((t) => ({ from: `ticket:${t.key}`, to: `org:${t.customer}` })));
  await link(g, 'Ticket', 'PART_OF', 'Project', L.tickets.filter((t) => t.project).map((t) => ({ from: `ticket:${t.key}`, to: `project:${t.project}` })));
  return { tickets: L.tickets.length };
}

export async function ingestMail(g: UserGraph) {
  const now = Date.now();
  const dict = await loadDictionary(g);
  const threads = [...new Set(L.mail.map((m) => m.thread))];
  await upsertNodes(g, 'Thread', threads.map((t) => {
    const msgs = L.mail.filter((m) => m.thread === t);
    const last = msgs[msgs.length - 1];
    return {
      uid: `thread:${t}`,
      props: {
        name: msgs[0].subject,
        subject: msgs[0].subject,
        lastAt: now + last.at,
        count: msgs.length,
        // waiting on me = the last message is from someone else and not a newsletter
        awaitingReply: last.from !== 'me' && !(last.labels || []).includes('newsletter'),
        newsletter: (last.labels || []).includes('newsletter'),
        source: 'gmail',
      },
      search: msgs.map((m) => `${m.subject} ${m.body}`).join(' '),
    };
  }));
  const emails = L.mail.map((m, i) => ({ ...m, uid: `email:${m.thread}:${i}` }));
  await upsertNodes(g, 'Email', emails.map((m) => ({
    uid: m.uid,
    props: { name: m.subject, subject: m.subject, body: m.body, at: now + m.at, important: (m.labels || []).includes('important'), newsletter: (m.labels || []).includes('newsletter'), source: 'gmail' },
    search: `${m.subject} ${m.body}`,
  })));
  await link(g, 'Email', 'IN_THREAD', 'Thread', emails.map((m) => ({ from: m.uid, to: `thread:${m.thread}` })));
  await link(g, 'Email', 'FROM', 'Person', emails.map((m) => ({ from: m.uid, to: P(m.from) })));
  await link(g, 'Email', 'TO', 'Person', emails.flatMap((m) => m.to.map((t) => ({ from: m.uid, to: P(t) }))));
  const mentions = emails.flatMap((m) => {
    const keys = new Set([...(m.mentions || []).map(keyToUid), ...mentionsIn(dict, `${m.subject} ${m.body}`)]);
    keys.delete(P(m.from));
    return [...keys].map((to) => ({ from: m.uid, to }));
  });
  await linkAny(g, 'Email', 'MENTIONS', mentions);
  // Emails that ask me to decide something become pending :Decision nodes.
  const asks = emails.filter((m) => m.asks);
  await upsertNodes(g, 'Decision', asks.map((m) => ({ uid: `decision:${m.asks!.key}`, props: { name: m.asks!.text, text: m.asks!.text, options: m.asks!.options, status: 'pending', at: now + m.at }, search: `decision pending ${m.asks!.text}` })));
  await link(g, 'Decision', 'AWAITS', 'Person', asks.map((m) => ({ from: `decision:${m.asks!.key}`, to: P('me') })));
  await link(g, 'Decision', 'RAISED_BY', 'Person', asks.map((m) => ({ from: `decision:${m.asks!.key}`, to: P(m.from) })));
  await linkAny(g, 'Decision', 'SOURCE', asks.map((m) => ({ from: `decision:${m.asks!.key}`, to: m.uid })));
  await linkAny(g, 'Decision', 'ABOUT', asks.flatMap((m) => (m.mentions || []).filter((k) => !L.people.some((p) => p.key === k)).map((k) => ({ from: `decision:${m.asks!.key}`, to: keyToUid(k) }))));
  return { threads: threads.length, emails: emails.length, pendingDecisions: asks.length };
}

export async function ingestCalendar(g: UserGraph) {
  const evs = L.events();
  await upsertNodes(g, 'Event', evs.map((e) => ({
    uid: `event:${e.key}`,
    props: { name: e.title, title: e.title, start: e.start, end: e.start + e.mins * 60_000, source: 'gcal' },
    search: `${e.title} meeting`,
  })));
  await link(g, 'Person', 'ATTENDS', 'Event', evs.flatMap((e) => e.attendees.map((a) => ({ from: P(a), to: `event:${e.key}` }))));
  await linkAny(g, 'Event', 'ABOUT', evs.flatMap((e) => (e.about || []).map((a) => ({ from: `event:${e.key}`, to: keyToUid(a) }))));
  return { events: evs.length };
}

export async function ingestSlack(g: UserGraph) {
  const now = Date.now();
  const dict = await loadDictionary(g);
  await upsertNodes(g, 'Channel', L.channels.map((c) => ({ uid: `channel:${c}`, props: { name: `#${c}`, source: 'slack' }, search: `#${c} ${c} channel` })));
  const msgs = L.chat.map((m, i) => ({ ...m, uid: `msg:${m.channel}:${i}` }));
  await upsertNodes(g, 'ChatMessage', msgs.map((m) => ({ uid: m.uid, props: { name: m.text.slice(0, 80), text: m.text, at: now + m.at, source: 'slack' }, search: m.text })));
  await link(g, 'Person', 'POSTED', 'ChatMessage', msgs.map((m) => ({ from: P(m.from), to: m.uid })));
  await link(g, 'ChatMessage', 'IN', 'Channel', msgs.map((m) => ({ from: m.uid, to: `channel:${m.channel}` })));
  await linkAny(g, 'ChatMessage', 'MENTIONS', msgs.flatMap((m) => mentionsIn(dict, m.text, P(m.from)).map((to) => ({ from: m.uid, to }))));
  const decisions = msgs.filter((m) => m.decision).map((m) => ({ ...m.decision!, by: m.from, source: m.uid, at: now + m.at }));
  await ingestDecisions(g, decisions);
  return { channels: L.channels.length, messages: msgs.length, decisions: decisions.length };
}

export async function ingestNotion(g: UserGraph) {
  const now = Date.now();
  const dict = await loadDictionary(g);
  await upsertNodes(g, 'Doc', L.docs.map((d) => ({ uid: `doc:${d.key}`, props: { name: d.title, title: d.title, body: d.body, at: now + d.at, source: 'notion' }, search: `${d.title} ${d.body}` })));
  await link(g, 'Person', 'OWNS', 'Doc', L.docs.map((d) => ({ from: P(d.owner), to: `doc:${d.key}` })));
  await linkAny(g, 'Doc', 'ABOUT', L.docs.flatMap((d) => d.about.map((a) => ({ from: `doc:${d.key}`, to: keyToUid(a) }))));
  await linkAny(g, 'Doc', 'MENTIONS', L.docs.flatMap((d) => mentionsIn(dict, d.body).map((to) => ({ from: `doc:${d.key}`, to }))));
  const decisions = L.docs.filter((d) => d.decision).map((d) => ({ ...d.decision!, by: d.owner, source: `doc:${d.key}`, at: now + d.at }));
  await ingestDecisions(g, decisions);
  // RFC-012 is the written source for the Stripe decision announced in #eng.
  await g.q(`MATCH (d:Decision {uid:'decision:d-stripe'}), (doc:Doc {uid:'doc:rfc-012'}) MERGE (d)-[:SOURCE]->(doc)`, {}, 'link decision source');
  return { docs: L.docs.length, decisions: decisions.length };
}

async function ingestDecisions(g: UserGraph, ds: { key: string; text: string; about: string[]; by: string; source: string; at: number; approvedBy?: string }[]) {
  if (!ds.length) return;
  await upsertNodes(g, 'Decision', ds.map((d) => ({ uid: `decision:${d.key}`, props: { name: d.text, text: d.text, at: d.at, status: 'made' }, search: `decision ${d.text}` })));
  await link(g, 'Decision', 'DECIDED_BY', 'Person', ds.map((d) => ({ from: `decision:${d.key}`, to: P(d.by) })));
  await link(g, 'Decision', 'APPROVED_BY', 'Person', ds.filter((d) => d.approvedBy).map((d) => ({ from: `decision:${d.key}`, to: P(d.approvedBy!) })));
  await linkAny(g, 'Decision', 'SOURCE', ds.map((d) => ({ from: `decision:${d.key}`, to: d.source })));
  await linkAny(g, 'Decision', 'ABOUT', ds.flatMap((d) => d.about.map((a) => ({ from: `decision:${d.key}`, to: keyToUid(a) }))));
}
