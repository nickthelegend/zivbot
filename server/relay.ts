/**
 * ZivBot anywhere: reach the Zivs on your computer from your phone on any network.
 *
 * The computer joins a Supabase Realtime broadcast channel and answers encrypted
 * requests that arrive there (the wire format is Loom's relay protocol, see
 * relay-protocol.ts: XChaCha20-Poly1305, Supabase only ever sees ciphertext).
 * The channel id and the 32-byte key exist only on this computer and inside the
 * pairing QR's URL fragment, which never reaches a server.
 *
 * The bridge is dumb on purpose: a relayed request becomes a real HTTP call to
 * this server on loopback, as the user the channel belongs to, and a relayed
 * stream is the same event bus the SSE endpoint uses. Every rule of the API
 * applies unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { zivHome } from './connectors/git.ts';
import { subscribe } from './bus.ts';
import {
  encodeMessage, fromB64, newRelayCredentials, packCredentials, RelayDecoder, relayTopic, toB64,
  type RelayCredentials, type RelayEnvelope, type RelayMessage, type RelayTransport,
} from './relay-protocol.ts';

// Loom's hosted Supabase project (public URL and publishable key — they only name the project).
export const SUPABASE_URL = process.env.ZIV_SUPABASE_URL || 'https://ufpkfpzspfzzxabklyec.supabase.co';
export const SUPABASE_KEY = process.env.ZIV_SUPABASE_KEY || 'sb_publishable_DBiS9r-XDdqlgjt_bdpC2w_JdXqEvb1';
const WEB = process.env.ZIV_WEB_URL || 'https://zivbot.vercel.app';

const file = (userId: string) => path.join(zivHome(), 'relay', `${userId}.json`);
function load(userId: string): RelayCredentials | null {
  try { return JSON.parse(fs.readFileSync(file(userId), 'utf8')); } catch { return null; }
}
function save(userId: string, c: RelayCredentials) {
  fs.mkdirSync(path.dirname(file(userId)), { recursive: true });
  fs.writeFileSync(file(userId), JSON.stringify(c), { mode: 0o600 });
}

async function supabaseTransport(channel: string): Promise<RelayTransport> {
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 40 } } });
  const ch = client.channel(relayTopic(channel), { config: { broadcast: { self: false, ack: false } } });
  const listeners: Array<(env: unknown) => void> = [];
  ch.on('broadcast', { event: 'e' }, (msg: { payload?: unknown }) => { for (const l of listeners) l(msg.payload); });
  let ok!: () => void;
  let fail!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => { ok = res; fail = rej; });
  ready.catch(() => {});
  ch.subscribe((status: string, err?: Error) => {
    if (status === 'SUBSCRIBED') ok();
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { fail(err ?? new Error(`realtime ${status.toLowerCase()}`)); console.warn('[relay]', status, err?.message || ''); }
  });
  return {
    async send(env) { await ch.send({ type: 'broadcast', event: 'e', payload: env }); },
    onEnvelope(cb) { listeners.push(cb); },
    ready: () => ready,
    async close() { await client.removeChannel(ch).catch(() => {}); client.realtime.disconnect(); },
  };
}

const SKEW_MS = 10 * 60_000;
const DENY = [/^\/api\/session/, /^\/api\/relay/, /^\/api\/account\/github\/start/];

class Bridge {
  private key: Uint8Array;
  private decoder: RelayDecoder;
  private seen = new Map<string, number>();
  private streams = new Map<string, { off: () => void; buf: unknown[]; timer?: ReturnType<typeof setTimeout>; last: number }>();
  stats = { requests: 0, events: 0, clients: () => this.streams.size };

  constructor(private userId: string, private transport: RelayTransport, key: string, private localBase: () => string) {
    this.key = fromB64(key);
    this.decoder = new RelayDecoder(this.key, 'c');
    transport.onEnvelope((env) => {
      const msg = this.decoder.push(env);
      if (msg) void this.handle(msg).catch((e) => console.warn('[relay]', e.message));
    });
  }

  private async send(msg: RelayMessage) {
    for (const env of encodeMessage(this.key, 'd', msg)) await this.transport.send(env as RelayEnvelope);
  }

  private async handle(msg: RelayMessage) {
    if (msg.t === 'ping') return this.send({ t: 'pong', to: String(msg.from), ts: Number(msg.ts) || 0, daemon: { version: '1', name: 'ZivBot' } });
    if (msg.t === 'sub') return this.sub(String(msg.from));
    if (msg.t === 'unsub') return this.unsub(String(msg.from));
    if (msg.t !== 'req') return;
    const from = String(msg.from);
    const reply = (status: number, body: unknown) => this.send({ t: 'res', id: String(msg.id), to: from, status, body });
    const k = `${from}:${msg.id}`;
    if (this.seen.has(k)) return; // a replayed copy
    if (typeof msg.ts === 'number' && Math.abs(Date.now() - msg.ts) > SKEW_MS) return reply(408, { error: "check the phone's clock" });
    this.seen.set(k, Date.now());
    if (this.seen.size > 5000) for (const [kk, at] of this.seen) if (Date.now() - at > 2 * SKEW_MS) this.seen.delete(kk);
    const method = String(msg.method || 'GET').toUpperCase();
    const p = String(msg.path || '');
    if (!p.startsWith('/api/') || p.includes('..') || DENY.some((re) => re.test(p)) || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return reply(403, { error: 'not relayable' });
    this.stats.requests++;
    try {
      // the channel belongs to one user: requests run as that user, whatever the phone claims
      const res = await fetch(this.localBase() + p, {
        method,
        headers: { 'x-ziv-user': this.userId, 'x-ziv-via': 'relay', ...(msg.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(msg.body !== undefined && method !== 'GET' ? { body: JSON.stringify(msg.body) } : {}),
      });
      const text = await res.text();
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* text body */ }
      await reply(res.status, body);
    } catch (e: any) {
      await reply(502, { error: `ZivBot unreachable: ${e.message}` });
    }
  }

  private sub(from: string) {
    this.unsub(from);
    const s = { buf: [] as unknown[], last: Date.now(), off: () => {}, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    s.off = subscribe(this.userId, (e) => {
      s.buf.push(e);
      this.stats.events++;
      s.timer ??= setTimeout(() => { s.timer = undefined; const frames = s.buf; s.buf = []; void this.send({ t: 'evs', to: from, frames }); }, 80);
    });
    this.streams.set(from, s);
    void this.send({ t: 'stream', to: from, open: true });
  }

  private unsub(from: string) {
    const s = this.streams.get(from);
    if (!s) return;
    s.off();
    if (s.timer) clearTimeout(s.timer);
    this.streams.delete(from);
  }

  async close() {
    for (const k of [...this.streams.keys()]) this.unsub(k);
    await this.transport.close();
  }
}

