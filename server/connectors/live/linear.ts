import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link, upsertPeople } from '../../ingest.ts';
import { clip, linkMentions, daysAgo, ms } from './_util.ts';

async function gql(ctx: ConnectorCtx, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const [apiKey] = need(ctx, 'apiKey');
  const r = await getJson('https://api.linear.app/graphql', {
    method: 'POST',
    // Personal API keys go in Authorization as-is; OAuth tokens need "Bearer".
    headers: { authorization: apiKey.startsWith('lin_oauth') ? `Bearer ${apiKey}` : apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (r?.errors?.length) throw new Error(`Linear: ${r.errors.map((e: any) => e.message).join('; ')}`);
  return r.data;
}

const PRI: Record<number, string> = { 0: 'P4', 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' };
const teamUid = (id: string) => `team:linear:${id}`;
const projUid = (id: string) => `project:linear:${id}`;
const tUid = (ident: string) => `ticket:linear:${ident}`;

const ISSUE_FIELDS = `id identifier title description priority url createdAt updatedAt completedAt canceledAt
  state { name type } assignee { id } creator { id } team { id key } project { id } labels { nodes { name } }`;

export const linear: ConnectorDef = {
  id: 'linear',
  name: 'Linear',
  category: 'Productivity',
  description: 'Teams, projects and recently updated issues from Linear; create issues and comment with approval.',
  icon: 'linear',
  color: '#5E6AD2',
  auth: 'key',
  docs: 'https://linear.app/settings/account/security',
  fields: [
    { key: 'apiKey', label: 'Personal API key', env: 'LINEAR_API_KEY', secret: true, placeholder: 'lin_api_…', help: 'Linear → Settings → Account → Security & access → Personal API keys.' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    ctx.progress('Reading Linear teams, people and projects');
    const d = await gql(ctx, `query {
      teams(first: 50) { nodes { id key name members(first: 100) { nodes { id } } } }
      users(first: 200) { nodes { id name displayName email active avatarUrl } }
      projects(first: 100) { nodes { id name description state url targetDate lead { id } members(first: 50) { nodes { id } } } }
    }`);
    const teams: any[] = d.teams?.nodes || [];
    const users: any[] = (d.users?.nodes || []).filter((u: any) => u.active !== false);
    const projects: any[] = d.projects?.nodes || [];

    const people = await upsertPeople(g, users.map((u) => ({ id: u.id, name: u.name || u.displayName, email: u.email || undefined, avatar: u.avatarUrl || undefined, source: 'linear' })));
    await upsertNodes(g, 'Team', teams.map((t) => ({ uid: teamUid(t.id), props: { name: t.name, key: t.key, source: 'linear' }, search: `${t.name} ${t.key} team` })));
    await link(g, 'Person', 'MEMBER_OF', 'Team', teams.flatMap((t) => (t.members?.nodes || []).filter((m: any) => people.has(m.id)).map((m: any) => ({ from: people.get(m.id)!, to: teamUid(t.id) }))));
    await upsertNodes(g, 'Project', projects.map((p) => ({
      uid: projUid(p.id),
      props: { name: p.name, status: p.state, description: clip(p.description, 1000), url: p.url, targetDate: p.targetDate, source: 'linear' },
      search: `${p.name} project ${p.description || ''}`,
    })));
    await link(g, 'Person', 'OWNS', 'Project', projects.filter((p) => p.lead && people.has(p.lead.id)).map((p) => ({ from: people.get(p.lead.id)!, to: projUid(p.id) })));
    await link(g, 'Person', 'WORKS_ON', 'Project', projects.flatMap((p) => (p.members?.nodes || []).filter((m: any) => people.has(m.id)).map((m: any) => ({ from: people.get(m.id)!, to: projUid(p.id) }))));

    ctx.progress('Reading Linear issues updated in the last 60 days');
    const since = new Date(daysAgo(60)).toISOString();
    const issues: any[] = [];
    let after: string | null = null;
    do {
      const r: any = await gql(ctx, `query($after: String) {
        issues(first: 100, after: $after, orderBy: updatedAt, filter: { updatedAt: { gte: "${since}" } }) {
          nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor }
        }
      }`, { after });
      issues.push(...(r.issues?.nodes || []));
      after = r.issues?.pageInfo?.hasNextPage ? r.issues.pageInfo.endCursor : null;
    } while (after && issues.length < 200);
    const top = issues.slice(0, 200);

    // Assignees/creators who left (inactive) still deserve a node.
    const missing = [...new Set(top.flatMap((i) => [i.assignee?.id, i.creator?.id]).filter((id) => id && !people.has(id)))];
    if (missing.length) {
      const extra = await gql(ctx, `query($ids: [ID!]) { users(filter: { id: { in: $ids } }, includeDisabled: true) { nodes { id name email } } }`, { ids: missing }).catch(() => null);
      const more = await upsertPeople(g, (extra?.users?.nodes || []).map((u: any) => ({ id: u.id, name: u.name, email: u.email || undefined, source: 'linear' })));
      for (const [k, v] of more) people.set(k, v);
    }

    ctx.progress(`Linking ${top.length} issues`);
    await upsertNodes(g, 'Ticket', top.map((i) => {
      const resolved = ['completed', 'canceled'].includes(i.state?.type);
      const labels = (i.labels?.nodes || []).map((l: any) => l.name);
      return {
        uid: tUid(i.identifier),
        props: {
          key: i.identifier, name: `${i.identifier} ${i.title}`, title: i.title, status: resolved ? 'resolved' : 'open', state: i.state?.name,
          priority: PRI[i.priority ?? 0] || 'P4', body: clip(i.description, 2000), at: ms(i.createdAt), updatedAt: ms(i.updatedAt),
          resolvedAt: ms(i.completedAt || i.canceledAt), url: i.url, labels, team: i.team?.key, linearId: i.id, source: 'linear',
        },
        search: `${i.identifier} ${i.title} ${labels.join(' ')} ${clip(i.description, 800)}`,
      };
    }));
    await link(g, 'Ticket', 'ASSIGNED_TO', 'Person', top.filter((i) => i.assignee && people.has(i.assignee.id)).map((i) => ({ from: tUid(i.identifier), to: people.get(i.assignee.id)! })));
    await link(g, 'Ticket', 'REPORTED_BY', 'Person', top.filter((i) => i.creator && people.has(i.creator.id)).map((i) => ({ from: tUid(i.identifier), to: people.get(i.creator.id)! })));
    await link(g, 'Ticket', 'PART_OF', 'Project', top.filter((i) => i.project).map((i) => ({ from: tUid(i.identifier), to: projUid(i.project.id) })));
    await link(g, 'Ticket', 'PART_OF', 'Team', top.filter((i) => i.team).map((i) => ({ from: tUid(i.identifier), to: teamUid(i.team.id) })));
    const mentions = await linkMentions(g, 'Ticket', top.map((i) => ({ uid: tUid(i.identifier), text: `${i.title}\n${i.description || ''}` })));
    return { teams: teams.length, people: users.length, projects: projects.length, issues: top.length, mentions };
  },
  actions: [
    {
      name: 'create_issue',
      description: 'Create a Linear issue in a team (by team key like "ENG" or team id).',
      params: {
        type: 'object',
        properties: { teamKey: { type: 'string' }, teamId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'number', description: '1 urgent … 4 low' } },
        required: ['title'],
      },
      mutates: true,
      async run(ctx, a) {
        let teamId = a.teamId as string | undefined;
        if (!teamId) {
          const t = await gql(ctx, `query { teams(first: 100) { nodes { id key name } } }`);
          const nodes: any[] = t.teams?.nodes || [];
          const want = String(a.teamKey || '').toLowerCase();
          const hit = want ? nodes.find((n) => n.key.toLowerCase() === want || n.name.toLowerCase() === want) : nodes.length === 1 ? nodes[0] : undefined;
          if (!hit) throw new Error(`Pick a team: ${nodes.map((n) => n.key).join(', ')}`);
          teamId = hit.id;
        }
        const r = await gql(ctx, `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url title } } }`, {
          input: { teamId, title: String(a.title), description: a.description ? String(a.description) : undefined, priority: a.priority ? Number(a.priority) : undefined },
        });
        const i = r.issueCreate?.issue;
        if (!r.issueCreate?.success || !i) throw new Error('Linear did not create the issue');
        return `Created ${i.identifier} "${i.title}": ${i.url}`;
      },
    },
    {
      name: 'comment',
      description: 'Add a comment to a Linear issue (identifier like ENG-12, or issue id).',
      params: { type: 'object', properties: { issueId: { type: 'string' }, body: { type: 'string' } }, required: ['issueId', 'body'] },
      mutates: true,
      async run(ctx, a) {
        const q = await gql(ctx, `query($id: String!) { issue(id: $id) { id identifier url } }`, { id: String(a.issueId).trim() });
        if (!q.issue) throw new Error(`No Linear issue ${a.issueId}`);
        const r = await gql(ctx, `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }`, { input: { issueId: q.issue.id, body: String(a.body) } });
        if (!r.commentCreate?.success) throw new Error('Linear did not add the comment');
        return `Commented on ${q.issue.identifier}: ${r.commentCreate.comment?.url || q.issue.url}`;
      },
    },
  ],
};
