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
const { seed, seedCatalog } = require('../src/seed');
const { resolveDownload } = require('../src/downloads');

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

  // --- catalog seed: 50 platform products, durable via seed on every boot ---
  const seed1 = seed();
  eq('seed creates 2 gumroad listings', seed1.created, 2);
  const cat1 = seedCatalog();
  eq('catalog seed creates 50 listings', cat1.created, 50);
  eq('50 catalog listings in db',
    db.prepare("SELECT COUNT(*) AS n FROM listings WHERE owner = 'platform' AND sku IS NOT NULL").get().n, 50);
  eq('catalog total $21,502',
    db.prepare('SELECT COALESCE(SUM(price_cents),0) AS t FROM listings WHERE sku IS NOT NULL').get().t, 2150200);
  const spot = db.prepare('SELECT price_cents, billing, owner, image_url FROM listings WHERE sku = ?').get('RE-06');
  eq('RE-06 price $1,997', spot.price_cents, 199700);
  eq('RE-06 one_time', spot.billing, 'one_time');
  eq('RE-06 platform-owned', spot.owner, 'platform');
  eq('RE-06 cover path', spot.image_url, '/covers/RE-06.jpg');
  const cat2 = seedCatalog();
  eq('catalog seed is idempotent', cat2.created, 0);
  eq('still 50 after re-seed',
    db.prepare('SELECT COUNT(*) AS n FROM listings WHERE sku IS NOT NULL').get().n, 50);
  eq('2 gumroad listings untouched',
    db.prepare("SELECT COUNT(*) AS n FROM listings WHERE external_url LIKE '%gumroad%'").get().n, 2);
  check('no video-course claims in catalog descriptions',
    !db.prepare("SELECT 1 FROM listings WHERE sku IS NOT NULL AND (description LIKE '%video course%' OR description LIKE '%video masterclass%')").get()
    || db.prepare("SELECT description FROM listings WHERE sku IS NOT NULL AND (description LIKE '%video course%' OR description LIKE '%video masterclass%')").all()
      .every((r) => /in (full )?written form|fully written|not a video course|video-course manual|video course companion/i.test(r.description)));

  // --- download gate: only a proven payment for a catalog listing resolves ---
  const dlDir = path.join(__dirname, '..', 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  const scratchSku = 'TST-99';
  const scratchFile = path.join(dlDir, `${scratchSku}.pdf`);
  fs.writeFileSync(scratchFile, '%PDF-1.4 scratch');
  try {
    const scratch = db.prepare(
      "INSERT INTO listings (seller_id, owner, sku, image_url, title, description, price_cents, billing) VALUES (NULL, 'platform', ?, '/covers/TST-99.jpg', 'Scratch', '', 9700, 'one_time')"
    ).run(scratchSku);
    const scratchId = Number(scratch.lastInsertRowid);
    const fakeStripe = (status, listingId) => ({ checkout: { sessions: { retrieve: async (id) => ({ id, payment_status: status, metadata: { listing_id: String(listingId) } }) } } });
    // (a) paid Stripe session resolves.
    const r1 = await resolveDownload(db, { sessionId: 'cs_test_paid123', kind: 'pdf', stripe: fakeStripe('paid', scratchId) });
    check('paid Stripe session resolves download', !!r1 && r1.listing.sku === scratchSku && r1.filePath === scratchFile);
    // (b) unpaid Stripe session, no order, refuses.
    const r2 = await resolveDownload(db, { sessionId: 'cs_test_unpaid123', kind: 'pdf', stripe: fakeStripe('unpaid', scratchId) });
    eq('unpaid session refuses', r2, null);
    // (c) local paid order resolves without Stripe.
    db.prepare("INSERT INTO orders (listing_id, seller_id, buyer_email, type, amount_cents, status, stripe_checkout_session_id, stripe_payment_intent_id) VALUES (?, NULL, 'buyer@example.com', 'one_time', 9700, 'paid', 'cs_test_order123', 'pi_scratch')").run(scratchId);
    const r3 = await resolveDownload(db, { sessionId: 'cs_test_order123', kind: 'pdf', stripe: null });
    check('local paid order resolves download', !!r3 && r3.listing.sku === scratchSku);
    // (d) unknown session refuses; malformed session id refuses.
    const r4 = await resolveDownload(db, { sessionId: 'cs_test_nothing123', kind: 'pdf', stripe: null });
    eq('unknown session refuses', r4, null);
    const r5 = await resolveDownload(db, { sessionId: 'not-a-session', kind: 'pdf', stripe: null });
    eq('malformed session id refuses', r5, null);
    // (e) seed (non-catalog) listing never resolves even when paid.
    const seedListingId = db.prepare("SELECT id FROM listings WHERE title = 'Smart Money Budget Planner'").get().id;
    const r6 = await resolveDownload(db, { sessionId: 'cs_test_seed123', kind: 'pdf', stripe: fakeStripe('paid', seedListingId) });
    eq('non-catalog listing refuses', r6, null);
    // (f) two-letter SKUs (RE-*) resolve too — the sku pattern is 2-3 letters.
    const reFile = path.join(dlDir, 'RE-99.pdf');
    fs.writeFileSync(reFile, '%PDF-1.4 scratch re');
    try {
      const re = db.prepare(
        "INSERT INTO listings (seller_id, owner, sku, image_url, title, description, price_cents, billing) VALUES (NULL, 'platform', 'RE-99', '/covers/RE-99.jpg', 'Scratch RE', '', 9700, 'one_time')"
      ).run();
      const reId = Number(re.lastInsertRowid);
      const r7 = await resolveDownload(db, { sessionId: 'cs_test_re99', kind: 'pdf', stripe: fakeStripe('paid', reId) });
      check('two-letter RE sku resolves download', !!r7 && r7.listing.sku === 'RE-99' && r7.filePath === reFile);
    } finally {
      fs.unlinkSync(reFile);
    }
  } finally {
    fs.unlinkSync(scratchFile);
  }

  console.log(`\n${passed} checks passed.`);
  fs.unlinkSync(tmpDb);
  fs.unlinkSync(tmpDb + '-wal');
  fs.unlinkSync(tmpDb + '-shm');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
