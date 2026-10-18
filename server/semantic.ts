import { createHash } from 'node:crypto';
import type { UserGraph } from './graph.ts';

/**
 * Semantic memory on FalkorDB's vector index.
 *
 * Text-bearing nodes (mail, chat, docs, tickets, decisions, memories, episodes)
 * get the :Memorable label and an `emb` vector, all under ONE vector index.
 * A query is answered GraphRAG-style: vector search finds the closest records,
 * then the graph says what they are about (people, systems, customers, tickets).
 *
 * Embeddings are computed locally by default (feature hashing over words and
 * bigrams: no model, no network, deterministic), or by any OpenAI-compatible
 * /embeddings endpoint when ZIV_EMBED_BASE_URL + ZIV_EMBED_API_KEY are set.
 */

export const EMBED_LABELS = ['Doc', 'Email', 'ChatMessage', 'Ticket', 'Decision', 'Fact', 'Procedure', 'Episode', 'Thread'];
const DIM_LOCAL = 384;
const remote = () => (process.env.ZIV_EMBED_BASE_URL && process.env.ZIV_EMBED_API_KEY ? { url: process.env.ZIV_EMBED_BASE_URL.replace(/\/$/, ''), key: process.env.ZIV_EMBED_API_KEY, model: process.env.ZIV_EMBED_MODEL || 'text-embedding-3-small' } : null);

const STOP = new Set('a an the and or of to in on for with at by from is are was were be been it this that these those i you we they he she our your their my me us them as not no do does did can could should would will just so if then than there here about into over under up out what who when where why how which'.split(' '));
const norm = (w: string) => w.replace(/(ing|ed|es|s)$/, (m) => (w.length > 5 ? '' : m));

// A small concept layer so the local embedder bridges everyday wording and
// the words teams actually write ("slow portal" ≈ "latency on checkout-web").
const CONCEPTS: [RegExp, string][] = [
  [/^(slow|slowly|sluggish|lag|laggy|latency|p95|forever|timeout|times?|hang)$/, '#slow'],
  [/^(broken|bug|fail|fails|error|errors|crash|crashes|down|outage|incident|broke|loop)$/, '#broken'],
  [/^(invoice|invoices|invoic|billing|bill|charge|payment|payments|stripe|chargebee)$/, '#billing'],
  [/^(login|log|sso|auth|signin|saml|password)$/, '#auth'],
  [/^(portal|checkout|website|site|page|dashboard)$/, '#web'],
  [/^(customer|customers|client|clients|account|accounts|brightwave|kestrel)$/, '#customer'],
  [/^(launch|ship|release|rollout|go-live|golive|cutover)$/, '#launch'],
  [/^(money|revenue|arr|price|pricing|cost|deal)$/, '#money'],
  [/^(angry|upset|escalate|escalation|frustrated|chasing|chase|follow|waiting)$/, '#unhappy'],
  [/^(phone|mobile|android|ios|app|push|notification|notifications)$/, '#mobile'],
  [/^(firmware|ota|device|devices|hardware|bootloader|helios)$/, '#device'],
  [/^(eu|europe|vat|gdpr)$/, '#eu'],
];
const concept = (w: string) => CONCEPTS.find(([re]) => re.test(w))?.[1];

const contentWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/[\s-]+/).filter((w) => w.length > 1 && !STOP.has(w) && !ASK.has(w));
// question scaffolding: not what the question is about
const ASK = new Set('anything anyone everyone someone team said saying say tell know think worried worry happening going mention mentioned talk talked news update updates latest recent recently lately'.split(' '));

function tokens(text: string) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/[\s-]+/).filter((w) => w.length > 1 && !STOP.has(w));
  const concepts = words.map(concept).filter((c): c is string => !!c);
  const stems = words.map(norm);
  const grams = stems.slice(0, -1).map((w, i) => `${w}_${stems[i + 1]}`);
  return [...stems, ...grams, ...concepts];
}

function hashEmbed(text: string): number[] {
  const v = new Float32Array(DIM_LOCAL);
  const counts = new Map<string, number>();
  for (const t of tokens(text)) counts.set(t, (counts.get(t) || 0) + 1);
  for (const [t, c] of counts) {
    const h = createHash('md5').update(t).digest();
    const idx = h.readUInt32LE(0) % DIM_LOCAL;
    const sign = h[4] & 1 ? 1 : -1;
    const w = (1 + Math.log(c)) * (t.includes('_') ? 0.6 : t.startsWith('#') ? 0.8 : 1);
    v[idx] += sign * w;
    // a second hash spreads each feature, which makes collisions cheaper
    const idx2 = h.readUInt32LE(8) % DIM_LOCAL;
    v[idx2] += (h[12] & 1 ? 1 : -1) * w * 0.5;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => +(x / n).toFixed(5));
}

