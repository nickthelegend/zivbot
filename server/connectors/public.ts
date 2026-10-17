import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { UserGraph } from '../graph.ts';
import { upsertNodes, link, linkAny, loadDictionary, mentionsIn, upsertPeople } from '../ingest.ts';
import { getJson, type ConnectorDef, type ConnectorCtx } from './types.ts';
import { ingestGithub, ingestRepo } from './git.ts';
import { clip } from '../util.ts';

/** Connectors that work with no API key: public data and things on this computer. */

const h = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

async function saveDocs(g: UserGraph, source: string, docs: { uid: string; title: string; body: string; url?: string; at?: number; author?: string }[]) {
  const dict = await loadDictionary(g);
  await upsertNodes(g, 'Doc', docs.map((d) => ({ uid: d.uid, props: { name: d.title, title: d.title, body: clip(d.body, 4000), url: d.url, at: d.at || Date.now(), source }, search: `${d.title} ${clip(d.body, 1500)}` })));
  await linkAny(g, 'Doc', 'MENTIONS', docs.flatMap((d) => mentionsIn(dict, `${d.title} ${d.body}`).map((to) => ({ from: d.uid, to }))));
  const authors = docs.filter((d) => d.author);
  if (authors.length) {
    const ids = await upsertPeople(g, authors.map((d) => ({ id: d.author!, name: d.author!, source, external: true })));
    await link(g, 'Person', 'OWNS', 'Doc', authors.map((d) => ({ from: ids.get(d.author!)!, to: d.uid })));
  }
}

export const stripHtml = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<\/(p|div|h\d|li|br|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

const tag = (xml: string, t: string) => xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i'))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '';

export const githubPublic: ConnectorDef = {
  id: 'github',
  name: 'GitHub (public repos)',
  category: 'Code',
  description: 'Map any public repo — contributors, open issues and PRs, the file tree — into your graph. No key needed.',
  icon: 'github',
  auth: 'none',
  recommended: true,
  fields: [{ key: 'repo', label: 'Repository', placeholder: 'FalkorDB/FalkorDB' }],
  async sync(ctx) {
    const repo = ctx.config.repo || 'FalkorDB/FalkorDB';
    ctx.progress(`Reading ${repo} from GitHub…`);
    return ingestGithub(ctx.g, repo);
  },
};

export const gitLocal: ConnectorDef = {
  id: 'git',
  name: 'Git repo on this computer',
  category: 'Code',
  description: 'Files, imports, commits and authors from a local repository — and a place your coding agents can work.',
  icon: 'git',
  auth: 'local',
  fields: [
    { key: 'path', label: 'Path', placeholder: '/Users/me/code/my-service' },
    { key: 'system', label: 'Implements system (optional)', placeholder: 'payments-api', optional: true },
  ],
  async sync(ctx) {
    const path = ctx.config.path;
    if (!path) throw new Error('Give the repo path');
    const name = path.replace(/\/+$/, '').split('/').pop()!;
    let implementsUid: string | undefined;
    if (ctx.config.system) {
      implementsUid = `system:${ctx.config.system}`;
      await upsertNodes(ctx.g, 'System', [{ uid: implementsUid, props: { name: ctx.config.system, key: ctx.config.system, source: 'git' }, search: `${ctx.config.system} system` }]);
    }
    ctx.progress(`Indexing ${name}…`);
    return ingestRepo(ctx.g, path, { name, implements: implementsUid });
  },
};

export const rss: ConnectorDef = {
  id: 'rss',
  name: 'RSS & blogs',
  category: 'Research',
  description: 'Follow blogs, changelogs and status pages. New posts land in your graph, linked to the people, vendors and systems they mention.',
  icon: 'rss',
  auth: 'none',
  fields: [{ key: 'feeds', label: 'Feed URLs (comma separated)', placeholder: 'https://github.blog/changelog/feed/, https://www.githubstatus.com/history.rss' }],
  async sync(ctx) {
    const feeds = (ctx.config.feeds || 'https://github.blog/changelog/feed/').split(',').map((s) => s.trim()).filter(Boolean);
    let n = 0;
    for (const url of feeds.slice(0, 10)) {
      ctx.progress(`Reading ${new URL(url).host}…`);
      const xml = await getJson<string>(url, { headers: { accept: 'application/rss+xml, application/atom+xml, text/xml' } }).then(String).catch(() => '');
      const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]).slice(0, 25);
      const docs = items.map((it) => {
        const link = tag(it, 'link') || it.match(/<link[^>]*href="([^"]+)"/i)?.[1] || url;
        const title = stripHtml(tag(it, 'title'));
        const body = stripHtml(tag(it, 'description') || tag(it, 'summary') || tag(it, 'content') || tag(it, 'content:encoded'));
        const at = Date.parse(tag(it, 'pubDate') || tag(it, 'updated') || tag(it, 'published')) || Date.now();
        return { uid: `doc:rss:${h(link + title)}`, title, body, url: link, at, author: stripHtml(tag(it, 'author') || tag(it, 'dc:creator')).split('\n')[0] || undefined };
      }).filter((d) => d.title);
      await saveDocs(ctx.g, 'rss', docs);
      n += docs.length;
    }
    return { feeds: feeds.length, posts: n };
  },
};

