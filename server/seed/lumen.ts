/**
 * Lumen Labs — a fully synthetic demo workspace (hackathon rule 6: no personal
 * or private data). A fictional smart-battery startup: people, teams,
 * customers, systems, tickets, mail, calendar, chat, docs and decisions that
 * reference each other, so the interesting answers only exist in the graph.
 *
 * Times are offsets from "now" so the demo is always current.
 */
import { DAY, HOUR } from '../util.ts';

export const DOMAIN = 'lumenlabs.example';

export type PersonSeed = { key: string; name: string; email: string; role: string; team?: string; org?: string; tz?: string };
export const people: PersonSeed[] = [
  { key: 'priya', name: 'Priya Raman', email: `priya@${DOMAIN}`, role: 'Staff Engineer', team: 'platform' },
  { key: 'marcus', name: 'Marcus Webb', email: `marcus@${DOMAIN}`, role: 'CTO', team: 'leadership' },
  { key: 'sofia', name: 'Sofia Alvarez', email: `sofia@${DOMAIN}`, role: 'Head of Product', team: 'leadership' },
  { key: 'dev', name: 'Dev Patel', email: `dev@${DOMAIN}`, role: 'Mobile Lead', team: 'mobile' },
  { key: 'hana', name: 'Hana Kim', email: `hana@${DOMAIN}`, role: 'Firmware Engineer', team: 'hardware' },
  { key: 'leo', name: 'Leo Okafor', email: `leo@${DOMAIN}`, role: 'Growth Lead', team: 'growth' },
  { key: 'ines', name: 'Inès Laurent', email: `ines@${DOMAIN}`, role: 'EU Launch Manager', team: 'ops' },
  { key: 'tom', name: 'Tom Becker', email: `tom@${DOMAIN}`, role: 'Support Lead', team: 'ops' },
  { key: 'ava', name: 'Ava Chen', email: `ava@${DOMAIN}`, role: 'Finance Lead', team: 'ops' },
  { key: 'raj', name: 'Raj Iyer', email: `raj@${DOMAIN}`, role: 'Platform Engineer', team: 'platform' },
  { key: 'kate', name: 'Kate Morgan', email: 'kate@brightwave.example', role: 'Head of Operations', org: 'brightwave' },
  { key: 'daniel', name: 'Daniel Ross', email: 'daniel@kestrelhomes.example', role: 'IT Manager', org: 'kestrel' },
  { key: 'maya', name: 'Maya Lin', email: 'maya@northstar.example', role: 'Partner', org: 'northstar' },
  { key: 'stripeteam', name: 'Stripe Billing Team', email: 'billing@stripe-partners.example', role: 'Vendor', org: 'stripe' },
  { key: 'saas', name: 'SaaS Weekly', email: 'news@saasweekly.example', role: 'Newsletter' },
  { key: 'devtrends', name: 'DevTrends Digest', email: 'digest@devtrends.example', role: 'Newsletter' },
  { key: 'cloudco', name: 'CloudCo Offers', email: 'promo@cloudco.example', role: 'Newsletter' },
  { key: 'growthhq', name: 'GrowthHQ Webinars', email: 'events@growthhq.example', role: 'Newsletter' },
  { key: 'trust', name: 'TrustWatch Compliance', email: 'alerts@trustwatch.example', role: 'Vendor' },
];

export const teams = [
  { key: 'leadership', name: 'Leadership' },
  { key: 'platform', name: 'Platform' },
  { key: 'mobile', name: 'Mobile' },
  { key: 'hardware', name: 'Hardware' },
  { key: 'growth', name: 'Growth' },
  { key: 'ops', name: 'Operations' },
];

