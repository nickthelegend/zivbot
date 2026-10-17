import { AsyncLocalStorage } from 'node:async_hooks';
import { FalkorDB, type Graph } from 'falkordb';
import { config } from './config.ts';

/**
 * Every Cypher statement ZivBot runs goes through here. While an agent turn is
 * in flight, an AsyncLocalStorage trace collects each query (text, params,
 * timing, row count) and every node uid the results touched. That trace is
 * what the UI's "Show how I got this" renders: the queries plus the subgraph
 * the answer was built from.
 */

export type QueryLog = { label: string; cypher: string; params: Record<string, unknown>; ms: number; rows: number; error?: string; internal?: boolean };
export type Trace = { queries: QueryLog[]; touched: Set<string>; onQuery?: (q: QueryLog) => void };

const traceStore = new AsyncLocalStorage<Trace>();
export const withTrace = <T>(trace: Trace, fn: () => Promise<T>) => traceStore.run(trace, fn);
export const currentTrace = () => traceStore.getStore();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

let db: FalkorDB | null = null;
let connecting: Promise<FalkorDB> | null = null;

export async function falkor(): Promise<FalkorDB> {
  if (db) return db;
  connecting ??= FalkorDB.connect({
    url: config.falkorUrl,
    username: config.falkorUsername,
    password: config.falkorPassword,
  } as any).then((c) => {
    db = c;
    (c as any).on?.('error', (e: Error) => console.error('[falkordb]', e.message));
    return c;
  });
  return connecting;
}

/** Plain-JSON view of FalkorDB result values (nodes, edges, paths). */
function plain(v: any, touched?: Set<string>): any {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => plain(x, touched));
  if ('labels' in v && 'properties' in v && 'id' in v) {
    const p = v.properties || {};
    if (p.uid && touched) touched.add(p.uid);
    return { _label: v.labels[0], ...p };
  }
  if ('relationshipType' in v && 'sourceId' in v) return { _type: v.relationshipType, ...(v.properties || {}) };
  if ('nodes' in v && 'edges' in v) return { nodes: plain(v.nodes, touched), edges: plain(v.edges, touched) };
  const o: Row = {};
  for (const [k, x] of Object.entries(v)) o[k] = plain(x, touched);
  return o;
}

export class UserGraph {
  constructor(readonly name: string, private g: Graph) {}

  async q(cypher: string, params: Record<string, unknown> = {}, label = 'query', readOnly = false): Promise<Row[]> {
    const trace = currentTrace();
    const t0 = performance.now();
    try {
      const res = readOnly ? await this.g.roQuery(cypher, { params: params as any }) : await this.g.query(cypher, { params: params as any });
      const internal = label.startsWith('~');
      const touched = trace && !internal ? trace.touched : undefined;
      const rows = ((res as any).data || []).map((r: Row) => plain(r, touched));
      if (touched) for (const r of rows) collectUids(r, touched);
      if (trace) {
        const log: QueryLog = { label: internal ? label.slice(1) : label, cypher: tidy(cypher), params, ms: +(performance.now() - t0).toFixed(2), rows: rows.length, ...(internal ? { internal } : {}) };
        trace.queries.push(log);
        trace.onQuery?.(log);
      }
      return rows;
    } catch (e: any) {
      if (trace) trace.queries.push({ label, cypher: tidy(cypher), params, ms: +(performance.now() - t0).toFixed(2), rows: 0, error: e.message });
      throw e;
    }
  }

  ro(cypher: string, params: Record<string, unknown> = {}, label = 'query') {
    return this.q(cypher, params, label, true);
  }

  async one(cypher: string, params: Record<string, unknown> = {}, label = 'query') {
    return (await this.q(cypher, params, label))[0];
  }

  async drop() {
    try { await this.g.delete(); } catch { /* graph did not exist */ }
  }
}

const UID = /^(person|team|org|project|system|repo|file|ticket|email|thread|event|doc|msg|channel|decision|agent|run|commit|fact|procedure|tool|connector|draft):/;
/** Scalar projections (`RETURN t.uid AS uid`) count as touched too. */
function collectUids(v: any, out: Set<string>, depth = 0) {
  if (depth > 4 || v == null) return;
  if (typeof v === 'string') { if (UID.test(v)) out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 200)) collectUids(x, out, depth + 1); return; }
  if (typeof v === 'object') for (const x of Object.values(v)) collectUids(x, out, depth + 1);
}

const tidy = (s: string) => s.replace(/^\s+/gm, '').trim();

const cache = new Map<string, UserGraph>();

/** One isolated FalkorDB graph per user — FalkorDB's multigraph tenancy. */
export async function userGraph(userId: string): Promise<UserGraph> {
  const name = `ziv_${userId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  let g = cache.get(name);
  if (!g) {
    const c = await falkor();
    g = new UserGraph(name, c.selectGraph(name));
    cache.set(name, g);
  }
  return g;
}

export async function registryGraph(): Promise<UserGraph> {
  const c = await falkor();
  let g = cache.get('ziv_registry');
  if (!g) {
    g = new UserGraph('ziv_registry', c.selectGraph('ziv_registry'));
    cache.set('ziv_registry', g);
  }
  return g;
}

export async function listGraphs(): Promise<string[]> {
  return (await falkor()).list();
}