const bridges = new Map<string, Bridge>();

/** Turn on (or resume) ZivBot anywhere for a user; returns the pairing link for the QR. */
export async function enableRelay(userId: string, localBase: () => string) {
  let creds = load(userId);
  if (!creds) { creds = newRelayCredentials(); save(userId, creds); }
  if (!bridges.has(userId)) {
    const t = await supabaseTransport(creds.channel);
    await Promise.race([t.ready(), new Promise((_, rej) => setTimeout(() => rej(new Error('Supabase Realtime did not answer')), 15_000))]);
    bridges.set(userId, new Bridge(userId, t, creds.key, localBase));
  }
  const enc = (s: string) => toB64(new TextEncoder().encode(s));
  // everything secret rides the fragment: browsers never send it to a server
  const link = `${WEB}/#pair=${userId}&relay=${packCredentials(creds)}&sb=${enc(SUPABASE_URL)}&sbk=${enc(SUPABASE_KEY)}`;
  return { link, channel: creds.channel, on: true };
}

export function relayStatus(userId: string) {
  const b = bridges.get(userId);
  return { on: !!b, requests: b?.stats.requests ?? 0, events: b?.stats.events ?? 0, phones: b?.stats.clients() ?? 0 };
}

/** Bring every user's bridge back after a restart (the computer stays reachable while it's on). */
export async function resumeRelays(localBase: () => string) {
  let users: string[] = [];
  try { users = fs.readdirSync(path.join(zivHome(), 'relay')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return; }
  for (const u of users) await enableRelay(u, localBase).catch((e) => console.warn('[relay] resume', u, e.message));
}

export async function disableRelay(userId: string, forget = false) {
  await bridges.get(userId)?.close();
  bridges.delete(userId);
  if (forget) { try { fs.unlinkSync(file(userId)); } catch { /* none */ } }
}
