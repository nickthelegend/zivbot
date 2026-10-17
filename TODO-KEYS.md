# Keys for live connectors

Every live connector (`server/connectors/live/`) reads its credentials from one of two places:

1. **The app's Connect Apps modal** — paste the values there. They are stored in `~/.zivbot/secrets.json` (file mode `0600`), never in the graph.
2. **`.env`** — set the env vars listed below. Anything stored through the modal wins over env.

> **Hackathon warning (rule 6): do not load personal or private data into the graph for the demo.**
> Use the synthetic Lumen Labs demo workspace plus public data (public GitHub repos, public web pages via Firecrawl).
> If you want to show a live connector, point it at a throwaway or sandbox workspace (a test Slack, an empty Notion,
> a Stripe **test-mode** key, a HubSpot developer test account), never your real inbox or company tools.

Actions marked *mutating* never run on their own: the dot makes an approval card, and the action runs when you approve it.

---

## Slack — `slack`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `SLACK_BOT_TOKEN` (`xoxb-…`) | https://api.slack.com/apps → Create New App → OAuth & Permissions → Install to Workspace → *Bot User OAuth Token* | Bot scopes: `users:read`, `users:read.email`, `channels:read`, `groups:read`, `channels:history`, `groups:history`, `chat:write` | Only channels the bot was invited to (`/invite @yourbot`) are synced; ≤20 channels × 100 messages from the last 30 days. |

## Notion — `notion`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `NOTION_TOKEN` (`ntn_…` / `secret_…`) | https://www.notion.so/my-integrations → New integration (Internal) → *Internal Integration Secret* | Capabilities: Read content, Insert content (for `create_page`), Read user information **including email addresses** | Share each page with the integration (page `•••` → Connections). Syncs ≤100 pages, first 50 blocks each. |

## Linear — `linear`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `LINEAR_API_KEY` (`lin_api_…`) | https://linear.app/settings/account/security → Personal API keys → New key | Read; Write (or "Create issues" + "Create comments") for actions | Syncs teams, users, projects and ≤200 issues updated in the last 60 days. |

## GitHub (private) — `github-api`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `GITHUB_TOKEN` | https://github.com/settings/personal-access-tokens/new (fine-grained) | Repository access: chosen repos. Permissions: Metadata (read), Contents (read), Issues (read & write), Pull requests (read) | Classic token alternative: https://github.com/settings/tokens with `repo`. Also raises the rate limit of the public GitHub importer. |
| `GITHUB_REPOS` *(optional)* | — | — | Comma list `owner/repo,owner/other`. Empty = your 10 most recently updated repos. |

## Google Workspace (Gmail + Calendar) — `google`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | https://console.cloud.google.com/apis/credentials → Create credentials → OAuth client ID → *Web application*; add `https://developers.google.com/oauthplayground` as an authorized redirect URI | Enable **Gmail API** and **Google Calendar API** in https://console.cloud.google.com/apis/library | While the consent screen is in *Testing*, add yourself as a test user (https://console.cloud.google.com/apis/credentials/consent). |
| `GOOGLE_CLIENT_SECRET` | Same OAuth client | — | |
| `GOOGLE_REFRESH_TOKEN` | https://developers.google.com/oauthplayground → ⚙ *Use your own OAuth credentials* → authorize the scopes → *Exchange authorization code for tokens* → copy *Refresh token* | `https://www.googleapis.com/auth/gmail.modify` (read + send + drafts) and `https://www.googleapis.com/auth/calendar.events` | Read-only demo: `gmail.readonly` + `calendar.readonly` works for sync (actions will then fail). Testing-mode refresh tokens expire after 7 days. |

## Jira Cloud — `jira`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `JIRA_SITE` | Your site host, e.g. `acme.atlassian.net` | — | |
| `JIRA_EMAIL` | The Atlassian account email that owns the token | — | |
| `JIRA_API_TOKEN` (`ATATT…`) | https://id.atlassian.com/manage-profile/security/api-tokens → Create API token | Inherits the account's permissions: Browse projects; Create issues / Add comments for actions | Syncs ≤200 issues updated in the last 60 days. Emails are often hidden by Atlassian privacy settings, so people are keyed by accountId. |

## Sentry — `sentry`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `SENTRY_AUTH_TOKEN` (`sntryu_…`) | https://sentry.io/settings/account/api/auth-tokens/ → Create New Token | `org:read`, `project:read`, `event:read`; `event:write` for `resolve_issue` | |
| `SENTRY_ORG` | Your org slug (in the URL: `https://<org>.sentry.io/`) | — | |
| `SENTRY_HOST` *(optional)* | — | — | Default `sentry.io`. Use `us.sentry.io` / `de.sentry.io` or your self-hosted host if needed. Projects become `system:<slug>` and merge with existing systems of that slug. |

## Stripe — `stripe`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `STRIPE_SECRET_KEY` (`rk_test_…` recommended) | https://dashboard.stripe.com/apikeys → Create restricted key (or https://dashboard.stripe.com/test/apikeys for test mode) | Restricted key, **Read** on Customers, Subscriptions, Invoices, Prices/Products | Read-only connector. For the demo use a **test-mode** key with fake customers. ARR = active subscriptions normalised to yearly. |

## HubSpot — `hubspot`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `HUBSPOT_TOKEN` (`pat-na1-…`) | HubSpot → Settings → Integrations → **Private Apps** → Create a private app (https://developers.hubspot.com/docs/api/private-apps) → Access token | `crm.objects.companies.read`, `crm.objects.contacts.read`, `crm.objects.deals.read`; `crm.objects.contacts.write` (notes) for `create_note` | Use a free developer test account (https://developers.hubspot.com/get-started) for the demo. |

## Vercel — `vercel`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `VERCEL_TOKEN` | https://vercel.com/account/settings/tokens → Create Token | Scope: your account or the team that owns the projects | `redeploy` is mutating; `deployment_status` is read-only. |
| `VERCEL_TEAM_ID` *(optional)* | Team → Settings → General → *Team ID* (`team_…`) | — | Only for team-owned projects. |

## Firecrawl — `firecrawl`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `FIRECRAWL_API_KEY` (`fc-…`) | https://www.firecrawl.dev/app/api-keys | — | No sync. `scrape` saves the page as a `Doc` (public web data is fine for the demo); `search` is a web search. Free tier has a small credit allowance. |

## Telegram — `telegram`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather) → `/newbot` (docs: https://core.telegram.org/bots/tutorial) | — | |
| `TELEGRAM_CHAT_ID` | Send your bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id` | — | The proactive loop can call `telegramNotify(config, text)` from `server/connectors/live/telegram.ts`. |

## Discord — `discord`

| Env var | Where to get it | Scopes / permissions | Note |
|---|---|---|---|
| `DISCORD_WEBHOOK_URL` | Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL (https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) | Manage Webhooks on that channel | Post-only; mentions are disabled in sent messages. |

---

### `.env` template

```bash
SLACK_BOT_TOKEN=
NOTION_TOKEN=
LINEAR_API_KEY=
GITHUB_TOKEN=
GITHUB_REPOS=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
JIRA_SITE=
JIRA_EMAIL=
JIRA_API_TOKEN=
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_HOST=
STRIPE_SECRET_KEY=
HUBSPOT_TOKEN=
VERCEL_TOKEN=
VERCEL_TEAM_ID=
FIRECRAWL_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
```
