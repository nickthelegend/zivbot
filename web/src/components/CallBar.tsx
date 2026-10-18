import { useEffect, useRef, useState } from 'react';
import type { Message } from '../api';
import { useStore, set, get, send } from '../store';
import { Avatar } from './Avatar';

/**
 * Call mode: talk to a Ziv hands-free. Speech recognition listens, a pause sends,
 * and new replies from the Ziv are read aloud (browser speech APIs, no server).
 */
export function CallBar({ conv, name, avatar, color, messages }: { conv: string; name: string; avatar?: string; color?: string; messages: Message[] }) {
  const call = useStore((s) => s.call);
  const [state, setState] = useState<'listening' | 'thinking' | 'speaking'>('listening');
  const [heard, setHeard] = useState('');
  const rec = useRef<any>(null);
  const lastSpoken = useRef<string | null>(null);
  const speaking = useRef(false);

  // remember where the call started so we only read new replies
  useEffect(() => { if (call) lastSpoken.current = messages[messages.length - 1]?.uid || null; }, [call]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!call) { rec.current?.stop(); speechSynthesis.cancel(); return; }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert('Voice calls need Chrome, Edge or Safari.'); set({ call: false }); return; }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e: any) => {
      if (speaking.current) return;
      const res = e.results[e.results.length - 1];
      setHeard(res[0].transcript);
      if (res.isFinal && res[0].transcript.trim()) {
        setState('thinking');
        setHeard('');
        void send(conv, res[0].transcript.trim());
      }
    };
    r.onend = () => { if (useStoreCall()) try { r.start(); } catch { /* already running */ } };
    rec.current = r;
    try { r.start(); } catch { /* */ }
    return () => { r.onend = null; r.stop(); };
  }, [call, conv]);

  // read new assistant replies aloud
  useEffect(() => {
    if (!call) return;
    const idx = messages.findIndex((m) => m.uid === lastSpoken.current);
    const fresh = messages.slice(idx + 1).filter((m) => m.role === 'assistant');
    if (!fresh.length) return;
    lastSpoken.current = messages[messages.length - 1].uid;
    const text = fresh.map((m) => m.text).join('\n').replace(/[*_`#>]/g, '').replace(/\n+/g, '. ').slice(0, 600);
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    speaking.current = true;
    setState('speaking');
    u.onend = () => { speaking.current = false; setState('listening'); };
    speechSynthesis.speak(u);
  }, [messages.length, call]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!call) return null;
  return (
    <div className="call-bar">
      <span className={`call-orb ${state}`}><Avatar avatar={avatar} color={color} size={30} busy={state !== 'listening'} /></span>
      <div className="grow">
        <b>On a call with {name}</b>
        <small>{heard || (state === 'listening' ? 'Listening… just talk' : state === 'thinking' ? 'Working in your graph…' : 'Speaking…')}</small>
      </div>
      <button className="btn end" onClick={() => set({ call: false })}>End</button>
    </div>
  );
}

const useStoreCall = () => get().call;
