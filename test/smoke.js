'use strict';
/**
 * Smoke tests for EightyTwenty — the repo's repeatable regression suite.
 * No network, no Stripe keys: runs the fee math and the webhook handlers
 * against a throwaway SQLite database.
 *
 * Usage: npm test   (or: node test/smoke.js)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `eightytwenty-smoke-${process.pid}.db`);
process.env.DATABASE_PATH = tmpDb;
delete process.env.STRIPE_SECRET_KEY; // handlers must work with no Stripe key

const { db } = require('../src/db');
const { calculateRevenueSplit, chargeBreakdown, processingFeeCents, refundNetCents, money } = require('../src/fees');
const { handleEvent } = require('../src/webhooks');
const { sellerReady } = require('../src/onboarding');

let passed = 0;
function check(name, cond) {
  if (!cond) throw new Error(`FAILED: ${name}`);
  passed++;
  console.log(`ok - ${name}`);
}
function eq(name, got, want) {
  if (got !== want) throw new Error(`FAILED: ${name} — got ${got}, want ${want}`);
  passed++;
  console.log(`ok - ${name}`);
}

async function main() {
  // --- fee math (Larry's exact split + Stripe costs) ---
  eq('split $100 -> platform $20', calculateRevenueSplit(10000).platformFee, 2000);
  eq('split $100 -> seller $80', calculateRevenueSplit(10000).sellerEarnings, 8000);
  const b100 = chargeBreakdown(10000);
  eq('$100 one-time platform net', b100.platformNet, 1680);
  eq('$100 one-time processing', b100.processingFee, 320);
  eq('$10 renewal processing (billing)', processingFeeCents(1000, { billing: true }), 66);
  eq('refund net on $100 sale', refundNetCents({ grossCents: 10000, sellerShareCents: 8000, platformFeeCents: 2000, processingFeeCents: 320 }), -320);
  eq('money formats negatives', money(-320), '-$3.20');

  // --- seller readiness is the v2 transfers status ---
  check('sellerReady: active', sellerReady({ transfers_status: 'active' }) === true);
  check('sellerReady: pending is not ready', sellerReady({ transfers_status: 'pending' }) === false);
  check('sellerReady: null seller is not ready', sellerReady(null) === false);

  // --- webhook handlers against a throwaway DB ---
  const listing = db.prepare(
    "INSERT INTO listings (seller_id, owner, title, description, price_cents, billing) VALUES (NULL, 'platform', 'Smoke Monthly', '', 1000, 'monthly')"
  ).run();
  const listingId = Number(listing.lastInsertRowid);

  // New-shape invoice (API 2026-10-28): subscription under parent,
  // subscription/charge/payment_intent all null.
  const newShapeInvoice = (id, billingReason) => ({
    id, object: 'invoice', amount_paid: 1000, billing_reason: billingReason,
    subscription: null, charge: null, payment_intent: null, customer: 'cus_smoke',
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_smoke' } },
  });

  // Order + subscription rows as checkout.session.completed would create them.
  const order = db.prepare(
    "INSERT INTO orders (listing_id, seller_id, buyer_email, type, amount_cents, status, stripe_payment_intent_id, stripe_subscription_id, stripe_customer_id) VALUES (?, NULL, 'smoke@example.com', 'subscription', 1000, 'pending', 'pi_smoke', 'sub_smoke', 'cus_smoke')"
  ).run(Number(listingId));
  const orderId = Number(order.lastInsertRowid);
  db.prepare(
    "INSERT INTO subscriptions (stripe_subscription_id, stripe_customer_id, seller_id, listing_id, buyer_email, status) VALUES ('sub_smoke', 'cus_smoke', NULL, ?, 'smoke@example.com', 'active')"
  ).run(Number(listingId));

  const evt = (id, type, object) => ({ id, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const ledgerCount = () => db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get().n;

  // (a) PI succeeded for a subscription order records NOTHING (invoice is the trigger).
  await handleEvent(evt('evt_smoke_pi', 'payment_intent.succeeded', {
    id: 'pi_smoke', object: 'payment_intent', amount: 1000, invoice: null, latest_charge: null,
  }), 'platform');
  eq('subscription PI records no revenue', ledgerCount(), 0);
  eq('subscription PI marks order paid', db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'paid');

  // (b) New-shape invoice.payment_succeeded records ONE renewal with 80/20 split.
  await handleEvent(evt('evt_smoke_inv1', 'invoice.payment_succeeded', newShapeInvoice('in_smoke1', 'subscription_create')), 'platform');
  eq('invoice.payment_succeeded records one renewal', ledgerCount(), 1);
  const renewal = db.prepare("SELECT * FROM ledger_entries WHERE kind = 'renewal'").get();
  eq('renewal gross', renewal.gross_cents, 1000);
  eq('renewal platform fee 20%', renewal.platform_fee_cents, 200);
  eq('renewal seller share 80%', renewal.seller_share_cents, 800);

  // (c) invoice.paid for the SAME invoice records nothing (dedupe).
  await handleEvent(evt('evt_smoke_inv2', 'invoice.paid', newShapeInvoice('in_smoke1', 'subscription_create')), 'platform');
  eq('invoice.paid for same invoice is deduped', ledgerCount(), 1);

  // (d) Replaying the same event id is a no-op for the handler path too
  // (the route layer dedupes by event.id; the handler dedupes by invoice).
  await handleEvent(evt('evt_smoke_inv1', 'invoice.payment_succeeded', newShapeInvoice('in_smoke1', 'subscription_create')), 'platform');
  eq('replayed invoice event adds nothing', ledgerCount(), 1);

  // (e) Old-shape invoice (subscription field set) still resolves.
  await handleEvent(evt('evt_smoke_inv3', 'invoice.payment_succeeded', {
    id: 'in_smoke2', object: 'invoice', amount_paid: 1000, billing_reason: 'subscription_cycle',
    subscription: 'sub_smoke', charge: null, payment_intent: null, customer: 'cus_smoke',
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, parent: null,
  }), 'platform');
  eq('old-shape invoice records a renewal', ledgerCount(), 2);

  // (f) One-time PI records a sale.
  const ot = db.prepare(
    "INSERT INTO orders (listing_id, seller_id, buyer_email, type, amount_cents, status, stripe_payment_intent_id) VALUES (?, NULL, 'one@example.com', 'one_time', 700, 'pending', 'pi_smoke_once')"
  ).run(Number(listingId));
  await handleEvent(evt('evt_smoke_pi2', 'payment_intent.succeeded', {
    id: 'pi_smoke_once', object: 'payment_intent', amount: 700, amount_received: 700, invoice: null, latest_charge: null,
  }), 'platform');
  const sale = db.prepare("SELECT * FROM ledger_entries WHERE kind = 'sale'").get();
  check('one-time PI records a sale', !!sale && sale.gross_cents === 700 && sale.platform_fee_cents === 140);

  // (g) invoice.created records nothing.
  await handleEvent(evt('evt_smoke_inv4', 'invoice.created', newShapeInvoice('in_smoke3', 'subscription_create')), 'platform');
  eq('invoice.created records nothing', ledgerCount(), 3);

  console.log(`\n${passed} checks passed.`);
  fs.unlinkSync(tmpDb);
  fs.unlinkSync(tmpDb + '-wal');
  fs.unlinkSync(tmpDb + '-shm');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