export const orgs = [
  { key: 'brightwave', name: 'Brightwave Energy', kind: 'customer', arr: 184000, tier: 'Enterprise' },
  { key: 'kestrel', name: 'Kestrel Homes', kind: 'customer', arr: 62000, tier: 'Growth' },
  { key: 'solace', name: 'Solace Co-op', kind: 'prospect', arr: 0, tier: 'Prospect' },
  { key: 'northstar', name: 'Northstar Ventures', kind: 'investor', arr: 0, tier: 'Lead investor' },
  { key: 'stripe', name: 'Stripe', kind: 'vendor', arr: 0, tier: 'Vendor' },
];

export const projects = [
  { key: 'atlas', name: 'Atlas Billing Migration', aliases: ['atlas', 'billing migration', 'stripe billing'], status: 'in progress', owner: 'priya', members: ['priya', 'raj', 'ava'], uses: ['payments-api', 'billing-db', 'stripe'] },
  { key: 'app3', name: 'Lumen App 3.0', aliases: ['app 3.0', 'app3', 'mobile app 3'], status: 'beta', owner: 'dev', members: ['dev', 'sofia'], uses: ['mobile-app', 'auth-service', 'notification-service'] },
  { key: 'ota', name: 'Helios OTA 2.4', aliases: ['ota 2.4', 'ota', 'helios ota'], status: 'blocked', owner: 'hana', members: ['hana', 'raj'], uses: ['ota-server', 'device-gateway'] },
  { key: 'eu', name: 'EU Launch', aliases: ['eu launch', 'eu', 'europe launch'], status: 'blocked', owner: 'ines', members: ['ines', 'leo', 'sofia'], uses: ['payments-api', 'checkout-web'], blockedBy: ['ota'] },
  { key: 'seriesa', name: 'Series A Raise', aliases: ['series a', 'fundraise', 'diligence'], status: 'in progress', owner: 'me', members: ['me', 'marcus', 'ava'], uses: [] },
  { key: 'copilot', name: 'Support Copilot', aliases: ['support copilot', 'copilot'], status: 'planned', owner: 'tom', members: ['tom', 'priya'], uses: ['analytics-pipeline'] },
];

export const systems = [
  { key: 'payments-api', name: 'payments-api', aliases: ['payments api', 'payments-api', 'invoice api'], tier: 'critical', repo: 'lumen-payments' },
  { key: 'billing-db', name: 'billing-db', aliases: ['billing db', 'billing-db', 'billing database'], tier: 'critical' },
  { key: 'stripe', name: 'Stripe', aliases: ['stripe'], tier: 'external' },
  { key: 'auth-service', name: 'auth-service', aliases: ['auth service', 'auth-service', 'sso'], tier: 'critical' },
  { key: 'mobile-app', name: 'mobile-app', aliases: ['mobile app', 'android app', 'ios app'], tier: 'high' },
  { key: 'notification-service', name: 'notification-service', aliases: ['notification service', 'push notifications'], tier: 'medium' },
  { key: 'ota-server', name: 'ota-server', aliases: ['ota server', 'ota-server'], tier: 'high' },
  { key: 'device-gateway', name: 'device-gateway', aliases: ['device gateway', 'device-gateway'], tier: 'critical' },
  { key: 'analytics-pipeline', name: 'analytics-pipeline', aliases: ['analytics pipeline', 'analytics'], tier: 'medium' },
  { key: 'data-warehouse', name: 'data-warehouse', aliases: ['data warehouse', 'warehouse'], tier: 'medium' },
  { key: 'checkout-web', name: 'checkout-web', aliases: ['checkout', 'checkout-web', 'customer portal', 'portal'], tier: 'critical' },
];

/** a DEPENDS_ON b */
export const deps: [string, string][] = [
  ['checkout-web', 'payments-api'], ['mobile-app', 'auth-service'], ['mobile-app', 'payments-api'], ['mobile-app', 'notification-service'],
  ['payments-api', 'billing-db'], ['payments-api', 'stripe'], ['payments-api', 'auth-service'], ['notification-service', 'auth-service'],
  ['ota-server', 'device-gateway'], ['device-gateway', 'auth-service'], ['analytics-pipeline', 'data-warehouse'],
  ['analytics-pipeline', 'billing-db'], ['data-warehouse', 'billing-db'],
];

