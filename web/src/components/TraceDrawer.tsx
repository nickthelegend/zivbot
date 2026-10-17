import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore, set } from '../store';
import { ForceGraph } from './ForceGraph';
import { Icon } from './icons';

type Trace = Awaited<ReturnType<typeof api.answer>>;

/** "Show path": the Cypher a dot ran and the subgraph its answer was built from. */
export function TraceDrawer() {
  const id = useStore((s) => s.trace);
  const [t, setT] = useState<Trace | null>(null);
  const [internal, setInternal] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { setT(null); setOpen(null); if (id) void api.answer(id).then(setT).catch(() => {}); }, [id]);
  useEffect(() => {
    if (!id) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') set({ trace: undefined }); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [id]);
  if (!id) return null;
  const queries = (t?.queries || []).filter((q) => internal || !q.internal);
  const total = (t?.queries || []).reduce((s, q) => s + q.ms, 0);
  return (
    <div className="drawer-backdrop" onClick={() => set({ trace: undefined })}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <div className="drawer-kicker"><Icon.path size={14} /> How {t?.dot || 'the dot'} got this</div>
            <div className="drawer-title">{t?.question || '…'}</div>
            {t && (
              <div className="drawer-meta">
                <span className="pill-mini">{t.mode === 'graph-planner' ? 'graph planner' : t.mode}</span>
                {t.delegatedTo?.length > 0 && <span className="pill-mini">delegated to {t.delegatedTo.join(', ')}</span>}
                <span>{t.queries.length} Cypher queries · {total.toFixed(1)}ms in FalkorDB · {t.nodes.length} nodes touched by those queries</span>
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => set({ trace: undefined })}><Icon.close size={18} /></button>
        </div>
        {t && t.nodes.length > 0 && (
          <div className="drawer-graph">
            <ForceGraph nodes={t.nodes} edges={t.edges} height={320} labels="all" onNodeClick={(n) => set({ entity: n.id })} />
          </div>
        )}
        {t && t.tools?.length > 0 && <div className="tools-used">Tools: {[...new Set(t.tools)].map((x) => <code key={x}>{x}</code>)}</div>}
        <div className="queries-head">
          <b>Queries</b>
          <label><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> show bookkeeping</label>
        </div>
        <div className="queries">
          {queries.map((q, i) => (
            <div key={i} className={`query ${q.error ? 'err' : ''}`}>
              <button className="query-row" onClick={() => setOpen(open === i ? null : i)}>
                <span className="q-n">{i + 1}</span>
                <span className="grow">{q.dot ? <span className="pill-mini">{q.dot}</span> : null} {q.label}</span>
                <small>{q.rows} rows · {q.ms}ms</small>
              </button>
              {open === i && (
                <>
                  <pre className="cypher">{highlight(q.cypher)}</pre>
                  {q.params && Object.keys(q.params).length > 0 && <pre className="params">{JSON.stringify(q.params, null, 1).slice(0, 800)}</pre>}
                  {q.error && <div className="q-error">{q.error}</div>}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const KW = /\b(MATCH|OPTIONAL|WHERE|RETURN|WITH|ORDER BY|LIMIT|UNWIND|MERGE|CREATE|SET|DELETE|DETACH|CALL|YIELD|AS|AND|OR|NOT|IN|DISTINCT|CASE|WHEN|THEN|ELSE|END|IS NULL|IS NOT NULL|count|collect|sum|min|max|size|coalesce|any|none|labels|type|nodes|relationships|length|DESC|ASC)\b/g;
function highlight(cypher: string) {
  const parts: (string | React.ReactElement)[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  const re = new RegExp(`${KW.source}|(:[A-Z_][A-Z_]+)|(\\$\\w+)|('[^']*')`, 'g');
  while ((m = re.exec(cypher))) {
    if (m.index > last) parts.push(cypher.slice(last, m.index));
    const cls = m[1] ? 'kw' : m[2] ? 'rel' : m[3] ? 'param' : 'str';
    parts.push(<span key={k++} className={`c-${cls}`}>{m[0]}</span>);
    last = re.lastIndex;
  }
  parts.push(cypher.slice(last));
  return parts;
}
