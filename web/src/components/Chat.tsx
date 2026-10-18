import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type Message, type GraphNode, type GraphEdge } from '../api';
import { ForceGraph } from './ForceGraph';
import { useStore, set, get, send, openConversation } from '../store';
import { Avatar, AvatarStack } from './Avatar';
import { CardView, ExchangeChip, useDotMap } from './Cards';
import { Markdown } from './Markdown';
import { Icon } from './icons';
import { CallBar } from './CallBar';
import { MentionMenu, DotCard, useMentionItems, type MentionItem } from './MentionMenu';

export function Chat() {
  const active = useStore((s) => s.active);
  const conv = useStore((s) => s.conversations.find((c) => c.uid === s.active));
  const messages = useStore((s) => (s.active ? s.messages[s.active] : undefined));
  const thinking = useStore((s) => (s.active ? s.thinking[s.active] : undefined));
  const working = useStore((s) => (s.active ? s.working[s.active] : undefined));
  const dotMap = useDotMap();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { if (active && !messages) void openConversation(active); }, [active, messages]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, thinking && Object.values(thinking).map((t) => t.steps.length).join()]);

  if (!active || !conv) return <div className="chat empty" />;
  const isGroup = conv.kind === 'group';
  const dot = conv.dots[0];
  const onboarding = !isGroup && String(dotMap.get(dot?.uid)?.stage || '').startsWith('onboard');
  const list = messages || [];
  // which option card was answered: the next user message after it
  const answerAfter = (i: number) => list.slice(i + 1).find((m) => m.role === 'user')?.text;
  const lastCardIdx = list.reduce((acc, m, i) => (m.cards?.some((c) => c.type === 'options') ? i : acc), -1);
  const thinkers = Object.values(thinking || {});

  return (
    <div className="chat">
      <div className="chat-top">
        <button className="mobile-back icon-btn round" onClick={() => set({ mobileList: true })} aria-label="Back to chats"><Icon.chevron size={16} className="flip" /></button>
        <button className="conv-pill" onClick={() => set({ rightOpen: true })}>
          {isGroup ? <AvatarStack dots={conv.dots} size={20} /> : <Avatar avatar={dot?.avatar} color={dot?.color} size={22} />}
          <span>{isGroup ? conv.name : dot?.name}</span>
        </button>
      </div>
      <div className="messages" ref={scroller}>
        <div className="messages-inner">
          {list.map((m, i) => (
            <MessageRow key={m.uid} m={m} prev={list[i - 1]} isGroup={isGroup} answered={answerAfter(i)} latest={i === lastCardIdx} />
          ))}
          {thinkers.map((t) => <Thinking key={t.dot} name={dotMap.get(t.dot)?.name || 'Dot'} avatar={dotMap.get(t.dot)} steps={t.steps} tool={t.tool} touched={t.touched} />)}
          {!!working?.length && working.length > 1 && <div className="working-line"><AvatarStack dots={working.map((n) => [...dotMap.values()].find((d) => d.name === n)!).filter(Boolean)} size={16} /> {working[0]}{working.length > 1 ? ` and ${working.length - 1} other${working.length > 2 ? 's' : ''}` : ''} {working.length > 1 ? 'are' : 'is'} working.</div>}
        </div>
      </div>
      <CallBar conv={active} name={isGroup ? conv.name : dot?.name || 'your dot'} avatar={dot?.avatar} color={dot?.color} messages={list} />
      <Composer conv={active} placeholder={onboarding ? 'Type your answer, or talk about something else' : `Message ${isGroup ? conv.name : dot?.name || ''}`} />
    </div>
  );
}

