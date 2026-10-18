import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes, link, upsertPeople, type PersonIn } from '../../ingest.ts';
import { clip, linkMentions, list, ms, parseAddresses, pool, qs, daysAgo, DAY_MS } from './_util.ts';

/** Access tokens cached per refresh token until shortly before they expire. */
const tokens = new Map<string, { token: string; exp: number }>();

async function accessToken(ctx: ConnectorCtx): Promise<string> {
  const [clientId, clientSecret, refreshToken] = need(ctx, 'clientId', 'clientSecret', 'refreshToken');
  const hit = tokens.get(refreshToken);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await getJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: qs({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
  });
  if (!r?.access_token) throw new Error('Google did not return an access token (check client id/secret/refresh token)');
  tokens.set(refreshToken, { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
  return r.access_token;
}

async function gapi(ctx: ConnectorCtx, url: string, body?: unknown, method?: string): Promise<any> {
  const token = await accessToken(ctx);
  return getJson(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const emailUid = (id: string) => `email:gmail:${id}`;
const threadUid = (id: string) => `thread:gmail:${id}`;
const eventUid = (id: string) => `event:gcal:${id}`;

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** Build an RFC 822 message; replies carry In-Reply-To/References so they thread. */
async function buildRaw(ctx: ConnectorCtx, a: any) {
  const to = list(a.to).join(', ');
  if (!to) throw new Error('Need at least one recipient');
  let subject = String(a.subject || '');
  const headers: string[] = [`To: ${to}`];
  if (a.cc) headers.push(`Cc: ${list(a.cc).join(', ')}`);
  if (a.threadId) {
    const t = await gapi(ctx, `${GMAIL}/threads/${a.threadId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=References`);
    const last = (t.messages || []).at(-1);
    const h = (n: string) => last?.payload?.headers?.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value as string | undefined;
    const mid = h('Message-ID');
    if (mid) headers.push(`In-Reply-To: ${mid}`, `References: ${[h('References'), mid].filter(Boolean).join(' ')}`);
    if (!subject) subject = h('Subject') || '';
    if (subject && !/^re:/i.test(subject)) subject = `Re: ${subject}`;
  }
  headers.push(`Subject: ${encHeader(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit');
  return { raw: b64url(`${headers.join('\r\n')}\r\n\r\n${String(a.body || '').replace(/\r?\n/g, '\r\n')}`), threadId: a.threadId || undefined, to, subject };
}

export const google: ConnectorDef = {
  id: 'google',
  name: 'Google Workspace',
  category: 'Workspace',
  description: 'Gmail threads (last 30 days) and Google Calendar events; send mail, drafts and invites with approval.',
  icon: 'google',
  color: '#4285F4',
  auth: 'key',
  docs: 'https://console.cloud.google.com/apis/credentials',
  fields: [
    { key: 'clientId', label: 'OAuth client ID', env: 'GOOGLE_CLIENT_ID', placeholder: '….apps.googleusercontent.com' },
    { key: 'clientSecret', label: 'OAuth client secret', env: 'GOOGLE_CLIENT_SECRET', secret: true, placeholder: 'GOCSPX-…' },
    { key: 'refreshToken', label: 'Refresh token', env: 'GOOGLE_REFRESH_TOKEN', secret: true, placeholder: '1//…', help: 'Get one from the OAuth Playground using your own client (gmail.modify + calendar.events scopes). See TODO-KEYS.md.' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    ctx.progress('Connecting to Gmail');
    const profile = await gapi(ctx, `${GMAIL}/profile`);
    const myEmail = String(profile.emailAddress || '').toLowerCase();

    ctx.progress('Listing mail from the last 30 days');
    const ids: { id: string; threadId: string }[] = [];
    let pageToken: string | undefined;
    do {
      const r = await gapi(ctx, `${GMAIL}/messages?${qs({ q: 'newer_than:30d -in:chats', maxResults: 100, pageToken })}`);
      ids.push(...(r.messages || []));
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < 100);

    ctx.progress(`Reading ${Math.min(ids.length, 100)} messages`);
    const hdrs = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe'].map((h) => `metadataHeaders=${h}`).join('&');
    const raw = await pool(ids.slice(0, 100), 8, (m) => gapi(ctx, `${GMAIL}/messages/${m.id}?format=metadata&${hdrs}`));
    const msgs = raw.filter(Boolean).map((m: any) => {
      const h = (n: string) => m.payload?.headers?.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value as string | undefined;
      const labels: string[] = m.labelIds || [];
      const from = parseAddresses(h('From'))[0];
      return {
        id: m.id as string,
        threadId: m.threadId as string,
        subject: h('Subject') || '(no subject)',
        snippet: String(m.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
        at: Number(m.internalDate) || ms(h('Date')) || Date.now(),
        from,
        to: [...parseAddresses(h('To')), ...parseAddresses(h('Cc'))],
        important: labels.includes('IMPORTANT') || labels.includes('STARRED'),
        unread: labels.includes('UNREAD'),
        newsletter: !!h('List-Unsubscribe') || labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL') || (labels.includes('CATEGORY_UPDATES') && !labels.includes('IMPORTANT')),
        sent: labels.includes('SENT'),
      };
    });

    // you are the owner of this mailbox: your address belongs to "me", so triage, agenda and replies are yours
    if (myEmail) await g.q(`MATCH (m:Person {me:true}) SET m.gmail = $e, m.email = CASE WHEN m.email IS NULL OR m.email ENDS WITH '.example' OR m.email CONTAINS 'lumen' THEN $e ELSE m.email END`, { e: myEmail }, 'your Gmail address is you');
    const humans: PersonIn[] = [];
    for (const m of msgs) for (const a of [m.from, ...m.to]) if (a?.email) humans.push({ id: a.email, email: a.email, name: a.name, source: 'google', external: !!myEmail && a.email.split('@')[1] !== myEmail.split('@')[1] });
    const people = await upsertPeople(g, humans);
    // if your address had already become a separate person, fold it into "me"
    const dupMe = await g.one(`MATCH (m:Person {me:true}), (p:Person) WHERE p <> m AND toLower(p.email) = $e RETURN m.uid AS me, p.uid AS dup`, { e: myEmail }, 'is your address a separate person?');
    if (dupMe) { const { mergePeople } = await import('../../identity.ts'); await mergePeople(g, dupMe.me, dupMe.dup); for (const [k, v] of people) if (v === dupMe.dup) people.set(k, dupMe.me); }

    const byThread = new Map<string, typeof msgs>();
    for (const m of msgs) byThread.set(m.threadId, [...(byThread.get(m.threadId) || []), m]);
    const threads = [...byThread.entries()].map(([id, ms_]) => {
      const sorted = ms_.sort((a, b) => a.at - b.at);
      const last = sorted[sorted.length - 1];
      const lastFromMe = last.sent || last.from?.email === myEmail;
      return { id, sorted, last, awaitingReply: !lastFromMe && !last.newsletter };
    });
    ctx.progress(`Linking ${threads.length} threads`);
    await upsertNodes(g, 'Thread', threads.map((t) => ({
      uid: threadUid(t.id),
      props: {
        name: t.sorted[0].subject, subject: t.sorted[0].subject, lastAt: t.last.at, count: t.sorted.length, awaitingReply: t.awaitingReply,
        newsletter: t.last.newsletter, unread: t.sorted.some((m) => m.unread), url: `https://mail.google.com/mail/u/0/#inbox/${t.id}`, gmailThreadId: t.id, source: 'gmail',
      },
      search: t.sorted.map((m) => `${m.subject} ${m.snippet}`).join(' '),
    })));
    await upsertNodes(g, 'Email', msgs.map((m) => ({
      uid: emailUid(m.id),
      props: { name: m.subject, subject: m.subject, body: m.snippet, at: m.at, important: m.important, newsletter: m.newsletter, unread: m.unread, gmailId: m.id, source: 'gmail' },
      search: `${m.subject} ${m.snippet} ${m.from?.name || ''} ${m.from?.email || ''}`,
    })));
    await link(g, 'Email', 'IN_THREAD', 'Thread', msgs.map((m) => ({ from: emailUid(m.id), to: threadUid(m.threadId) })));
    await link(g, 'Email', 'FROM', 'Person', msgs.filter((m) => m.from && people.has(m.from.email)).map((m) => ({ from: emailUid(m.id), to: people.get(m.from!.email)! })));
    await link(g, 'Email', 'TO', 'Person', msgs.flatMap((m) => m.to.filter((t) => people.has(t.email)).map((t) => ({ from: emailUid(m.id), to: people.get(t.email)! }))));
    const mailMentions = await linkMentions(g, 'Email', msgs.filter((m) => !m.newsletter).map((m) => ({ uid: emailUid(m.id), text: `${m.subject}\n${m.snippet}`, self: m.from ? people.get(m.from.email) : undefined })));

    ctx.progress('Reading Google Calendar');
    const cal = await gapi(ctx, `${CAL}/events?${qs({ timeMin: new Date(daysAgo(7)).toISOString(), timeMax: new Date(Date.now() + 14 * DAY_MS).toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 200 })}`);
    const events: any[] = (cal.items || []).filter((e: any) => e.status !== 'cancelled');
    const attendees: PersonIn[] = events.flatMap((e) => [...(e.attendees || []), e.organizer].filter((a: any) => a?.email && !a.resource && !String(a.email).endsWith('calendar.google.com')).map((a: any) => ({ id: String(a.email).toLowerCase(), email: String(a.email).toLowerCase(), name: a.displayName || undefined, source: 'google' })));
    const ppl = await upsertPeople(g, attendees);
    await upsertNodes(g, 'Event', events.map((e) => {
      const start = ms(e.start?.dateTime || e.start?.date) || Date.now();
      return {
        uid: eventUid(e.id),
        props: {
          name: e.summary || '(busy)', title: e.summary || '(busy)', start, end: ms(e.end?.dateTime || e.end?.date) || start, allDay: !e.start?.dateTime,
          location: e.location, url: e.htmlLink, meet: e.hangoutLink, description: clip(e.description, 1500), at: start, source: 'gcal',
        },
        search: `${e.summary || ''} meeting ${e.location || ''} ${clip(e.description, 500)}`,
      };
    }));
    await link(g, 'Person', 'ATTENDS', 'Event', events.flatMap((e) => (e.attendees || [{ email: e.organizer?.email, responseStatus: 'accepted' }])
      .filter((a: any) => a?.email && ppl.has(String(a.email).toLowerCase()) && a.responseStatus !== 'declined')
      .map((a: any) => ({ from: ppl.get(String(a.email).toLowerCase())!, to: eventUid(e.id), props: { response: a.responseStatus, organizer: !!a.organizer } }))));
    const evMentions = await linkMentions(g, 'Event', events.map((e) => ({ uid: eventUid(e.id), text: `${e.summary || ''}\n${e.description || ''}` })));
    return { threads: threads.length, emails: msgs.length, awaitingReply: threads.filter((t) => t.awaitingReply).length, events: events.length, people: new Set([...people.values(), ...ppl.values()]).size, mentions: mailMentions + evMentions };
  },
  actions: [
    {
      name: 'send_email',
      description: 'Send an email from your Gmail. Pass threadId to reply in an existing thread.',
      params: {
        type: 'object',
        properties: { to: { type: 'string', description: 'Comma-separated addresses' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, threadId: { type: 'string', description: 'Gmail thread id (thread:gmail:<id> also accepted)' } },
        required: ['to', 'body'],
      },
      mutates: true,
      async run(ctx, a) {
        const m = await buildRaw(ctx, { ...a, threadId: a.threadId ? String(a.threadId).replace(/^thread:gmail:/, '') : undefined });
        const r = await gapi(ctx, `${GMAIL}/messages/send`, { raw: m.raw, threadId: m.threadId });
        return `Sent "${m.subject}" to ${m.to}: https://mail.google.com/mail/u/0/#sent/${r.threadId || r.id}`;
      },
    },
    {
      name: 'create_draft',
      description: 'Save an email as a Gmail draft (optionally as a reply in a thread) without sending it.',
      params: { type: 'object', properties: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, threadId: { type: 'string' } }, required: ['to', 'body'] },
      mutates: true,
      async run(ctx, a) {
        const m = await buildRaw(ctx, { ...a, threadId: a.threadId ? String(a.threadId).replace(/^thread:gmail:/, '') : undefined });
        const r = await gapi(ctx, `${GMAIL}/drafts`, { message: { raw: m.raw, threadId: m.threadId } });
        return `Draft "${m.subject}" to ${m.to} saved: https://mail.google.com/mail/u/0/#drafts?compose=${r.message?.id || r.id}`;
      },
    },
    {
      name: 'create_event',
      description: 'Create a Google Calendar event and email invites to attendees.',
      params: {
        type: 'object',
        properties: { title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 start, e.g. 2026-10-20T15:00:00-07:00' }, minutes: { type: 'number', description: 'Duration, default 30' }, attendees: { type: 'array', items: { type: 'string' } }, description: { type: 'string' }, meet: { type: 'boolean', description: 'Add a Google Meet link' } },
        required: ['title', 'start'],
      },
      mutates: true,
      async run(ctx, a) {
        const start = ms(a.start);
        if (!start) throw new Error(`Could not parse start time "${a.start}"`);
        const end = start + (Number(a.minutes) || 30) * 60_000;
        const body: any = {
          summary: String(a.title),
          description: a.description ? String(a.description) : undefined,
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(end).toISOString() },
          attendees: list(a.attendees).map((email) => ({ email })),
        };
        if (a.meet) body.conferenceData = { createRequest: { requestId: `ziv-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
        const r = await gapi(ctx, `${CAL}/events?${qs({ sendUpdates: 'all', conferenceDataVersion: a.meet ? 1 : undefined })}`, body);
        await upsertNodes(ctx.g, 'Event', [{ uid: eventUid(r.id), props: { name: r.summary, title: r.summary, start, end, url: r.htmlLink, meet: r.hangoutLink, at: start, source: 'gcal' }, search: `${r.summary} meeting` }]);
        return `Created "${r.summary}" on ${new Date(start).toUTCString()}${body.attendees.length ? ` with ${body.attendees.length} invitee(s)` : ''}: ${r.htmlLink}`;
      },
    },
  ],
};
