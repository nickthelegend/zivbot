// Thin client for the ZivBot API. The user id is a local, random id kept in
// localStorage; each id maps to its own FalkorDB graph on the server.

export type Card =
  | { type: 'options'; question?: string; options: { key: string; label: string; value: string }[] }
  | { type: 'connectors' }
  | { type: 'list'; title?: string; items: { title: string; subtitle?: string; uid?: string; badge?: string; tone?: string }[] }
  | { type: 'draft'; draft: Draft }
  | { type: 'run'; runUid: string }
  | { type: 'graph'; title?: string; focus?: string[] }
  | { type: 'agents' }
  | { type: 'note'; text: string }
  | { type: 'customize' }
  | { type: 'timeline'; title: string; items: { uid: string; at: number; label: string; name: string; who?: string; rel: string; hop: number }[] }
  | { type: 'file'; uid: string; name: string; size: number }
  | { type: 'exchange'; conv: string; with: { uid: string; name: string; avatar?: string; color?: string }; count: number; verb: 'messaged' | 'with' };

export type Draft = {
  uid: string; kind: 'email' | 'event' | 'run' | 'decision' | 'mcp' | 'reassign' | 'merge'; status: string; title: string;
  to?: string; subject?: string; body?: string; when?: string; agent?: string; detail?: string;
  choices?: { agent: string; kind: string; name: string; score: number; reasons: string[]; installed: boolean }[];
};

export type Message = { uid: string; conv: string; role: 'user' | 'assistant' | 'system' | 'agent'; text: string; cards?: Card[]; at: number; answer?: string; dot?: string; proactive?: boolean };
export type Dot = { uid: string; name: string; avatar: string; role: string; stage?: string; color?: string; conv: string; lastText?: string; lastAt?: number };
export type Conversation = { uid: string; kind: 'direct' | 'group'; name: string; dots: { uid: string; name: string; avatar: string; color?: string; stage?: string }[]; lastText?: string; lastAt?: number; lastRole?: string; lastBy?: string; unread: number; createdAt: number };
export type GraphNode = { id: string; label: string; name: string; rank?: number; criticality?: number; status?: string; priority?: string; community?: number; focus?: boolean };
export type GraphEdge = { source: string; target: string; type: string };
export type Connector = {
  id: string; name: string; category: string; description: string; icon: string; auth: 'none' | 'key' | 'local' | 'demo'; recommended: boolean;
  fields: { key: string; label: string; secret: boolean; placeholder?: string; optional: boolean; env?: string; help?: string }[];
  configured: Record<string, boolean>; actions: { name: string; description: string; mutates: boolean }[];
  status: string; mode?: string; lastSync?: number; counts?: Record<string, number | string>; error?: string; version?: string;
};
export type Run = { uid: string; goal: string; status: string; startedAt: number; endedAt?: number; tests?: string; branch?: string; agent: string; agentKind: string; tickets: string[]; synthetic?: boolean; kind?: string; log?: string; diff?: string };

const KEY = 'zivbot.user';
export let userId: string | null = (() => {
  // ?pair=<id> (from the desktop's QR code) adopts that user's graph on this device
  const pair = new URLSearchParams(location.search).get('pair');
  try {
    if (pair && /^[a-zA-Z0-9_-]{6,64}$/.test(pair)) { localStorage.setItem(KEY, pair); history.replaceState(null, '', location.pathname); }
    return localStorage.getItem(KEY);
  } catch { return pair; }
})();

export const API_BASE: string = (window as any).ZIVBOT_API || '';

async function req<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(API_BASE + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-ziv-user': userId } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok && r.status !== 202) throw Object.assign(new Error(data.error || r.statusText), { data });
  return data as T;
}

