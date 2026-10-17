import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link, upsertPeople } from '../../ingest.ts';
import { clip, ms, qs, resolveOrgs } from './_util.ts';

async function hs(ctx: ConnectorCtx, path: string, body?: unknown, method?: string): Promise<any> {
  const [token] = need(ctx, 'token');
  return getJson(`https://api.hubapi.com${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Page through a CRM v3 object list. */
async function objects(ctx: ConnectorCtx, type: string, properties: string[], max: number, associations: string[] = []): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  do {
    const r = await hs(ctx, `/crm/v3/objects/${type}?${qs({ limit: 100, after, properties: properties.join(','), associations: associations.join(',') || undefined, archived: false })}`);
    out.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after && out.length < max);
  return out.slice(0, max);
}

const assoc = (o: any, type: string): string[] => (o.associations?.[type]?.results || []).map((r: any) => String(r.id));
const orgKey = (id: string) => `org:hubspot:${id}`;
const dealUid = (id: string) => `project:hubspot:${id}`;

export const hubspot: ConnectorDef = {
  id: 'hubspot',
  name: 'HubSpot',
  category: 'Sales',
  description: 'Companies, contacts and deals from HubSpot CRM; log notes on contacts with approval.',
  icon: 'hubspot',
  color: '#FF7A59',
  auth: 'key',
  docs: 'https://developers.hubspot.com/docs/api/private-apps',
  fields: [
    { key: 'token', label: 'Private app access token', env: 'HUBSPOT_TOKEN', secret: true, placeholder: 'pat-na1-…', help: 'Settings → Integrations → Private Apps → create app with CRM read scopes (+ notes write for actions).' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    ctx.progress('Reading HubSpot companies');
    const companies = await objects(ctx, 'companies', ['name', 'domain', 'lifecyclestage', 'industry', 'annualrevenue', 'numberofemployees', 'city', 'country'], 100);
    const { uids: orgUids, known } = await resolveOrgs(g, companies.map((c) => ({ id: c.id, name: c.properties?.name || undefined, domain: c.properties?.domain || undefined })), orgKey);
    await upsertNodes(g, 'Org', companies.map((c) => {
      const p = c.properties || {};
      const kind = p.lifecyclestage === 'customer' ? 'customer' : p.lifecyclestage || 'prospect';
      const hubProps = { hubspotId: c.id, lifecycle: p.lifecyclestage || undefined, industry: p.industry || undefined, employees: p.numberofemployees ? Number(p.numberofemployees) : undefined };
      return known.has(c.id)
        ? { uid: orgUids.get(c.id)!, props: hubProps }
        : { uid: orgUids.get(c.id)!, props: { name: p.name || p.domain || `Company ${c.id}`, kind, domain: p.domain || undefined, revenue: p.annualrevenue ? Number(p.annualrevenue) : undefined, location: [p.city, p.country].filter(Boolean).join(', ') || undefined, source: 'hubspot', ...hubProps }, search: `${p.name || ''} ${p.domain || ''} ${p.industry || ''} ${kind} company` };
    }));

    ctx.progress('Reading HubSpot contacts');
    const contacts = await objects(ctx, 'contacts', ['firstname', 'lastname', 'email', 'jobtitle', 'company'], 200, ['companies']);
    const people = await upsertPeople(g, contacts.map((c) => {
      const p = c.properties || {};
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ');
      return { id: c.id, name: name || undefined, email: p.email || undefined, role: p.jobtitle || undefined, external: true, source: 'hubspot' };
    }).filter((p) => p.name || p.email));
    await link(g, 'Person', 'WORKS_AT', 'Org', contacts.flatMap((c) => assoc(c, 'companies').filter((id) => orgUids.has(id) && people.has(c.id)).map((id) => ({ from: people.get(c.id)!, to: orgUids.get(id)! }))));

    ctx.progress('Reading HubSpot deals');
    const deals = await objects(ctx, 'deals', ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'hs_lastmodifieddate', 'hs_is_closed_won', 'hs_is_closed'], 100, ['companies', 'contacts']);
    await upsertNodes(g, 'Project', deals.map((d) => {
      const p = d.properties || {};
      const status = p.hs_is_closed_won === 'true' ? 'won' : p.hs_is_closed === 'true' ? 'lost' : 'open';
      return {
        uid: dealUid(d.id),
        props: { name: p.dealname || `Deal ${d.id}`, kind: 'deal', amount: p.amount ? Number(p.amount) : undefined, stage: p.dealstage, pipeline: p.pipeline, status, closeAt: ms(p.closedate), at: ms(p.hs_lastmodifieddate), hubspotId: d.id, source: 'hubspot' },
        search: `${p.dealname || ''} deal ${p.dealstage || ''}`,
      };
    }));
    await link(g, 'Project', 'FOR', 'Org', deals.flatMap((d) => assoc(d, 'companies').filter((id) => orgUids.has(id)).map((id) => ({ from: dealUid(d.id), to: orgUids.get(id)! }))));
    await link(g, 'Person', 'WORKS_ON', 'Project', deals.flatMap((d) => assoc(d, 'contacts').filter((id) => people.has(id)).map((id) => ({ from: people.get(id)!, to: dealUid(d.id) }))));
    const pipeline = deals.filter((d) => d.properties?.hs_is_closed !== 'true').reduce((t, d) => t + (Number(d.properties?.amount) || 0), 0);
    return { companies: companies.length, contacts: people.size, deals: deals.length, openPipeline: Math.round(pipeline) };
  },
  actions: [
    {
      name: 'create_note',
      description: 'Log a note on a HubSpot contact (found by email).',
      params: { type: 'object', properties: { contactEmail: { type: 'string' }, body: { type: 'string' } }, required: ['contactEmail', 'body'] },
      mutates: true,
      async run(ctx, a) {
        const email = String(a.contactEmail).trim();
        const s = await hs(ctx, '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['email', 'firstname', 'lastname'], limit: 1 });
        const c = s.results?.[0];
        if (!c) throw new Error(`No HubSpot contact with email ${email}`);
        const note = await hs(ctx, '/crm/v3/objects/notes', {
          properties: { hs_note_body: String(a.body).replace(/\n/g, '<br>'), hs_timestamp: new Date().toISOString() },
          // 202 = note → contact (HubSpot-defined association type)
          associations: [{ to: { id: c.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
        });
        const portal = await hs(ctx, '/account-info/v3/details').then((d) => d.portalId).catch(() => null);
        return `Logged note on ${[c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ') || email}: "${clip(a.body, 80)}"${portal ? ` https://app.hubspot.com/contacts/${portal}/record/0-1/${c.id}` : ` (note ${note.id})`}`;
      },
    },
  ],
};
