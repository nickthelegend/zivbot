import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { UserGraph } from '../graph.ts';
import { upsertNodes, link, linkAny } from '../ingest.ts';
import { DAY } from '../util.ts';

const run = promisify(execFile);
const ROOT = process.env.ZIV_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const zivHome = () => process.env.ZIV_HOME || join(homedir(), '.zivbot');
export const workspaceDir = (userId: string) => join(zivHome(), 'workspaces', userId.replace(/[^a-zA-Z0-9_-]/g, ''));

/**
 * The demo workspace's payments-api lives in a real git repo on the Ziv's
 * computer, so coding agents can actually change it. History is authored by
 * the (synthetic) Lumen engineers, which is where "who knows this code" comes from.
 */
export async function prepareDemoRepo(userId: string): Promise<string> {
  const dir = join(workspaceDir(userId), 'lumen-payments');
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'demo/lumen-payments'), dir, { recursive: true });
  const git = (args: string[], who?: [string, string, number]) =>
    run('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        ...(who ? { GIT_AUTHOR_NAME: who[0], GIT_AUTHOR_EMAIL: who[1], GIT_COMMITTER_NAME: who[0], GIT_COMMITTER_EMAIL: who[1], GIT_AUTHOR_DATE: new Date(Date.now() - who[2] * DAY).toISOString(), GIT_COMMITTER_DATE: new Date(Date.now() - who[2] * DAY).toISOString() } : {}),
      },
    });
  const priya: [string, string] = ['Priya Raman', 'priya@lumenlabs.example'];
  const raj: [string, string] = ['Raj Iyer', 'raj@lumenlabs.example'];
  await git(['init', '-q', '-b', 'main']);
  await git(['add', 'package.json', 'README.md', 'src/db.js']);
  await git(['commit', '-q', '-m', 'payments-api: billing-db client with query accounting'], [...priya, 60]);
  await git(['add', 'src/invoices.js']);
  await git(['commit', '-q', '-m', 'invoices: list invoices with line items for the portal'], [...priya, 45]);
  await git(['add', 'test/invoices.test.js']);
  await git(['commit', '-q', '-m', 'test: invoice listing + lease regression tests'], [...raj, 12]);
  await git(['add', '-A']);
  await git(['commit', '-q', '--allow-empty', '-m', 'Atlas phase 1: import Chargebee leases as line items'], [...raj, 27]);
  return dir;
}

type Commit = { sha: string; name: string; email: string; at: number; subject: string; files: string[] };

async function gitLog(dir: string): Promise<Commit[]> {
  const { stdout } = await run('git', ['log', '--name-only', '--format=@@%H|%an|%ae|%at|%s', '-n', '400'], { cwd: dir, maxBuffer: 20 << 20 });
  const commits: Commit[] = [];
  for (const block of stdout.split('@@').filter(Boolean)) {
    const [head, ...rest] = block.split('\n');
    const [sha, name, email, at, ...subj] = head.split('|');
    commits.push({ sha, name, email, at: Number(at) * 1000, subject: subj.join('|'), files: rest.map((s) => s.trim()).filter(Boolean) });
  }
  return commits;
}

