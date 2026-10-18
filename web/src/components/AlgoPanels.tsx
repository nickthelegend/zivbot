import { useEffect, useMemo, useState } from 'react';
import { api, type GraphEdge, type GraphNode } from '../api';
import { useStore, set } from '../store';
import { ForceGraph } from './ForceGraph';
import { Icon } from './icons';

type Result = Awaited<ReturnType<typeof api.runAlgorithm>>;
type Schema = Awaited<ReturnType<typeof api.schema>>;

const PRESETS: { label: string; body: Parameters<typeof api.runAlgorithm>[0] }[] = [
  { label: 'Most central people', body: { algorithm: 'pagerank', label: 'Person', rel: 'COLLABORATES' } },
  { label: 'Systems everything leans on', body: { algorithm: 'pagerank', label: 'System', rel: 'DEPENDS_ON' } },
  { label: 'Brokers between teams', body: { algorithm: 'betweenness', label: 'Person', rel: 'COLLABORATES' } },
  { label: 'Real working groups', body: { algorithm: 'communities', label: 'Person', rel: 'CLOSE_TO' } },
  { label: 'Who depends on billing-db', body: { algorithm: 'reach', source: 'billing-db', rel: 'DEPENDS_ON', direction: 'in', depth: 4 } },
  { label: 'Warm path: Leo → Kate Morgan', body: { algorithm: 'shortest_path', source: 'Leo Okafor', target: 'Kate Morgan', rel: 'COLLABORATES' } },
  { label: 'Islands in the dependency graph', body: { algorithm: 'components', label: 'System', rel: 'DEPENDS_ON' } },
];

