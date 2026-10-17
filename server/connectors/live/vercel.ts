import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link } from '../../ingest.ts';
import { clip, ms, qs, slugify, upsertSystems } from './_util.ts';

async function vercelApi(ctx: ConnectorCtx, path: string, params: Record<string, string | number | undefined> = {}, body?: unknown): Promise<any> {
  const [token] = need(ctx, 'token');
  const q = qs({ ...params, teamId: ctx.config.teamId || undefined });
  return getJson(`https://api.vercel.com${path}${q ? `?${q}` : ''}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const sysUid = (name: string) => `system:${slugify(name)}`;
const runUid = (id: string) => `run:vercel:${id}`;
const STATUS: Record<string, string> = { READY: 'succeeded', ERROR: 'failed', CANCELED: 'canceled', BUILDING: 'running', INITIALIZING: 'running', QUEUED: 'queued' };
const stateOf = (d: any) => String(d.state || d.readyState || 'UNKNOWN').toUpperCase();

async function projectByName(ctx: ConnectorCtx, name: string) {
  return vercelApi(ctx, `/v9/projects/${encodeURIComponent(String(name).trim())}`);
}

export const vercel: ConnectorDef = {
  id: 'vercel',
  name: 'Vercel',
  category: 'Code',
  description: 'Vercel projects as systems and recent deployments as runs; check deploy status and redeploy with approval.',
  icon: 'vercel',
  color: '#000000',
  auth: 'key',
  docs: 'https://vercel.com/account/settings/tokens',
  fields: [
    { key: 'token', label: 'Access token', env: 'VERCEL_TOKEN', secret: true },
    { key: 'teamId', label: 'Team ID', env: 'VERCEL_TEAM_ID', optional: true, placeholder: 'team_…', help: 'Only for team-owned projects (Team Settings → General → Team ID).' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    ctx.progress('Reading Vercel projects');
    const pr = await vercelApi(ctx, '/v9/projects', { limit: 100 });
    const projects: any[] = pr.projects || [];
    const byId = new Map(projects.map((p) => [p.id, p]));

    ctx.progress('Reading recent deployments');
    const dr = await vercelApi(ctx, '/v6/deployments', { limit: 50 });
    const deployments: any[] = (dr.deployments || []).slice(0, 50);
    const latest = new Map<string, any>();
    for (const d of deployments) {
      const pid = d.projectId || projects.find((p) => p.name === d.name)?.id;
      if (pid && (!latest.has(pid) || (d.created || 0) > (latest.get(pid).created || 0))) latest.set(pid, d);
    }

    await upsertSystems(g, projects.map((p) => {
      const last = latest.get(p.id);
      return {
        uid: sysUid(p.name),
        name: p.name,
        props: {
          vercelProject: p.name, framework: p.framework || undefined, repoUrl: p.link?.repo ? `${p.link.type || 'github'}:${p.link.org || ''}/${p.link.repo}` : undefined,
          lastDeployState: last ? stateOf(last) : undefined, lastDeployAt: last ? ms(last.created) : undefined, lastDeployUrl: last?.url ? `https://${last.url}` : undefined, deployedOn: 'vercel',
        },
        search: `${p.name} ${p.framework || ''} vercel app service system`,
      };
    }));

    const projName = (d: any) => byId.get(d.projectId)?.name || d.name;
    await upsertNodes(g, 'Run', deployments.map((d) => {
      const st = stateOf(d);
      const msg = d.meta?.githubCommitMessage || d.meta?.gitlabCommitMessage || d.meta?.bitbucketCommitMessage || '';
      return {
        uid: runUid(d.uid),
        props: {
          name: `Deploy ${projName(d)}${d.target ? ` (${d.target})` : ''}${msg ? ` — ${clip(msg.split('\n')[0], 60)}` : ''}`, kind: 'deploy', status: STATUS[st] || st.toLowerCase(), state: st,
          startedAt: ms(d.buildingAt || d.created), endedAt: ms(d.ready), at: ms(d.created), url: d.url ? `https://${d.url}` : undefined, inspectorUrl: d.inspectorUrl,
          target: d.target || 'preview', commit: d.meta?.githubCommitSha?.slice(0, 10), commitMessage: clip(msg, 300), branch: d.meta?.githubCommitRef, by: d.creator?.username, source: 'vercel',
        },
        search: `deploy ${projName(d)} ${st} ${msg}`,
      };
    }));
    await link(g, 'Run', 'WORKED_ON', 'System', deployments.filter((d) => projName(d)).map((d) => ({ from: runUid(d.uid), to: sysUid(projName(d)) })));
    return { projects: projects.length, deployments: deployments.length, failed: deployments.filter((d) => stateOf(d) === 'ERROR').length };
  },
  actions: [
    {
      name: 'deployment_status',
      description: 'Show the latest deployments of a Vercel project (by name) and their state.',
      params: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
      mutates: false,
      async run(ctx, a) {
        const p = await projectByName(ctx, a.project);
        const r = await vercelApi(ctx, '/v6/deployments', { projectId: p.id, limit: 5 });
        const ds: any[] = r.deployments || [];
        if (!ds.length) return `${p.name}: no deployments yet.`;
        return [`${p.name} — latest deployments:`, ...ds.map((d) => `  · ${stateOf(d)} ${d.target || 'preview'} ${new Date(d.created).toISOString().replace('T', ' ').slice(0, 16)} UTC${d.meta?.githubCommitMessage ? ` "${clip(d.meta.githubCommitMessage.split('\n')[0], 60)}"` : ''} https://${d.url}`)].join('\n');
      },
    },
    {
      name: 'redeploy',
      description: 'Redeploy the most recent deployment of a Vercel project (production by default).',
      params: { type: 'object', properties: { project: { type: 'string' }, target: { type: 'string', enum: ['production', 'preview'] } }, required: ['project'] },
      mutates: true,
      async run(ctx, a) {
        const p = await projectByName(ctx, a.project);
        const target = a.target === 'preview' ? 'preview' : 'production';
        const r = await vercelApi(ctx, '/v6/deployments', { projectId: p.id, limit: 20, ...(target === 'production' ? { target: 'production' } : {}) });
        const ds: any[] = r.deployments || [];
        const base = ds.find((d) => stateOf(d) === 'READY') || ds[0];
        if (!base) throw new Error(`${p.name} has no deployment to redeploy`);
        const d = await vercelApi(ctx, '/v13/deployments', { forceNew: 1 }, { name: p.name, deploymentId: base.uid, target, project: p.id });
        return `Redeploying ${p.name} (${target}) from ${base.uid}: https://${d.url}${d.inspectorUrl ? ` · ${d.inspectorUrl}` : ''}`;
      },
    },
  ],
};
