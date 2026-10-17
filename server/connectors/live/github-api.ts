import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link, upsertPeople, type PersonIn } from '../../ingest.ts';
import { clip, linkMentions, list, ms } from './_util.ts';

async function gh(ctx: ConnectorCtx, path: string, body?: unknown, method?: string): Promise<any> {
  const [token] = need(ctx, 'token');
  return getJson(`https://api.github.com${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const repoName = (s: string) => {
  const m = String(s || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error(`Use owner/repo (got "${s}")`);
  return `${m[1]}/${m[2]}`;
};
// Same uids as the public GitHub connector (git.ts) so both views merge.
const repoUid = (full: string) => `repo:${full}`;
const tUid = (full: string, n: number) => `ticket:${full}#${n}`;

export const githubApi: ConnectorDef = {
  id: 'github-api',
  name: 'GitHub (private)',
  category: 'Code',
  description: 'Your GitHub repos (including private): contributors, open issues and PRs; open issues and comment with approval.',
  icon: 'github',
  color: '#181717',
  auth: 'key',
  docs: 'https://github.com/settings/personal-access-tokens',
  fields: [
    { key: 'token', label: 'Personal access token', env: 'GITHUB_TOKEN', secret: true, placeholder: 'github_pat_… or ghp_…', help: 'Fine-grained token with read access to Issues, Pull requests, Metadata (and write to Issues for actions).' },
    { key: 'repos', label: 'Repos', env: 'GITHUB_REPOS', optional: true, placeholder: 'owner/repo, owner/other', help: 'Comma-separated. Empty = your 10 most recently updated repos.' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    let repos = list(ctx.config.repos).map(repoName);
    if (!repos.length) {
      ctx.progress('Listing your recently updated repos');
      const mine: any[] = await gh(ctx, '/user/repos?sort=updated&per_page=10');
      repos = mine.map((r) => r.full_name);
    }
    let tickets = 0;
    let contributorsN = 0;
    const allTickets: { uid: string; text: string }[] = [];
    for (const [idx, full] of repos.entries()) {
      ctx.progress(`Reading ${full} (${idx + 1}/${repos.length})`);
      let info: any;
      try { info = await gh(ctx, `/repos/${full}`); } catch (e) { ctx.progress(`Skipped ${full}: ${(e as Error).message.slice(0, 120)}`); continue; }
      await upsertNodes(g, 'Repo', [{
        uid: repoUid(full),
        props: { name: full, url: info.html_url, private: !!info.private, stars: info.stargazers_count, language: info.language, description: info.description, defaultBranch: info.default_branch, at: ms(info.pushed_at), source: 'github-api' },
        search: `${full} ${info.name} ${info.description || ''} repository`,
      }]);
      const contributors: any[] = await gh(ctx, `/repos/${full}/contributors?per_page=30`).then((r) => (Array.isArray(r) ? r : [])).catch(() => []);
      const issues: any[] = await gh(ctx, `/repos/${full}/issues?state=open&per_page=50&sort=updated`).then((r) => (Array.isArray(r) ? r : [])).catch(() => []);
      const humans: PersonIn[] = [];
      const add = (u: any, role?: string) => u?.login && u.type !== 'Bot' && humans.push({ id: u.login, name: u.login, login: u.login, avatar: u.avatar_url, role, source: 'github' });
      contributors.forEach((c) => add(c, 'Contributor'));
      issues.forEach((i) => { add(i.user); (i.assignees || []).forEach((a: any) => add(a)); });
      const people = await upsertPeople(g, humans);
      contributorsN += contributors.length;
      await link(g, 'Person', 'CONTRIBUTES_TO', 'Repo', contributors.filter((c) => people.has(c.login)).map((c) => ({ from: people.get(c.login)!, to: repoUid(full), props: { commits: c.contributions } })));
      await upsertNodes(g, 'Ticket', issues.map((i) => {
        const labels = (i.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name));
        return {
          uid: tUid(full, i.number),
          props: {
            key: `#${i.number}`, name: `#${i.number} ${i.title}`, title: i.title, status: 'open', kind: i.pull_request ? 'pull_request' : 'issue',
            labels, url: i.html_url, at: ms(i.created_at), updatedAt: ms(i.updated_at), comments: i.comments, body: clip(i.body, 2000), repo: full, draft: i.draft || undefined, source: 'github-api',
          },
          search: `${full} #${i.number} ${i.title} ${labels.join(' ')} ${clip(i.body, 600)}`,
        };
      }));
      await link(g, 'Ticket', 'IN_REPO', 'Repo', issues.map((i) => ({ from: tUid(full, i.number), to: repoUid(full) })));
      await link(g, 'Ticket', 'REPORTED_BY', 'Person', issues.filter((i) => people.has(i.user?.login)).map((i) => ({ from: tUid(full, i.number), to: people.get(i.user.login)! })));
      await link(g, 'Ticket', 'ASSIGNED_TO', 'Person', issues.flatMap((i) => (i.assignees || []).filter((a: any) => people.has(a.login)).map((a: any) => ({ from: tUid(full, i.number), to: people.get(a.login)! }))));
      tickets += issues.length;
      allTickets.push(...issues.map((i) => ({ uid: tUid(full, i.number), text: `${i.title}\n${i.body || ''}` })));
    }
    ctx.progress('Linking mentions');
    const mentions = await linkMentions(g, 'Ticket', allTickets);
    return { repos: repos.length, contributors: contributorsN, issuesAndPrs: tickets, mentions };
  },
  actions: [
    {
      name: 'create_issue',
      description: 'Open a GitHub issue in owner/repo.',
      params: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['repo', 'title'] },
      mutates: true,
      async run(ctx, a) {
        const full = repoName(a.repo);
        const r = await gh(ctx, `/repos/${full}/issues`, { title: String(a.title), body: a.body ? String(a.body) : undefined, labels: a.labels ? list(a.labels) : undefined });
        await upsertNodes(ctx.g, 'Ticket', [{ uid: tUid(full, r.number), props: { key: `#${r.number}`, name: `#${r.number} ${r.title}`, title: r.title, status: 'open', kind: 'issue', url: r.html_url, at: Date.now(), body: clip(r.body, 2000), repo: full, source: 'github-api' }, search: `${full} #${r.number} ${r.title}` }]);
        await link(ctx.g, 'Ticket', 'IN_REPO', 'Repo', [{ from: tUid(full, r.number), to: repoUid(full) }]);
        return `Opened ${full}#${r.number}: ${r.html_url}`;
      },
    },
    {
      name: 'comment',
      description: 'Comment on a GitHub issue or pull request.',
      params: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' }, number: { type: 'number' }, body: { type: 'string' } }, required: ['repo', 'number', 'body'] },
      mutates: true,
      async run(ctx, a) {
        const full = repoName(a.repo);
        const n = Number(String(a.number).replace(/^#/, ''));
        const r = await gh(ctx, `/repos/${full}/issues/${n}/comments`, { body: String(a.body) });
        return `Commented on ${full}#${n}: ${r.html_url}`;
      },
    },
  ],
};
