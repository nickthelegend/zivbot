// Customer health from the graph: every signal a customer leaves across apps,
// joined through the systems they run on. One score per customer, with the
// reasons, and the next action that would move it.
import type { UserGraph } from './graph.ts';
import { DAY, HOUR } from './util.ts';

export type Signal = { what: string; points: number; uids: string[] };
export type CustomerHealth = {
  uid: string; name: string; arr: number; tier?: string;
  risk: number; level: 'at risk' | 'watch' | 'healthy';
  signals: Signal[];
  next?: { label: string; ask: string };
  contacts: number; lastContact?: number;
};

const ESCALATION = /\b(escalat\w*|cancel\w*|churn|frustrat\w*|unacceptable|still (?:have not|haven't|not)|takes forever|otherwise|deadline|by friday|lawyer|refund)\b/i;

export async function customerHealth(g: UserGraph): Promise<CustomerHealth[]> {
  const now = Date.now();
  const orgs = await g.q(`MATCH (o:Org {kind:'customer'}) RETURN o.uid AS uid, o.name AS name, coalesce(o.arr, 0) AS arr, o.tier AS tier`, {}, 'customers');
  const out: CustomerHealth[] = [];
  for (const o of orgs) {
    const signals: Signal[] = [];

    const own = await g.q(
      `MATCH (t:Ticket {status:'open'})-[:FOR]->(:Org {uid:$o}) RETURN t.uid AS uid, t.key AS key, t.priority AS priority, t.at AS at`,
      { o: o.uid },
      `${o.name}: their open tickets`,
    );
    for (const t of own) {
      const age = Math.round((now - t.at) / DAY);
      signals.push({ what: `${t.key} ${t.priority} open ${age}d`, points: (t.priority === 'P1' ? 20 : t.priority === 'P2' ? 12 : 5) + Math.min(10, Math.floor(age / 7) * 3), uids: [t.uid] });
    }

    // Incidents they feel without having filed them: open P1/P2 on what they use, or what that depends on.
    const felt = await g.q(
      `MATCH (:Org {uid:$o})-[:USES]->(s:System)-[:DEPENDS_ON*0..3]->(d:System)<-[:AFFECTS]-(t:Ticket {status:'open'})
       WHERE t.priority IN ['P1', 'P2'] AND NOT (t)-[:FOR]->(:Org {uid:$o})
       RETURN t.uid AS uid, t.key AS key, t.priority AS priority, collect(DISTINCT s.name)[0] AS via`,
      { o: o.uid },
      `${o.name}: incidents on systems they use (DEPENDS_ON 0-3 hops)`,
    );
    for (const t of felt) signals.push({ what: `${t.key} ${t.priority} hits ${t.via}`, points: t.priority === 'P1' ? 10 : 5, uids: [t.uid] });

    const threads = await g.q(
      `MATCH (:Org {uid:$o})<-[:WORKS_AT]-(p:Person)<-[:FROM]-(e:Email)-[:IN_THREAD]->(th:Thread)
       WITH th, p, count(e) AS sent, max(e.at) AS last
       MATCH (th)<-[:IN_THREAD]-(latest:Email) WHERE latest.at = last
       RETURN th.uid AS uid, th.subject AS subject, coalesce(th.awaitingReply, false) AS waiting, sent, last, p.name AS who, latest.body AS body`,
      { o: o.uid },
      `${o.name}: their threads and the latest word`,
    );
    for (const th of threads) {
      if (th.waiting) {
        const h = Math.round((now - th.last) / HOUR);
        signals.push({ what: `${th.who} waiting ${h < 48 ? `${h}h` : `${Math.round(h / 24)}d`} on "${th.subject}"`, points: 10 + Math.min(10, Math.floor(h / 24) * 2), uids: [th.uid] });
        if (th.sent >= 3) signals.push({ what: `${th.who} has written ${th.sent} times`, points: 8, uids: [th.uid] });
      }
      if (ESCALATION.test(th.body || '') && th.waiting) signals.push({ what: `escalation language: "${(th.body.match(ESCALATION) || [''])[0]}"`, points: 12, uids: [th.uid] });
    }

    const reach = await g.one(
      `MATCH (o:Org {uid:$o})
       OPTIONAL MATCH (o)<-[:WORKS_AT]-(:Person)-[:COLLABORATES|ATTENDS]-()<-[:COLLABORATES|ATTENDS]-(us:Person) WHERE NOT coalesce(us.external, false)
       WITH o, collect(DISTINCT us.uid) AS a
       OPTIONAL MATCH (o)<-[:FOR]-(:Ticket)-[:ASSIGNED_TO]->(t:Person)
       WITH o, a, collect(DISTINCT t.uid) AS b
       OPTIONAL MATCH (o)<-[:ABOUT]-(:Event)<-[:ATTENDS]-(m:Person) WHERE NOT coalesce(m.external, false)
       WITH o, a, b, collect(DISTINCT m.uid) AS c
       OPTIONAL MATCH (o)<-[:WORKS_AT]-(:Person)-[:FROM|TO]-(e:Email)
       RETURN a + b + c AS people, max(e.at) AS last`,
      { o: o.uid },
      `${o.name}: how many of us they are connected to`,
    );
    const contacts = new Set((reach?.people || []).filter(Boolean)).size;
    if (contacts <= 1) signals.push({ what: contacts ? 'one person on our side holds the relationship' : 'nobody on our side is connected', points: 6, uids: [] });
    const lastContact = reach?.last ?? undefined;
    if (lastContact && now - lastContact > 30 * DAY) signals.push({ what: `no contact for ${Math.round((now - lastContact) / DAY)}d`, points: 6, uids: [] });

    const meeting = await g.one(
      `MATCH (e:Event)-[:ABOUT]->(:Org {uid:$o}) WHERE e.start > $now RETURN e.uid AS uid, coalesce(e.title, e.name) AS title, e.start AS start ORDER BY e.start LIMIT 1`,
      { o: o.uid, now },
      `${o.name}: next meeting`,
    );

    // Bigger accounts weigh more; an imminent meeting makes open issues urgent.
    const raw = signals.reduce((n, s) => n + s.points, 0);
    const soon = meeting && meeting.start - now < 3 * DAY && raw > 0;
    if (soon) signals.push({ what: `${meeting.title} in ${Math.max(1, Math.round((meeting.start - now) / HOUR))}h with this open`, points: 10, uids: [meeting.uid] });
    const weight = o.arr >= 150_000 ? 1.25 : o.arr >= 50_000 ? 1 : 0.8;
    // saturating, so a pile of signals approaches 100 without pinning everyone there
    const risk = Math.round(100 * (1 - Math.exp(-signals.reduce((n, s) => n + s.points, 0) * weight / 60)));
    const level = risk >= 50 ? 'at risk' : risk >= 20 ? 'watch' : 'healthy';

    const waiting = threads.find((t) => t.waiting);
    const p1 = [...own, ...felt].find((t) => t.priority === 'P1');
    const next = waiting ? { label: `Reply to ${waiting.who}`, ask: `Draft a reply to ${waiting.who}` }
      : soon ? { label: `Prep ${meeting.title}`, ask: `Prep me for ${meeting.title}` }
      : p1 ? { label: `Fix ${p1.key}`, ask: `Fix ${p1.key}` }
      : own[0] ? { label: `Who should take ${own[0].key}?`, ask: `Who should take ${own[0].key}?` } : undefined;

    out.push({ uid: o.uid, name: o.name, arr: o.arr, tier: o.tier ?? undefined, risk, level, signals: signals.sort((a, b) => b.points - a.points), next, contacts, lastContact });
  }
  return out.sort((a, b) => b.risk - a.risk || b.arr - a.arr);
}
