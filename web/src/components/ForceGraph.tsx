import { useEffect, useRef, useState } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import type { GraphEdge, GraphNode } from '../api';
import { useStore } from '../store';

type N = GraphNode & SimulationNodeDatum & { r: number; color: string };
type E = { source: N; target: N; type: string };

const COMMUNITY = ['#f59e0b', '#22d3ee', '#a78bfa', '#34d399', '#fb7185', '#facc15', '#60a5fa', '#f472b6', '#4ade80', '#c084fc'];

export function ForceGraph({
  nodes, edges, height = 260, onNodeClick, labels = 'auto', sizeBy = 'degree', colorBy = 'label', selected, dim, wheel = true, spread = 1,
}: {
  nodes: GraphNode[]; edges: GraphEdge[]; height?: number | string; onNodeClick?: (n: GraphNode) => void;
  labels?: 'auto' | 'all' | 'none'; sizeBy?: 'degree' | 'rank'; colorBy?: 'label' | 'community'; selected?: string; dim?: Set<string>; wheel?: boolean; spread?: number;
}) {
  const meta = useStore((s) => s.labels);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<N | null>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const sim = useRef<{ nodes: N[]; edges: E[] } | null>(null);
  const draw = useRef<() => void>(() => {});
  // re-layout when the container really changes size (window resize, panel open/close)
  const [size, setSize] = useState('');
  const lastSize = useRef('');
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width / 40), h = Math.round(e.contentRect.height / 40);
      const k = `${w}x${h}`;
      if (lastSize.current && lastSize.current !== k) setSize(k);
      lastSize.current = k;
    });
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current!;
    const w = wrap.current!.clientWidth;
    const h = wrap.current!.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    el.width = w * dpr;
    el.height = h * dpr;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    const deg = new Map<string, number>();
    for (const e of edges) { deg.set(e.source, (deg.get(e.source) || 0) + 1); deg.set(e.target, (deg.get(e.target) || 0) + 1); }
    const ranks = nodes.map((n) => n.rank || 0);
    const maxRank = Math.max(...ranks, 0.0001);
    const ns: N[] = nodes.map((n) => {
      const d = deg.get(n.id) || 0;
      const base = sizeBy === 'rank' && n.rank ? 4 + 14 * (n.rank / maxRank) : 3.5 + Math.min(10, Math.sqrt(d) * 2.2);
      const color = colorBy === 'community' && n.label === 'Person' && n.community != null ? COMMUNITY[Math.abs(n.community) % COMMUNITY.length] : meta[n.label]?.color || '#9ca3af';
      return { ...n, r: n.focus ? base + 3 : base, color };
    });
    const byId = new Map(ns.map((n) => [n.id, n]));
    const es: E[] = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)!, type: e.type }));
    sim.current = { nodes: ns, edges: es };
    view.current = { x: w / 2, y: h / 2, k: nodes.length > 200 ? 0.55 : nodes.length > 60 ? 0.8 : 1 };
    const ctx = el.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--text').trim() || '#eee';
    const line = css.getPropertyValue('--graph-edge').trim() || 'rgba(255,255,255,0.12)';

    draw.current = () => {
      const { x, y, k } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(x, y);
      ctx.scale(k, k);
      ctx.lineWidth = 1 / k;
      for (const e of es) {
        const faded = dim && (dim.has(e.source.id) || dim.has(e.target.id));
        ctx.strokeStyle = selected && (e.source.id === selected || e.target.id === selected) ? 'rgba(255,138,61,0.8)' : line;
        ctx.globalAlpha = faded ? 0.15 : 1;
        ctx.beginPath();
        ctx.moveTo(e.source.x!, e.source.y!);
        ctx.lineTo(e.target.x!, e.target.y!);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const n of ns) {
        ctx.globalAlpha = dim?.has(n.id) ? 0.2 : 1;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.fill();
        if (n.focus || n.id === selected || n === hover) {
          ctx.lineWidth = 2 / k;
          ctx.strokeStyle = fg;
          ctx.stroke();
          ctx.lineWidth = 1 / k;
        }
      }
      ctx.globalAlpha = 1;
      const showAll = labels === 'all' || (labels === 'auto' && ns.length <= 45);
      ctx.font = `${11 / Math.max(k, 0.7)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      for (const n of ns) {
        if (labels === 'none' && n !== hover) continue;
        if (!(showAll || n.focus || n.id === selected || n === hover || n.r > 10)) continue;
        if (dim?.has(n.id) && n !== hover) continue;
        const name = (n.name || n.id).length > 28 ? (n.name || n.id).slice(0, 27) + '…' : n.name || n.id;
        ctx.fillStyle = fg;
        ctx.globalAlpha = 0.9;
        ctx.fillText(name, n.x!, n.y! + n.r + 11 / Math.max(k, 0.7));
      }
      ctx.globalAlpha = 1;
    };

    const s = forceSimulation(ns)
      .force('link', forceLink(es as any).distance((ns.length > 150 ? 34 : 54) * spread).strength(0.6 / spread))
      .force('charge', forceManyBody().strength((ns.length > 150 ? -60 : -160) * spread * spread))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(0.04))
      .force('y', forceY(0).strength(0.06))
      .force('collide', forceCollide<N>().radius((n) => n.r + 3))
      .on('tick', () => draw.current());
    if (ns.length > 300) s.alphaDecay(0.05);
    return () => { s.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, sizeBy, colorBy, meta, spread, size]);

  useEffect(() => { draw.current(); }, [hover, selected, dim, labels]);

  const toGraph = (ev: { clientX: number; clientY: number }) => {
    const rect = canvas.current!.getBoundingClientRect();
    const { x, y, k } = view.current;
    return { gx: (ev.clientX - rect.left - x) / k, gy: (ev.clientY - rect.top - y) / k };
  };
  const pick = (ev: { clientX: number; clientY: number }) => {
    const { gx, gy } = toGraph(ev);
    let best: N | null = null;
    let bd = Infinity;
    for (const n of sim.current?.nodes || []) {
      const d = Math.hypot(n.x! - gx, n.y! - gy);
      if (d < n.r + 6 && d < bd) { bd = d; best = n; }
    }
    return best;
  };
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  return (
    <div ref={wrap} className="force-graph" style={{ height }}>
      <canvas
        ref={canvas}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false }; }}
        onMouseMove={(e) => {
          if (drag.current) {
            const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
            view.current.x = drag.current.vx + dx;
            view.current.y = drag.current.vy + dy;
            draw.current();
          } else setHover(pick(e));
        }}
        onMouseUp={(e) => {
          const moved = drag.current?.moved;
          drag.current = null;
          if (!moved) { const n = pick(e); if (n) onNodeClick?.(n); }
        }}
        onMouseLeave={() => { drag.current = null; setHover(null); }}
        onWheel={(e) => {
          if (!wheel && !e.ctrlKey && !e.metaKey) return;
          const rect = canvas.current!.getBoundingClientRect();
          const mx = e.clientX - rect.left, my = e.clientY - rect.top;
          const v = view.current;
          const k2 = Math.min(4, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.12 : 0.89)));
          v.x = mx - ((mx - v.x) * k2) / v.k;
          v.y = my - ((my - v.y) * k2) / v.k;
          v.k = k2;
          draw.current();
        }}
        style={{ cursor: hover ? 'pointer' : 'grab' }}
      />
      {hover && (
        <div className="graph-tip">
          <span className="chip-dot" style={{ background: hover.color }} />
          <b>{hover.name}</b> <small>{hover.label}{hover.status ? ` · ${hover.status}` : ''}{hover.rank ? ` · PR ${hover.rank.toFixed(3)}` : ''}</small>
        </div>
      )}
    </div>
  );
}
