import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link, upsertPeople } from '../../ingest.ts';
import { clip, linkMentions, ms, qs, slugify, upsertSystems } from './_util.ts';

async function sentryApi(ctx: ConnectorCtx, path: string, body?: unknown, method?: string): Promise<any> {
  const [token] = need(ctx, 'token');
  const host = (ctx.config.host || 'sentry.io').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return getJson(`https://${host}/api/0${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const sysUid = (slug: string) => `system:${slugify(slug)}`;
const tUid = (shortId: string) => `ticket:sentry:${shortId}`;

function priority(level: string, count: number) {
  if (level === 'fatal') return 'P1';
  if (level === 'error') return count >= 100 ? 'P1' : 'P2';
  if (level === 'warning') return 'P3';
  return 'P4';
}

export const sentry: ConnectorDef = {
  id: 'sentry',
  name: 'Sentry',
  category: 'Code',
  description: 'Sentry projects as systems and their unresolved issues (last 14 days) as tickets; resolve issues with approval.',
  icon: 'sentry',
  color: '#362D59',
  auth: 'key',
  docs: 'https://sentry.io/settings/account/api/auth-tokens/',
  fields: [
    { key: 'token', label: 'Auth token', env: 'SENTRY_AUTH_TOKEN', secret: true, placeholder: 'sntryu_…', help: 'User auth token with project:read, event:read (event:write to resolve).' },
    { key: 'org', label: 'Organization slug', env: 'SENTRY_ORG', placeholder: 'acme' },
    { key: 'host', label: 'Host', env: 'SENTRY_HOST', optional: true, placeholder: 'sentry.io', help: 'Only for self-hosted or regional hosts (e.g. us.sentry.io, de.sentry.io).' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    const [org] = need(ctx, 'org');
    ctx.progress('Reading Sentry projects');
    const projects: any[] = await sentryApi(ctx, `/organizations/${org}/projects/`);
    await upsertSystems(g, projects.map((p) => ({
      uid: sysUid(p.slug),
      name: p.name || p.slug,
      props: { sentryProject: p.slug, platform: p.platform || undefined, monitoredBy: 'sentry' },
      search: `${p.name} ${p.slug} ${p.platform || ''} service system`,
    })));

    const issues: { i: any; project: string }[] = [];
    for (const p of projects.slice(0, 20)) {
      if (issues.length >= 100) break;
      ctx.progress(`Unresolved issues in ${p.slug}`);
      try {
        const r: any[] = await sentryApi(ctx, `/projects/${org}/${p.slug}/issues/?${qs({ query: 'is:unresolved', statsPeriod: '14d', limit: Math.min(100, 100 - issues.length) })}`);
        issues.push(...r.map((i) => ({ i, project: p.slug })));
      } catch (e) {
        ctx.progress(`Skipped ${p.slug}: ${(e as Error).message.slice(0, 100)}`);
      }
    }
    const top = issues.slice(0, 100);

    const assignees = top.filter(({ i }) => i.assignedTo?.type === 'user');
    const people = await upsertPeople(g, assignees.map(({ i }) => ({ id: String(i.assignedTo.id), name: i.assignedTo.name, email: i.assignedTo.email || undefined, source: 'sentry' })));

    ctx.progress(`Linking ${top.length} issues`);
    await upsertNodes(g, 'Ticket', top.map(({ i, project }) => {
      const count = Number(i.count) || 0;
      const body = [i.culprit, i.metadata?.value, i.metadata?.type].filter(Boolean).join('\n');
      return {
        uid: tUid(i.shortId),
        props: {
          key: i.shortId, name: `${i.shortId} ${i.title}`, title: i.title, status: 'open', priority: priority(i.level, count), level: i.level,
          body: clip(body, 1500), at: ms(i.firstSeen), lastSeen: ms(i.lastSeen), events: count, users: i.userCount, url: i.permalink,
          project, sentryId: i.id, kind: 'error', source: 'sentry',
        },
        search: `${i.shortId} ${i.title} ${i.culprit || ''} ${project} error`,
      };
    }));
    await link(g, 'Ticket', 'AFFECTS', 'System', top.map(({ i, project }) => ({ from: tUid(i.shortId), to: sysUid(project) })));
    await link(g, 'Ticket', 'ASSIGNED_TO', 'Person', assignees.filter(({ i }) => people.has(String(i.assignedTo.id))).map(({ i }) => ({ from: tUid(i.shortId), to: people.get(String(i.assignedTo.id))! })));
    const mentions = await linkMentions(g, 'Ticket', top.map(({ i }) => ({ uid: tUid(i.shortId), text: `${i.title}\n${i.culprit || ''}` })));
    return { systems: projects.length, issues: top.length, p1: top.filter(({ i }) => priority(i.level, Number(i.count) || 0) === 'P1').length, mentions };
  },
  actions: [
    {
      name: 'resolve_issue',
      description: 'Mark a Sentry issue resolved (numeric issue id or short id like PAYMENTS-1A).',
      params: { type: 'object', properties: { issueId: { type: 'string' } }, required: ['issueId'] },
      mutates: true,
      async run(ctx, a) {
        const [org] = need(ctx, 'org');
        let id = String(a.issueId).trim().replace(/^ticket:sentry:/, '');
        let shortId = id;
        if (!/^\d+$/.test(id)) {
          const r = await sentryApi(ctx, `/organizations/${org}/shortids/${encodeURIComponent(id)}/`);
          id = String(r.groupId);
        }
        let r: any;
        try {
          r = await sentryApi(ctx, `/organizations/${org}/issues/${id}/`, { status: 'resolved' }, 'PUT');
        } catch (e) {
          if (!/ 404:/.test((e as Error).message)) throw e;
          r = await sentryApi(ctx, `/issues/${id}/`, { status: 'resolved' }, 'PUT');
        }
        shortId = r?.shortId || shortId;
        await ctx.g.q(`MATCH (t:Ticket {uid: $uid}) SET t.status = 'resolved', t.resolvedAt = $now`, { uid: tUid(shortId), now: Date.now() }, 'mark sentry ticket resolved').catch(() => {});
        return `Resolved Sentry issue ${shortId}${r?.permalink ? `: ${r.permalink}` : ''}`;
      },
    },
  ],
};
