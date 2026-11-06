'use strict';
/**
 * Stripe webhooks — the ONLY source of truth for "paid".
 *
 * Rules (from STRIPE-SPEC.md §6):
 *  - HTTPS endpoint, raw body preserved byte-for-byte, signature verified
 *    with the SDK (5-minute tolerance), HTTP 400 on failure.
 *  - Idempotency keyed by event.id (Stripe retries deliveries).
 *  - Revenue is recorded ONLY on payment_succeeded events
 *    (invoice.payment_succeeded / payment_intent.succeeded) — NEVER on
 *    invoice creation.
 *  - Two endpoints, two secrets: platform events and Connect events
 *    ("Listen to events on Connected accounts").
 */
const { db } = require('./db');
const { getStripe, stripeConfigured } = require('./stripeClient');
const { recordSale, recordRefund, recordDisputeFee } = require('./ledger');
const { calculateRevenueSplit, refundNetCents } = require('./fees');

const DISPUTE_RECEIVED_FEE_CENTS = 1500; // US $15, never refunded (verified Nov 2026)

function alreadyProcessed(eventId) {
  return !!db.prepare('SELECT 1 FROM processed_events WHERE event_id = ?').get(eventId);
}

function markProcessed(eventId, type, source) {
  db.prepare('INSERT OR IGNORE INTO processed_events (event_id, type, source) VALUES (?, ?, ?)')
    .run(eventId, type, source);
}

/** Exact Stripe processing fee from a charge's balance transaction, when available. */
async function exactProcessingFee(chargeId) {
  if (!stripeConfigured() || !chargeId) return null;
  try {
    const stripe = getStripe();
    const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
    const bt = charge.balance_transaction;
    if (bt && typeof bt === 'object' && Number.isInteger(bt.fee)) return bt.fee;
    if (typeof bt === 'string') {
      const fetched = await stripe.balanceTransactions.retrieve(bt);
      if (Number.isInteger(fetched.fee)) return fetched.fee;
    }
  } catch (e) {
    console.warn('[webhook] could not fetch balance transaction for', chargeId, '-', e.message);
  }
  return null;
}

function findOrderByPI(piId) {
  return db.prepare('SELECT * FROM orders WHERE stripe_payment_intent_id = ?').get(piId);
}

function findOrderBySubscription(subId) {
  return db.prepare('SELECT * FROM orders WHERE stripe_subscription_id = ? ORDER BY id DESC').get(subId);
}

async function handlePaymentIntentSucceeded(event) {
  const pi = event.data.object;
  const order = findOrderByPI(pi.id);
  if (!order) {
    console.warn('[webhook] payment_intent.succeeded with no matching order:', pi.id);
    return;
  }
  if (order.status === 'paid') return; // already recorded (e.g. duplicate delivery)
  const chargeId = pi.latest_charge || (pi.charges && pi.charges.data && pi.charges.data[0] && pi.charges.data[0].id);
  const exactFee = await exactProcessingFee(chargeId);
  const gross = pi.amount_received || pi.amount;
  recordSale({
    eventId: event.id, orderId: order.id, sellerId: order.seller_id,
    grossCents: gross, processingFeeCents: exactFee,
    billing: false, kind: 'sale',
    description: `one-time sale — order #${order.id}`,
  });
  db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(order.id);
}

async function handleInvoicePaymentSucceeded(event) {
  const invoice = event.data.object;
  const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription && invoice.subscription.id;
  const sub = subId
    ? db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(subId)
    : null;
  if (!sub) {
    console.warn('[webhook] invoice.payment_succeeded with no matching subscription:', invoice.id);
    return;
  }
  const amountPaid = invoice.amount_paid;
  if (!Number.isInteger(amountPaid) || amountPaid <= 0) return;
  const chargeId = invoice.charge;
  const exactFee = await exactProcessingFee(chargeId);
  const order = findOrderBySubscription(subId);
  recordSale({
    eventId: event.id, orderId: order ? order.id : null, sellerId: sub.seller_id,
    grossCents: amountPaid, processingFeeCents: exactFee,
    billing: true, kind: 'renewal',
    description: `subscription renewal — ${subId} (invoice ${invoice.id})`,
  });
}

