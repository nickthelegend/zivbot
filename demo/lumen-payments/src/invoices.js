// Invoice listing for the customer portal.

/** All invoices for an account, each with its line items and total. */
export function listInvoices(db, accountId) {
  const invoices = db.query('invoices', { accountId });
  return invoices.map((inv) => {
    const items = db.query('line_items', { invoiceId: inv.id });
    return buildInvoice(inv, items, db);
  });
}

/** Recurring charges (leases) plus one-off items, with a total in cents. */
export function buildInvoice(inv, items, db) {
  const recurring = db.query('subscriptions', { accountId: inv.accountId, period: inv.period }).map((s) => ({
    sku: s.sku,
    description: s.description,
    amount: s.amount,
  }));
  const lines = [...recurring, ...items];
  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return { id: inv.id, period: inv.period, lines, total };
}
