import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore, set, send, toast } from '../store';
import { Avatar } from './Avatar';
import { AppIcon, Icon } from './icons';

const AGO = (t?: number) => {
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
};

/** ChatGPT-dots style profile: who this dot is, its computer, what it's doing, what it made. */
export function ProfilePanel() {
  const conv = useStore((s) => s.conversations.find((c) => c.uid === s.active));
  const dots = useStore((s) => s.dots);
  const runMap = useStore((s) => s.runs);
  const runs = useMemo(() => Object.values(runMap).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)), [runMap]);
  const thinking = useStore((s) => s.thinking);
  const connectors = useStore((s) => s.connectors);
  const brain = useStore((s) => s.brain);
  const [outputs, setOutputs] = useState<{ uid: string; name: string; size: number; at: number; dot: string }[]>([]);
  const [memory, setMemory] = useState<{ uid: string; kind: string; text: string }[]>([]);
  const [stats, setStats] = useState<{ nodes: number; edges: number; graph: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  const lastLen = useStore((s) => (s.active ? s.messages[s.active]?.length : 0));

  useEffect(() => {
    void api.outputs().then(setOutputs).catch(() => {});
    void api.memory().then(setMemory).catch(() => {});
    void api.stats().then(setStats).catch(() => {});
  }, [conv?.uid, lastLen]);

  if (!conv) return null;
  const dot = dots.find((d) => d.uid === conv.dots[0]?.uid);
  const isGroup = conv.kind === 'group';
  const busy = Object.keys(thinking[conv.uid] || {}).length > 0 || runs.some((r) => r.status === 'running');
  const agents = connectors.filter((c) => c.id.startsWith('agent-'));
  const live = runs.filter((r) => !r.synthetic).slice(0, 6);
  const lastLog = runs.find((r) => r.status === 'running')?.log?.split('\n').filter(Boolean).slice(-6) || [];

  return (
    <aside className="profile">
      <div className="profile-card">
        <div className="profile-head">
          <div className="profile-avatar">
            <Avatar avatar={dot?.avatar} color={dot?.color} size={64} busy={busy} />
            {!isGroup && <button className="edit-badge" onClick={() => setEditing(!editing)} title="Customize"><Icon.edit size={12} /></button>}
          </div>
          <div>
            <div className="profile-name">{isGroup ? conv.name : dot?.name}</div>
            <div className="profile-sub">{busy ? 'Working now' : dot?.lastAt ? `Active ${AGO(dot.lastAt)}` : 'Active now'}</div>
          </div>
          <button className="icon-btn panel-close" onClick={() => set({ rightOpen: false })}><Icon.close size={16} /></button>
        </div>
        {editing && dot && <CustomizeDot dot={dot} onDone={() => setEditing(false)} />}
        {!isGroup && dot && <div className="profile-role">{dot.role}</div>}
        <div className="profile-buttons">
          <button className="btn tile" onClick={() => conv && void send(conv.uid, 'What needs my attention?')}><Icon.spark size={16} /> Brief me</button>
          <button className="btn tile" onClick={() => set({ view: 'graph' })}><Icon.graph size={16} /> Graph</button>
          <button className="btn tile" onClick={() => window.dispatchEvent(new CustomEvent('zivbot:pair'))}><Icon.phone size={16} /> Phone</button>
        </div>
        <div className="profile-line">
          <Icon.bell size={16} /> Desktop notifications
          {notif === 'granted' ? <span className="ok-tag sm">On</span> : <button className="btn white sm" onClick={() => void Notification.requestPermission().then(setNotif)}>Enable</button>}
        </div>

        <div className="section-title">Computers</div>
        <div className="computer">
          <Icon.monitor size={16} />
          <div className="grow">
            <div>{dot?.name || 'Ziv'}'s computer</div>
            <div className="bar"><i style={{ width: busy ? '72%' : '18%' }} /></div>
          </div>
          <div className={`screen ${busy ? 'on' : ''}`}>
            {(lastLog.length ? lastLog : [`brain: ${brain}`, `graph: ${stats?.graph || '…'}`, `${stats?.nodes ?? '…'} nodes`, `${stats?.edges ?? '…'} edges`]).map((l, i) => <div key={i}>{l.slice(0, 40)}</div>)}
          </div>
        </div>
        <div className="computer">
          <Icon.laptop size={16} />
          <div className="grow">
            <div>Your computer</div>
            <div className="agent-icons">{agents.map((a) => <span key={a.id} className={a.status === 'connected' ? '' : 'off'} title={`${a.name}: ${a.status}`}><AppIcon slug={a.icon} size={18} /></span>)}</div>
          </div>
        </div>

        <div className="section-title">Recent activity</div>
        {live.length === 0 && <div className="muted-line">No runs yet — try “Fix LUM-142”.</div>}
        {live.map((r) => (
          <button key={r.uid} className="activity-row" onClick={() => set({ view: 'activity' })}>
            {r.status === 'running' ? <span className="spinner sm" /> : r.status === 'succeeded' ? <Icon.check size={14} className="ok" /> : <Icon.x size={14} className="bad" />}
            <span className="grow">{r.goal}<small>{r.agent} · {AGO(r.startedAt)}</small></span>
          </button>
        ))}

        <div className="section-title">Outputs</div>
        {outputs.length === 0 && <div className="muted-line">No outputs yet</div>}
        {outputs.slice(0, 5).map((o) => (
          <button key={o.uid} className="activity-row" onClick={() => set({ file: { uid: o.uid, name: o.name } })}>
            <Icon.file size={14} /> <span className="grow">{o.name}<small>{o.dot} · {(o.size / 1024).toFixed(1)}kB</small></span>
          </button>
        ))}

        <div className="section-title">Memory <small>{memory.length}</small></div>
        {memory.length === 0 && <div className="muted-line">Say “remember that …” and every dot will use it.</div>}
        {memory.slice(0, 4).map((m) => <div key={m.uid} className="memory-row"><span className="tone tone-gray">{m.kind}</span> {m.text}</div>)}

        {stats && <div className="graph-footer"><Icon.database size={13} /> FalkorDB · <code>{stats.graph}</code> · {stats.nodes} nodes · {stats.edges} edges</div>}
      </div>
    </aside>
  );
}

function CustomizeDot({ dot, onDone }: { dot: { uid: string; name: string; role: string; avatar: string; color?: string }; onDone: () => void }) {
  const [name, setName] = useState(dot.name);
  const [role, setRole] = useState(dot.role);
  const [avatar, setAvatar] = useState(dot.avatar);
  const [color, setColor] = useState(dot.color || '#ff7a1a');
  return (
    <div className="customize">
      <div className="avatar-picker">
        {['ziv', 'forge', 'scout', 'ledger', 'ghost'].map((a) => <button key={a} className={avatar === a ? 'on' : ''} onClick={() => setAvatar(a)}><Avatar avatar={a} color={a === avatar ? color : undefined} size={30} /></button>)}
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <textarea value={role} onChange={(e) => setRole(e.target.value)} rows={3} placeholder="What is this dot for?" />
      <button className="btn primary sm" onClick={() => void api.updateDot(dot.uid, { name, role, avatar, color }).then(() => { toast('Saved'); onDone(); })}>Save</button>
    </div>
  );
}
