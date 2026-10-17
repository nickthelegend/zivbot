import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '../api';
import { useStore, set, get, send, openConversation } from '../store';
import { Avatar, AvatarStack } from './Avatar';
import { CardView, ExchangeChip, useDotMap } from './Cards';
import { Markdown } from './Markdown';
import { Icon } from './icons';
import { CallBar } from './CallBar';

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
          {thinkers.map((t) => <Thinking key={t.dot} name={dotMap.get(t.dot)?.name || 'Dot'} avatar={dotMap.get(t.dot)} steps={t.steps} tool={t.tool} />)}
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
        {isGroup && <span className="bot-avatar">{!sameAuthor && <Avatar avatar={dot?.avatar} color={dot?.color} size={26} />}</span>}
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

function Thinking({ name, avatar, steps, tool }: { name: string; avatar?: { avatar?: string; color?: string }; steps: { label: string; ms: number; rows: number }[]; tool?: string }) {
  const visible = steps.slice(-4);
  return (
    <div className="bot-row thinking">
      <div className="bot-col">
        <div className="thinking-head"><Avatar avatar={avatar?.avatar} color={avatar?.color} size={18} busy /> {name} is {tool ? `using ${tool.replace(/_/g, ' ')}` : 'thinking'}<span className="dots"><i /><i /><i /></span></div>
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
  const [listening, setListening] = useState(false);
  const [menu, setMenu] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
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
      <div className="composer">
        <div className="plus-wrap">
          <button className="icon-btn round" onClick={() => setMenu(!menu)} title="More"><Icon.plus size={18} /></button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); set({ connectOpen: true }); }}><Icon.bolt size={15} /> Connect apps</button>
              <button onClick={() => { setMenu(false); setText('Remember that '); ta.current?.focus(); }}><Icon.brain size={15} /> Teach me something</button>
              <button onClick={() => { setMenu(false); void send(conv, 'What needs my attention?'); }}><Icon.spark size={15} /> What needs me?</button>
              <button onClick={() => { setMenu(false); set({ view: 'graph' }); }}><Icon.graph size={15} /> Open the graph</button>
            </div>
          )}
        </div>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <button className={`icon-btn round ${listening ? 'live' : ''}`} onClick={dictate} title="Dictate"><Icon.mic size={17} /></button>
        {text.trim() ? (
          <button className="send-btn" onClick={submit} title="Send"><Icon.send size={17} /></button>
        ) : (
          <button className="send-btn voice" onClick={() => set({ call: !get().call })} title="Talk to your dot"><Icon.wave size={17} /></button>
        )}
      </div>
    </div>
  );
}
