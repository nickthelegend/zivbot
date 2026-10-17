import { useEffect, useMemo, useState } from 'react';
import { api, type GraphEdge, type GraphNode } from '../api';
import { useStore, set, get, openConversation, send } from '../store';
import { ForceGraph } from './ForceGraph';
import { Icon } from './icons';
import { InsightsPanel } from './InsightsPanel';
import { AlgorithmsPanel, SchemaPanel } from './AlgoPanels';

/** Hand a question about a node to Ziv's chat. */
async function askZiv(q: string) {
  const conv = get().dots[0]?.conv;
  if (!conv) return;
  await openConversation(conv);
  void send(conv, q);
}

const SAMPLES = [
  ['Who knows payments-api', `MATCH (p:Person)<-[:AUTHORED_BY]-(c:Commit)-[:TOUCHES]->(:File)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(:System {name:'payments-api'})\nRETURN p.name AS person, count(DISTINCT c) AS commits ORDER BY commits DESC`],
  ['What breaks if billing-db goes down', `MATCH p = (d:System)-[:DEPENDS_ON*1..4]->(:System {name:'billing-db'})\nRETURN d.name AS system, min(length(p)) AS hops ORDER BY hops`],
  ['Customers exposed by open P1s', `MATCH (t:Ticket {status:'open', priority:'P1'})-[:AFFECTS]->(s:System)<-[:DEPENDS_ON*0..3]-(:System)<-[:USES]-(o:Org {kind:'customer'})\nWITH t, collect(DISTINCT o) AS orgs\nRETURN t.key AS ticket, [o IN orgs | o.name] AS customers, reduce(n = 0, o IN orgs | n + o.arr) AS arr`],
  ['Decisions and their sources', `MATCH (d:Decision)-[:SOURCE]->(src)\nOPTIONAL MATCH (d)-[:DECIDED_BY]->(p:Person)\nRETURN d.text AS decision, d.status AS status, p.name AS by, labels(src)[0] AS source`],
  ['Most central people (PageRank)', `MATCH (p:Person) WHERE p.rank IS NOT NULL\nRETURN p.name AS name, p.role AS role, round(p.rank * 1000) / 1000 AS pagerank ORDER BY pagerank DESC LIMIT 8`],
  ['Agent track record', `MATCH (a:Agent)<-[:EXECUTED_BY]-(r:Run)\nRETURN a.name AS agent, count(r) AS runs, count(CASE WHEN r.status = 'succeeded' THEN 1 END) AS wins ORDER BY wins DESC`],
];

