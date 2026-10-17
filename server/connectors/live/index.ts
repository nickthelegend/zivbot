import type { ConnectorDef } from '../types.ts';
import { slack } from './slack.ts';
import { notion } from './notion.ts';
import { linear } from './linear.ts';
import { githubApi } from './github-api.ts';
import { google } from './google.ts';
import { jira } from './jira.ts';
import { sentry } from './sentry.ts';
import { stripe } from './stripe.ts';
import { hubspot } from './hubspot.ts';
import { vercel } from './vercel.ts';
import { firecrawl } from './firecrawl.ts';
import { telegram } from './telegram.ts';
import { discord } from './discord.ts';

export { telegramNotify } from './telegram.ts';

/** Live, API-key connectors (see TODO-KEYS.md for where each key comes from). */
export const liveConnectors: ConnectorDef[] = [slack, notion, linear, githubApi, google, jira, sentry, stripe, hubspot, vercel, firecrawl, telegram, discord];
