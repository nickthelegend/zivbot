import { useState } from 'react';
import { api } from '../api';
import { useStore, set, openConversation } from '../store';
import { Avatar, AvatarCluster } from './Avatar';
import { AppIcon, Icon } from './icons';

/** GrokBot sidebar: search + new at the top, your dots, and "Connect apps" at the bottom. */
export function Sidebar() {
  const conversations = useStore((s) => s.conversations);
  const dots = useStore((s) => s.dots);
  const active = useStore((s) => s.active);
  const view = useStore((s) => s.view);
  const thinking = useStore((s) => s.thinking);
  const profile = useStore((s) => s.profile);
  const connectors = useStore((s) => s.connectors);
  const pending = useStore((s) => s.pendingDrafts);
  const theme = useStore((s) => s.theme);
  const graph = useStore((s) => s.graph);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<'new' | 'me' | null>(null);
  const connected = connectors.filter((c) => c.status === 'connected' && !c.id.startsWith('agent-'));
  const list = conversations
    .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.lastText || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt));
  const go = (patch: Parameters<typeof set>[0]) => { setMenu(null); set(patch); };
  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="brand">
          <img src="/brand/icon-64.png" width={26} height={26} alt="" />
          <span className="brand-name">ZivBot</span>
          {graph && <button className="graph-pulse" title={`Your FalkorDB graph · ${graph.nodes} nodes · ${graph.edges} edges`} onClick={() => set({ view: 'graph', mobileList: false })}><i />{graph.nodes >= 1000 ? `${(graph.nodes / 1000).toFixed(1)}k` : graph.nodes}</button>}
        </div>
        <div className="side-actions">
          <button className="icon-btn round" onClick={() => set({ paletteOpen: true })} title="Search (⌘K)"><Icon.search size={17} /></button>
          <div className="menu-anchor">
            <button className="icon-btn round" onClick={() => setMenu(menu === 'new' ? null : 'new')} title="New"><Icon.plus size={17} /></button>
            {menu === 'new' && (
              <div className="menu down" onMouseLeave={() => setMenu(null)}>
                <button onClick={() => go({ newDotOpen: true })}><Icon.plus size={15} /> New dot</button>
                <button onClick={() => go({ newDotOpen: true })}><Icon.users size={15} /> New group chat</button>
                <hr />
                <button onClick={() => go({ view: 'graph', mobileList: false })}><Icon.graph size={15} /> Memory graph</button>
                <button onClick={() => go({ view: 'activity', mobileList: false })}><Icon.bolt size={15} /> Activity {pending > 0 && <span className="count">{pending}</span>}</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="conv-list">
        {(['direct', 'group'] as const).map((kind) => {
          const rows = list.filter((c) => c.kind === kind);
          if (!rows.length) return null;
          return (
            <div key={kind} className="conv-section">
              <div className="conv-label">{kind === 'direct' ? 'Dots' : 'Groups'}</div>
        {rows.map((c) => {
          const isGroup = c.kind === 'group';
          const d = c.dots[0];
          const busy = Object.keys(thinking[c.uid] || {}).length > 0;
          const dot = dots.find((x) => x.uid === d?.uid);
          const preview = busy ? 'Working…' : (isGroup && c.lastBy ? `${c.lastBy}: ` : '') + (c.lastText || '').replace(/\*\*|`/g, '').replace(/\n/g, ' ');
          return (
            <button key={c.uid} aria-label={`Open ${c.name}`} className={`conv ${active === c.uid && view === 'chat' ? 'on' : ''}`} onClick={() => void openConversation(c.uid)}>
              {isGroup ? <AvatarCluster dots={c.dots} size={40} /> : <Avatar avatar={d?.avatar} color={d?.color || dot?.color} size={40} busy={busy} badge={String(dot?.stage || '').startsWith('onboard')} />}
              <span className="conv-text">
                <span className="conv-name">{isGroup ? c.name : d?.name}</span>
                <span className="conv-prev">{preview || dot?.role}</span>
              </span>
              {c.unread > 0 && active !== c.uid && <span className="unread" />}
            </button>
          );
        })}
            </div>
          );
        })}
      </div>
      <div className="side-bottom">
        <div className="menu-anchor">
          <button className="me-avatar" title={profile.name || 'You'} onClick={() => setMenu(menu === 'me' ? null : 'me')}>{(profile.name || 'Y')[0]}</button>
          {menu === 'me' && (
            <div className="menu up" onMouseLeave={() => setMenu(null)}>
              <div className="menu-head">{profile.name || 'You'}</div>
              <button onClick={() => go({ theme: theme === 'dark' ? 'light' : 'dark' })}>{theme === 'dark' ? <Icon.sun size={15} /> : <Icon.moon size={15} />} {theme === 'dark' ? 'Light' : 'Dark'} mode</button>
              <button onClick={() => { setMenu(null); window.dispatchEvent(new CustomEvent('zivbot:pair')); }}><Icon.phone size={15} /> Pair your phone</button>
              <button onClick={() => go({ view: 'graph', mobileList: false })}><Icon.graph size={15} /> Memory graph</button>
              <button onClick={() => go({ view: 'activity', mobileList: false })}><Icon.bolt size={15} /> Activity</button>
              <hr />
              <button onClick={() => { if (confirm('Start over with a fresh ZivBot? Your current graph stays in FalkorDB.')) { api.reset(); location.reload(); } }}><Icon.refresh size={15} /> Start fresh</button>
            </div>
          )}
        </div>
        <button className="connect-pill" onClick={() => set({ connectOpen: true })}>
          Connect apps
          <span className="icon-stack">{(connected.length ? connected.slice(0, 3).map((c) => c.icon) : ['gmail', 'googlecalendar', 'notion']).map((s) => <AppIcon key={s} slug={s} size={18} />)}</span>
        </button>
      </div>
    </aside>
  );
}
