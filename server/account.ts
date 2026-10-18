/**
 * Sign in with GitHub (desktop / local): Supabase Auth with PKCE, the redirect
 * landing on a loopback listener on this computer — the same flow Loom uses,
 * against the same hosted Supabase project. Signing in does two things:
 *
 *  1. Your identity: the profile, and "me" in the graph, become your GitHub
 *     account (name, login, avatar).
 *  2. Real data: with the token GitHub hands back, ZivBot maps your own most
 *     recently pushed repositories — contributors, open issues and PRs, files —
 *     into your FalkorDB graph, linked to you.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { userGraph, registryGraph } from './graph.ts';
import { upsertNodes } from './ingest.ts';
import { publish } from './bus.ts';
import { ingestGithub } from './connectors/git.ts';
import { saveConnectorConfig } from './secrets.ts';
import { enrich } from './analytics.ts';
import { embedPending } from './semantic.ts';
import { SUPABASE_URL, SUPABASE_KEY } from './relay.ts';

type Pending = { url: string; done: Promise<void> };
const pending = new Map<string, Pending>();

function openInBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); } catch { /* the UI also shows the link */ }
}

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;background:#100f0e;color:#efe8de;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}h1{font-size:22px}p{opacity:.7}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;

/** Start a GitHub sign-in for this ZivBot user; resolves with the URL to open. */
export async function startGithubSignIn(userId: string): Promise<{ url: string }> {
  const live = pending.get(userId);
  if (live) return { url: live.url };
  const { createClient } = await import('@supabase/supabase-js');
  const store = new Map<string, string>();
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'zivbot-signin',
      storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } },
  });
  const server = http.createServer();
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => res()); });
  const redirectTo = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const { data, error } = await sb.auth.signInWithOAuth({ provider: 'github', options: { redirectTo, skipBrowserRedirect: true, scopes: 'read:user' } });
  if (error || !data?.url) { server.close(); throw new Error(error?.message || 'Supabase gave no sign-in URL'); }
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => { server.close(); pending.delete(userId); publish(userId, { type: 'account', status: 'timeout' }); resolve(); }, 15 * 60_000);
    server.on('request', async (req, res) => {
      const u = new URL(req.url || '/', redirectTo);
      const reply = (code: number, t: string, b: string) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }); res.end(page(t, b)); };
      if (u.pathname !== '/callback') return reply(404, 'Not found', "This is ZivBot's sign-in listener.");
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      const code = u.searchParams.get('code');
      try {
        if (err || !code) throw new Error(err || 'no sign-in code came back');
        const ex = await sb.auth.exchangeCodeForSession(code);
        if (ex.error || !ex.data.session) throw new Error(ex.error?.message || 'no session came back');
        reply(200, 'Signed in to ZivBot', 'You can close this tab — your Zivs are reading your GitHub now.');
        await linkAccount(userId, ex.data.session as any);
      } catch (e: any) {
        reply(400, 'Sign-in failed', `${e.message}. Close this tab and try again.`);
        publish(userId, { type: 'account', status: 'error', error: e.message });
      } finally {
        clearTimeout(timer);
        server.closeAllConnections?.();
        server.close();
        pending.delete(userId);
        resolve();
      }
    });
  });
  pending.set(userId, { url: data.url, done });
  openInBrowser(data.url);
  return { url: data.url };
}

async function linkAccount(userId: string, session: { user: any; provider_token?: string | null }) {
  const md = session.user.user_metadata || {};
  const login: string = md.user_name || md.preferred_username || '';
  const account = { github: login, name: md.full_name || md.name || login, avatar: md.avatar_url || '', email: session.user.email || '', supabaseId: session.user.id };
  const reg = await registryGraph();
  await reg.q(`MERGE (u:User {id:$id}) SET u.github = $github, u.name = $name, u.avatar = $avatar, u.supabaseId = $sid, u.signedInAt = $now`, { id: userId, github: login, name: account.name, avatar: account.avatar, sid: account.supabaseId, now: Date.now() }, '~link the account');
  const g = await userGraph(userId);
  // you, in your own graph: your GitHub identity on the "me" node, and your GitHub person merged into it
  await g.q(`MATCH (m:Person {me:true}) SET m.name = coalesce($name, m.name), m.login = $login, m.avatar = $avatar, m.github = $login`, { name: account.name || null, login, avatar: account.avatar }, 'you are your GitHub account');
  await g.q(`MERGE (p:Profile) SET p.name = $name, p.github = $login, p.avatar = $avatar`, { name: account.name, login, avatar: account.avatar }, 'profile from GitHub');
  publish(userId, { type: 'account', status: 'signed-in', account });
  if (session.provider_token) saveConnectorConfig(userId, 'github-account', { token: session.provider_token, login });
  await syncMyGithub(userId, login, session.provider_token || undefined).catch((e) => publish(userId, { type: 'account', status: 'sync-error', error: e.message }));
}

/** Map your own recently pushed repositories into the graph, linked to you. */
export async function syncMyGithub(userId: string, login: string, token?: string) {
  const g = await userGraph(userId);
  publish(userId, { type: 'connector.progress', id: 'github', msg: `Reading ${login}'s repositories…` });
  const r = await fetch(`https://api.github.com/users/${login}/repos?sort=pushed&per_page=12&type=owner`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'zivbot', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`GitHub ${r.status} listing your repositories`);
  const repos = ((await r.json()) as any[]).filter((x) => !x.fork && !x.archived).slice(0, 3);
  const names: string[] = [];
  for (const repo of repos) {
    publish(userId, { type: 'connector.progress', id: 'github', msg: `Mapping ${repo.full_name}…` });
    await ingestGithub(g, repo.full_name, token);
    names.push(repo.full_name);
  }
  // the contributor node for you is you
  await g.q(`MATCH (m:Person {me:true}), (p:Person {uid:$gh}) MERGE (m)-[:SAME_AS]->(p) SET p.name = coalesce(m.name, p.name)`, { gh: `person:gh-${login.toLowerCase()}` }, 'your GitHub contributor node is you');
  await upsertNodes(g, 'Connector', [{ uid: 'connector:github', props: { name: 'GitHub', kind: 'Code', status: 'connected', mode: 'live', lastSync: Date.now(), counts: JSON.stringify({ repos: names.length, account: login }) }, search: 'GitHub connector' }]);
  await enrich(g);
  await embedPending(g).catch(() => {});
  publish(userId, { type: 'account', status: 'synced', repos: names });
  const [{ ensureTeam }, { afterConnect }] = await Promise.all([import('./users.ts'), import('./agent.ts')]);
  await ensureTeam(userId);
  publish(userId, { type: 'dots' });
  await afterConnect(userId, { repositories: names.length });
  publish(userId, { type: 'connector', id: 'github', status: 'connected' });
  return names;
}

export async function accountOf(userId: string) {
  const reg = await registryGraph();
  const u = await reg.one(`MATCH (u:User {id:$id}) RETURN u.github AS github, u.name AS name, u.avatar AS avatar`, { id: userId }, '~account');
  return u?.github ? { github: u.github, name: u.name, avatar: u.avatar } : null;
}

export async function signOut(userId: string) {
  const reg = await registryGraph();
  await reg.q(`MATCH (u:User {id:$id}) REMOVE u.github, u.supabaseId, u.avatar`, { id: userId }, '~sign out');
  publish(userId, { type: 'account', status: 'signed-out' });
}
