/** Per-user event fan-out to every open client (SSE). */
export type BusEvent = { type: string; [k: string]: unknown };
type Listener = (e: BusEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(userId: string, fn: Listener) {
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function publish(userId: string, e: BusEvent) {
  for (const fn of listeners.get(userId) || []) {
    try { fn(e); } catch { /* a closed stream */ }
  }
}

export const onlineUsers = () => [...listeners.entries()].filter(([, s]) => s.size).map(([u]) => u);