export const customersUse: [string, string][] = [
  ['brightwave', 'checkout-web'], ['brightwave', 'payments-api'], ['brightwave', 'device-gateway'],
  ['kestrel', 'auth-service'], ['kestrel', 'mobile-app'], ['kestrel', 'checkout-web'],
];

export const tickets = [
  { key: 'LUM-142', title: 'payments-api: invoice list p95 latency > 2s', priority: 'P1', status: 'open', assignee: 'priya', reporter: 'tom', affects: ['payments-api'], customer: 'brightwave', project: 'atlas', at: -6 * HOUR, body: 'GET /invoices is slow for large accounts. Brightwave (1.2k line items) sees 2.3s p95. Looks like one query per line item.' },
  { key: 'LUM-139', title: 'Brightwave invoice shows duplicate line items', priority: 'P2', status: 'open', assignee: 'raj', reporter: 'tom', affects: ['payments-api', 'billing-db'], customer: 'brightwave', project: 'atlas', at: -26 * DAY, body: 'September invoice lists the battery lease twice. Customer asked for a corrected invoice.' },
  { key: 'LUM-131', title: 'OTA 2.4 fails to install on Helios v1 hardware', priority: 'P1', status: 'open', assignee: 'hana', reporter: 'hana', affects: ['ota-server', 'device-gateway'], project: 'ota', at: -5 * DAY, body: 'v1 bootloader rejects the new image signature. Either ship a shim or drop v1 support.' },
  { key: 'LUM-145', title: 'Add VAT fields to EU invoices', priority: 'P2', status: 'open', assignee: 'ava', reporter: 'sofia', affects: ['payments-api'], project: 'eu', at: -3 * DAY, body: 'EU launch requires VAT number + reverse-charge note on invoices.' },
  { key: 'LUM-128', title: 'Push notifications delayed on Android', priority: 'P3', status: 'open', assignee: 'dev', reporter: 'dev', affects: ['notification-service', 'mobile-app'], project: 'app3', at: -8 * DAY, body: 'FCM batches delayed up to 10 minutes during peak.' },
  { key: 'LUM-120', title: 'Kestrel SSO login loop', priority: 'P2', status: 'resolved', assignee: 'raj', reporter: 'tom', affects: ['auth-service'], customer: 'kestrel', at: -24 * DAY, resolvedAt: -20 * DAY, body: 'SAML assertion clock skew caused a redirect loop.' },
  { key: 'LUM-117', title: 'Dashboard export times out', priority: 'P3', status: 'resolved', assignee: 'priya', reporter: 'tom', affects: ['analytics-pipeline'], at: -40 * DAY, resolvedAt: -33 * DAY, body: 'CSV export of 90 days of telemetry exceeds 30s.' },
];

