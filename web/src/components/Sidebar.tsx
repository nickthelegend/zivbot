import { useState } from 'react';
import { useStore, set, openConversation } from '../store';
import { Avatar, AvatarStack } from './Avatar';
import { AppIcon, Icon } from './icons';

export function Sidebar() {
  const conversations = useStore((s) => s.conversations);
  const dots = useStore((s) => s.dots);
  const active = useStore((s) => s.active);
  const view = useStore((s) => s.view);
  const thinking = useStore((s) => s.thinking);
  const profile = useStore((s) => s.profile);
  const connectors = useStore((s) => s.connectors);
  const pending = useStore((s) => s.pendingDrafts);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const connected = connectors.filter((c) => c.status === 'connected' && !c.id.startsWith('agent-'));
  const list = conversations
    .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.lastText || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt));
  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="brand"><Avatar avatar="ziv" size={22} /> <b>ZivBot</b></div>
        <div className="side-actions">
          <button className="icon-btn round" onClick={() => setSearching(!searching)} title="Search"><Icon.search size={17} /></button>
          <button className="icon-btn round" onClick={() => set({ newDotOpen: true })} title="New dot or group"><Icon.plus size={17} /></button>
        </div>
      </div>
      {searching && <input className="side-search" autoFocus placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />}
      <nav className="side-nav">
        <button className={view === 'chat' ? 'on' : ''} onClick={() => set({ view: 'chat' })}><Icon.chat size={16} /> Chats</button>
        <button className={view === 'graph' ? 'on' : ''} onClick={() => set({ view: 'graph' })}><Icon.graph size={16} /> Graph</button>
        <button className={view === 'activity' ? 'on' : ''} onClick={() => set({ view: 'activity' })}><Icon.bolt size={16} /> Activity {pending > 0 && <span className="count">{pending}</span>}</button>
      </nav>
      <div className="conv-list">
        {list.map((c) => {
          const isGroup = c.kind === 'group';
          const d = c.dots[0];
          const busy = Object.keys(thinking[c.uid] || {}).length > 0;
          const dot = dots.find((x) => x.uid === d?.uid);
          const preview = busy ? 'Working…' : (c.lastRole === 'user' ? 'You: ' : isGroup && c.lastBy ? `${c.lastBy}: ` : '') + (c.lastText || '').replace(/\*\*/g, '').replace(/\n/g, ' ');
          return (
            <button key={c.uid} className={`conv ${active === c.uid && view === 'chat' ? 'on' : ''}`} onClick={() => void openConversation(c.uid)}>
              {isGroup ? <AvatarStack dots={c.dots} size={26} /> : <Avatar avatar={d?.avatar} color={d?.color || dot?.color} size={38} busy={busy} badge={String(dot?.stage || '').startsWith('onboard')} />}
              <span className="conv-text">
                <span className="conv-name">{isGroup ? c.name : d?.name}</span>
                <span className="conv-prev">{preview || dot?.role}</span>
              </span>
              {c.unread > 0 && active !== c.uid && <span className="unread" />}
            </button>
          );
        })}
      </div>
      <div className="side-bottom">
        <span className="me-avatar" title={profile.name || 'You'}>{(profile.name || 'Y')[0]}</span>
        <button className="connect-pill" onClick={() => set({ connectOpen: true })}>
          Connect apps
          <span className="icon-stack">{(connected.length ? connected.slice(0, 3).map((c) => c.icon) : ['gmail', 'slack', 'notion']).map((s) => <AppIcon key={s} slug={s} size={18} />)}</span>
        </button>
      </div>
    </aside>
  );
}
