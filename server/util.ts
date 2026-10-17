import { randomUUID } from 'node:crypto';

export const uid = (prefix: string) => `${prefix}:${randomUUID().slice(0, 12)}`;
export const now = () => Date.now();
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function ago(ms: number, from = Date.now()) {
  const d = from - ms;
  const abs = Math.abs(d);
  const fut = d < 0;
  const f = (n: number, u: string) => (fut ? `in ${n}${u}` : `${n}${u} ago`);
  if (abs < 60_000) return fut ? 'soon' : 'just now';
  if (abs < HOUR) return f(Math.round(abs / 60_000), 'm');
  if (abs < DAY) return f(Math.round(abs / HOUR), 'h');
  return f(Math.round(abs / DAY), 'd');
}

export function when(ms: number) {
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const clip = (s: string, n = 140) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
