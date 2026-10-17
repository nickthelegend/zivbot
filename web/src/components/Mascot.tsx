import { useMemo, useState } from 'react';
import { useStore, set } from '../store';
import { Icon } from './icons';

/**
 * Ziv, floating on your desktop: the ember dot with three graph nodes in orbit.
 * The orbit speeds up and glows while any dot is working; a toast says what's
 * happening right now, and the little bar starts a call or a new dot.
 */
export function Mascot() {
  const thinking = useStore((s) => Object.values(s.thinking).some((c) => Object.keys(c).length));
  const runMap = useStore((s) => s.runs);
  const running = useMemo(() => Object.values(runMap).filter((r) => r.status === 'running'), [runMap]);
  const toastMsg = useStore((s) => s.toast);
  const call = useStore((s) => s.call);
  const graph = useStore((s) => s.graph);
  const [collapsed, setCollapsed] = useState(false);
  const busy = thinking || running.length > 0 || call;
  const toast = toastMsg
    ? { title: toastMsg.text.split(': ')[0], sub: toastMsg.text.split(': ').slice(1).join(': ') || 'Tap to see what your dots did' }
    : running[0] ? { title: `${running[0].agent} is working`, sub: running[0].goal } : thinking ? { title: 'Thinking in your graph', sub: `Cypher on FalkorDB · ${graph?.nodes ?? '…'} nodes` } : null;
  return (
    <div className={`pet ${collapsed ? 'collapsed' : ''} ${busy ? 'busy' : ''}`}>
      {!collapsed && (
        <button className="pet-ziv" onClick={() => set({ call: !call })} title={call ? 'End call' : 'Talk to Ziv'}>
          <span className="orbit"><i /><i /><i /></span>
          <img src="/dots/ziv.png" width={76} height={76} alt="Ziv" draggable={false} />
        </button>
      )}
      <div className="pet-bar">
        <button title="New dot" onClick={() => set({ newDotOpen: true })}><Icon.plus size={15} /></button>
        <button title={call ? 'End call' : 'Talk'} className={call ? 'live' : ''} onClick={() => set({ call: !call })}><Icon.wave size={15} /></button>
        <button title="Graph" onClick={() => set({ view: 'graph' })}><Icon.graph size={15} /></button>
        <button title={collapsed ? 'Show' : 'Tuck away'} onClick={() => setCollapsed(!collapsed)}><Icon.down size={15} className={collapsed ? 'flip-v' : ''} /></button>
      </div>
      {toast && !collapsed && (
        <button className="pet-toast" onClick={() => set({ view: 'activity' })}>
          <span className="toast-mark"><i /></span>
          <span className="grow"><b>{toast.title}</b><small>{toast.sub}</small></span>
        </button>
      )}
    </div>
  );
}