export function GraphView() {
  const labels = useStore((s) => s.labels);
  const [data, setData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set(['Email', 'Thread', 'ChatMessage', 'File']));
  const [sizeBy, setSizeBy] = useState<'degree' | 'rank'>('degree');
  const [colorBy, setColorBy] = useState<'label' | 'community'>('label');
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [detail, setDetail] = useState<string>('');
  const [query, setQuery] = useState(SAMPLES[0][1]);
  const [result, setResult] = useState<{ rows: any[]; text: string } | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'explore' | 'insights' | 'algorithms' | 'schema'>('explore');
  const [focusSet, setFocusSet] = useState<Set<string> | null>(null);

  useEffect(() => {
    void api.graph({ limit: 900 }).then(setData);
    void api.stats().then(setStats);
  }, []);
  useEffect(() => { setDetail(''); if (selected) void api.entity(selected.id).then((r) => setDetail(r.text)).catch(() => {}); }, [selected]);

  const view = useMemo(() => {
    if (!data) return null;
    const nodes = data.nodes.filter((n) => !hidden.has(n.label));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }, [data, hidden]);
  const dim = useMemo(() => {
    if (focusSet && view) return new Set(view.nodes.filter((n) => !focusSet.has(n.id)).map((n) => n.id));
    if (!search.trim() || !view) return undefined;
    const q = search.toLowerCase();
    return new Set(view.nodes.filter((n) => !(n.name || '').toLowerCase().includes(q)).map((n) => n.id));
  }, [search, view, focusSet]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of data?.nodes || []) m.set(n.label, (m.get(n.label) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [data]);

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <div>
          <h2>Your graph</h2>
          <div className="muted">FalkorDB · <code>{stats?.graph}</code> · {stats?.nodes} nodes · {stats?.edges} edges · one isolated graph per user</div>
        </div>
        <div className="seg big">
          <button className={tab === 'explore' ? 'on' : ''} onClick={() => setTab('explore')}><Icon.graph size={14} /> Explore</button>
          <button className={tab === 'insights' ? 'on' : ''} onClick={() => setTab('insights')}><Icon.spark size={14} /> Insights</button>
          <button className={tab === 'algorithms' ? 'on' : ''} onClick={() => setTab('algorithms')}><Icon.bolt size={14} /> Algorithms</button>
          <button className={tab === 'schema' ? 'on' : ''} onClick={() => setTab('schema')}><Icon.database size={14} /> Schema</button>
        </div>
        <div className="search-box sm"><Icon.search size={15} /><input placeholder="Find a node" value={search} onChange={(e) => { setSearch(e.target.value); setFocusSet(null); }} /></div>
        {tab === 'explore' && <div className="seg">
          <button className={sizeBy === 'degree' ? 'on' : ''} onClick={() => setSizeBy('degree')}>Size: links</button>
          <button className={sizeBy === 'rank' ? 'on' : ''} onClick={() => setSizeBy('rank')}>Size: PageRank</button>
        </div>}
        {tab === 'explore' && <div className="seg">
          <button className={colorBy === 'label' ? 'on' : ''} onClick={() => setColorBy('label')}>Color: type</button>
          <button className={colorBy === 'community' ? 'on' : ''} onClick={() => setColorBy('community')}>Color: groups</button>
        </div>}
      </div>
      {tab === 'explore' && <div className="label-chips">
        {counts.map(([l, n]) => (
          <button key={l} className={hidden.has(l) ? 'off' : ''} onClick={() => { const h = new Set(hidden); h.has(l) ? h.delete(l) : h.add(l); setHidden(h); }}>
            <span className="chip-dot" style={{ background: labels[l]?.color || '#999' }} /> {l} <small>{n}</small>
          </button>
        ))}
      </div>}
      {tab === 'algorithms' ? <AlgorithmsPanel /> : tab === 'schema' ? <SchemaPanel /> : tab === 'insights' ? (
        <InsightsPanel onShow={(uids) => {
          const extra = new Set(uids);
          // make sure focused nodes are visible even if their label is filtered out
          setHidden(new Set([...hidden].filter((l) => !(data?.nodes || []).some((n) => extra.has(n.id) && n.label === l))));
          setFocusSet(extra);
          setTab('explore');
        }} />
      ) : (
      <div className="graph-main">
        <div className="graph-canvas">
          {view ? <ForceGraph nodes={view.nodes} edges={view.edges} height="100%" sizeBy={sizeBy} colorBy={colorBy} selected={selected?.id} dim={dim} onNodeClick={setSelected} /> : <div className="center-msg"><span className="spinner" /></div>}
        </div>
        <div className="graph-side">
          {selected ? (
            <div className="node-detail">
              <div className="nd-head"><span className="chip-dot" style={{ background: labels[selected.label]?.color }} /> {selected.label}<button className="icon-btn" onClick={() => setSelected(null)}><Icon.close size={15} /></button></div>
              <h3>{selected.name}</h3>
              <div className="nd-body">{detail ? detail.split('\n').slice(1).filter((l) => l.trim()).map((l, i) => <div key={i}>{l.replace(/\*\*/g, '').replace(/^- /, '')}</div>) : <span className="spinner sm" />}</div>
              <div className="nd-actions">
                <button className="btn ghost sm" onClick={() => set({ entity: selected.id })}>Open</button>
                {selected.label === 'Person' && <button className="btn ghost sm" onClick={() => void askZiv(`What if ${selected.name} is out next week?`)}>What if they're out?</button>}
                {selected.label === 'Project' && <button className="btn ghost sm" onClick={() => void askZiv(`What's blocking ${selected.name}?`)}>What's blocking it?</button>}
                {selected.label === 'Org' && <button className="btn ghost sm" onClick={() => void askZiv(`Where are we with ${selected.name}?`)}>Where are we?</button>}
                {selected.label === 'System' && <button className="btn ghost sm" onClick={() => void askZiv(`What breaks if ${selected.name} goes down?`)}>What if it's down?</button>}
              </div>
            </div>
          ) : (
            <div className="cypher-console">
              <div className="cc-head"><Icon.terminal size={15} /> Cypher console <small>read-only</small></div>
              <div className="samples">{SAMPLES.map(([t, q]) => <button key={t} onClick={() => { setQuery(q); setResult(null); }}>{t}</button>)}</div>
              <textarea value={query} onChange={(e) => setQuery(e.target.value)} rows={6} spellCheck={false} />
              <button className="btn primary sm" onClick={() => void api.cypher(query).then(setResult).catch((e) => setResult({ rows: [], text: e.message }))}><Icon.play size={13} /> Run</button>
              {result && <ResultTable rows={result.rows} text={result.text} />}
            </div>
          )}
        </div>
      </div>
      )}
      {focusSet && tab === 'explore' && <button className="focus-clear" onClick={() => setFocusSet(null)}><Icon.close size={13} /> Clear highlight</button>}
    </div>
  );
}

function ResultTable({ rows, text }: { rows: any[]; text: string }) {
  if (!rows.length) return <pre className="cc-result">{text.replace(/```json|```/g, '')}</pre>;
  const cols = Object.keys(rows[0]);
  const fmt = (v: any) => (v && typeof v === 'object' ? (v.name || JSON.stringify(v).slice(0, 60)) : String(v ?? ''));
  return (
    <div className="cc-table">
      <table>
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 50).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{Array.isArray(r[c]) ? r[c].map(fmt).join(', ') : fmt(r[c])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
