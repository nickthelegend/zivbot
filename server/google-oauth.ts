/**
 * "Sign in with Google" for the Google Workspace connector — one click, like the
 * Claude and ChatGPT connectors: open Google's consent page, come back to a loopback
 * listener on this computer, trade the code (PKCE) for a refresh token, store it, and
 * sync Gmail + Calendar into the graph. Nothing to paste per account.
 *
 * Google only does this for an app with an OAuth client. ZivBot's client is set once
 * per computer (type "Desktop app": any 127.0.0.1 port is an allowed redirect) — from
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET or saved via the app; after that every
 * Google account on this computer is one click.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zivHome } from './connectors/git.ts';
import { saveConnectorConfig } from './secrets.ts';
import { publish } from './bus.ts';
import { connect } from './connectors/index.ts';

const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events'];
const clientFile = () => path.join(zivHome(), 'google-client.json');

export function googleClient(): { clientId: string; clientSecret: string } | null {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  try { const c = JSON.parse(fs.readFileSync(clientFile(), 'utf8')); return c.clientId && c.clientSecret ? c : null; } catch { return null; }
}

export function saveGoogleClient(clientId: string, clientSecret: string) {
  if (!/\.apps\.googleusercontent\.com$/.test(clientId.trim())) throw new Error('That client ID should end in .apps.googleusercontent.com');
  if (!clientSecret.trim()) throw new Error('The client secret is missing');
  fs.mkdirSync(zivHome(), { recursive: true });
  fs.writeFileSync(clientFile(), JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }), { mode: 0o600 });
}

function openInBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); } catch { /* the UI shows the link too */ }
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;background:#100f0e;color:#efe8de;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center;max-width:460px}h1{font-size:22px}p{opacity:.7}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;

const pending = new Map<string, string>();

/** Start Google sign-in for a ZivBot user; resolves with the consent URL (also opened in the browser). */
export async function startGoogleSignIn(userId: string): Promise<{ url: string }> {
  const client = googleClient();
  if (!client) throw Object.assign(new Error('Set up Google sign-in once: add your OAuth client (Desktop app).'), { code: 'NO_CLIENT' });
  const live = pending.get(userId);
  if (live) return { url: live };
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const server = http.createServer();
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => res()); });
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: client.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true',
    code_challenge: challenge, code_challenge_method: 'S256', state,
  })}`;
  const timer = setTimeout(() => { server.close(); pending.delete(userId); publish(userId, { type: 'google', status: 'timeout' }); console.warn('[google] sign-in timed out for', userId); }, 30 * 60_000);
  server.on('request', async (req, res) => {
    const u = new URL(req.url || '/', redirect);
    const reply = (code: number, t: string, b: string) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }); res.end(page(t, b)); };
    if (u.pathname !== '/callback') return reply(404, 'Not found', "This is ZivBot's Google sign-in listener.");
    try {
      if (u.searchParams.get('state') !== state) throw new Error('the sign-in did not come from this request');
      const err = u.searchParams.get('error');
      if (err) throw new Error(err === 'access_denied' ? 'you cancelled, or this Google account is not a test user of the app' : err);
      const code = u.searchParams.get('code');
      if (!code) throw new Error('no code came back');
      const tok = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
      }).then((r) => r.json() as Promise<any>);
      if (!tok.refresh_token) throw new Error(tok.error_description || tok.error || 'Google returned no refresh token');
      const email = tok.id_token ? JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString()).email : '';
      reply(200, `Connected ${email || 'Google'}`, 'You can close this tab. ZivBot is reading your mail and calendar into your graph.');
      saveConnectorConfig(userId, 'google', { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: tok.refresh_token, email });
      console.log('[google] signed in as', email);
      publish(userId, { type: 'google', status: 'signed-in', email });
      // the real sync, exactly as if the fields had been filled in
      void connect(userId, 'google', {}).then(async (r: any) => {
        publish(userId, { type: 'google', status: 'synced', email, counts: r?.counts });
        // first real data in: the specialist Zivs join, and Ziv says what it found
        const [{ ensureTeam }, { afterConnect }] = await Promise.all([import('./users.ts'), import('./agent.ts')]);
        await ensureTeam(userId);
        publish(userId, { type: 'dots' });
        await afterConnect(userId, r?.counts || {});
      })
        .catch((e) => { console.warn('[google] sync failed:', e.message); publish(userId, { type: 'google', status: 'error', error: e.message }); });
    } catch (e: any) {
      console.warn('[google] sign-in failed:', e.message);
      reply(400, 'Google sign-in failed', `${e.message}. Close this tab and try again.`);
      publish(userId, { type: 'google', status: 'error', error: e.message });
    } finally {
      clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
      pending.delete(userId);
    }
  });
  pending.set(userId, url);
  openInBrowser(url);
  return { url };
}
