import { useSyncExternalStore } from 'react';
import { api, events, type Connector, type Conversation, type Dot, type Message, type Run } from './api';

/** One tiny external store for the whole app, fed by the API and the SSE stream. */

export type View = 'chat' | 'graph' | 'activity';
type Thinking = { dot: string; steps: { label: string; ms: number; rows: number }[]; tool?: string };

export type State = {
  ready: boolean;
  error?: string;
  brain: string;
  profile: { name?: string };
  dots: Dot[];
  conversations: Conversation[];
  presets: { name: string; avatar: string; role: string; color: string }[];
  labels: Record<string, { color: string; icon: string }>;
  pendingDrafts: number;
  active?: string;
  view: View;
  messages: Record<string, Message[]>;
  thinking: Record<string, Record<string, Thinking>>;
  working: Record<string, string[]>;
  runs: Record<string, Run & { log?: string }>;
  connectors: Connector[];
  connectorProgress: Record<string, string>;
  draftStatus: Record<string, { status: string; result?: string }>;
  trace?: string;
  entity?: string;
  file?: { uid: string; name: string };
  connectOpen: boolean;
  newDotOpen: boolean;
  rightOpen: boolean;
  exchange?: { conv: string; name: string };
  toast?: { text: string; at: number };
  /** phone layout: showing the conversation list instead of a chat */
  mobileList: boolean;
  theme: 'dark' | 'light';
  call: boolean;
  customizeOpen: boolean;
};

let state: State = {
  ready: false, brain: '', profile: {}, dots: [], conversations: [], presets: [], labels: {}, pendingDrafts: 0, view: 'chat',
  messages: {}, thinking: {}, working: {}, runs: {}, connectors: [], connectorProgress: {}, draftStatus: {}, connectOpen: false, newDotOpen: false,
  rightOpen: typeof window !== 'undefined' ? window.innerWidth > 1200 : true,
  mobileList: true,
  theme: (() => { try { return (localStorage.getItem('zivbot.theme') as 'dark' | 'light') || 'dark'; } catch { return 'dark'; } })(),
  call: false,
  customizeOpen: false,
};
const subs = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  subs.forEach((f) => f());
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}

// ------------------------------------------------------------------ actions

let reloadTimer: any;
export function reloadState(delay = 0) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const s = await api.state();
    set((st) => ({ ...s, active: st.active && s.conversations.some((c) => c.uid === st.active) ? st.active : s.conversations[s.conversations.length - 1]?.uid }));
  }, delay);
}

export async function boot() {
  try {
    await api.session();
    const s = await api.state();
    const firstDot = s.dots[0];
    set({ ...s, ready: true, active: firstDot?.conv || s.conversations[0]?.uid });
    events(onEvent, () => { reloadState(); const a = get().active; if (a) void openConversation(a); });
    void loadConnectors();
    void api.runs().then((runs) => set({ runs: Object.fromEntries(runs.map((r) => [r.uid, r])) }));
  } catch (e: any) {
    set({ error: e.message, ready: false });
    setTimeout(boot, 3000);
  }
}

export async function loadConnectors() {
  set({ connectors: await api.connectors() });
}

export async function openConversation(conv: string) {
  set({ active: conv, view: 'chat', mobileList: false });
  const r = await api.messages(conv);
  set((s) => ({ messages: { ...s.messages, [conv]: r.messages }, conversations: s.conversations.map((c) => (c.uid === conv ? { ...c, unread: 0 } : c)) }));
}

export async function send(conv: string, text: string) {
  const t = text.trim();
  if (!t) return;
  await api.send(conv, t);
  // If the live stream missed the reply (sleeping laptop, proxy restart), catch up.
  const before = get().messages[conv]?.length || 0;
  for (const ms of [4000, 10000, 25000]) {
    setTimeout(() => {
      if ((get().messages[conv]?.length || 0) <= before + 1) void api.messages(conv).then((r) => set((s) => ({ messages: { ...s.messages, [conv]: r.messages } }))).catch(() => {});
    }, ms);
  }
}