function MessageRow({ m, prev, isGroup, answered, latest }: { m: Message; prev?: Message; isGroup: boolean; answered?: string; latest: boolean }) {
  const dotMap = useDotMap();
  const dot = m.dot ? dotMap.get(m.dot) : undefined;
  const showTime = !prev || m.at - prev.at > 30 * 60_000;
  const time = showTime ? <div className="time-sep">{new Date(m.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div> : null;

  if (m.role === 'system') {
    const ex = m.cards?.find((c) => c.type === 'exchange');
    return <>{time}<div className="system-row">{ex ? <ExchangeChip card={ex as any} /> : m.text}</div></>;
  }
  if (m.role === 'user') {
    return <>{time}<div className="user-row"><div className="user-bubble">{m.text}</div></div></>;
  }
  const showName = isGroup || m.role === 'agent';
  const sameAuthor = prev && prev.dot === m.dot && prev.role === m.role;
  // GrokBot-style: a short question with options renders as one card
  const opts = m.cards?.find((c) => c.type === 'options') as Extract<NonNullable<Message['cards']>[number], { type: 'options' }> | undefined;
  const merged = opts && !opts.question && m.text.length < 240 && m.cards!.length === 1 ? opts : undefined;
  return (
    <>
      {time}
      <div className={`bot-row ${m.proactive ? 'proactive' : ''}`}>
        {isGroup && <span className="bot-avatar">{!sameAuthor && <AvatarWithCard dot={dot} />}</span>}
        <div className="bot-col">
          {showName && !sameAuthor && <div className="bot-name">{dot?.name}{m.proactive && <span className="pill-mini">while you were away</span>}</div>}
          {!showName && m.proactive && <div className="bot-name"><span className="pill-mini">while you were away</span></div>}
          {m.text && !merged && <div className="bubble"><Markdown text={m.text} /></div>}
          {m.cards?.filter((c) => c.type !== 'exchange').map((c, i) => (
            <CardView key={i} card={merged && c === merged ? { ...merged, question: m.text } : c} conv={m.conv} answered={answered} latest={latest} />
          ))}
          {m.answer && (
            <button className="trace-link" onClick={() => set({ trace: m.answer })} title="Show the Cypher and nodes behind this answer">
              <Icon.path size={13} /> Show path
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function AvatarWithCard({ dot }: { dot?: ReturnType<ReturnType<typeof useDotMap>['get']> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // click anywhere else or press Escape to close
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);
  if (!dot) return <Avatar size={26} />;
  return (
    <span ref={ref} className="avatar-card-anchor" onMouseLeave={() => setOpen(false)}>
      <button onClick={() => setOpen(!open)} aria-label={`${dot.name} profile`}><Avatar avatar={dot.avatar} color={dot.color} size={26} /></button>
      {open && <DotCard dot={dot} style={{ position: 'absolute', left: 0, bottom: 34 }} onClose={() => setOpen(false)} />}
    </span>
  );
}

function Thinking({ name, avatar, steps, tool, touched }: { name: string; avatar?: { avatar?: string; color?: string }; steps: { label: string; ms: number; rows: number }[]; tool?: string; touched: string[] }) {
  const visible = steps.slice(-4);
  const [g, setG] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  // redraw the live graph as the touched set grows (throttled)
  useEffect(() => {
    if (!touched.length) return;
    const t = setTimeout(() => void api.graph({ ids: touched.slice(-80) }).then((r) => setG({ nodes: r.nodes.map((n) => ({ ...n, focus: touched.slice(-6).includes(n.id) })), edges: r.edges })).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [touched.length]);
  return (
    <div className="bot-row thinking">
      <div className="bot-col">
        <div className="thinking-head"><Avatar avatar={avatar?.avatar} color={avatar?.color} size={18} busy /> {name} is {tool ? `using ${tool.replace(/_/g, ' ')}` : 'thinking'}<span className="dots"><i /><i /><i /></span></div>
        {g && g.nodes.length > 1 && (
          <div className="live-graph">
            <ForceGraph nodes={g.nodes} edges={g.edges} height={170} labels="none" wheel={false} />
            <span className="live-count">{g.nodes.length} nodes touched</span>
          </div>
        )}
        {visible.length > 0 && (
          <div className="steps">
            {visible.map((s, i) => <div key={i} className="step"><Icon.database size={11} /> {s.label} <small>{s.rows} rows · {s.ms}ms</small></div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ conv, placeholder }: { conv: string; placeholder: string }) {
  const [text, setText] = useState('');
  const graph = useStore((s) => s.graph);
  const brain = useStore((s) => s.brain);
  const [listening, setListening] = useState(false);
  const [menu, setMenu] = useState(false);
  const [caret, setCaret] = useState(0);
  const [mIndex, setMIndex] = useState(0);
  const [mHover, setMHover] = useState<number | undefined>();
  const [mClosed, setMClosed] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const mention = text.slice(0, caret).match(/(^|\s)@([\w .-]{0,30})$/);
  const items = useMentionItems(mention && !mClosed ? mention[2].trimStart() : '\u0000');
  const showMentions = !!mention && !mClosed && items.length > 0;
  useEffect(() => { setMIndex(0); setMHover(undefined); }, [mention?.[2]]);
  const pick = (m: MentionItem) => {
    const start = caret - (mention![2].length + 1);
    const next = `${text.slice(0, start)}@${m.name} ${text.slice(caret)}`;
    setText(next);
    const pos = start + m.name.length + 2;
    setCaret(pos);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(pos, pos); });
  };
  const rec = useRef<any>(null);
  useEffect(() => { ta.current?.focus(); }, [conv]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void send(conv, t);
  };
  const dictate = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return alert('Voice input needs Chrome or Safari.');
    if (listening) { rec.current?.stop(); return; }
    const r = new SR();
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e: any) => setText([...e.results].map((x: any) => x[0].transcript).join(''));
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };
  return (
    <div className="composer-wrap">
      {showMentions && <MentionMenu items={items} index={mIndex} hovered={mHover ?? (items[mIndex]?.kind === 'dot' ? mIndex : undefined)} onHover={(i) => { setMHover(i); setMIndex(i); }} onPick={pick} />}
      <div className="composer">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setMClosed(false); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if (showMentions) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMIndex((mIndex + 1) % items.length); setMHover(undefined); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMIndex((mIndex - 1 + items.length) % items.length); setMHover(undefined); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[mIndex]); return; }
              if (e.key === 'Escape') { setMClosed(true); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        <div className="composer-bar">
        <div className="plus-wrap">
          <button aria-label="More" className="icon-btn round" onClick={() => setMenu(!menu)} title="More"><Icon.plus size={18} /></button>
          {menu && (
            <div className="menu up" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); set({ connectOpen: true }); }}><Icon.bolt size={15} /> Connect apps</button>
              <button onClick={() => { setMenu(false); setText('Remember that '); ta.current?.focus(); }}><Icon.brain size={15} /> Teach me something</button>
              <button onClick={() => { setMenu(false); void send(conv, 'What needs my attention?'); }}><Icon.spark size={15} /> What needs me?</button>
              <button onClick={() => { setMenu(false); set({ view: 'graph' }); }}><Icon.graph size={15} /> Open the graph</button>
            </div>
          )}
        </div>
          <button className="chip-btn" onClick={() => { const pos = ta.current?.selectionStart ?? text.length; const next = `${text.slice(0, pos)}${text && !/\s$/.test(text.slice(0, pos)) ? ' ' : ''}@${text.slice(pos)}`; setText(next); setMClosed(false); const p = pos + (next.length - text.length); setCaret(p); requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(p, p); }); }} title="Mention a dot or plugin">@ Mention</button>
          {graph && <button className="chip-btn info" onClick={() => set({ view: 'graph' })} title={`FalkorDB graph ${graph.graph}`}><i className="pulse" />{graph.nodes.toLocaleString()} nodes</button>}
          <span className="chip-btn info static" title="What the dots think with">{brain === 'graph-planner' ? 'Graph planner' : brain.startsWith('hybrid:') ? `Planner + ${brain.split('/').pop()?.replace(/:free$/, '')}` : brain.replace(/^llm:/, '').split('/').pop()}</span>
          <span className="grow" />
          <button aria-label="Dictate" className={`icon-btn round ${listening ? 'live' : ''}`} onClick={dictate} title="Dictate"><Icon.mic size={17} /></button>
          {text.trim() ? (
            <button className="send-btn" onClick={submit} title="Send"><Icon.send size={17} /></button>
          ) : (
            <button className="send-btn voice" onClick={() => set({ call: !get().call })} title="Talk to your dot"><Icon.wave size={17} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
