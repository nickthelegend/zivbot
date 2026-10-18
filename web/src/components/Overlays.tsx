import { useEffect, useState } from 'react';
import { api, type GraphEdge, type GraphNode, type Message } from '../api';
import { useStore, set, openConversation, toast } from '../store';
import { Avatar } from './Avatar';
import { ForceGraph } from './ForceGraph';
import { Markdown } from './Markdown';
import { Icon } from './icons';
import { useDotMap } from './Cards';

export function EntityDrawer() {
  const uid = useStore((s) => s.entity);
  const active = useStore((s) => s.active);
  const [d, setD] = useState<{ text: string } | null>(null);
  const [g, setG] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  useEffect(() => {
    setD(null); setG(null);
    if (uid) { void api.entity(uid).then(setD); void api.graph({ focus: [uid] }).then(setG); }
  }, [uid]);
  if (!uid) return null;
  return (
    <div className="drawer-backdrop" onClick={() => set({ entity: undefined })}>
      <div className="drawer narrow" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="drawer-kicker"><Icon.graph size={14} /> Node <code>{uid}</code></div>
          <button aria-label="Close" className="icon-btn" onClick={() => set({ entity: undefined })}><Icon.close size={18} /></button>
        </div>
        {g && <ForceGraph nodes={g.nodes} edges={g.edges} height={260} labels="all" onNodeClick={(n) => set({ entity: n.id })} />}
        <div className="entity-body">{d ? <Markdown text={d.text} /> : <span className="spinner" />}</div>
        {active && <button className="btn primary sm" onClick={() => { void api.send(active, `Tell me about ${uid}`); set({ entity: undefined }); }}>Ask about this</button>}
      </div>
    </div>
  );
}

export function FileViewer() {
  const f = useStore((s) => s.file);
  const [text, setText] = useState('');
  useEffect(() => { setText(''); if (f) void api.file(f.uid).then(setText); }, [f?.uid]);
  if (!f) return null;
  return (
    <div className="modal-backdrop" onClick={() => set({ file: undefined })}>
      <div className="modal file-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2><Icon.file size={18} /> {f.name}</h2>
          <button className="btn ghost sm" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' })); a.download = f.name; a.click(); }}>Download</button>
          <button aria-label="Close" className="icon-btn" onClick={() => set({ file: undefined })}><Icon.close size={18} /></button>
        </div>
        <div className="modal-body doc">{text ? <Markdown text={text} /> : <span className="spinner" />}</div>
      </div>
    </div>
  );
}

/** The dot↔dot conversation behind a "Messaged Forge" chip. */
export function ExchangeViewer() {
  const ex = useStore((s) => s.exchange);
  const dotMap = useDotMap();
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  useEffect(() => { setMsgs(null); if (ex) void api.messages(ex.conv).then((r) => setMsgs(r.messages)); }, [ex?.conv]);
  if (!ex) return null;
  return (
    <div className="drawer-backdrop" onClick={() => set({ exchange: undefined })}>
      <div className="drawer narrow" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div><div className="drawer-kicker"><Icon.users size={14} /> Between your dots</div><div className="drawer-title">Messages with {ex.name}</div></div>
          <button aria-label="Close" className="icon-btn" onClick={() => set({ exchange: undefined })}><Icon.close size={18} /></button>
        </div>
        <div className="exchange-list">
          {!msgs && <span className="spinner" />}
          {msgs?.filter((m) => m.role !== 'system').map((m) => {
            const d = dotMap.get(m.dot || '');
            return (
              <div key={m.uid} className="ex-msg">
                <div className="ex-who"><Avatar avatar={d?.avatar} color={d?.color} size={20} /> <b>{d?.name}</b> <small>{new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></div>
                <div className="bubble"><Markdown text={m.text} /></div>
                {m.answer && <button className="trace-link" onClick={() => set({ trace: m.answer })}><Icon.path size={13} /> Show path</button>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function NewDotModal() {
  const open = useStore((s) => s.newDotOpen);
  const presets = useStore((s) => s.presets);
  const dots = useStore((s) => s.dots);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [group, setGroup] = useState<Set<string>>(new Set());
  if (!open) return null;
  const have = new Set(dots.map((d) => d.avatar));
  const create = async (b: any) => {
    const r = await api.createDot(b);
    set({ newDotOpen: false });
    setTimeout(() => void openConversation(r.conv), 300);
  };
  return (
    <div className="modal-backdrop" onClick={() => set({ newDotOpen: false })}>
      <div className="modal new-dot" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>New dot</h2><button aria-label="Close" className="icon-btn" onClick={() => set({ newDotOpen: false })}><Icon.close size={18} /></button></div>
        <div className="modal-body">
          <div className="sec-head"><h3>Templates</h3></div>
          <div className="preset-grid">
            {presets.map((p) => (
              <button key={p.avatar} className="preset" disabled={have.has(p.avatar)} onClick={() => void create({ preset: p.avatar })}>
                <Avatar avatar={p.avatar} color={p.color} size={40} />
                <b>{p.name}</b><small>{p.role}</small>
                {have.has(p.avatar) && <span className="pill-mini">added</span>}
              </button>
            ))}
          </div>
          <div className="sec-head"><h3>Custom</h3></div>
          <div className="custom-dot">
            <input placeholder="Name (e.g. Trader)" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="What should it do?" value={role} onChange={(e) => setRole(e.target.value)} />
            <button className="btn primary sm" disabled={!name.trim()} onClick={() => void create({ name, role: role || 'General helper', avatar: 'ghost', color: '#e5e5e5' })}>Create</button>
          </div>
          <div className="sec-head"><h3>Group chat</h3></div>
          <div className="group-pick">
            {dots.map((d) => (
              <button key={d.uid} className={group.has(d.uid) ? 'on' : ''} onClick={() => { const g = new Set(group); g.has(d.uid) ? g.delete(d.uid) : g.add(d.uid); setGroup(g); }}>
                <Avatar avatar={d.avatar} color={d.color} size={22} /> {d.name}
              </button>
            ))}
            <button className="btn primary sm" disabled={group.size < 2} onClick={() => void api.createGroup([...group]).then((r) => { set({ newDotOpen: false }); setGroup(new Set()); setTimeout(() => void openConversation(r.conv), 300); }).catch((e) => toast(e.message))}>Start group</button>
          </div>
        </div>
      </div>
    </div>
  );
}
