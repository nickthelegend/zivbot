import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link, upsertPeople, type PersonIn } from '../../ingest.ts';
import { clip, linkMentions, ms, qs } from './_util.ts';

function base(ctx: ConnectorCtx) {
  const [site, email, token] = need(ctx, 'site', 'email', 'token');
  const host = site.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return { host, auth: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
}

async function jiraApi(ctx: ConnectorCtx, path: string, body?: unknown, method?: string): Promise<any> {
  const { host, auth } = base(ctx);
  return getJson(`https://${host}/rest/api/3${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { authorization: auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Atlassian Document Format → plain text. */
export function adfText(n: any): string {
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (n.type === 'text') return n.text || '';
  if (n.type === 'mention') return n.attrs?.text || '';
  if (n.type === 'hardBreak') return '\n';
  const inner = (n.content || []).map(adfText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'tableRow'].includes(n.type) ? `${inner}\n` : inner;
}
const adfDoc = (text: string) => ({
  type: 'doc',
  version: 1,
  content: String(text || '').split(/\n{2,}|\r?\n/).filter((l) => l.trim()).map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })),
});

const PRI: Record<string, string> = { highest: 'P1', blocker: 'P1', critical: 'P1', high: 'P2', major: 'P2', medium: 'P3', normal: 'P3', low: 'P4', lowest: 'P4', minor: 'P4', trivial: 'P4' };
const tUid = (key: string) => `ticket:jira:${key}`;
const projUid = (key: string) => `project:jira:${key}`;
const FIELDS = 'summary,description,status,priority,assignee,reporter,project,created,updated,resolutiondate,labels,issuetype';

export const jira: ConnectorDef = {
  id: 'jira',
  name: 'Jira',
  category: 'Productivity',
  description: 'Jira Cloud projects and issues updated in the last 60 days; create issues and comment with approval.',
  icon: 'jira',
  color: '#0052CC',
  auth: 'key',
  docs: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  fields: [
    { key: 'site', label: 'Site', env: 'JIRA_SITE', placeholder: 'acme.atlassian.net' },
    { key: 'email', label: 'Atlassian account email', env: 'JIRA_EMAIL', placeholder: 'you@company.com' },
    { key: 'token', label: 'API token', env: 'JIRA_API_TOKEN', secret: true, placeholder: 'ATATT…' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    const { host } = base(ctx);
    ctx.progress('Searching Jira issues updated in the last 60 days');
    const jql = 'updated >= -60d ORDER BY updated DESC';
    const issues: any[] = [];
    try {
      // Current endpoint (token-paginated).
      let next: string | undefined;
      do {
        const r = await jiraApi(ctx, `/search/jql?${qs({ jql, maxResults: 100, fields: FIELDS, nextPageToken: next })}`);
        issues.push(...(r.issues || []));
        next = !r.isLast && r.nextPageToken ? r.nextPageToken : undefined;
      } while (next && issues.length < 200);
    } catch (e) {
      if (!/ 40[45]:| 410:/.test((e as Error).message)) throw e;
      // Older sites: offset-paginated /search.
      for (let startAt = 0; startAt < 200; startAt += 100) {
        const r = await jiraApi(ctx, `/search?${qs({ jql, maxResults: 100, startAt, fields: FIELDS })}`);
        issues.push(...(r.issues || []));
        if (startAt + 100 >= (r.total ?? 0)) break;
      }
    }
    const top = issues.slice(0, 200);

    const humans: PersonIn[] = [];
    for (const i of top) for (const u of [i.fields?.assignee, i.fields?.reporter]) if (u?.accountId && u.accountType !== 'app') humans.push({ id: u.accountId, name: u.displayName, email: u.emailAddress || undefined, avatar: u.avatarUrls?.['48x48'], source: 'jira' });
    const people = await upsertPeople(g, humans);

    const projects = [...new Map(top.filter((i) => i.fields?.project).map((i) => [i.fields.project.key, i.fields.project])).values()];
    await upsertNodes(g, 'Project', projects.map((p: any) => ({ uid: projUid(p.key), props: { name: p.name, key: p.key, url: `https://${host}/browse/${p.key}`, source: 'jira' }, search: `${p.name} ${p.key} project` })));

    ctx.progress(`Linking ${top.length} issues`);
    const rows = top.map((i) => ({ i, f: i.fields || {}, body: adfText(i.fields?.description).trim() }));
    await upsertNodes(g, 'Ticket', rows.map(({ i, f, body }) => ({
      uid: tUid(i.key),
      props: {
        key: i.key, name: `${i.key} ${f.summary}`, title: f.summary, status: f.status?.statusCategory?.key === 'done' ? 'resolved' : 'open', state: f.status?.name,
        priority: PRI[String(f.priority?.name || '').toLowerCase()] || 'P3', body: clip(body, 2000), at: ms(f.created), updatedAt: ms(f.updated), resolvedAt: ms(f.resolutiondate),
        url: `https://${host}/browse/${i.key}`, labels: f.labels || [], kind: f.issuetype?.name, source: 'jira',
      },
      search: `${i.key} ${f.summary} ${(f.labels || []).join(' ')} ${clip(body, 800)}`,
    })));
    await link(g, 'Ticket', 'ASSIGNED_TO', 'Person', rows.filter(({ f }) => people.has(f.assignee?.accountId)).map(({ i, f }) => ({ from: tUid(i.key), to: people.get(f.assignee.accountId)! })));
    await link(g, 'Ticket', 'REPORTED_BY', 'Person', rows.filter(({ f }) => people.has(f.reporter?.accountId)).map(({ i, f }) => ({ from: tUid(i.key), to: people.get(f.reporter.accountId)! })));
    await link(g, 'Ticket', 'PART_OF', 'Project', rows.filter(({ f }) => f.project).map(({ i, f }) => ({ from: tUid(i.key), to: projUid(f.project.key) })));
    await link(g, 'Person', 'WORKS_ON', 'Project', rows.filter(({ f }) => f.project && people.has(f.assignee?.accountId)).map(({ f }) => ({ from: people.get(f.assignee.accountId)!, to: projUid(f.project.key) })));
    const mentions = await linkMentions(g, 'Ticket', rows.map(({ i, f, body }) => ({ uid: tUid(i.key), text: `${f.summary}\n${body}` })));
    return { issues: top.length, projects: projects.length, people: people.size, mentions };
  },
  actions: [
    {
      name: 'create_issue',
      description: 'Create a Jira issue in a project.',
      params: { type: 'object', properties: { projectKey: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, issueType: { type: 'string', description: 'Default Task' } }, required: ['projectKey', 'summary'] },
      mutates: true,
      async run(ctx, a) {
        const { host } = base(ctx);
        const r = await jiraApi(ctx, '/issue', {
          fields: { project: { key: String(a.projectKey).toUpperCase() }, summary: String(a.summary), issuetype: { name: a.issueType || 'Task' }, ...(a.description ? { description: adfDoc(a.description) } : {}) },
        });
        return `Created ${r.key}: https://${host}/browse/${r.key}`;
      },
    },
    {
      name: 'comment',
      description: 'Add a comment to a Jira issue.',
      params: { type: 'object', properties: { issueKey: { type: 'string' }, body: { type: 'string' } }, required: ['issueKey', 'body'] },
      mutates: true,
      async run(ctx, a) {
        const { host } = base(ctx);
        const key = String(a.issueKey || a.issueId).trim();
        await jiraApi(ctx, `/issue/${encodeURIComponent(key)}/comment`, { body: adfDoc(a.body) });
        return `Commented on ${key}: https://${host}/browse/${key}`;
      },
    },
  ],
};

