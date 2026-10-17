import { type ConnectorDef, getJson } from '../types.ts';
import { clip } from './_util.ts';

/**
 * Send a Telegram message with the bot. Exported so the proactive loop can
 * push notices without going through the action/approval path.
 * `config` is the connector config ({ botToken, chatId }); env vars fill gaps.
 */
export async function telegramNotify(config: Record<string, string | undefined>, text: string): Promise<string> {
  const botToken = config.botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = config.chatId || process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) throw new Error('Telegram needs botToken and chatId');
  const r = await getJson(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: clip(text, 4096), disable_web_page_preview: true }),
  });
  if (!r?.ok) throw new Error(`Telegram: ${r?.description || 'send failed'}`);
  return `Sent to Telegram chat ${chatId} (message ${r.result?.message_id})`;
}

export const telegram: ConnectorDef = {
  id: 'telegram',
  name: 'Telegram',
  category: 'Notifications',
  description: 'Get pinged on Telegram when the dot needs you or finishes something.',
  icon: 'telegram',
  color: '#26A5E4',
  auth: 'key',
  docs: 'https://core.telegram.org/bots/tutorial',
  fields: [
    { key: 'botToken', label: 'Bot token', env: 'TELEGRAM_BOT_TOKEN', secret: true, placeholder: '123456:ABC-…', help: 'Talk to @BotFather → /newbot.' },
    { key: 'chatId', label: 'Chat ID', env: 'TELEGRAM_CHAT_ID', placeholder: '123456789', help: 'Message your bot, then open https://api.telegram.org/bot<token>/getUpdates and copy message.chat.id.' },
  ],
  actions: [
    {
      name: 'notify',
      description: 'Send a Telegram message to your chat.',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      mutates: true,
      async run(ctx, a) {
        return telegramNotify(ctx.config, String(a.text));
      },
    },
  ],
};
