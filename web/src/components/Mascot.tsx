import { useEffect, useMemo, useState } from 'react';
import { useStore, set } from '../store';
import { Icon } from './icons';

/**
 * The floating pixel buddy: Ziv with a flame, sitting on its own computer.
 * The flame flickers and the screen scrolls while any dot is working, and a
 * bubble shows what's happening right now.
 */

const ZIV = [
  '......FF........',
  '.....FYF..F.....',
  '....FYYF.FF.....',
  '...FYYYFFYF.....',
  '...FYRYYYYF.....',
  '..OOOOOOOOOO....',
  '.OOOOOOOOOOOO...',
  '.OOWKOOOOWKOO...',
  '.OOKKOOOOKKOO...',
  '.OOOOOOOOOOOO...',
  '.OOOPOOOOPOOO...',
  '..OOOODDOOOO....',
  '...OOOOOOOO.....',
  '...OO....OO.....',
];
const PAL: Record<string, string> = { F: '#ff5a1a', Y: '#ffd23f', R: '#ff2d55', O: '#ff8a3d', W: '#ffffff', K: '#1b1b1b', P: '#ff5f7e', D: '#c2410c' };

const PC = [
  'BBBBBBBBBBBB',
  'BSSSSSSSSSSB',
  'BSGGSSSSGGSB',
  'BSGGSSSSGGSB',
  'BSSSSSSSSSSB',
  'BSSSGGGGSSSB',
  'BSSSSSSSSSSB',
  'BBBBBBBBBBBB',
  '....BBBB....',
  '..BBBBBBBB..',
];

function Sprite({ rows, pal, px }: { rows: string[]; pal: Record<string, string>; px: number }) {
  return (
    <svg width={rows[0].length * px} height={rows.length * px} shapeRendering="crispEdges" aria-hidden>
      {rows.flatMap((r, y) => [...r].map((c, x) => (pal[c] ? <rect key={`${x}-${y}`} x={x * px} y={y * px} width={px} height={px} fill={pal[c]} /> : null)))}
    </svg>
  );
}

export function Mascot() {
  const thinking = useStore((s) => Object.values(s.thinking).some((c) => Object.keys(c).length));
  const runMap = useStore((s) => s.runs);
  const running = useMemo(() => Object.values(runMap).filter((r) => r.status === 'running'), [runMap]);
  const toastMsg = useStore((s) => s.toast);
  const call = useStore((s) => s.call);
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const busy = thinking || running.length > 0 || call;
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), busy ? 160 : 600);
    return () => clearInterval(t);
  }, [busy]);
  const flame = tick % 2 ? ZIV : ZIV.map((r, i) => (i < 5 ? r.replace(/Y/g, 'F').replace(/R/g, 'Y') : r));
  const screen = busy ? { B: '#6b4a2b', S: '#0f766e', G: tick % 3 ? '#5eead4' : '#99f6e4' } : { B: '#6b4a2b', S: '#134e4a', G: '#2dd4bf' };
  const toast = toastMsg
    ? { title: toastMsg.text.split(': ')[0], sub: toastMsg.text.split(': ').slice(1).join(': ') || 'Tap to see what your dots did' }
    : running[0] ? { title: `${running[0].agent} is working`, sub: running[0].goal } : thinking ? { title: 'Thinking in your graph', sub: 'Running Cypher on FalkorDB…' } : null;
  return (
    <>
      <div className={`pet ${collapsed ? 'collapsed' : ''}`}>
        {!collapsed && (
          <div className="pet-ziv" style={{ transform: `translateY(${busy ? (tick % 2 ? -2 : 0) : tick % 4 < 2 ? 0 : -2}px)` }}>
            <Sprite rows={flame} pal={PAL} px={4} />
          </div>
        )}
        <div className="pet-bar">
          <button title="New dot" onClick={() => set({ newDotOpen: true })}><Icon.edit size={15} /></button>
          <button title={call ? 'End call' : 'Talk to your dot'} className={call ? 'live' : ''} onClick={() => set({ call: !call })}><Icon.wave size={15} /></button>
          <button title={collapsed ? 'Show' : 'Hide'} onClick={() => setCollapsed(!collapsed)}><Icon.down size={15} className={collapsed ? 'flip-v' : ''} /></button>
        </div>
        {toast && !collapsed && (
          <button className="pet-toast" onClick={() => set({ view: 'activity' })}>
            <span className="dot-ok"><Icon.check size={10} /></span>
            <span className="grow"><b>{toast.title}</b><small>{toast.sub}</small></span>
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="pet-pc" title="Your dots' computer">
          <Sprite rows={PC} pal={screen} px={5} />
        </div>
      )}
    </>
  );
}