/** Inside the Android/iOS app: hand notifications to the native side. */
export function nativeNotify(text: string, title = 'ZivBot') {
  const rn = (window as any).ReactNativeWebView;
  if (rn) rn.postMessage(JSON.stringify({ type: 'notify', title, text }));
  else if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) new Notification(title, { body: text });
}
if (typeof window !== 'undefined') window.addEventListener('zivbot:back', () => set({ mobileList: true }));

export function toast(text: string) {
  set({ toast: { text, at: Date.now() } });
  setTimeout(() => { if (get().toast?.text === text) set({ toast: undefined }); }, 6000);
}

function onEvent(e: any) {
  switch (e.type) {
    case 'message': {
      const m: Message = e.message;
      set((s) => {
        const list = s.messages[m.conv];
        const next = list ? (list.some((x) => x.uid === m.uid) ? list : [...list, m]) : list;
        return { messages: next ? { ...s.messages, [m.conv]: next } : s.messages };
      });
      if (get().active === m.conv && get().view === 'chat') void api.messages(m.conv).catch(() => {}); // marks read server-side
      reloadState(250);
      if (m.role === 'assistant' && m.proactive) { toast('Ziv found a few things for you'); nativeNotify(m.text.replace(/\*\*/g, '').slice(0, 140), 'Ziv found a few things for you'); }
      break;
    }
    case 'thinking':
      set((s) => {
        const conv = { ...(s.thinking[e.conv] || {}) };
        if (e.on) conv[e.dot] = { dot: e.dot, steps: [] };
        else delete conv[e.dot];
        return { thinking: { ...s.thinking, [e.conv]: conv } };
      });
      break;
    case 'step':
      set((s) => {
        const conv = s.thinking[e.conv];
        const t = conv?.[e.dot];
        if (!t) return {};
        return { thinking: { ...s.thinking, [e.conv]: { ...conv, [e.dot]: { ...t, steps: [...t.steps.slice(-30), { label: e.label, ms: e.ms, rows: e.rows }] } } } };
      });
      break;
    case 'tool':
      set((s) => {
        const conv = s.thinking[e.conv];
        const t = conv?.[e.dot];
        if (!t) return {};
        return { thinking: { ...s.thinking, [e.conv]: { ...conv, [e.dot]: { ...t, tool: e.name } } } };
      });
      break;
    case 'working':
      set((s) => ({ working: { ...s.working, [e.conv]: e.dots } }));
      break;
    case 'run':
      set((s) => ({ runs: { ...s.runs, [e.run.uid]: { ...(s.runs[e.run.uid] || {}), ...e.run } } }));
      if (e.run.status === 'running') toast(`${e.run.agent} started: ${e.run.goal}`);
      else if (e.run.status === 'succeeded') { toast(`${e.run.agent} finished: ${e.run.goal}`); nativeNotify(`${e.run.goal} — tests ${e.run.tests || 'done'}`, `${e.run.agent} finished`); }
      break;
    case 'run.log':
      set((s) => {
        const r = s.runs[e.uid] || ({ uid: e.uid } as any);
        return { runs: { ...s.runs, [e.uid]: { ...r, log: ((r.log || '') + e.chunk).slice(-20000) } } };
      });
      break;
    case 'connector':
      set((s) => ({ connectors: s.connectors.map((c) => (c.id === e.id ? { ...c, status: e.status, counts: e.counts || c.counts, error: e.error } : c)), connectorProgress: { ...s.connectorProgress, [e.id]: e.status === 'syncing' ? 'Starting…' : '' } }));
      if (e.status === 'connected') void loadConnectors();
      break;
    case 'connector.progress':
      set((s) => ({ connectorProgress: { ...s.connectorProgress, [e.id]: e.msg } }));
      break;
    case 'draft':
      set((s) => ({ draftStatus: { ...s.draftStatus, [e.uid]: { status: e.status, result: e.result } } }));
      reloadState(100);
      break;
    case 'dots':
    case 'profile':
      reloadState(50);
      break;
    case 'error':
      toast(e.message);
      break;
  }
}

export const dotByUid = (s: State, uid?: string) => s.dots.find((d) => d.uid === uid);
