import { type ConnectorDef, need } from '../types.ts';
import { clip } from './_util.ts';

export const discord: ConnectorDef = {
  id: 'discord',
  name: 'Discord',
  category: 'Notifications',
  description: 'Post notifications to a Discord channel through a webhook.',
  icon: 'discord',
  color: '#5865F2',
  auth: 'key',
  docs: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
  fields: [
    { key: 'webhookUrl', label: 'Webhook URL', env: 'DISCORD_WEBHOOK_URL', secret: true, placeholder: 'https://discord.com/api/webhooks/…', help: 'Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL.' },
  ],
  actions: [
    {
      name: 'notify',
      description: 'Post a message to the Discord channel behind the webhook.',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      mutates: true,
      async run(ctx, a) {
        const [url] = need(ctx, 'webhookUrl');
        if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(url)) throw new Error('That does not look like a Discord webhook URL');
        const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}wait=true`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'ZivBot/0.1' },
          body: JSON.stringify({ content: clip(a.text, 2000), username: 'ZivBot', allowed_mentions: { parse: [] } }),
        });
        if (!r.ok) throw new Error(`Discord ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const m: any = await r.json().catch(() => ({}));
        return `Posted to Discord${m.channel_id ? ` (channel ${m.channel_id})` : ''}`;
      },
    },
  ],
};
