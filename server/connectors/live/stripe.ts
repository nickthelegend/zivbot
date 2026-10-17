import { type ConnectorDef, type ConnectorCtx, need, getJson } from '../types.ts';
import { upsertNodes } from '../../ingest.ts';
import { ms, resolveOrgs } from './_util.ts';

async function stripeApi(ctx: ConnectorCtx, path: string): Promise<any> {
  const [key] = need(ctx, 'secretKey');
  return getJson(`https://api.stripe.com/v1${path}`, { headers: { authorization: `Bearer ${key}`, 'stripe-version': '2024-06-20' } });
}

/** Cursor-paginate a Stripe list endpoint up to `max` objects. */
async function all(ctx: ConnectorCtx, path: string, max: number): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const r = await stripeApi(ctx, `${path}${sep}limit=100${after ? `&starting_after=${after}` : ''}`);
    out.push(...(r.data || []));
    after = r.has_more && r.data?.length ? r.data[r.data.length - 1].id : undefined;
  } while (after && out.length < max);
  return out.slice(0, max);
}

const PER_YEAR: Record<string, number> = { day: 365, week: 52, month: 12, year: 1 };
/** Yearly value of a subscription in major units (cents → dollars). */
function subArr(s: any): number {
  let cents = 0;
  for (const it of s.items?.data || []) {
    const p = it.price || it.plan;
    const rec = p?.recurring || (p?.interval ? { interval: p.interval, interval_count: p.interval_count } : null);
    if (!rec) continue;
    const unit = p.unit_amount ?? (p.unit_amount_decimal ? Number(p.unit_amount_decimal) : p.amount ?? 0);
    cents += (unit * (it.quantity ?? 1) * (PER_YEAR[rec.interval] || 0)) / (rec.interval_count || 1);
  }
  return Math.round(cents) / 100;
}
const FREE_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton|protonmail|gmx|yandex)\./i;
const workDomain = (email?: string) => {
  const d = email?.split('@')[1];
  return d && !FREE_MAIL.test(d) ? d : undefined;
};
const money = (n: number, cur = 'usd') => `${cur.toUpperCase()} ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export const stripe: ConnectorDef = {
  id: 'stripe',
  name: 'Stripe',
  category: 'Finance',
  description: 'Customers as orgs with ARR from active subscriptions and open / past-due invoices. Read-only.',
  icon: 'stripe',
  color: '#635BFF',
  auth: 'key',
  docs: 'https://dashboard.stripe.com/apikeys',
  fields: [
    { key: 'secretKey', label: 'Restricted or test secret key', env: 'STRIPE_SECRET_KEY', secret: true, placeholder: 'rk_test_… / sk_test_…', help: 'Use a restricted key with read-only Customers, Subscriptions, Invoices — or a test-mode key.' },
  ],
  async sync(ctx) {
    const { g } = ctx;
    ctx.progress('Reading Stripe customers');
    const customers = await all(ctx, '/customers', 100);
    ctx.progress('Reading active subscriptions');
    const subs = await all(ctx, '/subscriptions?status=active', 300);
    ctx.progress('Reading open invoices');
    const invoices = await all(ctx, '/invoices?status=open', 300);

    const arr = new Map<string, number>();
    const currency = new Map<string, string>();
    for (const s of subs) {
      const c = typeof s.customer === 'string' ? s.customer : s.customer?.id;
      arr.set(c, (arr.get(c) || 0) + subArr(s));
      if (s.currency) currency.set(c, s.currency);
    }
    const open = new Map<string, { n: number; due: number; pastDue: boolean }>();
    const now = Date.now();
    for (const inv of invoices) {
      const c = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
      const o = open.get(c) || { n: 0, due: 0, pastDue: false };
      o.n++;
      o.due += (inv.amount_remaining ?? inv.amount_due ?? 0) / 100;
      if (inv.due_date && inv.due_date * 1000 < now) o.pastDue = true;
      open.set(c, o);
    }

    const { uids, known } = await resolveOrgs(g, customers.map((c) => ({ id: c.id, name: c.name || undefined, domain: workDomain(c.email) })), (id) => `org:stripe:${id}`);
    ctx.progress(`Writing ${customers.length} customers`);
    await upsertNodes(g, 'Org', customers.map((c) => {
      const o = open.get(c.id);
      const stripeProps = {
        stripeId: c.id, arr: arr.get(c.id) || 0, currency: currency.get(c.id) || c.currency || undefined, openInvoices: o?.n || 0, openAmount: o ? Math.round(o.due * 100) / 100 : 0,
        pastDue: !!(o?.pastDue || c.delinquent), delinquent: !!c.delinquent, subscriptions: subs.filter((s) => (typeof s.customer === 'string' ? s.customer : s.customer?.id) === c.id).length,
      };
      return known.has(c.id)
        ? { uid: uids.get(c.id)!, props: stripeProps }
        : { uid: uids.get(c.id)!, props: { name: c.name || c.email || c.id, kind: 'customer', email: c.email || undefined, customerSince: ms(c.created), source: 'stripe', ...stripeProps }, search: `${c.name || ''} ${c.email || ''} customer stripe` };
    }));
    const totalArr = [...arr.values()].reduce((a, b) => a + b, 0);
    return { customers: customers.length, activeSubscriptions: subs.length, arr: Math.round(totalArr), openInvoices: invoices.length, pastDue: [...open.values()].filter((o) => o.pastDue).length };
  },
  actions: [
    {
      name: 'customer_summary',
      description: 'Look up a Stripe customer by email: subscriptions, ARR, and recent invoices.',
      params: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      mutates: false,
      async run(ctx, a) {
        const r = await stripeApi(ctx, `/customers?email=${encodeURIComponent(String(a.email).trim())}&limit=3`);
        const c = r.data?.[0];
        if (!c) return `No Stripe customer with email ${a.email}.`;
        const subs = (await stripeApi(ctx, `/subscriptions?customer=${c.id}&status=all&limit=20`)).data || [];
        const invs = (await stripeApi(ctx, `/invoices?customer=${c.id}&limit=5`)).data || [];
        const live = subs.filter((s: any) => ['active', 'trialing', 'past_due'].includes(s.status));
        const cur = live[0]?.currency || c.currency || 'usd';
        const lines = [
          `${c.name || c.email} (${c.id}) — customer since ${new Date(c.created * 1000).toISOString().slice(0, 10)}${c.delinquent ? ' · DELINQUENT' : ''}`,
          `ARR ${money(live.filter((s: any) => s.status !== 'trialing').reduce((t: number, s: any) => t + subArr(s), 0), cur)} across ${live.length} live subscription(s)${live.some((s: any) => s.status === 'past_due') ? ' (one is past due)' : ''}`,
          ...live.map((s: any) => `  · ${s.status} ${(s.items?.data || []).map((it: any) => `${it.price?.nickname || it.price?.product || 'item'} ×${it.quantity ?? 1}`).join(', ')} — renews ${s.current_period_end ? new Date(s.current_period_end * 1000).toISOString().slice(0, 10) : '?'}`),
          `Recent invoices:`,
          ...invs.map((i: any) => `  · ${i.number || i.id} ${i.status} ${money((i.amount_due || 0) / 100, i.currency)}${i.due_date ? ` due ${new Date(i.due_date * 1000).toISOString().slice(0, 10)}` : ''}${i.hosted_invoice_url ? ` ${i.hosted_invoice_url}` : ''}`),
          `https://dashboard.stripe.com/${c.livemode ? '' : 'test/'}customers/${c.id}`,
        ];
        return lines.join('\n');
      },
    },
  ],
};
