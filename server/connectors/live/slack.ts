import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link, linkAny, upsertPeople } from '../../ingest.ts';
import { clip, linkMentions, qs, daysAgo, uniq } from './_util.ts';

/** Slack Web API: GET for reads, JSON POST for writes; errors come back as { ok: false }. */
async function slackApi(ctx: ConnectorCtx, method: string, params: Record<string, any> = {}, post = false): Promise<any> {
  const [token] = need(ctx, 'token');
  const url = `https://slack.com/api/${method}${post ? '' : `?${qs(params)}`}`;
  const res = await getJson(url, {
    method: post ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(post ? { 'content-type': 'application/json; charset=utf-8' } : {}) },
    body: post ? JSON.stringify(params) : undefined,
  });
  if (!res || res.ok === false) throw new Error(`Slack ${method}: ${res?.error || 'unknown error'}${res?.needed ? ` (needs scope ${res.needed})` : ''}`);
  return res;
}

const chanUid = (id: string) => `channel:slack:${id}`;
const msgUid = (ch: string, ts: string) => `msg:slack:${ch}:${ts}`;

/** Turn Slack markup (<@U1>, <#C1|name>, <url|label>) into readable text. */
function plain(text: string, names: Map<string, string>) {
  return String(text || '')
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names.get(id) || id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export const slack: ConnectorDef = {
  id: 'slack',
  name: 'Slack',
  category: 'Communication',
  description: 'Channels, messages and people from your Slack workspace; post messages with approval.',
  icon: 'slack',
  color: '#4A154B',
  auth: 'key',
  docs: 'https://api.slack.com/apps',
  fields: [
    { key: 'token', label: 'Bot token', env: 'SLACK_BOT_TOKEN', secret: true, placeholder: 'xoxb-…', help: 'Create an app at api.slack.com/apps, add bot scopes, install it, copy the Bot User OAuth Token. Invite the bot to channels you want synced.' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    ctx.progress('Reading Slack users');
    const users: any[] = [];
    let cursor = '';
    do {
      const r = await slackApi(ctx, 'users.list', { limit: 200, cursor });
      users.push(...(r.members || []));
      cursor = r.response_metadata?.next_cursor || '';
    } while (cursor && users.length < 1000);
    const humans = users.filter((u) => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT');
    const names = new Map<string, string>(users.map((u) => [u.id, u.profile?.real_name || u.real_name || u.name]));
    const people = await upsertPeople(g, humans.map((u) => ({
      id: u.id,
      name: u.profile?.real_name || u.real_name || u.name,
      email: u.profile?.email || undefined,
      role: u.profile?.title || undefined,
      avatar: u.profile?.image_72 || undefined,
      external: !!(u.is_restricted || u.is_ultra_restricted || u.is_stranger),
      source: 'slack',
    })));

    ctx.progress('Reading Slack channels');
    const r = await slackApi(ctx, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 });
    const channels = ((r.channels || []) as any[]).filter((c) => c.is_member).slice(0, 20);
    await upsertNodes(g, 'Channel', channels.map((c) => ({
      uid: chanUid(c.id),
      props: { name: `#${c.name}`, slackId: c.id, private: !!c.is_private, topic: c.topic?.value || undefined, purpose: c.purpose?.value || undefined, members: c.num_members, source: 'slack' },
      search: `#${c.name} ${c.name} channel ${c.topic?.value || ''} ${c.purpose?.value || ''}`,
    })));

    const oldest = String(Math.floor(daysAgo(30) / 1000));
    const msgs: { uid: string; ch: string; ts: string; user?: string; text: string; thread?: string; replies?: number }[] = [];
    for (const [i, c] of channels.entries()) {
      ctx.progress(`Reading #${c.name} (${i + 1}/${channels.length})`);
      try {
        const h = await slackApi(ctx, 'conversations.history', { channel: c.id, oldest, limit: 100 });
        for (const m of (h.messages || []) as any[]) {
          if (m.subtype && !['thread_broadcast', 'file_share', 'bot_message'].includes(m.subtype)) continue;
          if (!m.text) continue;
          msgs.push({ uid: msgUid(c.id, m.ts), ch: c.id, ts: m.ts, user: m.user, text: m.text, thread: m.thread_ts, replies: m.reply_count });
        }
      } catch (e) {
        ctx.progress(`Skipped #${c.name}: ${(e as Error).message}`);
      }
    }

    ctx.progress(`Linking ${msgs.length} messages`);
    await upsertNodes(g, 'ChatMessage', msgs.map((m) => {
      const text = plain(m.text, names);
      return {
        uid: m.uid,
        props: { name: clip(text, 80), text: clip(text, 4000), at: Math.round(Number(m.ts) * 1000), threadTs: m.thread, replies: m.replies, source: 'slack' },
        search: text,
      };
    }));
    await link(g, 'Person', 'POSTED', 'ChatMessage', msgs.filter((m) => m.user && people.has(m.user)).map((m) => ({ from: people.get(m.user!)!, to: m.uid })));
    await link(g, 'ChatMessage', 'IN', 'Channel', msgs.map((m) => ({ from: m.uid, to: chanUid(m.ch) })));
    // Explicit @-mentions are exact; free-text entity linking catches the rest.
    await linkAny(g, 'ChatMessage', 'MENTIONS', msgs.flatMap((m) =>
      uniq([...m.text.matchAll(/<@([A-Z0-9]+)/g)].map((x) => x[1])).filter((id) => people.has(id) && id !== m.user).map((id) => ({ from: m.uid, to: people.get(id)! }))));
    const mentions = await linkMentions(g, 'ChatMessage', msgs.map((m) => ({ uid: m.uid, text: plain(m.text, names), self: m.user ? people.get(m.user) : undefined })));
    return { people: humans.length, channels: channels.length, messages: msgs.length, mentions };
  },
  actions: [
    {
      name: 'post_message',
      description: 'Post a message to a Slack channel (channel ID or #name). The bot must be a member of the channel.',
      params: { type: 'object', properties: { channel: { type: 'string', description: 'Channel ID (C…) or #name' }, text: { type: 'string' }, thread_ts: { type: 'string', description: 'Reply in this thread (optional)' } }, required: ['channel', 'text'] },
      mutates: true,
      async run(ctx, a) {
        let channel = String(a.channel || '').trim();
        if (channel.startsWith('#') || !/^[CGD][A-Z0-9]+$/.test(channel)) {
          const want = channel.replace(/^#/, '').toLowerCase();
          const r = await slackApi(ctx, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000 });
          const hit = (r.channels || []).find((c: any) => c.name.toLowerCase() === want);
          if (!hit) throw new Error(`No Slack channel named #${want} visible to the bot`);
          channel = hit.id;
        }
        const r = await slackApi(ctx, 'chat.postMessage', { channel, text: String(a.text), thread_ts: a.thread_ts || undefined }, true);
        const link = await slackApi(ctx, 'chat.getPermalink', { channel, message_ts: r.ts }).then((p) => p.permalink as string).catch(() => '');
        return `Posted to Slack ${a.channel}${link ? `: ${link}` : ''}`;
      },
    },
    {
      name: 'list_channels',
      description: 'List Slack channels visible to the bot, with member counts and whether the bot has joined.',
      params: { type: 'object', properties: {} },
      mutates: false,
      async run(ctx) {
        const r = await slackApi(ctx, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 });
        const cs = (r.channels || []) as any[];
        if (!cs.length) return 'No channels visible to the bot.';
        return cs.slice(0, 60).map((c) => `#${c.name} (${c.id}) · ${c.num_members ?? '?'} members${c.is_member ? ' · joined' : ''}${c.is_private ? ' · private' : ''}`).join('\n');
      },
    },
  ],
};

