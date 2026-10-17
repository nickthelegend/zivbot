import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore, set } from '../store';
import { RunCard } from './Cards';
import { AppIcon, Icon } from './icons';

/** Everything the dots did and want to do: approvals, runs on your agents, routing. */
export function ActivityView() {
  const runs = useStore((s) => s.runs);
  const draftStatus = useStore((s) => s.draftStatus);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [fleet, setFleet] = useState<{ agents: any[]; routing: any[] } | null>(null);
  const [rules, setRules] = useState<Awaited<ReturnType<typeof api.rules>> | null>(null);
  const loadRules = () => void api.rules().then(setRules).catch(() => {});
  useEffect(loadRules, []);
  useEffect(() => {
    void api.drafts().then(setDrafts);
    void api.fleet().then(setFleet).catch(() => {});
  }, [draftStatus]);
  const list = Object.values(runs).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const pending = drafts.filter((d) => (draftStatus[d.uid]?.status || d.status) === 'pending');
  return (
    <div className="activity-view">
      <div className="act-col">
        <h2>Waiting on you <small>{pending.length}</small></h2>
        {pending.length === 0 && <div className="muted-line">Nothing to approve. Dots never send, run or book without you.</div>}
        {pending.map((d) => (
          <div key={d.uid} className="act-item">
            <span className="tone tone-amber">{d.kind}</span>
            <div className="grow"><b>{d.title}</b><small>{d.dot} · {d.to || d.when || d.agent || ''}</small></div>
            <button className="btn primary sm" onClick={() => void api.approve(d.uid).then(() => set((s) => ({ draftStatus: { ...s.draftStatus, [d.uid]: { status: 'done' } } })))}>Approve</button>
          </div>
        ))}
        <h2>History</h2>
        {drafts.filter((d) => (draftStatus[d.uid]?.status || d.status) !== 'pending').slice(0, 12).map((d) => (
          <div key={d.uid} className="act-item dim">
            <span className={`tone tone-${(draftStatus[d.uid]?.status || d.status) === 'done' ? 'green' : 'gray'}`}>{draftStatus[d.uid]?.status || d.status}</span>
            <div className="grow"><b>{d.title}</b><small>{d.result || d.kind}</small></div>
          </div>
        ))}
      </div>
      <div className="act-col wide">
        <h2>Runs on your agents</h2>
        {list.length === 0 && <div className="muted-line">No runs yet.</div>}
        {list.slice(0, 12).map((r) => (r.synthetic ? (
          <div key={r.uid} className="act-item dim">
            <span className={`tone tone-${r.status === 'succeeded' ? 'green' : 'red'}`}>{r.status}</span>
            <div className="grow"><b>{r.goal}</b><small>{r.agent} · demo history</small></div>
          </div>
        ) : <RunCard key={r.uid} uid={r.uid} />))}
      </div>
      <div className="act-col">
        <h2>Watch rules <small>{rules?.rules.length ?? 0}</small></h2>
        <div className="muted-line">Graph patterns your dots check in the background — they speak up the moment one matches.</div>
        {rules?.rules.map((r) => (
          <div key={r.uid} className={`act-item rule ${r.active ? '' : 'dim'}`}>
            <span className="tone tone-amber">rule</span>
            <div className="grow"><b>{r.title}</b><small>{r.says} · fired {r.fired}×{r.dot ? ` · ${r.dot}` : ''}</small></div>
            <button className={`switch ${r.active ? 'on' : ''}`} onClick={() => void api.setRule(r.uid, !r.active).then(loadRules)} aria-label="toggle"><i /></button>
          </div>
        ))}
        <div className="rule-add">
          {rules && Object.entries(rules.kinds).filter(([k]) => !rules.rules.some((r) => r.kind === k)).map(([k, v]) => (
            <button key={k} onClick={() => void api.addRule(k).then(loadRules)}><Icon.plus size={12} /> {v.title}</button>
          ))}
          {rules && rules.rules.length > 0 && <button onClick={() => void api.runRules().then(loadRules)}><Icon.refresh size={12} /> Check now</button>}
        </div>
        <h2>Your agent fleet</h2>
        <div className="muted-line">Routing for <code>payments-api</code> — scored by one Cypher query over past runs, quota and your preferences.</div>
        {fleet?.routing.map((c: any, i: number) => (
          <div key={c.kind} className={`fleet-row ${!c.installed ? 'dim' : ''}`}>
            <span className="rank">{i + 1}</span>
            <AppIcon slug={({ codex: 'openai', 'claude-code': 'claude', cursor: 'cursor', opencode: 'opencode', grok: 'x', antigravity: 'google' } as any)[c.kind]} size={26} />
            <div className="grow"><b>{c.name}</b><small>{c.reasons.join(' · ')}</small></div>
            <span className="score">{c.score > -50 ? c.score.toFixed(1) : '—'}</span>
          </div>
        ))}
        <button className="btn ghost sm" onClick={() => set({ connectOpen: true })}><Icon.plus size={14} /> Connect another agent</button>
      </div>
    </div>
  );
}
