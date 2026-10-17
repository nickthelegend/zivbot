import { useEffect, useMemo, useState } from 'react';
import { useStore, set } from '../store';

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
  const [tick, setTick] = useState(0);
  const busy = thinking || running.length > 0;
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), busy ? 160 : 600);
    return () => clearInterval(t);
  }, [busy]);
  const flame = tick % 2 ? ZIV : ZIV.map((r, i) => (i < 5 ? r.replace(/Y/g, 'F').replace(/R/g, 'Y') : r));
  const screen = busy ? { B: '#6b4a2b', S: '#0f766e', G: tick % 3 ? '#5eead4' : '#99f6e4' } : { B: '#6b4a2b', S: '#134e4a', G: '#2dd4bf' };
  const bubble = toastMsg?.text || (running[0] ? `${running[0].agent} is working on ${running[0].goal}` : thinking ? 'Thinking in the graph…' : '');
  return (
    <div className={`mascot ${busy ? 'busy' : ''}`}>
      {bubble && (
        <button className="mascot-bubble" onClick={() => set({ view: 'activity' })}>
          <span className="dot-ok" />
          <span><b>{running[0] ? 'Working' : toastMsg ? 'Update' : 'Thinking'}</b><br /><small>{bubble}</small></span>
        </button>
      )}
      <div className="mascot-ziv" style={{ transform: `translateY(${busy ? (tick % 2 ? -2 : 0) : tick % 4 < 2 ? 0 : -2}px)` }}>
        <Sprite rows={flame} pal={PAL} px={4} />
      </div>
      <div className="mascot-pc" title="Ziv's computer">
        <Sprite rows={PC} pal={screen} px={5} />
      </div>
    </div>
  );
}
