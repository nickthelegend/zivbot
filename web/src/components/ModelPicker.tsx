import { useEffect, useRef, useState } from 'react';
import { useStore, set } from '../store';
import { modelFor, setModelFor } from '../store';
import { Icon } from './icons';

/** The model menu in the composer: which brain answers in this chat (saved per chat). */
export function ModelPicker({ conv }: { conv: string }) {
  const models = useStore((s) => s.models);
  const [pick, setPick] = useState(() => modelFor(conv));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setPick(modelFor(conv)), [conv]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  const current = models.find((m) => m.id === pick) || models[0];
  const groups = [...new Set(models.map((m) => m.group))];
  return (
    <div className="model-pick" ref={ref}>
      <button className="chip-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Choose the model that answers in this chat">
        <Icon.spark size={13} /> {current?.label || 'Auto'} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu up model-menu" role="menu">
          {groups.map((g) => (
            <div key={g} className="model-group">
              <div className="model-group-title">{g}</div>
              {models.filter((m) => m.group === g).map((m) => (
                <button key={m.id} role="menuitemradio" aria-checked={m.id === current?.id} disabled={!m.available} title={m.reason || m.sub}
                  className={m.id === current?.id ? 'on' : ''}
                  onClick={() => { setModelFor(conv, m.id); setPick(m.id); setOpen(false); set({}); }}>
                  <span className="grow"><span className="model-name">{m.label}</span><span className="model-sub">{m.available ? m.sub : m.reason}</span></span>
                  {m.id === current?.id && <Icon.check size={15} />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
