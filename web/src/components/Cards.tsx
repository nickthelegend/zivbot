import { useEffect, useMemo, useState } from 'react';
import { api, type Card, type Draft, type GraphEdge, type GraphNode } from '../api';
import { useStore, set, send, toast } from '../store';
import { AppIcon, Icon } from './icons';
import { Avatar } from './Avatar';
import { ForceGraph } from './ForceGraph';
import { Markdown } from './Markdown';

export function CardView({ card, conv, answered, latest }: { card: Card; conv: string; answered?: string; latest: boolean }) {
  switch (card.type) {
    case 'options': return <OptionsCard card={card} conv={conv} answered={answered} latest={latest} />;
    case 'connectors': return <ConnectorsCard />;
    case 'list': return <ListCard card={card} />;
    case 'draft': return <DraftCard draft={card.draft} />;
    case 'run': return <RunCard uid={card.runUid} />;
    case 'graph': return <GraphCard card={card} />;
    case 'agents': return <AgentsCard />;
    case 'note': return <div className="note-chip"><Icon.check size={14} /> {card.text}</div>;
    case 'file': return <FileCard card={card} />;
    case 'exchange': return null;
  }
}

function OptionsCard({ card, conv, answered, latest }: { card: Extract<Card, { type: 'options' }>; conv: string; answered?: string; latest: boolean }) {
  const [picked, setPicked] = useState<string | undefined>();
  const chosen = picked || answered;
  const disabled = !!chosen || !latest;
  return (
    <div className="options-card">
      {card.question && <div className="options-q">{card.question}</div>}
      {card.options.map((o) => (
        <button
          key={o.key}
          className={`option ${chosen === o.value ? 'chosen' : ''}`}
          disabled={disabled && chosen !== o.value}
          onClick={() => { if (disabled) return; setPicked(o.value); void send(conv, o.value); }}
        >
          <kbd>{o.key}</kbd>
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function ConnectorsCard() {
  const connectors = useStore((s) => s.connectors);
  const progress = useStore((s) => s.connectorProgress);
  const demo = connectors.find((c) => c.id === 'demo');
  const connected = connectors.filter((c) => c.status === 'connected' && !c.id.startsWith('agent-'));
  const agents = connectors.filter((c) => c.id.startsWith('agent-') && c.status === 'connected');
  const syncing = demo?.status === 'syncing';
  return (
    <div className="connector-card">
      <div className="connector-row">
        <AppIcon slug="zivbot" size={40} />
        <div className="grow">
          <div className="row-title">Lumen Labs workspace <span className="pill-mini">demo</span></div>
          <div className="row-sub">
            {demo?.status === 'connected' ? `Connected · Gmail, Calendar, Slack, Notion, Linear, Git` : syncing ? progress.demo || 'Connecting…' : 'Synthetic company · mail, calendar, Slack, Notion, Linear, git'}
          </div>
        </div>
        {demo?.status === 'connected' ? (
          <span className="ok-tag"><Icon.check size={14} /> Connected</span>
        ) : (
          <button className="btn primary sm" disabled={syncing} onClick={() => void api.connect('demo').catch((e) => toast(e.message))}>{syncing ? 'Connecting…' : 'Connect'}</button>
        )}
      </div>
      <div className="connector-row">
        <span className="icon-stack">{['gmail', 'slack', 'notion', 'linear', 'github'].map((s) => <AppIcon key={s} slug={s} size={22} />)}</span>
        <div className="grow"><div className="row-sub">{connected.length} apps · {agents.length} agent subscriptions connected</div></div>
        <button className="btn ghost sm" onClick={() => set({ connectOpen: true })}>Browse apps</button>
      </div>
      <div className="fine">Ziv always asks before making changes. Disconnect at any time.</div>
    </div>
  );
}

function ListCard({ card }: { card: Extract<Card, { type: 'list' }> }) {
  if (!card.items.length) return null;
  return (
    <div className="list-card">
      {card.title && <div className="list-title">{card.title}</div>}
      {card.items.map((it, i) => (
        <button key={i} className="list-item" onClick={() => it.uid && set({ entity: it.uid })}>
          <span className={`tone tone-${it.tone || 'gray'}`}>{it.badge}</span>
          <span className="grow">
            <span className="li-title">{it.title}</span>
            {it.subtitle && <span className="li-sub">{it.subtitle}</span>}
          </span>
          <Icon.chevron size={14} />
        </button>
      ))}
    </div>
  );
}

const AGENT_SLUG: Record<string, string> = { codex: 'openai', 'claude-code': 'claude', cursor: 'cursor', opencode: 'opencode', grok: 'x', antigravity: 'google' };

function DraftCard({ draft }: { draft: Draft }) {
  const live = useStore((s) => s.draftStatus[draft.uid]);
  const status = live?.status || draft.status;
  const [body, setBody] = useState(draft.body || '');
  const [editing, setEditing] = useState(false);
  const [agent, setAgent] = useState(draft.agent);
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const done = status !== 'pending';
  const approve = async () => {
    setBusy(true);
    try {
      const r = await api.approve(draft.uid, { body: draft.kind === 'email' ? body : undefined, agent });
      set((s) => ({ draftStatus: { ...s.draftStatus, [draft.uid]: { status: r.status, result: r.result } } }));
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const head = { email: 'Email draft', event: 'Calendar invite', run: 'Coding job', decision: 'Decision', mcp: 'App action' }[draft.kind];
  return (
    <div className={`draft-card ${done ? 'done' : ''}`}>
      <div className="draft-head">
        <span className="draft-kind">{draft.kind === 'run' ? <Icon.terminal size={14} /> : draft.kind === 'event' ? <Icon.bell size={14} /> : draft.kind === 'mcp' ? <Icon.bolt size={14} /> : <Icon.edit size={14} />} {head}</span>
        <span className={`status-tag s-${status}`}>{status === 'pending' ? 'Needs your approval' : status === 'done' ? 'Approved' : status}</span>
      </div>
      <div className="draft-title">{draft.title}</div>
      {draft.to && <div className="draft-meta"><span>To</span> {draft.to}</div>}
      {draft.when && <div className="draft-meta"><span>When</span> {draft.when}</div>}
      {draft.detail && <div className="draft-meta"><span>Where</span> {draft.detail}</div>}
      {draft.kind === 'email' && (editing && !done
        ? <textarea className="draft-body" value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(14, body.split('\n').length + 2)} />
        : <div className="draft-body"><Markdown text={body} /></div>)}
      {draft.kind === 'mcp' && draft.body && <pre className="draft-args">{draft.body}</pre>}
      {draft.kind === 'run' && draft.choices && (
        <div className="agent-choices">
          <div className="choices-label">Picked from your subscriptions by graph history — tap to switch</div>
          {draft.choices.slice(0, 4).map((c) => (
            <button key={c.kind} className={`agent-choice ${agent === c.kind ? 'on' : ''} ${!c.installed ? 'off' : ''}`} disabled={done || !c.installed} onClick={() => setAgent(c.kind)}>
              <AppIcon slug={AGENT_SLUG[c.kind] || 'zivbot'} size={26} />
              <span className="grow"><b>{c.name}</b><small>{c.reasons.join(' · ')}</small></span>
              <span className="score">{c.score > -50 ? c.score.toFixed(1) : '—'}</span>
            </button>
          ))}
          <button className="link-btn" onClick={() => setShowPrompt(!showPrompt)}>{showPrompt ? 'Hide' : 'Show'} the brief Ziv wrote from the graph</button>
          {showPrompt && <pre className="draft-args">{draft.body}</pre>}
        </div>
      )}
      {live?.result && <div className="draft-result"><Icon.check size={14} /> {live.result}</div>}
      {!done && (
        <div className="draft-actions">
          <button className="btn primary" disabled={busy} onClick={approve}>{busy ? 'Working…' : draft.kind === 'email' ? 'Approve & send' : draft.kind === 'run' ? `Approve & run ${draft.choices?.find((c) => c.kind === agent)?.name || ''}` : 'Approve'}</button>
          {draft.kind === 'email' && <button className="btn ghost" onClick={() => setEditing(!editing)}>{editing ? 'Preview' : 'Edit'}</button>}
          <button className="btn ghost" onClick={() => void api.reject(draft.uid).then(() => set((s) => ({ draftStatus: { ...s.draftStatus, [draft.uid]: { status: 'rejected' } } })))}>Discard</button>
        </div>
      )}
    </div>
  );
}

export function RunCard({ uid }: { uid: string }) {
  const run = useStore((s) => s.runs[uid]);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!run?.log && run?.status !== 'running') void api.run(uid).then((r) => set((s) => ({ runs: { ...s.runs, [uid]: { ...s.runs[uid], ...r } } }))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, run?.status]);
  if (!run) return <div className="run-card"><span className="spinner" /> Starting…</div>;
  const st = run.status;
  return (
    <div className={`run-card st-${st}`}>
      <div className="run-head">
        <AppIcon slug={AGENT_SLUG[run.agentKind || (run as any).kind] || 'zivbot'} size={26} />
        <div className="grow">
          <b>{run.goal}</b>
          <small>{run.agent} · {st === 'running' ? 'running on Ziv’s computer…' : st}{run.tests ? ` · tests ${run.tests}` : ''}{run.branch ? ` · ${run.branch}` : ''}</small>
        </div>
        {st === 'running' ? <span className="spinner" /> : st === 'succeeded' ? <span className="ok-tag"><Icon.check size={14} /> Done</span> : <span className="bad-tag">{st}</span>}
        <button className="icon-btn" onClick={() => setOpen(!open)}><Icon.down size={16} /></button>
      </div>
      {open && (run.log || run.diff) && <pre className="run-log">{(run.log || '').split('\n').slice(-18).join('\n')}{run.diff ? `\n${run.diff}` : ''}</pre>}
    </div>
  );
}

function GraphCard({ card }: { card: Extract<Card, { type: 'graph' }> }) {
  const [g, setG] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const key = (card.focus || []).join(',');
  useEffect(() => { if (card.focus?.length) void api.graph({ focus: card.focus }).then(setG).catch(() => {}); }, [key]);
  if (!g || !g.nodes.length) return null;
  return (
    <div className="graph-card">
      <div className="graph-card-head">
        <span><Icon.graph size={14} /> {card.title || 'From your graph'}</span>
        <small>{g.nodes.length} nodes · {g.edges.length} edges</small>
      </div>
      <ForceGraph nodes={g.nodes} edges={g.edges} height={230} wheel={false} onNodeClick={(n) => set({ entity: n.id })} />
    </div>
  );
}

function AgentsCard() {
  const all = useStore((s) => s.connectors);
  const connectors = useMemo(() => all.filter((c) => c.id.startsWith('agent-')), [all]);
  return (
    <div className="list-card">
      {connectors.map((c) => (
        <div key={c.id} className="list-item static">
          <AppIcon slug={c.icon} size={26} />
          <span className="grow"><span className="li-title">{c.name}</span><span className="li-sub">{c.status === 'connected' ? `Installed · ${c.version || ''}` : 'Not installed on this computer'}</span></span>
          <span className={`tone tone-${c.status === 'connected' ? 'green' : 'gray'}`}>{c.status === 'connected' ? 'ready' : 'missing'}</span>
        </div>
      ))}
    </div>
  );
}

function FileCard({ card }: { card: Extract<Card, { type: 'file' }> }) {
  return (
    <button className="file-card" onClick={() => set({ file: { uid: card.uid, name: card.name } })}>
      <span className="file-icon"><Icon.file size={22} /></span>
      <span><b>{card.name}</b><small>{(card.size / 1024).toFixed(1)}kB</small></span>
    </button>
  );
}

export function ExchangeChip({ card }: { card: Extract<Card, { type: 'exchange' }> }) {
  return (
    <button className="exchange-chip" onClick={() => set({ exchange: { conv: card.conv, name: card.with.name } })}>
      {card.verb === 'messaged' ? 'Messaged' : `${card.count} messages with`}
      <Avatar avatar={card.with.avatar} color={card.with.color} size={16} />
      {card.with.name}
    </button>
  );
}

export function useDotMap() {
  const dots = useStore((s) => s.dots);
  return useMemo(() => new Map(dots.map((d) => [d.uid, d])), [dots]);
}