async function handleChargeRefunded(event) {
  const charge = event.data.object;
  const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
  const order = piId ? findOrderByPI(piId) : null;
  if (!order) {
    console.warn('[webhook] charge.refunded with no matching order:', charge.id);
    return;
  }
  const refunded = charge.amount_refunded || 0;
  if (refunded <= 0) return;
  // Original sale numbers, for the platform-net math.
  const sale = db.prepare(
    "SELECT * FROM ledger_entries WHERE order_id = ? AND kind IN ('sale','renewal') ORDER BY id ASC LIMIT 1"
  ).get(order.id);
  const gross = sale ? sale.gross_cents : order.amount_cents;
  const sellerShare = sale ? sale.seller_share_cents : calculateRevenueSplit(gross).sellerEarnings;
  const platformFee = sale ? sale.platform_fee_cents : calculateRevenueSplit(gross).platformFee;
  const processingFee = sale ? sale.processing_fee_cents : 0;
  const refundedShare = Math.round((sellerShare * refunded) / gross);
  const { platformNetAfter } = recordRefund({
    eventId: event.id, orderId: order.id, sellerId: order.seller_id,
    grossCents: refunded, sellerShareCents: refundedShare,
    platformFeeCents: Math.round((platformFee * refunded) / gross),
    processingFeeCents: Math.round((processingFee * refunded) / gross),
    description: `refund — order #${order.id} (${refunded === gross ? 'full' : 'partial'})`,
  });
  // The admin refund flow may already have created this row (with the Stripe
  // refund id); update it in place rather than duplicating it.
  const existingRefund = db.prepare(
    'SELECT id FROM refunds WHERE order_id = ? AND amount_cents = ?'
  ).get(order.id, refunded);
  if (existingRefund) {
    db.prepare('UPDATE refunds SET platform_net_after_cents = ?, reason = COALESCE(reason, ?) WHERE id = ?')
      .run(platformNetAfter, 'webhook: charge.refunded', existingRefund.id);
  } else {
    db.prepare('INSERT INTO refunds (order_id, amount_cents, reverse_transfer, refund_application_fee, platform_net_after_cents, reason) VALUES (?, ?, 1, 0, ?, ?)')
      .run(order.id, refunded, platformNetAfter, 'webhook: charge.refunded');
  }
  db.prepare("UPDATE orders SET status = ? WHERE id = ?")
    .run(refunded >= gross ? 'refunded' : 'partially_refunded', order.id);
}