/** Ingest a local git repo: files, imports between files, commits and their authors. */
export async function ingestRepo(g: UserGraph, dir: string, opts: { name: string; implements?: string; url?: string }) {
  const repoUid = `repo:${opts.name}`;
  await upsertNodes(g, 'Repo', [{ uid: repoUid, props: { name: opts.name, path: dir, url: opts.url, source: 'git' }, search: `${opts.name} repository repo code` }]);
  if (opts.implements) await link(g, 'Repo', 'IMPLEMENTS', 'System', [{ from: repoUid, to: opts.implements }]);

  const { stdout } = await run('git', ['ls-files'], { cwd: dir, maxBuffer: 20 << 20 });
  const files = stdout.split('\n').filter(Boolean).slice(0, 2000);
  const fuid = (f: string) => `file:${opts.name}/${f}`;
  await upsertNodes(g, 'File', files.map((f) => ({ uid: fuid(f), props: { name: f, path: f, repo: opts.name, source: 'git' }, search: `${f} ${f.split('/').pop()}` })));
  await link(g, 'File', 'IN_REPO', 'Repo', files.map((f) => ({ from: fuid(f), to: repoUid })));

  // Code graph: relative imports between JS/TS files.
  const imports: { from: string; to: string }[] = [];
  const set = new Set(files);
  for (const f of files.filter((f) => /\.(m?[jt]sx?)$/.test(f))) {
    let src = '';
    try { src = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
      const target = normalize(join(dirname(f), m[1])).replace(/\\/g, '/');
      const hit = [target, `${target}.js`, `${target}.ts`, `${target}/index.js`, `${target}/index.ts`].find((t) => set.has(t));
      if (hit) imports.push({ from: fuid(f), to: fuid(hit) });
    }
  }
  await link(g, 'File', 'IMPORTS', 'File', imports);

  const commits = await gitLog(dir);
  const people = await g.q(`MATCH (p:Person) RETURN p.uid AS uid, toLower(p.email) AS email, toLower(p.name) AS name`, {}, 'match commit authors');
  const byEmail = new Map(people.map((p) => [p.email, p.uid]));
  const byName = new Map(people.map((p) => [p.name, p.uid]));
  const authorUid = (c: Commit) => byEmail.get(c.email.toLowerCase()) || byName.get(c.name.toLowerCase()) || `person:git-${c.email.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const newPeople = [...new Map(commits.filter((c) => !byEmail.has(c.email.toLowerCase()) && !byName.has(c.name.toLowerCase())).map((c) => [authorUid(c), c])).values()];
  await upsertNodes(g, 'Person', newPeople.map((c) => ({ uid: authorUid(c), props: { name: c.name, email: c.email, role: 'Contributor', external: true, source: 'git' }, search: `${c.name} ${c.email} contributor` })));
  await upsertNodes(g, 'Commit', commits.map((c) => ({ uid: `commit:${c.sha}`, props: { name: c.subject, sha: c.sha.slice(0, 10), at: c.at, source: 'git' }, search: c.subject })));
  await link(g, 'Commit', 'AUTHORED_BY', 'Person', commits.map((c) => ({ from: `commit:${c.sha}`, to: authorUid(c) })));
  await link(g, 'Commit', 'IN_REPO', 'Repo', commits.map((c) => ({ from: `commit:${c.sha}`, to: repoUid })));
  await link(g, 'Commit', 'TOUCHES', 'File', commits.flatMap((c) => c.files.filter((f) => set.has(f)).map((f) => ({ from: `commit:${c.sha}`, to: fuid(f) }))));
  // Commit messages that name a ticket ("LUM-142") link to it.
  await linkAny(g, 'Commit', 'MENTIONS', commits.flatMap((c) => [...c.subject.matchAll(/\b([A-Z]{2,6}-\d+)\b/g)].map((m) => ({ from: `commit:${c.sha}`, to: `ticket:${m[1]}` }))));
  return { files: files.length, commits: commits.length, imports: imports.length, contributors: new Set(commits.map(authorUid)).size };
}

/**
 * A public GitHub repo (public data is allowed in the hackathon graph):
 * contributors, open issues and PRs, and the file tree. Set GITHUB_TOKEN for
 * higher rate limits.
 */
export async function ingestGithub(g: UserGraph, full: string, token?: string) {
  const m = full.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error('Use owner/repo or a github.com URL');
  const [owner, repo] = [m[1], m[2]];
  const gh = async (path: string) => {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'zivbot', ...((token || process.env.GITHUB_TOKEN) ? { authorization: `Bearer ${token || process.env.GITHUB_TOKEN}` } : {}) },
    });
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${path || 'repo'}`);
    return r.json() as Promise<any>;
  };
  const info = await gh('');
  const name = `${owner}/${repo}`;
  const repoUid = `repo:${name}`;
  await upsertNodes(g, 'Repo', [{ uid: repoUid, props: { name, url: info.html_url, stars: info.stargazers_count, language: info.language, description: info.description, source: 'github' }, search: `${name} ${info.description || ''} repository` }]);
  const contributors: any[] = await gh('/contributors?per_page=30').catch(() => []);
  const puid = (login: string) => `person:gh-${login.toLowerCase()}`;
  await upsertNodes(g, 'Person', contributors.map((c) => ({ uid: puid(c.login), props: { name: c.login, login: c.login, role: 'Contributor', external: true, source: 'github', avatar: c.avatar_url }, search: `${c.login} github contributor` })));
  await link(g, 'Person', 'CONTRIBUTES_TO', 'Repo', contributors.map((c) => ({ from: puid(c.login), to: repoUid, props: { commits: c.contributions } })));
  const issues: any[] = await gh('/issues?state=open&per_page=40').catch(() => []);
  const tuid = (n: number) => `ticket:${name}#${n}`;
  await upsertNodes(g, 'Person', issues.map((i) => ({ uid: puid(i.user.login), props: { name: i.user.login, login: i.user.login, external: true, source: 'github' }, search: `${i.user.login} github` })));
  await upsertNodes(g, 'Ticket', issues.map((i) => ({
    uid: tuid(i.number),
    props: { key: `#${i.number}`, name: `#${i.number} ${i.title}`, title: i.title, status: 'open', kind: i.pull_request ? 'pull_request' : 'issue', labels: (i.labels || []).map((l: any) => l.name), url: i.html_url, at: Date.parse(i.created_at), body: String(i.body || '').slice(0, 600), source: 'github' },
    search: `${i.title} ${(i.labels || []).map((l: any) => l.name).join(' ')} ${String(i.body || '').slice(0, 300)}`,
  })));
  await link(g, 'Ticket', 'IN_REPO', 'Repo', issues.map((i) => ({ from: tuid(i.number), to: repoUid })));
  await link(g, 'Ticket', 'REPORTED_BY', 'Person', issues.map((i) => ({ from: tuid(i.number), to: puid(i.user.login) })));
  await link(g, 'Ticket', 'ASSIGNED_TO', 'Person', issues.flatMap((i) => (i.assignees || []).map((a: any) => ({ from: tuid(i.number), to: puid(a.login) }))));
  const tree = await gh(`/git/trees/${info.default_branch}?recursive=1`).catch(() => ({ tree: [] }));
  const files = (tree.tree || []).filter((t: any) => t.type === 'blob').slice(0, 600);
  const fuid = (p: string) => `file:${name}/${p}`;
  await upsertNodes(g, 'File', files.map((f: any) => ({ uid: fuid(f.path), props: { name: f.path, path: f.path, repo: name, source: 'github' }, search: f.path })));
  await link(g, 'File', 'IN_REPO', 'Repo', files.map((f: any) => ({ from: fuid(f.path), to: repoUid })));
  // Issues that name a file path link to it.
  const paths = new Set<string>(files.map((f: any) => f.path as string));
  await linkAny(g, 'Ticket', 'MENTIONS', issues.flatMap((i) => [...paths].filter((p) => p.includes('/') && String(i.body || '').includes(p)).slice(0, 5).map((p) => ({ from: tuid(i.number), to: fuid(p) }))));
  return { repo: name, contributors: contributors.length, issues: issues.length, files: files.length };
}
