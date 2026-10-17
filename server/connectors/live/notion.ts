import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link, upsertPeople } from '../../ingest.ts';
import { clip, linkMentions, pool, ms } from './_util.ts';

const NOTION = 'https://api.notion.com/v1';

async function notionApi(ctx: ConnectorCtx, path: string, body?: unknown, method?: string): Promise<any> {
  const [token] = need(ctx, 'token');
  return getJson(`${NOTION}${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const docUid = (id: string) => `doc:notion:${id.replace(/-/g, '')}`;
const rich = (rt: any[] | undefined) => (rt || []).map((t) => t.plain_text || '').join('');

function pageTitle(p: any): string {
  if (p.object === 'database') return rich(p.title) || 'Untitled database';
  for (const v of Object.values<any>(p.properties || {})) if (v?.type === 'title') return rich(v.title) || 'Untitled';
  return 'Untitled';
}

function blockText(b: any): string {
  const v = b[b.type] || {};
  const t = rich(v.rich_text) || rich(v.text) || (v.title ? String(v.title) : '');
  if (!t) return '';
  if (b.type.startsWith('heading_')) return `${'#'.repeat(Number(b.type.slice(-1)))} ${t}`;
  if (b.type === 'bulleted_list_item') return `- ${t}`;
  if (b.type === 'numbered_list_item') return `1. ${t}`;
  if (b.type === 'to_do') return `[${v.checked ? 'x' : ' '}] ${t}`;
  return t;
}

/** Markdown-ish lines → Notion blocks (headings, bullets, to-dos, paragraphs). */
function toBlocks(md: string) {
  const rt = (s: string) => [{ type: 'text', text: { content: s.slice(0, 2000) } }];
  return String(md || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(0, 100).map((l) => {
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)$/))) { const t = `heading_${m[1].length}`; return { object: 'block', type: t, [t]: { rich_text: rt(m[2]) } }; }
    if ((m = l.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)$/i))) return { object: 'block', type: 'to_do', to_do: { rich_text: rt(m[2]), checked: m[1].toLowerCase() === 'x' } };
    if ((m = l.match(/^\s*[-*]\s+(.*)$/))) return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(m[1]) } };
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) return { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: rt(m[1]) } };
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: rt(l) } };
  });
}

export const notion: ConnectorDef = {
  id: 'notion',
  name: 'Notion',
  category: 'Productivity',
  description: 'Pages and docs shared with your Notion integration, who wrote them, and what they mention.',
  icon: 'notion',
  color: '#000000',
  auth: 'key',
  docs: 'https://www.notion.so/my-integrations',
  fields: [
    { key: 'token', label: 'Integration secret', env: 'NOTION_TOKEN', secret: true, placeholder: 'ntn_… or secret_…', help: 'Create an internal integration, then share pages with it (page ••• → Connections).' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    ctx.progress('Searching Notion pages');
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const r = await notionApi(ctx, '/search', { filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 100, start_cursor: cursor });
      pages.push(...(r.results || []).filter((p: any) => !p.archived && !p.in_trash));
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor && pages.length < 100);
    const top = pages.slice(0, 100);

    ctx.progress('Reading Notion users');
    const users = new Map<string, any>();
    try {
      let uc: string | undefined;
      do {
        const r = await notionApi(ctx, `/users?page_size=100${uc ? `&start_cursor=${uc}` : ''}`);
        for (const u of r.results || []) users.set(u.id, u);
        uc = r.has_more ? r.next_cursor : undefined;
      } while (uc && users.size < 500);
    } catch (e) {
      ctx.progress(`Notion users unavailable (${(e as Error).message.slice(0, 80)}); owners will be matched by id only`);
    }

    ctx.progress(`Reading ${top.length} pages`);
    const bodies = await pool(top, 4, async (p) => {
      const r = await notionApi(ctx, `/blocks/${p.id}/children?page_size=50`);
      return (r.results || []).map(blockText).filter(Boolean).join('\n');
    });

    const authorIds = new Set<string>();
    for (const p of top) for (const id of [p.created_by?.id, p.last_edited_by?.id]) if (id) authorIds.add(id);
    const people = await upsertPeople(g, [...authorIds].filter((id) => users.get(id)?.type !== 'bot').map((id) => {
      const u = users.get(id);
      return { id, name: u?.name || undefined, email: u?.person?.email || undefined, avatar: u?.avatar_url || undefined, source: 'notion' };
    }).filter((p) => p.name || p.email));

    const docs = top.map((p, i) => ({ p, uid: docUid(p.id), title: pageTitle(p), body: bodies[i] || '' }));
    await upsertNodes(g, 'Doc', docs.map((d) => ({
      uid: d.uid,
      props: { name: d.title, title: d.title, body: clip(d.body, 6000), url: d.p.url, at: ms(d.p.last_edited_time), createdAt: ms(d.p.created_time), notionId: d.p.id, source: 'notion' },
      search: `${d.title} ${clip(d.body, 4000)}`,
    })));
    await link(g, 'Person', 'OWNS', 'Doc', docs.filter((d) => people.has(d.p.created_by?.id)).map((d) => ({ from: people.get(d.p.created_by.id)!, to: d.uid })));
    await link(g, 'Person', 'EDITED', 'Doc', docs.filter((d) => d.p.last_edited_by?.id !== d.p.created_by?.id && people.has(d.p.last_edited_by?.id)).map((d) => ({ from: people.get(d.p.last_edited_by.id)!, to: d.uid })));
    // Sub-pages hang off their parent page.
    await link(g, 'Doc', 'PART_OF', 'Doc', docs.filter((d) => d.p.parent?.type === 'page_id').map((d) => ({ from: d.uid, to: docUid(d.p.parent.page_id) })));
    ctx.progress('Linking mentions');
    const mentions = await linkMentions(g, 'Doc', docs.map((d) => ({ uid: d.uid, text: `${d.title}\n${d.body}` })));
    return { pages: docs.length, people: people.size, mentions };
  },
  actions: [
    {
      name: 'create_page',
      description: 'Create a Notion page under a parent page. Markdown lines become headings, bullets, to-dos or paragraphs.',
      params: { type: 'object', properties: { parent_page_id: { type: 'string' }, title: { type: 'string' }, markdown: { type: 'string' } }, required: ['parent_page_id', 'title'] },
      mutates: true,
      async run(ctx, a) {
        const parent = String(a.parent_page_id).trim().replace(/^.*[-/]([0-9a-f]{32})(\?.*)?$/i, '$1');
        const r = await notionApi(ctx, '/pages', {
          parent: { page_id: parent },
          properties: { title: { title: [{ type: 'text', text: { content: String(a.title).slice(0, 2000) } }] } },
          children: toBlocks(a.markdown || ''),
        });
        await upsertNodes(ctx.g, 'Doc', [{ uid: docUid(r.id), props: { name: a.title, title: a.title, body: clip(a.markdown || '', 6000), url: r.url, at: Date.now(), source: 'notion' }, search: `${a.title} ${a.markdown || ''}` }]);
        return `Created Notion page "${a.title}": ${r.url}`;
      },
    },
    {
      name: 'search',
      description: 'Search Notion pages shared with the integration by title.',
      params: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      mutates: false,
      async run(ctx, a) {
        const r = await notionApi(ctx, '/search', { query: String(a.query), page_size: 10 });
        const hits = (r.results || []) as any[];
        if (!hits.length) return `No Notion pages match "${a.query}".`;
        return hits.map((p) => `${pageTitle(p)} — ${p.url} (edited ${String(p.last_edited_time).slice(0, 10)})`).join('\n');
      },
    },
  ],
};