function handleDispute(event, stage) {
  const d = event.data.object;
  const piId = typeof d.payment_intent === 'string' ? d.payment_intent : null;
  const order = piId ? findOrderByPI(piId) : null;
  const existing = db.prepare('SELECT * FROM disputes WHERE stripe_dispute_id = ?').get(d.id);
  if (!existing) {
    db.prepare(`INSERT INTO disputes (stripe_dispute_id, order_id, amount_cents, fee_cents, status, reason)
      VALUES (?, ?, ?, 0, ?, ?)`)
      .run(d.id, order ? order.id : null, d.amount || 0, d.status || 'needs_response', d.reason || null);
  } else {
    db.prepare('UPDATE disputes SET status = ?, reason = COALESCE(?, reason) WHERE stripe_dispute_id = ?')
      .run(d.status || existing.status, d.reason || null, d.id);
  }

  if (stage === 'funds_withdrawn' && order) {
    // Platform balance debited for the disputed amount; the seller's share is
    // pulled back (transfer reversed). The $15 received fee is never refunded.
    const sale = db.prepare(
      "SELECT * FROM ledger_entries WHERE order_id = ? AND kind IN ('sale','renewal') ORDER BY id ASC LIMIT 1"
    ).get(order.id);
    const sellerShare = sale ? sale.seller_share_cents : 0;
    const amount = d.amount || 0;
    db.prepare(`INSERT INTO ledger_entries
      (event_id, order_id, seller_id, kind, gross_cents, processing_fee_cents, platform_fee_cents, seller_share_cents, platform_net_cents, description)
      VALUES (?, ?, ?, 'dispute', ?, 0, 0, ?, ?, ?)`)
      .run(event.id, order.id, order.seller_id, -amount, -sellerShare, -amount + sellerShare,
        `dispute funds withdrawn — order #${order.id}`);
    recordDisputeFee({
      eventId: event.id, orderId: order.id, sellerId: order.seller_id,
      amountCents: DISPUTE_RECEIVED_FEE_CENTS,
      description: `dispute received fee ($15, never refunded) — ${d.id}`,
    });
    db.prepare('UPDATE disputes SET fee_cents = fee_cents + ? WHERE stripe_dispute_id = ?')
      .run(DISPUTE_RECEIVED_FEE_CENTS, d.id);
    db.prepare("UPDATE orders SET status = 'disputed' WHERE id = ?").run(order.id);
  }

  if (stage === 'funds_reinstated' && order) {
    // Dispute won: the amount comes back and the seller's share is re-sent.
    const sale = db.prepare(
      "SELECT * FROM ledger_entries WHERE order_id = ? AND kind IN ('sale','renewal') ORDER BY id ASC LIMIT 1"
    ).get(order.id);
    const sellerShare = sale ? sale.seller_share_cents : 0;
    const amount = d.amount || 0;
    db.prepare(`INSERT INTO ledger_entries
      (event_id, order_id, seller_id, kind, gross_cents, processing_fee_cents, platform_fee_cents, seller_share_cents, platform_net_cents, description)
      VALUES (?, ?, ?, 'dispute', ?, 0, 0, ?, ?, ?)`)
      .run(event.id, order.id, order.seller_id, amount, sellerShare, amount - sellerShare,
        `dispute funds reinstated (won) — order #${order.id}`);
    db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(order.id);
  }
}