export const api = {
  async session() {
    const s = await req<{ id: string; created: boolean }>('/api/session', { userId });
    userId = s.id;
    try { localStorage.setItem(KEY, s.id); } catch { /* private mode */ }
    return s;
  },
  reset() { try { localStorage.removeItem(KEY); } catch { /* */ } userId = null; },
  health: () => req<{ ok: boolean; falkordb: string; brain: string }>('/api/health'),
  state: () => req<{ dots: Dot[]; conversations: Conversation[]; profile: { name?: string }; pendingDrafts: number; brain: string; presets: { name: string; avatar: string; role: string; color: string }[]; labels: Record<string, { color: string; icon: string }> }>('/api/state'),
  messages: (conv: string) => req<{ conversation: { uid: string; kind: string; name: string; dots: any[] }; messages: Message[] }>(`/api/conversations/${conv}/messages`),
  send: (conv: string, text: string) => req(`/api/conversations/${conv}/messages`, { text }),
  connectors: () => req<Connector[]>('/api/connectors'),
  connect: (id: string, values: Record<string, string> = {}) => req<{ ok: boolean; counts?: any; error?: string; missing?: string[] }>(`/api/connectors/${id}/connect`, values),
  disconnect: (id: string) => req(`/api/connectors/${id}/disconnect`, {}),
  approve: (id: string, edits: { body?: string; agent?: string } = {}) => req<{ status: string; result?: string }>(`/api/drafts/${id}/approve`, edits),
  reject: (id: string) => req(`/api/drafts/${id}/reject`, {}),
  drafts: () => req<any[]>('/api/drafts'),
  runs: () => req<Run[]>('/api/runs'),
  run: (id: string) => req<Run>(`/api/runs/${id}`),
  skills: () => req<{ nodes: GraphNode[]; edges: (GraphEdge & { score: number; wins: number; losses: number })[] }>('/api/fleet/skills'),
  fleet: () => req<{ agents: any[]; routing: any[] }>('/api/fleet'),
  graph: (q: { focus?: string[]; ids?: string[]; labels?: string[]; limit?: number; rel?: string } = {}) =>
    req<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/graph?${new URLSearchParams({ ...(q.focus ? { focus: q.focus.join(',') } : {}), ...(q.ids ? { ids: q.ids.join(',') } : {}), ...(q.labels?.length ? { labels: q.labels.join(',') } : {}), ...(q.limit ? { limit: String(q.limit) } : {}), ...(q.rel ? { rel: q.rel } : {}) })}`),
  answer: (id: string) => req<{ question: string; mode: string; tools: string[]; dot: string; delegatedTo: string[]; queries: { label: string; cypher: string; params: any; ms: number; rows: number; internal?: boolean; dot?: string; error?: string }[]; nodes: GraphNode[]; edges: GraphEdge[]; at: number }>(`/api/answers/${id}`),
  entity: (uid: string) => req<{ text: string; node: any; neighbours: any[] }>(`/api/entity/${encodeURIComponent(uid)}`),
  stats: () => req<{ graph: string; labels: { label: string; n: number }[]; rels: { type: string; n: number }[]; nodes: number; edges: number; graphs: number }>('/api/stats'),
  memory: () => req<{ uid: string; kind: string; text: string; at: number; about: string[] }[]>('/api/memory'),
  outputs: () => req<{ uid: string; name: string; size: number; at: number; dot: string }[]>('/api/outputs'),
  file: async (uid: string) => (await fetch(`${API_BASE}/api/files/${uid}`, { headers: { 'x-ziv-user': userId || '' } })).text(),
  cypher: (cypher: string) => req<{ rows: any[]; text: string }>('/api/cypher', { cypher }),
  createDot: (b: { preset?: string; name?: string; role?: string; avatar?: string; color?: string }) => req<{ dot: string; conv: string }>('/api/dots', b),
  updateDot: (id: string, b: { name?: string; role?: string; avatar?: string; color?: string }) => req(`/api/dots/${id}`, b, 'PATCH'),
  createGroup: (dots: string[], name?: string) => req<{ conv: string }>('/api/groups', { dots, name }),
  scan: () => req('/api/scan', {}),
  search: (q: string) => req<{ uid: string; name: string; label: string; score: number }[]>(`/api/search?q=${encodeURIComponent(q)}`),
  algorithms: () => req<Record<string, { title: string; what: string; defaults: { label?: string; rel?: string }; needs?: string[] }>>('/api/algorithms'),
  runAlgorithm: (b: { algorithm: string; label?: string; rel?: string; source?: string; target?: string; depth?: number; direction?: string }) =>
    req<{ title: string; what: string; label?: string; rel?: string; summary: string; rows: { uid: string; name: string; label: string; score?: number; group?: number }[]; paths?: { uids: string[]; names: string[]; weight: number }[] }>('/api/algorithms/run', b),
  schema: () => req<{ triples: { from: string; rel: string; to: string; n: number }[]; labels: { label: string; n: number }[]; indexes: { label: string; properties: string[]; types: Record<string, string[]> }[] }>('/api/schema'),
  rules: () => req<{ rules: { uid: string; kind: string; title: string; says: string; active: boolean; dot?: string; fired: number; lastFired?: number }[]; kinds: Record<string, { title: string; says: string; defaults: Record<string, number> }> }>('/api/rules'),
  addRule: (kind: string) => req<{ uid: string; fired: any[] }>('/api/rules', { kind }),
  setRule: (uid: string, active: boolean) => req(`/api/rules/${uid}/active`, { active }),
  runRules: () => req<any[]>('/api/rules/run', {}),
  insights: () => req<{ key: string; title: string; blurb: string; items: { title: string; detail: string; uids: string[]; severity: 'high' | 'medium' | 'low'; ask?: string }[] }[]>('/api/insights'),
};

/**
 * Live events over SSE. The server pings every 15s; if nothing arrives for
 * 40s (a proxy can hold a dead stream open), reconnect and let the caller
 * catch up on anything missed via onReconnect.
 */
export function events(onEvent: (e: any) => void, onReconnect?: () => void) {
  let es: EventSource | null = null;
  let stopped = false;
  let last = Date.now();
  let opened = 0;
  const open = () => {
    if (stopped || !userId) return;
    es?.close();
    es = new EventSource(`${API_BASE}/api/events?user=${userId}`);
    last = Date.now();
    es.onopen = () => { last = Date.now(); if (opened++ > 0) onReconnect?.(); };
    es.onmessage = (m) => { last = Date.now(); try { onEvent(JSON.parse(m.data)); } catch { /* bad frame */ } };
    es.addEventListener('ping', () => { last = Date.now(); });
    es.onerror = () => { es?.close(); setTimeout(open, 2000); };
  };
  open();
  const watchdog = setInterval(() => { if (Date.now() - last > 25_000) open(); }, 5000);
  return () => { stopped = true; clearInterval(watchdog); es?.close(); };
}
