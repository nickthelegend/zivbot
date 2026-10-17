# lumen-payments (payments-api)

Synthetic demo service used by ZivBot's demo workspace. Serves invoices for the
customer portal (`checkout-web`) and the mobile app.

- `src/db.js` — in-memory stand-in for `billing-db` that counts queries
- `src/invoices.js` — invoice listing and invoice building
- `npm test` — runs the test suite (`node --test`)

Known issues: LUM-142 (invoice list latency), LUM-139 (duplicate line items).