export async function embed(texts: string[]): Promise<number[][]> {
  const r = remote();
  if (!r) return texts.map(hashEmbed);
  const res = await fetch(`${r.url}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r.key}` },
    body: JSON.stringify({ model: r.model, input: texts.map((t) => t.slice(0, 6000)) }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j: any = await res.json();
  return j.data.map((d: any) => d.embedding);
}

const indexed = new Map<string, number>();
async function ensureIndex(g: UserGraph, dim: number) {
  if (indexed.get(g.name) === dim) return;
  await g.q(`CREATE VECTOR INDEX FOR (n:Memorable) ON (n.emb) OPTIONS {dimension: ${dim}, similarityFunction: 'cosine'}`, {}, '~vector index').catch((e) => {
    if (!/already|exists/i.test(e.message)) throw e;
  });
  indexed.set(g.name, dim);
}

/** Embed every text-bearing node that has no vector yet. Safe to call often. */
export async function embedPending(g: UserGraph, limit = 400) {
  const rows = await g.q(
    `MATCH (n:Searchable) WHERE n.emb IS NULL AND any(l IN labels(n) WHERE l IN $labels)
     RETURN n.uid AS uid, coalesce(n.search, n.text, n.name) AS text LIMIT $limit`,
    { labels: EMBED_LABELS, limit },
    '~nodes waiting for a vector',
  );
  const todo = rows.filter((r) => r.text && String(r.text).trim().length > 3);
  if (!todo.length) return 0;
  const vecs = await embed(todo.map((r) => String(r.text)));
  await ensureIndex(g, vecs[0].length);
  for (let i = 0; i < todo.length; i += 100) {
    await g.q(
      `UNWIND $rows AS r MATCH (n {uid: r.uid}) SET n:Memorable, n.emb = vecf32(r.v)`,
      { rows: todo.slice(i, i + 100).map((r, j) => ({ uid: r.uid, v: vecs[i + j] })) },
      '~store vectors',
    );
  }
  return todo.length;
}

/** Debounced background embedding after new messages / syncs. */
const timers = new Map<string, NodeJS.Timeout>();
export function scheduleEmbed(g: UserGraph) {
  clearTimeout(timers.get(g.name));
  timers.set(g.name, setTimeout(() => void embedPending(g).catch((e) => console.warn('[embed]', e.message)), 1500));
}

export type SemanticHit = { uid: string; name: string; label: string; distance: number; text?: string; about: { uid: string; name: string; label: string; rel: string }[] };

/** Vector search, then one graph hop to what each hit is about. */
export async function semanticSearch(g: UserGraph, query: string, opts: { k?: number; labels?: string[]; maxDistance?: number } = {}) {
  await embedPending(g);
  const [v] = await embed([query]);
  await ensureIndex(g, v.length);
  const k = opts.k ?? 8;
  const hits = await g.q(
    `CALL db.idx.vector.queryNodes('Memorable', 'emb', $k, vecf32($v)) YIELD node, score
     WITH node, score, [l IN labels(node) WHERE NOT l IN ['Searchable','Memorable']][0] AS label
     WHERE (size($labels) = 0 OR label IN $labels) AND NOT coalesce(node.newsletter, false)
     RETURN node.uid AS uid, node.name AS name, label, score AS distance, coalesce(node.text, node.body, node.subject, node.title) AS text
     ORDER BY distance`,
    { k: k * 3, v, labels: opts.labels || [] },
    `vector search "${query.slice(0, 40)}"`,
  );
  // cosine distance: past this, a hit shares words by accident rather than meaning
  const maxDistance = opts.maxDistance ?? (remote() ? 0.75 : 0.85);
  // …and a hit must share meaning with enough of the question: each content word counts once,
  // by its stem or its concept, so "purple elephant juggles invoices" can't ride on "invoices" alone
  const qWords = [...new Set(contentWords(query))];
  const need = Math.max(1, Math.ceil(qWords.length / 3));
  const shares = (text: string) => {
    const hw = contentWords(text);
    const stems = new Set(hw.map(norm));
    const concepts = new Set(hw.map(concept).filter(Boolean));
    return qWords.filter((w) => stems.has(norm(w)) || (concept(w) && concepts.has(concept(w)))).length;
  };
  const top = hits
    .filter((h) => h.distance <= maxDistance && shares(`${h.name} ${h.text || ''}`) >= need)
    .filter((h) => h.label !== 'Episode' || hits.length < 4)
    .slice(0, k);
  const about = top.length
    ? await g.q(
      `UNWIND $uids AS u MATCH (n {uid: u})-[r]-(m)
       WHERE (m:Person OR m:System OR m:Project OR m:Org OR m:Ticket OR m:Decision OR m:Repo) AND NOT coalesce(m.me, false)
       RETURN u AS hit, type(r) AS rel, m.uid AS uid, m.name AS name, [l IN labels(m) WHERE l <> 'Searchable'][0] AS label`,
      { uids: top.map((h) => h.uid) },
      'graph expansion of the vector hits',
    )
    : [];
  const result: SemanticHit[] = top.map((h) => ({ ...h, about: about.filter((a) => a.hit === h.uid).slice(0, 6) }));
  // entities the hits share: the "what this is really about" signal
  const tally = new Map<string, { uid: string; name: string; label: string; n: number }>();
  for (const a of about) {
    const t = tally.get(a.uid) || { uid: a.uid, name: a.name, label: a.label, n: 0 };
    t.n++;
    tally.set(a.uid, t);
  }
  const themes = [...tally.values()].filter((t) => t.n > 1).sort((a, b) => b.n - a.n).slice(0, 6);
  return { hits: result, themes };
}