type MailSeed = { thread: string; from: string; to: string[]; subject: string; body: string; at: number; mentions?: string[]; labels?: string[]; asks?: { key: string; text: string; options: string[] } };
export const mail: MailSeed[] = [
  { thread: 'bw-invoice', from: 'kate', to: ['me'], subject: 'Duplicate line items on our September invoice', body: 'Hi — our September invoice lists the battery lease twice. Could you send a corrected invoice? Thanks, Kate', at: -27 * DAY, mentions: ['LUM-139'] },
  { thread: 'bw-invoice', from: 'me', to: ['kate'], subject: 'Re: Duplicate line items on our September invoice', body: 'Thanks Kate — Raj is on it, we will send a corrected invoice next week.', at: -26 * DAY, mentions: ['LUM-139', 'raj'] },
  { thread: 'bw-invoice', from: 'kate', to: ['me'], subject: 'Re: Duplicate line items on our September invoice', body: 'Following up — we still have not received the corrected invoice, and the invoice page in your portal now takes forever to load.', at: -2 * DAY, mentions: ['LUM-139', 'checkout-web'] },
  { thread: 'bw-invoice', from: 'kate', to: ['me'], subject: 'Re: Duplicate line items on our September invoice', body: 'Our finance team needs the corrected invoice by Friday, otherwise procurement will escalate this before our QBR.', at: -5 * HOUR, mentions: ['LUM-139'], labels: ['important'] },
  { thread: 'ns-diligence', from: 'maya', to: ['me'], subject: 'Series A diligence — a few asks before Thursday', body: 'Could you share ARR by customer, logo churn for the last 4 quarters, and the EU launch timeline before our partner meeting? Thanks!', at: -3 * DAY, mentions: ['seriesa', 'eu'], labels: ['important'] },
  { thread: 'p1-latency', from: 'tom', to: ['me', 'priya'], subject: 'P1: invoice page latency spiking (LUM-142)', body: 'Brightwave is seeing 2.3s p95 on the invoice list. Priya thinks it is an N+1 in payments-api. Who can take it today?', at: -6 * HOUR, mentions: ['LUM-142', 'payments-api', 'brightwave'] },
  { thread: 'stripe-cutover', from: 'stripeteam', to: ['me'], subject: 'Action required: confirm your Stripe Billing cutover date', body: 'Please confirm the production cutover date for your Stripe Billing migration by Oct 24 so we can reserve a migration window.', at: -1 * DAY, mentions: ['atlas', 'stripe'] },
  { thread: 'ota-v1', from: 'hana', to: ['me'], subject: 'OTA 2.4 blocked on Helios v1 — need a call', body: 'The v1 bootloader rejects the new signature (LUM-131). We either drop v1 support (about 300 devices, mostly Brightwave) or delay the EU launch by ~3 weeks. Your call.', at: -1 * DAY, mentions: ['LUM-131', 'ota', 'eu', 'brightwave'], labels: ['important'], asks: { key: 'd-helios-v1', text: 'Drop Helios v1 support or delay the EU launch', options: ['Ship a v1 bootloader shim and delay EU ~3 weeks', 'Drop Helios v1 support and launch EU on time'] } },
  { thread: 'kestrel-sso', from: 'daniel', to: ['me'], subject: 'SSO is working again — thanks!', body: 'Confirming the login loop is gone for all our staff. Appreciate the quick turnaround.', at: -20 * DAY, mentions: ['LUM-120', 'auth-service'], labels: ['fyi'] },
  { thread: 'app3-beta', from: 'sofia', to: ['me'], subject: 'App 3.0 beta feedback summary', body: 'Beta NPS is 41. Top complaint: delayed push notifications (LUM-128). Otherwise people love the new energy timeline.', at: -2 * DAY, mentions: ['app3', 'LUM-128'] },
  { thread: 'board-deck', from: 'ava', to: ['me'], subject: 'Q3 board deck numbers', body: 'Draft numbers are in the data room. ARR is $612k; Brightwave is 30% of it.', at: -4 * DAY, mentions: ['seriesa', 'brightwave'] },
  { thread: 'eu-assets', from: 'leo', to: ['me'], subject: 'EU campaign assets ready', body: 'Campaign is ready to go — just need a launch date from you and Inès.', at: -1 * DAY, mentions: ['eu', 'ines'] },
  { thread: 'cutover-date', from: 'marcus', to: ['me'], subject: 'Can we lock the billing cutover date today?', body: 'Priya suggests Oct 28 for the Stripe Billing cutover. Stripe needs it by the 24th. OK to confirm?', at: -8 * HOUR, mentions: ['atlas', 'stripe', 'priya'], asks: { key: 'd-cutover', text: 'Lock the Stripe Billing cutover date', options: ['Confirm Oct 28', 'Push to Nov 4'] } },
  { thread: 'soc2', from: 'trust', to: ['me'], subject: 'SOC 2 evidence collection overdue (2 controls)', body: 'Two controls are missing evidence: access reviews and backup restore test for billing-db. Due in 2 days.', at: -10 * HOUR, mentions: ['billing-db'] },
  { thread: 'nl-1', from: 'saas', to: ['me'], subject: 'SaaS Weekly #212: pricing pages that convert', body: 'This week: pricing pages, PLG metrics, and more.', at: -1 * DAY, labels: ['newsletter'] },
  { thread: 'nl-2', from: 'devtrends', to: ['me'], subject: 'DevTrends Digest: 14 tools you should try', body: 'Your weekly roundup of developer tools.', at: -2 * DAY, labels: ['newsletter'] },
  { thread: 'nl-3', from: 'cloudco', to: ['me'], subject: '40% off reserved instances this week only', body: 'Limited time offer on compute.', at: -3 * DAY, labels: ['newsletter', 'promo'] },
  { thread: 'nl-4', from: 'growthhq', to: ['me'], subject: 'Webinar: 10 growth hacks for hardware startups', body: 'Join us live on Thursday.', at: -4 * DAY, labels: ['newsletter'] },
  { thread: 'nl-1b', from: 'saas', to: ['me'], subject: 'SaaS Weekly #211: the onboarding issue', body: 'Onboarding teardown of 12 products.', at: -8 * DAY, labels: ['newsletter'] },
];

