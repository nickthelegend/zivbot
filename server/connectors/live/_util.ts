import type { UserGraph } from '../../graph.ts';
import { loadDictionary, mentionsIn, linkAny, upsertNodes, type NodeIn } from '../../ingest.ts';

/** Helpers shared by the live (API-key) connectors. */

export const DAY_MS = 86_400_000;
export const daysAgo = (n: number) => Date.now() - n * DAY_MS;
export const clip = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
export const ms = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : undefined;
};
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const qs = (o: Record<string, string | number | boolean | undefined | null>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
export const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : String(v ?? '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
export const uniq = <T>(a: T[]) => [...new Set(a)];

/** Run fn over items with bounded concurrency; failures become undefined. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try { out[k] = await fn(items[k]); } catch { out[k] = undefined; }
      }
    }),
  );
  return out;
}

/** Entity linking over free text: (from)-[:MENTIONS]->(any known entity). */
export async function linkMentions(g: UserGraph, label: string, items: { uid: string; text: string; self?: string }[]) {
  if (!items.length) return 0;
  const dict = await loadDictionary(g);
  const edges = items.flatMap((it) => mentionsIn(dict, it.text, it.self).filter((to) => to !== it.uid).map((to) => ({ from: it.uid, to })));
  await linkAny(g, label, 'MENTIONS', edges);
  return edges.length;
}

/**
 * Cross-app identity for organisations: reuse an existing :Org with the same
 * name (case-insensitive) or domain, so Stripe/HubSpot/demo customers merge.
 * Returns external id → org uid; new orgs get `fallback(id)` uids.
 */
export async function resolveOrgs(g: UserGraph, orgs: { id: string; name?: string; domain?: string }[], fallback: (id: string) => string) {
  const out = new Map<string, string>();
  const known = new Set<string>();
  if (!orgs.length) return { uids: out, known };
  const rows = await g.q(
    `UNWIND $orgs AS o
     OPTIONAL MATCH (byName:Org) WHERE o.name IS NOT NULL AND toLower(byName.name) = toLower(o.name)
     OPTIONAL MATCH (byDomain:Org) WHERE o.domain IS NOT NULL AND toLower(byDomain.domain) = toLower(o.domain)
     RETURN o.id AS id, coalesce(byDomain.uid, byName.uid) AS uid`,
    { orgs: orgs.map((o) => ({ id: o.id, name: o.name || null, domain: o.domain || null })) },
    'resolve orgs',
  );
  for (const r of rows) if (r.uid) { out.set(r.id, r.uid); known.add(r.id); }
  for (const o of orgs) if (!out.has(o.id)) out.set(o.id, fallback(o.id));
  return { uids: out, known };
}

/**
 * Upsert :System nodes by uid without clobbering names/props another
 * connector (or the demo workspace) already set: name only on create.
 */
export async function upsertSystems(g: UserGraph, systems: { uid: string; name: string; props: Record<string, unknown>; search: string }[]) {
  if (!systems.length) return;
  const rows = await g.q(`UNWIND $uids AS u MATCH (s:System {uid: u}) RETURN s.uid AS uid`, { uids: systems.map((s) => s.uid) }, 'existing systems');
  const have = new Set(rows.map((r) => r.uid as string));
  const nodes: NodeIn[] = systems.map((s) =>
    have.has(s.uid) ? { uid: s.uid, props: s.props } : { uid: s.uid, props: { name: s.name, key: s.uid.replace(/^system:/, ''), ...s.props }, search: s.search },
  );
  await upsertNodes(g, 'System', nodes);
}

/** Parse "Name <a@b.c>, d@e.f" address lists. */
export function parseAddresses(h: string | undefined): { name?: string; email: string }[] {
  if (!h) return [];
  const out: { name?: string; email: string }[] = [];
  const re = /(?:"([^"]*)"|([^"<,]*?))\s*<([^<>\s]+@[^<>\s]+)>|([^\s,<>"]+@[^\s,<>"]+)/g;
  for (const m of h.matchAll(re)) {
    const email = (m[3] || m[4] || '').trim().toLowerCase();
    if (!email) continue;
    const name = (m[1] ?? m[2] ?? '').trim().replace(/^'|'$/g, '');
    out.push({ email, name: name && !name.includes('@') ? name : undefined });
  }
  return out;
}