export const hackerNews: ConnectorDef = {
  id: 'hackernews',
  name: 'Hacker News',
  category: 'Research',
  description: 'Front-page stories and searches, so your dot can tell you when the internet is talking about your stack, competitors or vendors.',
  icon: 'ycombinator',
  auth: 'none',
  fields: [{ key: 'query', label: 'Track a topic (optional)', placeholder: 'graph database', optional: true }],
  async sync(ctx) {
    const q = ctx.config.query;
    ctx.progress(q ? `Searching HN for "${q}"…` : 'Reading the front page…');
    const r = await getJson<any>(`https://hn.algolia.com/api/v1/${q ? `search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=30` : 'search?tags=front_page&hitsPerPage=30'}`);
    const docs = (r.hits || []).map((s: any) => ({ uid: `doc:hn:${s.objectID}`, title: s.title, body: `${s.points} points, ${s.num_comments} comments. ${s.url || ''} ${stripHtml(s.story_text || '')}`, url: `https://news.ycombinator.com/item?id=${s.objectID}`, at: s.created_at_i * 1000, author: s.author }));
    await saveDocs(ctx.g, 'hackernews', docs);
    return { stories: docs.length };
  },
  actions: [{
    name: 'search',
    description: 'Search Hacker News stories.',
    params: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    mutates: false,
    async run(_ctx, { query }) {
      const r = await getJson<any>(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=8`);
      return (r.hits || []).map((s: any) => `- ${s.title} (${s.points} pts) https://news.ycombinator.com/item?id=${s.objectID}`).join('\n') || 'No stories.';
    },
  }],
};

export const icsCalendar: ConnectorDef = {
  id: 'ics',
  name: 'Calendar feed (iCal)',
  category: 'Workspace',
  description: 'Any calendar’s iCal link — Google, Outlook, Apple, Cal.com. Meetings and attendees join your graph.',
  icon: 'googlecalendar',
  auth: 'none',
  fields: [{ key: 'url', label: 'iCal URL', placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics', secret: true }],
  async sync(ctx) {
    if (!ctx.config.url) throw new Error('Paste an iCal (.ics) URL');
    ctx.progress('Reading calendar…');
    const ics = String(await getJson<string>(ctx.config.url.replace(/^webcal:/, 'https:'))).replace(/\r?\n[ \t]/g, '');
    const now = Date.now();
    const events = [...ics.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) => {
      const b = m[1];
      const get = (k: string) => b.match(new RegExp(`^${k}[^:\\n]*:(.*)$`, 'm'))?.[1]?.trim() || '';
      const date = (v: string) => {
        const x = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
        if (!x) return NaN;
        return x[7] ? Date.UTC(+x[1], +x[2] - 1, +x[3], +(x[4] || 0), +(x[5] || 0)) : new Date(+x[1], +x[2] - 1, +x[3], +(x[4] || 0), +(x[5] || 0)).getTime();
      };
      const attendees = [...b.matchAll(/^ATTENDEE[^:\n]*?(?:CN=([^;:\n]+))?[^:\n]*:mailto:(.+)$/gm)].map((a) => ({ name: a[1]?.replace(/"/g, ''), email: a[2].trim() }));
      return { uid: `event:ics:${h(get('UID') || b)}`, title: get('SUMMARY').replace(/\\,/g, ',') || 'Busy', start: date(get('DTSTART')), end: date(get('DTEND')), attendees };
    }).filter((e) => e.start > now - 14 * 86_400_000 && e.start < now + 30 * 86_400_000).slice(0, 300);
    await upsertNodes(ctx.g, 'Event', events.map((e) => ({ uid: e.uid, props: { name: e.title, title: e.title, start: e.start, end: Number.isNaN(e.end) ? e.start + 1_800_000 : e.end, source: 'ics' }, search: e.title })));
    const people = events.flatMap((e) => e.attendees);
    const ids = await upsertPeople(ctx.g, people.map((p) => ({ id: p.email.toLowerCase(), email: p.email, name: p.name, source: 'ics' })));
    await link(ctx.g, 'Person', 'ATTENDS', 'Event', events.flatMap((e) => e.attendees.map((a) => ({ from: ids.get(a.email.toLowerCase())!, to: e.uid }))));
    await ctx.g.q(`MATCH (me:Person {me:true}) UNWIND $ev AS u MATCH (e:Event {uid:u}) MERGE (me)-[:ATTENDS]->(e)`, { ev: events.map((e) => e.uid) }, 'my calendar');
    return { events: events.length, attendees: ids.size };
  },
};

export const docsFolder: ConnectorDef = {
  id: 'docs-folder',
  name: 'Docs folder',
  category: 'Productivity',
  description: 'Markdown and text files from a folder on this computer — notes, ADRs, runbooks, an Obsidian vault.',
  icon: 'obsidian',
  auth: 'local',
  fields: [{ key: 'path', label: 'Folder', placeholder: '/Users/me/notes' }],
  async sync(ctx) {
    const root = ctx.config.path;
    if (!root) throw new Error('Give a folder path');
    const files: string[] = [];
    const walk = (d: string, depth = 0) => {
      if (depth > 4 || files.length > 400) return;
      for (const f of readdirSync(d)) {
        if (f.startsWith('.') || f === 'node_modules') continue;
        const p = join(d, f);
        const s = statSync(p);
        if (s.isDirectory()) walk(p, depth + 1);
        else if (['.md', '.markdown', '.txt', '.mdx'].includes(extname(f).toLowerCase())) files.push(p);
      }
    };
    walk(root);
    ctx.progress(`Reading ${files.length} files…`);
    const docs = files.map((p) => {
      const body = readFileSync(p, 'utf8');
      const title = body.match(/^#\s+(.+)$/m)?.[1] || relative(root, p);
      return { uid: `doc:file:${h(p)}`, title, body, url: `file://${p}`, at: statSync(p).mtimeMs };
    });
    await saveDocs(ctx.g, 'docs-folder', docs);
    return { docs: docs.length };
  },
};

export const webReader: ConnectorDef = {
  id: 'web',
  name: 'Web & Wikipedia',
  category: 'Research',
  description: 'Lets your dots read any public web page or Wikipedia article and file what they learn in the graph.',
  icon: 'wikipedia',
  auth: 'none',
  recommended: true,
  async sync() { return { ready: 'yes' }; },
  actions: [
    {
      name: 'read_url',
      description: 'Fetch a public web page, save it as a Doc in the graph (linked to everything it mentions), and return its text.',
      params: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      mutates: false,
      async run(ctx: ConnectorCtx, { url }) {
        const html = String(await getJson<string>(url, { headers: { accept: 'text/html' } }));
        const title = stripHtml(tag(html, 'title')) || url;
        const body = stripHtml(html.match(/<(main|article)[\s\S]*?<\/\1>/i)?.[0] || html);
        await saveDocs(ctx.g, 'web', [{ uid: `doc:web:${h(url)}`, title, body, url }]);
        return `${title}\n\n${clip(body, 3000)}`;
      },
    },
    {
      name: 'wikipedia',
      description: 'Summary of a Wikipedia article.',
      params: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
      mutates: false,
      async run(ctx: ConnectorCtx, { topic }) {
        const r = await getJson<any>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(topic).replace(/\s+/g, '_'))}`);
        await saveDocs(ctx.g, 'wikipedia', [{ uid: `doc:wiki:${h(r.title)}`, title: r.title, body: r.extract, url: r.content_urls?.desktop?.page }]);
        return `${r.title}: ${r.extract}`;
      },
    },
  ],
};

export const publicConnectors = [githubPublic, gitLocal, rss, hackerNews, icsCalendar, docsFolder, webReader];
