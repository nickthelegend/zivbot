import { createHash } from 'node:crypto';
import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes } from '../../ingest.ts';
import { clip, linkMentions } from './_util.ts';

async function fc(ctx: ConnectorCtx, path: string, body: unknown): Promise<any> {
  const [apiKey] = need(ctx, 'apiKey');
  const r = await getJson(`https://api.firecrawl.dev/v1${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r && r.success === false) throw new Error(`Firecrawl: ${r.error || 'request failed'}`);
  return r;
}

const webDocUid = (url: string) => `doc:web:${createHash('sha1').update(url).digest('hex').slice(0, 16)}`;

export const firecrawl: ConnectorDef = {
  id: 'firecrawl',
  name: 'Firecrawl',
  category: 'Research',
  description: 'Read any public web page as clean markdown (saved to the graph as a Doc) and search the web.',
  icon: 'firecrawl',
  color: '#FF4C00',
  auth: 'key',
  docs: 'https://www.firecrawl.dev/app/api-keys',
  fields: [{ key: 'apiKey', label: 'API key', env: 'FIRECRAWL_API_KEY', secret: true, placeholder: 'fc-…' }],
  actions: [
    {
      name: 'scrape',
      description: 'Fetch a public web page as markdown, store it as a Doc linked to the entities it mentions, and return the first ~3000 characters.',
      params: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      mutates: false,
      async run(ctx, a) {
        const url = String(a.url).trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Pass a full http(s) URL');
        const r = await fc(ctx, '/scrape', { url, formats: ['markdown'], onlyMainContent: true });
        const md: string = r.data?.markdown || '';
        const meta = r.data?.metadata || {};
        const src = meta.sourceURL || meta.url || url;
        const title = meta.title || meta.ogTitle || src;
        const uid = webDocUid(src);
        await upsertNodes(ctx.g, 'Doc', [{
          uid,
          props: { name: clip(title, 120), title, body: clip(md, 12000), url: src, description: meta.description, at: Date.now(), kind: 'web', source: 'firecrawl' },
          search: `${title} ${meta.description || ''} ${clip(md, 4000)}`,
        }]);
        await linkMentions(ctx.g, 'Doc', [{ uid, text: `${title}\n${md.slice(0, 20000)}` }]);
        return `# ${title}\n${src}\n\n${clip(md, 3000)}`;
      },
    },
    {
      name: 'search',
      description: 'Search the web; returns titles, URLs and descriptions.',
      params: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Default 5, max 10' } }, required: ['query'] },
      mutates: false,
      async run(ctx, a) {
        const limit = Math.max(1, Math.min(10, Number(a.limit) || 5));
        const r = await fc(ctx, '/search', { query: String(a.query), limit });
        const hits: any[] = Array.isArray(r.data) ? r.data : r.data?.web || [];
        if (!hits.length) return `No results for "${a.query}".`;
        return hits.map((h, i) => `${i + 1}. ${h.title || h.url}\n   ${h.url}${h.description ? `\n   ${clip(h.description, 200)}` : ''}`).join('\n');
      },
    },
  ],
};
