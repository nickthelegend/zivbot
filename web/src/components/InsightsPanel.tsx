import { useEffect, useState } from 'react';
import { api } from '../api';
import { get, openConversation, send } from '../store';
import { Icon } from './icons';

type Sections = Awaited<ReturnType<typeof api.insights>>;

/** Graph-wide insights: knowledge risk, single points of failure, who's waiting, working groups… */
export function InsightsPanel({ onShow }: { onShow: (uids: string[]) => void }) {
  const [data, setData] = useState<Sections | null>(null);
  useEffect(() => { void api.insights().then(setData); }, []);
  if (!data) return <div className="center-msg"><span className="spinner" /></div>;
  const ask = async (q: string) => {
    const conv = get().dots[0]?.conv;
    if (!conv) return;
    await openConversation(conv);
    void send(conv, q);
  };
  return (
    <div className="insights">
      {data.map((s) => (
        <section key={s.key} className={`insight-card k-${s.key}`}>
          <header>
            <h3>{s.title}</h3>
            <small>{s.blurb}</small>
          </header>
          {s.items.slice(0, 6).map((i, n) => (
            <div key={n} className="insight-item">
              <span className={`sev sev-${i.severity}`} />
              <div className="grow">
                <b>{i.title}</b>
                <small>{i.detail}</small>
              </div>
              <div className="insight-actions">
                <button aria-label="Show in graph" className="icon-btn" title="Show in graph" onClick={() => onShow(i.uids)}><Icon.graph size={15} /></button>
                {i.ask && <button aria-label={`Ask: ${i.ask}`} className="icon-btn" title={`Ask: ${i.ask}`} onClick={() => void ask(i.ask!)}><Icon.chat size={15} /></button>}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