function handleSubscriptionEvent(event) {
  const sub = event.data.object;
  const existing = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(sub.id);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  if (existing) {
    db.prepare('UPDATE subscriptions SET status = ?, current_period_end = ? WHERE stripe_subscription_id = ?')
      .run(sub.status, periodEnd, sub.id);
  } else {
    // Subscription created before we saw checkout.session.completed, or via
    // another path: record it so renewals can be attributed.
    const order = findOrderBySubscription(sub.id);
    db.prepare(`INSERT INTO subscriptions
      (stripe_subscription_id, stripe_customer_id, seller_id, listing_id, buyer_email, status, current_period_end)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sub.id, typeof sub.customer === 'string' ? sub.customer : null,
        order ? order.seller_id : null, order ? order.listing_id : null,
        order ? order.buyer_email : null, sub.status, periodEnd);
  }
}

function handlePayout(event) {
  const p = event.data.object;
  const accountId = event.account || null;
  db.prepare(`INSERT INTO payouts (stripe_payout_id, stripe_account_id, amount_cents, status, arrival_date)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(stripe_payout_id) DO UPDATE SET status = excluded.status, arrival_date = excluded.arrival_date`)
    .run(p.id, accountId, p.amount || 0, p.status || 'pending',
      p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null);
}

async function syncSellerFromAccount(accountId) {
  if (!stripeConfigured() || !accountId) return;
  try {
    const stripe = getStripe();
    const acct = await stripe.accounts.retrieve(accountId);
    db.prepare('UPDATE sellers SET charges_enabled = ?, payouts_enabled = ? WHERE stripe_account_id = ?')
      .run(acct.charges_enabled ? 1 : 0, acct.payouts_enabled ? 1 : 0, accountId);
    const s = db.prepare('SELECT charges_enabled, payouts_enabled FROM sellers WHERE stripe_account_id = ?').get(accountId);
    if (s && s.charges_enabled && s.payouts_enabled) {
      db.prepare("UPDATE sellers SET status = 'active' WHERE stripe_account_id = ?").run(accountId);
    }
  } catch (e) {
    console.warn('[webhook] could not sync account', accountId, '-', e.message);
  }
}

/**
 * Dispatch one verified Stripe event. Idempotency is enforced by the caller
 * (markProcessed happens inside the same logical step; see route handler).
 */
async function handleEvent(event, source) {
  const type = event.type;
  switch (type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      // Record the order as PENDING only. No revenue is recorded here.
      const listingId = s.metadata && s.metadata.listing_id ? Number(s.metadata.listing_id) : null;
      const sellerId = s.metadata && s.metadata.seller_id ? Number(s.metadata.seller_id) : null;
      const existing = s.payment_intent
        ? db.prepare('SELECT id FROM orders WHERE stripe_payment_intent_id = ?').get(
            typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id)
        : null;
      if (!existing && listingId) {
        const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
        // node:sqlite cannot bind `undefined` — coerce every optional
        // Stripe field to null.
        const piId = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || null;
        const subId = typeof s.subscription === 'string' ? s.subscription : (s.subscription && s.subscription.id) || null;
        const customerId = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id) || null;
        db.prepare(`INSERT INTO orders
          (listing_id, seller_id, buyer_email, type, amount_cents, status,
           stripe_checkout_session_id, stripe_payment_intent_id, stripe_subscription_id, stripe_customer_id)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
          .run(
            listingId, sellerId || (listing ? listing.seller_id : null),
            (s.customer_details && s.customer_details.email) || null,
            s.mode === 'subscription' ? 'subscription' : 'one_time',
            s.amount_total || (listing ? listing.price_cents : 0),
            s.id, piId, subId, customerId,
          );
      }
      break;
    }
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(event);
      break;
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const order = findOrderByPI(pi.id);
      if (order) db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event);
      break;
    case 'invoice.payment_failed': {
      // Dunning, not revenue. Logged via processed_events; visible to the
      // seller as a failed renewal, not as a sale.
      console.log('[webhook] invoice.payment_failed (dunning, no revenue):', event.data.object.id);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      handleSubscriptionEvent(event);
      break;
    case 'charge.refunded':
      await handleChargeRefunded(event);
      break;
    case 'charge.dispute.created':
      handleDispute(event, 'created');
      break;
    case 'charge.dispute.updated':
      handleDispute(event, 'updated');
      break;
    case 'charge.dispute.closed':
      handleDispute(event, 'closed');
      break;
    case 'charge.dispute.funds_withdrawn':
      handleDispute(event, 'funds_withdrawn');
      break;
    case 'charge.dispute.funds_reinstated':
      handleDispute(event, 'funds_reinstated');
      break;
    case 'payout.created':
    case 'payout.paid':
    case 'payout.failed':
      handlePayout(event);
      break;
    case 'account.updated':
    case 'capability.updated': {
      const accountId = event.account || (event.data.object && event.data.object.account) || null;
      if (accountId) await syncSellerFromAccount(accountId);
      break;
    }
    case 'application_fee.created':
    case 'balance.available':
      // Informational only; the ledger is the source of truth.
      break;
    default:
      console.log('[webhook] unhandled event type (acknowledged):', type);
  }
}

/**
 * Express route handler factory for a webhook endpoint.
 * Verifies the signature, enforces idempotency, dispatches, always answers.
 */
function webhookRoute(secret, source) {
  return async (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;
    try {
      // Static helper: signature verification needs only the endpoint
      // secret, not an API key, so webhooks verify even before keys exist.
      const Stripe = require('stripe');
      event = Stripe.webhooks.constructEvent(req.body, signature, secret);
    } catch (e) {
      console.warn(`[webhook:${source}] signature verification failed:`, e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }
    if (alreadyProcessed(event.id)) {
      return res.json({ received: true, duplicate: true });
    }
    try {
      await handleEvent(event, source);
      markProcessed(event.id, event.type, source);
    } catch (e) {
      console.error(`[webhook:${source}] handler error for ${event.type}:`, e);
      return res.status(500).send('Webhook handler error');
    }
    return res.json({ received: true });
  };
}

module.exports = { webhookRoute, handleEvent, alreadyProcessed, markProcessed };