/** Run FalkorDB algorithms and see the result on the graph: size = score, colour = group. */
export function AlgorithmsPanel() {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.algorithms>> | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [form, setForm] = useState<Parameters<typeof api.runAlgorithm>[0]>(PRESETS[0].body);
  const [res, setRes] = useState<Result | null>(null);
  const [g, setG] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.algorithms().then(setCatalog); void api.schema().then(setSchema); void run(PRESETS[0].body); }, []);

  const run = async (body: Parameters<typeof api.runAlgorithm>[0]) => {
    setBusy(true); setErr(''); setForm(body);
    try {
      const r = await api.runAlgorithm(body);
      setRes(r);
      const uids = r.rows.map((x) => x.uid).slice(0, 40);
      const graph = uids.length ? await api.graph({ focus: uids, rel: r.rel }) : { nodes: [], edges: [] };
      const score = new Map(r.rows.map((x) => [x.uid, x]));
      const keep = new Set(uids);
      // show the result nodes and the edges between them; non-result neighbours are dropped
      const nodes = graph.nodes.filter((n) => keep.has(n.id)).map((n) => {
        const x = score.get(n.id)!;
        return { ...n, rank: x.score != null ? (r.title.startsWith('Reach') ? 1 / (1 + x.score) : x.score) : undefined, community: x.group ?? n.community, focus: false };
      });
      setG({ nodes, edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) });
    } catch (e: any) { setErr(e.message); setRes(null); setG(null); } finally { setBusy(false); }
  };

  const labels = useMemo(() => (schema?.labels || []).map((l) => l.label).filter((l) => !['Episode', 'Answer', 'Conversation', 'Notice', 'Profile', 'Draft'].includes(l)), [schema]);
  const rels = useMemo(() => [...new Set((schema?.triples || []).map((t) => t.rel))], [schema]);
  const meta = catalog?.[form.algorithm];
  const grouped = res?.rows.some((r) => r.group != null);

  return (
    <div className="algo">
      <div className="algo-side">
        <div className="algo-presets">{PRESETS.map((p) => <button key={p.label} className={JSON.stringify(p.body) === JSON.stringify(form) ? 'on' : ''} onClick={() => void run(p.body)}>{p.label}</button>)}</div>
        <div className="algo-form">
          <label><span>Algorithm</span>
            <select value={form.algorithm} onChange={(e) => setForm({ ...form, algorithm: e.target.value, ...(catalog?.[e.target.value]?.defaults || {}) })}>
              {catalog && Object.entries(catalog).map(([k, v]) => <option key={k} value={k}>{v.title}</option>)}
            </select>
          </label>
          {meta && <small className="algo-what">{meta.what}</small>}
          {!meta?.needs?.length && (
            <label><span>Nodes</span><select value={form.label || ''} onChange={(e) => setForm({ ...form, label: e.target.value })}>{labels.map((l) => <option key={l}>{l}</option>)}</select></label>
          )}
          <label><span>Relationship</span><select value={form.rel || ''} onChange={(e) => setForm({ ...form, rel: e.target.value })}>{rels.map((r) => <option key={r}>{r}</option>)}</select></label>
          {meta?.needs?.includes('source') && <label><span>From</span><input value={form.source || ''} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="billing-db, Priya Raman…" /></label>}
          {meta?.needs?.includes('target') && <label><span>To</span><input value={form.target || ''} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="Maya Lin" /></label>}
          {form.algorithm === 'reach' && <label><span>Direction</span><select value={form.direction || 'out'} onChange={(e) => setForm({ ...form, direction: e.target.value })}><option value="out">what it reaches</option><option value="in">what reaches it</option></select></label>}
          <button className="btn primary sm" disabled={busy} onClick={() => void run(form)}><Icon.play size={13} /> {busy ? 'Running…' : 'Run on FalkorDB'}</button>
          {err && <div className="q-error">{err}</div>}
        </div>
      </div>
      <div className="algo-main">
        {res && (
          <div className="algo-head">
            <b>{res.title}</b> <small>{res.label ? `:${res.label}` : ''}{res.rel ? ` · ${res.rel}` : ''}</small>
            <div className="algo-summary">{res.summary}</div>
          </div>
        )}
        <div className="algo-canvas">
          {g && g.nodes.length > 0 ? <ForceGraph nodes={g.nodes} edges={g.edges} height="100%" labels="all" spread={1.5} sizeBy={grouped ? 'degree' : 'rank'} colorBy={grouped ? 'community' : 'label'} onNodeClick={(n) => set({ entity: n.id })} /> : <div className="center-msg">{busy ? <span className="spinner" /> : 'No nodes'}</div>}
        </div>
        {res?.paths && (
          <div className="algo-paths">{res.paths.map((p, i) => <div key={i}><span className="q-n">{i + 1}</span> {p.names.join(' → ')} <small>cost {p.weight}</small></div>)}</div>
        )}
        {res && !res.paths && (
          <div className="algo-table">
            {res.rows.slice(0, 12).map((r, i) => (
              <button key={r.uid} onClick={() => set({ entity: r.uid })}>
                <span className="q-n">{i + 1}</span><span className="grow">{r.name} <small>{r.label}</small></span>
                <code>{r.score != null ? Number(r.score).toFixed(3) : r.group != null ? `group ${r.group}` : ''}</code>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The graph model, read live from FalkorDB: labels as nodes, relationship types as edges. */
export function SchemaPanel() {
  const meta = useStore((s) => s.labels);
  const [s, setS] = useState<Schema | null>(null);
  useEffect(() => { void api.schema().then(setS); }, []);
  const graph = useMemo(() => {
    if (!s) return null;
    const max = Math.max(...s.labels.map((l) => l.n), 1);
    const nodes: GraphNode[] = s.labels.filter((l) => l.label).map((l) => ({ id: l.label, label: l.label, name: `${l.label} · ${l.n}`, rank: 0.15 + l.n / max }));
    const ids = new Set(nodes.map((n) => n.id));
    const edges: GraphEdge[] = s.triples.filter((t) => ids.has(t.from) && ids.has(t.to) && t.from !== t.to).map((t) => ({ source: t.from, target: t.to, type: t.rel }));
    return { nodes, edges };
  }, [s]);
  if (!s || !graph) return <div className="center-msg"><span className="spinner" /></div>;
  return (
    <div className="schema">
      <div className="schema-canvas"><ForceGraph nodes={graph.nodes} edges={graph.edges} height="100%" labels="all" sizeBy="rank" spread={2.4} /></div>
      <div className="schema-side">
        <h3>Relationships <small>{s.triples.length}</small></h3>
        <div className="schema-list">
          {s.triples.map((t, i) => (
            <div key={i} className="triple">
              <span className="chip-dot" style={{ background: meta[t.from]?.color || '#999' }} />{t.from}
              <code>-[:{t.rel}]-&gt;</code>
              <span className="chip-dot" style={{ background: meta[t.to]?.color || '#999' }} />{t.to}
              <small>{t.n}</small>
            </div>
          ))}
        </div>
        <h3>Indexes</h3>
        <div className="schema-list">
          {s.indexes.map((x, i) => <div key={i} className="triple"><b>{x.label}</b> <small>{x.properties.join(', ')}</small> <code>{[...new Set(Object.values(x.types).flat())].join(' + ')}</code></div>)}
        </div>
      </div>
    </div>
  );
}
