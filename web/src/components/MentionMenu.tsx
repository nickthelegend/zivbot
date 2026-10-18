import { useMemo } from 'react';
import type { Connector, Dot } from '../api';
import { useStore, set, openConversation } from '../store';
import { Avatar } from './Avatar';
import { AppIcon } from './icons';

export type MentionItem =
  | { kind: 'dot'; id: string; name: string; dot: Dot }
  | { kind: 'plugin'; id: string; name: string; plugin: Connector };

/** Everything you can @-mention: your Zivs, then your plugins (connected first). */
export function useMentionItems(query: string): MentionItem[] {
  const dots = useStore((s) => s.dots);
  const connectors = useStore((s) => s.connectors);
  return useMemo(() => {
    const q = query.toLowerCase();
    const d: MentionItem[] = dots.filter((x) => x.name.toLowerCase().includes(q)).map((x) => ({ kind: 'dot', id: x.uid, name: x.name, dot: x }));
    const rank = (c: Connector) => (c.status === 'connected' ? 0 : c.auth === 'key' ? 1 : 2);
    const p: MentionItem[] = connectors
      .filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(q))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 12)
      .map((c) => ({ kind: 'plugin', id: c.id, name: c.name, plugin: c }));
    return [...d, ...p];
  }, [dots, connectors, query]);
}

export const pluginStatus = (c: Connector) =>
  c.status === 'connected' ? 'connected' : c.status === 'not installed' ? 'not installed' : c.auth === 'key' ? (Object.values(c.configured).some(Boolean) ? 'ready' : 'needs auth') : c.status === 'error' ? 'error' : 'available';

export function MentionMenu({ items, index, onPick, onHover, hovered }: { items: MentionItem[]; index: number; onPick: (m: MentionItem) => void; onHover: (i: number) => void; hovered?: number }) {
  if (!items.length) return null;
  const card = hovered != null ? items[hovered] : undefined;
  return (
    <div className="mention-wrap">
      {card?.kind === 'dot' && <DotCard dot={card.dot} />}
      <div className="mention-menu" role="listbox">
        {items.map((m, i) => (
          <button
            key={`${m.kind}:${m.id}`}
            role="option"
            aria-selected={i === index}
            className={`mention-item ${i === index ? 'on' : ''}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(m); }}
          >
            {m.kind === 'dot' ? <Avatar avatar={m.dot.avatar} color={m.dot.color} size={18} /> : <AppIcon slug={m.plugin.icon} size={18} />}
            <span className="grow">
              {m.name}
              {m.kind === 'plugin' && <span className={`m-status s-${pluginStatus(m.plugin).replace(' ', '-')}`}>{pluginStatus(m.plugin)}</span>}
            </span>
            <span className="m-kind">{m.kind === 'dot' ? 'Ziv' : 'Plugin'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The little profile card: avatar, name, Open chat, Edit Profile. */
export function DotCard({ dot, style, onClose }: { dot: Dot; style?: React.CSSProperties; onClose?: () => void }) {
  return (
    <div className="dot-card" style={style} onMouseDown={(e) => e.preventDefault()}>
      <div className="dot-card-head">
        <Avatar avatar={dot.avatar} color={dot.color} size={34} />
        <div className="grow"><b>{dot.name}</b><small>{dot.role.split(' — ')[0]}</small></div>
      </div>
      <div className="dot-card-actions">
        <button onClick={() => { onClose?.(); void openConversation(dot.conv); }}>Open chat</button>
        <button onClick={() => { onClose?.(); void openConversation(dot.conv).then(() => set({ rightOpen: true, customizeOpen: true })); }}>Edit Profile</button>
      </div>
    </div>
  );
}
