import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore, set, get, openConversation } from '../store';
import { Avatar, AvatarCluster } from './Avatar';
import { Icon } from './icons';

type Row =
  | { kind: 'conv'; id: string; title: string; sub?: string; unread: boolean; dots: { uid: string; avatar?: string; color?: string }[]; group: boolean; shortcut?: number }
  | { kind: 'node'; id: string; title: string; label: string }
  | { kind: 'action'; id: string; title: string; run: () => void; icon: keyof typeof Icon };

/**
 * ⌘K: jump to any Ziv or group (⌘1–⌘9 work from anywhere), search your
 * FalkorDB graph (people, tickets, systems, decisions…), or run an action.
 */
export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const conversations = useStore((s) => s.conversations);
  const labels = useStore((s) => s.labels);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [nodes, setNodes] = useState<{ uid: string; name: string; label: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // the order you see in the palette is the ⌘1–⌘9 order
  const ordered = useMemo(() => [...conversations].sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0) || (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt)), [conversations]);

  // global shortcuts
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); set({ paletteOpen: !useStoreOpen() }); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && ordered[n - 1]) { e.preventDefault(); set({ paletteOpen: false }); void openConversation(ordered[n - 1].uid); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [ordered]);

  useEffect(() => { if (open) { setQ(''); setI(0); setNodes([]); setTimeout(() => input.current?.focus(), 10); } }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setNodes([]); return; }
    const t = setTimeout(() => void api.search(q).then(setNodes).catch(() => {}), 160);
    return () => clearTimeout(t);
  }, [q, open]);

  const rows: Row[] = useMemo(() => {
    const ql = q.toLowerCase();
    const convs: Row[] = ordered
      .map((c, n) => ({
        kind: 'conv' as const, id: c.uid, group: c.kind === 'group', unread: c.unread > 0, dots: c.dots, shortcut: n < 9 ? n + 1 : undefined,
        title: c.kind === 'group' ? c.name : c.dots[0]?.name || c.name,
        sub: c.kind === 'group' ? c.dots.map((d) => d.name).join(', ') : undefined,
      }))
      .filter((r) => !ql || r.title.toLowerCase().includes(ql) || (r.sub || '').toLowerCase().includes(ql));
    const graph: Row[] = nodes.map((n) => ({ kind: 'node', id: n.uid, title: n.name, label: n.label }));
    const actions: Row[] = [
      { kind: 'action', id: 'graph', title: 'Open your graph', icon: 'graph', run: () => set({ view: 'graph', mobileList: false }) },
      { kind: 'action', id: 'activity', title: 'Activity & approvals', icon: 'bolt', run: () => set({ view: 'activity', mobileList: false }) },
      { kind: 'action', id: 'connect', title: 'Connect apps', icon: 'plus', run: () => set({ connectOpen: true }) },
      { kind: 'action', id: 'newdot', title: 'New Ziv or group', icon: 'users', run: () => set({ newDotOpen: true }) },
    ].filter((a) => !ql || a.title.toLowerCase().includes(ql)) as Row[];
    return [...convs, ...graph, ...actions];
  }, [ordered, nodes, q]);

  useEffect(() => { setI((x) => Math.min(x, Math.max(rows.length - 1, 0))); }, [rows.length]);
  useEffect(() => { list.current?.querySelector('.p-row.on')?.scrollIntoView({ block: 'nearest' }); }, [i]);

  if (!open) return null;
  const choose = (r: Row) => {
    set({ paletteOpen: false });
    if (r.kind === 'conv') void openConversation(r.id);
    else if (r.kind === 'node') set({ entity: r.id });
    else r.run();
  };
  const firstNode = rows.findIndex((r) => r.kind === 'node');
  const firstAction = rows.findIndex((r) => r.kind === 'action');
  return (
    <div className="palette-backdrop" onMouseDown={() => set({ paletteOpen: false })}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="p-search">
          <Icon.search size={16} />
          <input
            ref={input}
            value={q}
            placeholder="Search Zivs, chats and your graph"
            onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((i + 1) % rows.length); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI((i - 1 + rows.length) % rows.length); }
              else if (e.key === 'Enter' && rows[i]) { e.preventDefault(); choose(rows[i]); }
              else if (e.key === 'Escape') set({ paletteOpen: false });
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="p-list" ref={list}>
          {rows.length === 0 && <div className="p-empty">Nothing matches “{q}”.</div>}
          {rows.map((r, n) => (
            <div key={`${r.kind}:${r.id}`}>
              {n === firstNode && <div className="p-section">In your graph</div>}
              {n === firstAction && <div className="p-section">Go to</div>}
              <button className={`p-row ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={() => choose(r)}>
                {r.kind === 'conv' ? (r.group ? <AvatarCluster dots={r.dots} size={28} /> : <Avatar avatar={r.dots[0]?.avatar} color={r.dots[0]?.color} size={28} />)
                  : r.kind === 'node' ? <span className="p-node" style={{ background: labels[r.label]?.color || '#999' }} />
                    : <span className="p-icon">{Icon[r.icon]({ size: 15 })}</span>}
                <span className="grow">
                  <span className="p-title">{r.title}</span>
                  {r.kind === 'conv' && r.sub && <span className="p-sub">{r.sub}</span>}
                </span>
                {r.kind === 'node' && <span className="p-label">{r.label}</span>}
                {r.kind === 'conv' && r.unread && <span className="p-unread" />}
                {r.kind === 'conv' && r.shortcut && <kbd>⌘{r.shortcut}</kbd>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const useStoreOpen = () => get().paletteOpen;
