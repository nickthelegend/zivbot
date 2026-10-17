import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { listInvoices } from '../src/invoices.js';

function seed(n = 50) {
  const invoices = [], line_items = [], subscriptions = [];
  for (let i = 0; i < n; i++) {
    const period = `2026-${String((i % 12) + 1).padStart(2, '0')}-${i}`;
    invoices.push({ id: `inv_${i}`, accountId: 'acct_brightwave', period });
    // The lease is billed as a subscription AND mirrored as a line item by the
    // Chargebee importer (sku matches) — it must only appear once.
    subscriptions.push({ accountId: 'acct_brightwave', period, sku: 'LEASE-H2', description: 'Helios battery lease', amount: 12000 });
    line_items.push({ invoiceId: `inv_${i}`, sku: 'LEASE-H2', description: 'Helios battery lease', amount: 12000 });
    line_items.push({ invoiceId: `inv_${i}`, sku: 'INSTALL', description: 'Installation', amount: 4500 });
  }
  return { invoices, line_items, subscriptions };
}

test('LUM-142: listing invoices does not query per invoice (no N+1)', () => {
  const db = createDb(seed(50));
  listInvoices(db, 'acct_brightwave');
  assert.ok(db.queryCount <= 3, `expected <= 3 queries for 50 invoices, got ${db.queryCount}`);
});

test('LUM-139: a lease billed as a subscription is not duplicated as a line item', () => {
  const db = createDb(seed(3));
  const [inv] = listInvoices(db, 'acct_brightwave');
  const leases = inv.lines.filter((l) => l.sku === 'LEASE-H2');
  assert.equal(leases.length, 1, 'lease appears more than once');
  assert.equal(inv.total, 16500);
});

test('invoices keep their line items', () => {
  const db = createDb(seed(2));
  const out = listInvoices(db, 'acct_brightwave');
  assert.equal(out.length, 2);
  assert.ok(out.every((i) => i.lines.some((l) => l.sku === 'INSTALL')));
});