const dayAt = (offsetDays: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

export const events = () => [
  { key: 'standup', title: 'Eng standup', start: dayAt(0, 10), mins: 15, attendees: ['me', 'priya', 'raj', 'dev', 'hana', 'marcus'] },
  { key: '1on1-priya', title: '1:1 Priya', start: dayAt(0, 17), mins: 30, attendees: ['me', 'priya'] },
  { key: 'bw-qbr', title: 'Brightwave QBR', start: dayAt(1, 15), mins: 60, attendees: ['me', 'kate', 'tom', 'sofia'], about: ['brightwave'] },
  { key: 'eu-sync', title: 'EU launch sync', start: dayAt(1, 15), mins: 45, attendees: ['me', 'ines', 'leo'], about: ['eu'] },
  { key: 'ota-review', title: 'OTA 2.4 review', start: dayAt(1, 12), mins: 30, attendees: ['me', 'hana', 'raj'], about: ['ota'] },
  { key: 'cutover-gonogo', title: 'Billing cutover go/no-go', start: dayAt(2, 16), mins: 30, attendees: ['me', 'priya', 'marcus', 'ava'], about: ['atlas'] },
  { key: 'northstar', title: 'Northstar partner meeting', start: dayAt(3, 11), mins: 60, attendees: ['me', 'marcus', 'maya'], about: ['seriesa'] },
];

export const channels = ['incidents', 'eng', 'launch', 'general'];

export const chat = [
  { channel: 'incidents', from: 'tom', at: -6 * HOUR, text: 'Invoice page p95 is 2.3s, Brightwave is complaining (LUM-142).' },
  { channel: 'incidents', from: 'priya', at: -5 * HOUR, text: 'Looks like the invoice list in payments-api runs one query per line item — classic N+1. I am in back-to-backs today though.' },
  { channel: 'incidents', from: 'raj', at: -4 * HOUR, text: 'I can look tomorrow, swamped with OTA auth work for LUM-131.' },
  { channel: 'eng', from: 'priya', at: -10 * DAY, text: 'Decision: we are moving billing from Chargebee to Stripe Billing (Atlas). RFC-012 has the details.', decision: { key: 'd-stripe', text: 'Move billing from Chargebee to Stripe Billing', about: ['atlas', 'stripe'], approvedBy: 'marcus' } },
  { channel: 'eng', from: 'marcus', at: -10 * DAY + HOUR, text: '+1, approved. Let us target end of October for cutover.' },
  { channel: 'eng', from: 'raj', at: -3 * DAY, text: 'Reminder: only Priya knows the billing-db failover runbook. We should write it down before the cutover.' },
  { channel: 'launch', from: 'ines', at: -2 * DAY, text: 'EU launch is gated on OTA 2.4 shipping to Helios v1 devices.', decision: { key: 'd-eu-ota', text: 'EU launch waits for OTA 2.4', about: ['eu', 'ota'] } },
  { channel: 'launch', from: 'sofia', at: -1 * DAY - 2 * HOUR, text: 'Decision: no EU launch without VAT-compliant invoices (LUM-145).', decision: { key: 'd-eu-vat', text: 'No EU launch without VAT-compliant invoices', about: ['eu', 'LUM-145'] } },
  { channel: 'launch', from: 'leo', at: -1 * DAY, text: 'Campaign assets are done. Waiting on a go date.' },
  { channel: 'general', from: 'ava', at: -4 * DAY, text: 'Board deck draft is in the data room — numbers locked Friday.' },
  { channel: 'general', from: 'dev', at: -2 * DAY, text: 'App 3.0 beta build 41 is out to 200 testers.' },
];

export const docs = [
  { key: 'rfc-012', title: 'RFC-012: Atlas — migrate billing to Stripe Billing', owner: 'priya', about: ['atlas', 'stripe', 'payments-api', 'billing-db'], at: -11 * DAY, body: 'We will replace Chargebee with Stripe Billing. Phase 1 dual-writes invoices from payments-api; phase 2 cuts over. Chargebee webhooks are dropped after cutover.', decision: { key: 'd-drop-chargebee', text: 'Drop Chargebee webhooks after the Stripe cutover', about: ['atlas'] } },
  { key: 'pm-kestrel', title: 'Postmortem: Kestrel SSO login loop', owner: 'raj', about: ['auth-service', 'LUM-120', 'kestrel'], at: -19 * DAY, body: 'Root cause: SAML clock skew of 90s. Fix: allow 120s skew and alert on drift.' },
  { key: 'eu-plan', title: 'EU Launch plan', owner: 'ines', about: ['eu', 'ota', 'LUM-145'], at: -6 * DAY, body: 'Launch markets: DE, NL, FR. Dependencies: OTA 2.4 on all devices, VAT invoices, localized app.' },
  { key: 'runbook-billing', title: 'billing-db failover runbook (draft)', owner: 'priya', about: ['billing-db'], at: -30 * DAY, body: 'Promote replica, rotate payments-api connection string, verify invoice writes. Draft — incomplete.' },
  { key: 'dataroom', title: 'Series A data room index', owner: 'ava', about: ['seriesa'], at: -5 * DAY, body: 'Financials, cap table, customer contracts (Brightwave, Kestrel), product roadmap.' },
  { key: 'ota-design', title: 'Helios OTA 2.4 design', owner: 'hana', about: ['ota', 'ota-server', 'device-gateway'], at: -14 * DAY, body: 'New ed25519 signature scheme. v1 bootloader only supports RSA — needs a shim.' },
];

/** Synthetic history so the fleet router has signal on day one. */
export const pastRuns = [
  { agent: 'codex', goal: 'Fix Kestrel SSO login loop (LUM-120)', system: 'auth-service', ticket: 'LUM-120', outcome: 'success', at: -21 * DAY, mins: 11 },
  { agent: 'codex', goal: 'Speed up dashboard CSV export (LUM-117)', system: 'analytics-pipeline', ticket: 'LUM-117', outcome: 'success', at: -34 * DAY, mins: 18 },
  { agent: 'claude-code', goal: 'Refactor payments-api invoice serializer', system: 'payments-api', outcome: 'success', at: -15 * DAY, mins: 9 },
  { agent: 'opencode', goal: 'Investigate delayed Android pushes (LUM-128)', system: 'notification-service', ticket: 'LUM-128', outcome: 'failed', at: -7 * DAY, mins: 25 },
  { agent: 'grok', goal: 'Draft OTA 2.4 changelog', system: 'ota-server', outcome: 'success', at: -9 * DAY, mins: 4 },
];
