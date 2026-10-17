import type { UserGraph } from './graph.ts';

/**
 * Batched MERGE helpers used by every connector. Nodes are keyed by `uid`;
 * every ingested entity also gets :Searchable + a `search` text so the single
 * full-text index can find it.
 */
export type NodeIn = { uid: string; props: Record<string, unknown>; search?: string };
export type EdgeIn = { from: string; to: string; props?: Record<string, unknown> };

export async function upsertNodes(g: UserGraph, label: string, nodes: NodeIn[], searchable = true) {
  if (!nodes.length) return;
  const rows = nodes.map((n) => ({ uid: n.uid, props: clean(n.props), search: n.search ?? '' }));
  for (const chunk of chunks(rows, 200)) {
    await g.q(
      `UNWIND $rows AS r
       MERGE (n:${label} {uid: r.uid})
       SET n += r.props, n.firstSeen = coalesce(n.firstSeen, timestamp()), n.lastSeen = timestamp() ${searchable ? ", n:Searchable, n.search = CASE WHEN r.search = '' THEN coalesce(n.search, '') ELSE r.search END" : ''}`,
      { rows: chunk },
      `${['Draft','Episode','Answer','Conversation','Dot'].includes(label) ? '~' : ''}ingest ${label}`,
    );
  }
}

export async function link(g: UserGraph, fromLabel: string, rel: string, toLabel: string, edges: EdgeIn[]) {
  if (!edges.length) return;
  const rows = edges.map((e) => ({ from: e.from, to: e.to, props: clean(e.props || {}) }));
  for (const chunk of chunks(rows, 300)) {
    await g.q(
      `UNWIND $rows AS r
       MATCH (a:${fromLabel} {uid: r.from}), (b:${toLabel} {uid: r.to})
       MERGE (a)-[e:${rel}]->(b)
       SET e += r.props`,
      { rows: chunk },
      `${['BY','MEMBER_OF','PROPOSES','FOR_TICKET','TO','REPLIES_TO','INVITES','ANSWERED_WITH'].includes(rel) ? '~' : ''}link ${rel}`,
    );
  }
}

/** Link by uid when the target label varies (mentions, ABOUT edges). */
export async function linkAny(g: UserGraph, fromLabel: string, rel: string, edges: EdgeIn[]) {
  if (!edges.length) return;
  for (const chunk of chunks(edges.map((e) => ({ from: e.from, to: e.to })), 300)) {
    await g.q(
      `UNWIND $rows AS r
       MATCH (a:${fromLabel} {uid: r.from}), (b:Searchable {uid: r.to})
       MERGE (a)-[:${rel}]->(b)`,
      { rows: chunk },
      `${['MENTIONS','USES_TOOL','FOR_TICKET','TO','REPLIES_TO','INVITES'].includes(rel) ? '~' : ''}link ${rel}`,
    );
  }
}

/**
 * Entity linking: find names/aliases of known entities inside free text.
 * The dictionary is read back from the graph, so anything any connector
 * ingested becomes linkable for every other connector.
 */
export type Dictionary = { term: string; uid: string; re: RegExp }[];

export async function loadDictionary(g: UserGraph): Promise<Dictionary> {
  const rows = await g.q(
    `MATCH (n:Searchable)
     WHERE n:Person OR n:Project OR n:System OR n:Org OR n:Ticket OR n:Team
     RETURN n.uid AS uid, n.name AS name, n.key AS key, n.aliases AS aliases, n.first AS first, labels(n)[0] AS label`,
    {},
    '~load entity dictionary',
  );
  const dict: Dictionary = [];
  const add = (term: string | undefined, uid: string) => {
    if (!term || term.length < 3) return;
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    dict.push({ term, uid, re: new RegExp(`(^|[^\\w-])${esc}(?![\\w-])`, 'i') });
  };
  for (const r of rows) {
    add(r.name, r.uid);
    if (r.label === 'Ticket') add(r.key, r.uid);
    if (r.first) add(r.first, r.uid);
    for (const a of (r.aliases as string[] | null) || []) add(a, r.uid);
  }
  // Longer terms first so "payments-api" wins over "payments".
  return dict.sort((a, b) => b.term.length - a.term.length);
}

export function mentionsIn(dict: Dictionary, text: string, self?: string): string[] {
  const found = new Set<string>();
  for (const d of dict) if (d.uid !== self && d.re.test(text)) found.add(d.uid);
  return [...found];
}

/**
 * Cross-app identity: the same human shows up in Gmail, Slack, Linear and
 * GitHub. Match an existing :Person by email (then by exact name) before
 * creating one, so every app's records hang off the same node.
 * Returns external id → person uid.
 */
export type PersonIn = { id: string; name?: string; email?: string; source: string; role?: string; login?: string; avatar?: string; external?: boolean };

export async function upsertPeople(g: UserGraph, people: PersonIn[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Map(people.filter((p) => p.id).map((p) => [p.id, p])).values()];
  if (!uniq.length) return out;
  const existing = await g.q(
    `UNWIND $people AS p
     OPTIONAL MATCH (byEmail:Person) WHERE p.email IS NOT NULL AND toLower(byEmail.email) = toLower(p.email)
     OPTIONAL MATCH (byName:Person) WHERE p.name IS NOT NULL AND toLower(byName.name) = toLower(p.name)
     RETURN p.id AS id, coalesce(byEmail.uid, byName.uid) AS uid`,
    { people: uniq.map((p) => ({ id: p.id, email: p.email ?? null, name: p.name ?? null })) },
    'cross-app identity resolution',
  );
  const found = new Map(existing.filter((r) => r.uid).map((r) => [r.id, r.uid as string]));
  const fresh: NodeIn[] = [];
  for (const p of uniq) {
    const u = found.get(p.id) || (p.email ? `person:${p.email.toLowerCase()}` : `person:${p.source}-${p.id}`.toLowerCase());
    out.set(p.id, u);
    fresh.push({
      uid: u,
      props: found.has(p.id)
        ? { [`${p.source}Id`]: p.id, ...(p.avatar ? { avatar: p.avatar } : {}) }
        : { name: p.name || p.email || p.login || p.id, email: p.email, role: p.role, login: p.login, avatar: p.avatar, external: p.external, source: p.source, [`${p.source}Id`]: p.id },
      search: found.has(p.id) ? '' : `${p.name || ''} ${p.email || ''} ${p.login || ''}`,
    });
  }
  await upsertNodes(g, 'Person', fresh);
  return out;
}

function clean(p: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) o[k] = v;
  return o;
}

function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
