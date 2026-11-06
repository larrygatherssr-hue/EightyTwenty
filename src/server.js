'use strict';
/**
 * EightyTwenty — Node.js + Express + SQLite + Stripe.
 *
 * TEST MODE ONLY. See src/stripeClient.js: the process refuses live keys.
 *
 * Architecture (per STRIPE-SPEC.md):
 *  - Accounts v2, Express-equivalent sellers; destination charges with
 *    application_fee_amount = 20% of gross; subscriptions on the platform
 *    account with application_fee_percent: 20 and transfer_data[destination].
 *  - Webhooks are the only source of truth for "paid"; the app keeps its own
 *    immutable ledger (src/ledger.js).
 *  - Platform-owned listings keep 100%; the 80/20 split applies only to
 *    third-party sellers.
 */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
const { initStripe, getStripe, stripeConfigured } = require('./stripeClient');
const { chargeBreakdown, money, refundNetCents, calculateRevenueSplit } = require('./fees');
const { totals } = require('./ledger');
const views = require('./views');
const { webhookRoute } = require('./webhooks');
const { seed } = require('./seed');

initStripe();
seed();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

/* ------------------------------------------------------------------ */
/* Webhooks FIRST: raw body preserved byte-for-byte, before any parser */
/* ------------------------------------------------------------------ */
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!secret) return res.status(503).send('Webhook secret not configured (STRIPE_WEBHOOK_SECRET).');
    return webhookRoute(secret, 'platform')(req, res, next);
  },
);
app.post(
  '/webhooks/stripe-connect',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    const secret = (process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim();
    if (!secret) return res.status(503).send('Webhook secret not configured (STRIPE_CONNECT_WEBHOOK_SECRET).');
    return webhookRoute(secret, 'connect')(req, res, next);
  },
);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* ------------------------- sessions ------------------------- */
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function createSession(res, role, sellerId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, role, seller_id) VALUES (?, ?, ?)')
    .run(token, role, sellerId);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000, path: '/' });
  return token;
}

function getSession(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) || null;
}

function destroySession(req, res) {
  const token = parseCookies(req).session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('session', { path: '/' });
}

function requireSeller(req, res, next) {
  const sess = getSession(req);
  if (!sess || sess.role !== 'seller' || !sess.seller_id) return res.redirect('/seller/login');
  const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(sess.seller_id);
  if (!seller) return res.redirect('/seller/login');
  req.seller = seller;
  return next();
}

function requireAdmin(req, res, next) {
  const sess = getSession(req);
  if (!sess || sess.role !== 'admin') return res.redirect('/admin/login');
  return next();
}

function stripeOrError(res) {
  if (!stripeConfigured()) {
    res.status(503).send(views.messagePage('Stripe not configured',
      `<p>This step needs Stripe test mode. Set <code>STRIPE_SECRET_KEY</code> (sk_test_...) in <code>.env</code> and restart the server.</p><p><a href="/">← Back to the marketplace</a></p>`));
    return null;
  }
  return getStripe();
}

/* ------------------------- public ------------------------- */
app.get('/health', (req, res) => res.json({ ok: true, stripe: stripeConfigured(), mode: 'test' }));

app.get('/', (req, res) => {
  const listings = db.prepare("SELECT * FROM listings WHERE active = 1 ORDER BY owner DESC, id ASC").all();
  res.send(views.home(listings));
});

app.get('/listing/:id', (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).send(views.messagePage('Not found', '<p>That listing does not exist.</p><p><a href="/">← Back</a></p>'));
  const seller = listing.seller_id ? db.prepare('SELECT name FROM sellers WHERE id = ?').get(listing.seller_id) : null;
  res.send(views.listingDetail(listing, seller ? seller.name : null));
});

app.get('/terms', (req, res) => res.send(views.termsPage()));
app.get('/seller-agreement', (req, res) => res.send(views.sellerAgreementPage()));

/* ------------------------- checkout ------------------------- */
app.post('/checkout/:id', async (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND active = 1').get(req.params.id);
  if (!listing) return res.status(404).send('Listing not found.');
  if (listing.billing !== 'one_time') return res.redirect(`/listing/${listing.id}`);
  if (listing.external_url) return res.redirect(listing.external_url);
  const stripe = stripeOrError(res);
  if (!stripe) return;
  const seller = listing.seller_id ? db.prepare('SELECT * FROM sellers WHERE id = ?').get(listing.seller_id) : null;
  if (seller && !(seller.charges_enabled && seller.payouts_enabled)) {
    return res.status(403).send(views.messagePage('Seller not ready',
      '<p>This seller is still finishing Stripe onboarding, so checkout is paused until their account shows charges and payouts enabled.</p><p><a href="/">← Back</a></p>'));
  }
  const b = chargeBreakdown(listing.price_cents);
  const params = {
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: listing.title, description: listing.description.slice(0, 200) },
        unit_amount: listing.price_cents,
      },
      quantity: 1,
    }],
    success_url: `${BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/listing/${listing.id}`,
    metadata: { listing_id: String(listing.id), seller_id: listing.seller_id ? String(listing.seller_id) : '' },
  };
  if (seller) {
    // Destination charge: platform is merchant of record; 20% stays on the
    // platform balance as the application fee, 80% transfers to the seller.
    params.payment_intent_data = {
      application_fee_amount: b.platformFee,
      transfer_data: { destination: seller.stripe_account_id },
    };
  }
  try {
    const session = await stripe.checkout.sessions.create(params);
    return res.redirect(303, session.url);
  } catch (e) {
    console.error('[checkout] Stripe error:', e.message);
    return res.status(502).send(views.messagePage('Checkout failed', `<p>Stripe returned an error: ${views.esc(e.message)}</p><p><a href="/listing/${listing.id}">← Back</a></p>`));
  }
});

app.post('/subscribe/:id', async (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND active = 1').get(req.params.id);
  if (!listing) return res.status(404).send('Listing not found.');
  if (listing.billing === 'one_time') return res.redirect(`/listing/${listing.id}`);
  const stripe = stripeOrError(res);
  if (!stripe) return;
  const seller = listing.seller_id ? db.prepare('SELECT * FROM sellers WHERE id = ?').get(listing.seller_id) : null;
  if (seller && !(seller.charges_enabled && seller.payouts_enabled)) {
    return res.status(403).send(views.messagePage('Seller not ready',
      '<p>This seller is still finishing Stripe onboarding, so subscriptions are paused until their account shows charges and payouts enabled.</p><p><a href="/">← Back</a></p>'));
  }
  try {
    // Create (once) and cache a Stripe Price for this listing. Prices live on
    // the platform account; the subscription itself is created on the platform
    // account with transfer_data[destination] + application_fee_percent: 20.
    let priceId = listing.stripe_price_id;
    if (!priceId) {
      const price = await stripe.prices.create({
        currency: 'usd',
        unit_amount: listing.price_cents,
        recurring: { interval: listing.billing === 'monthly' ? 'month' : 'year' },
        product_data: { name: listing.title, description: listing.description.slice(0, 200) },
      });
      priceId = price.id;
      db.prepare('UPDATE listings SET stripe_price_id = ? WHERE id = ?').run(priceId, listing.id);
    }
    const params = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/listing/${listing.id}`,
      metadata: { listing_id: String(listing.id), seller_id: listing.seller_id ? String(listing.seller_id) : '' },
    };
    if (seller) {
      // Every renewal splits automatically: 20% application fee on each
      // invoice, 80% transferred to the seller.
      params.subscription_data = {
        application_fee_percent: 20,
        transfer_data: { destination: seller.stripe_account_id },
      };
    }
    const session = await stripe.checkout.sessions.create(params);
    return res.redirect(303, session.url);
  } catch (e) {
    console.error('[subscribe] Stripe error:', e.message);
    return res.status(502).send(views.messagePage('Subscription failed', `<p>Stripe returned an error: ${views.esc(e.message)}</p><p><a href="/listing/${listing.id}">← Back</a></p>`));
  }
});

app.get('/checkout/success', async (req, res) => {
  const sessionId = req.query.session_id;
  let detail = '';
  if (sessionId && stripeConfigured()) {
    try {
      const s = await getStripe().checkout.sessions.retrieve(sessionId);
      const order = s.payment_intent
        ? db.prepare('SELECT * FROM orders WHERE stripe_payment_intent_id = ?').get(
            typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id)
        : null;
      detail = `<p>Payment status: <strong>${views.esc(s.payment_status)}</strong>.</p>`
        + (order ? `<p>Order #${order.id} — ${views.esc(order.status)}.</p>` : '<p>Your order is being confirmed; the receipt is on its way.</p>');
    } catch (e) {
      detail = '<p>Your payment was submitted. If anything looks wrong, contact the marketplace.</p>';
    }
  }
  res.send(views.messagePage('Thank you', `${detail || '<p>Your payment was submitted.</p>'}<p><a href="/">← Back to the marketplace</a></p>`));
});

app.get('/checkout/cancelled', (req, res) => {
  res.send(views.messagePage('Checkout cancelled', '<p>No charge was made.</p><p><a href="/">← Back to the marketplace</a></p>'));
});

// Customer portal: the platform manages subscriptions (Express sellers cannot).
app.post('/portal', async (req, res) => {
  const email = (req.body.email || '').trim();
  const stripe = stripeOrError(res);
  if (!stripe) return;
  const sub = db.prepare('SELECT * FROM subscriptions WHERE buyer_email = ? AND stripe_customer_id IS NOT NULL ORDER BY id DESC').get(email);
  if (!sub) {
    return res.status(404).send(views.messagePage('No subscription found', '<p>No subscription was found for that email.</p><p><a href="/">← Back</a></p>'));
  }
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${BASE_URL}/`,
    });
    return res.redirect(303, portal.url);
  } catch (e) {
    console.error('[portal] Stripe error:', e.message);
    return res.status(502).send(views.messagePage('Portal unavailable', `<p>Stripe returned an error: ${views.esc(e.message)}</p>`));
  }
});

/* ------------------------- seller onboarding ------------------------- */
app.get('/sell', (req, res) => res.send(views.sellForm(null)));

app.post('/sell', async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  if (!name || !email || !req.body.agree) {
    return res.status(400).send(views.sellForm('Name, email and agreement to the seller agreement are all required.'));
  }
  const stripe = stripeOrError(res);
  if (!stripe) return;
  let seller = db.prepare('SELECT * FROM sellers WHERE email = ?').get(email);
  if (!seller) {
    const token = crypto.randomBytes(16).toString('hex');
    const info = db.prepare('INSERT INTO sellers (name, email, dashboard_token, status) VALUES (?, ?, ?, ?)')
      .run(name, email, token, 'onboarding');
    seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(Number(info.lastInsertRowid));
  }
  try {
    // Accounts v2, Express-equivalent shape (per STRIPE-SPEC.md §1–2):
    // dashboard express; fees + losses collected by the application; the
    // seller requests BOTH merchant (card_payments) and recipient
    // (stripe_balance.stripe_transfers) capabilities together — requesting
    // the transfers-only recipient capability alone fails.
    let accountId = seller.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        country: 'US',
        email: seller.email,
        controller: {
          stripe_dashboard: { type: 'express' },
          fees: { payer: 'application' },
          losses: { payments: 'application' },
          requirement_collection: 'stripe',
        },
        capabilities: {
          card_payments: { requested: true },
          'stripe_balance.stripe_transfers': { requested: true },
        },
      });
      accountId = account.id;
      db.prepare('UPDATE sellers SET stripe_account_id = ? WHERE id = ?').run(accountId, seller.id);
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${BASE_URL}/sell/refresh?seller=${seller.id}`,
      return_url: `${BASE_URL}/sell/return?seller=${seller.id}`,
      type: 'account_onboarding',
    });
    return res.redirect(303, link.url);
  } catch (e) {
    console.error('[onboarding] Stripe error:', e.message);
    return res.status(502).send(views.messagePage('Onboarding failed', `<p>Stripe returned an error: ${views.esc(e.message)}</p><p><a href="/sell">← Try again</a></p>`));
  }
});

app.get('/sell/refresh', async (req, res) => {
  const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(req.query.seller);
  if (!seller || !seller.stripe_account_id) return res.redirect('/sell');
  const stripe = stripeOrError(res);
  if (!stripe) return;
  try {
    const link = await stripe.accountLinks.create({
      account: seller.stripe_account_id,
      refresh_url: `${BASE_URL}/sell/refresh?seller=${seller.id}`,
      return_url: `${BASE_URL}/sell/return?seller=${seller.id}`,
      type: 'account_onboarding',
    });
    return res.redirect(303, link.url);
  } catch (e) {
    return res.status(502).send(views.messagePage('Could not resume onboarding', `<p>${views.esc(e.message)}</p>`));
  }
});

app.get('/sell/resume/:id', async (req, res) => {
  const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(req.params.id);
  if (!seller || !seller.stripe_account_id) return res.redirect('/sell');
  const stripe = stripeOrError(res);
  if (!stripe) return;
  try {
    const link = await stripe.accountLinks.create({
      account: seller.stripe_account_id,
      refresh_url: `${BASE_URL}/sell/refresh?seller=${seller.id}`,
      return_url: `${BASE_URL}/sell/return?seller=${seller.id}`,
      type: 'account_onboarding',
    });
    return res.redirect(303, link.url);
  } catch (e) {
    return res.status(502).send(views.messagePage('Could not resume onboarding', `<p>${views.esc(e.message)}</p>`));
  }
});

app.get('/sell/return', async (req, res) => {
  const seller = db.prepare('SELECT * FROM sellers WHERE id = ?').get(req.query.seller);
  if (!seller) return res.redirect('/sell');
  // Refresh capability flags from Stripe right now (webhooks also sync them).
  if (stripeConfigured() && seller.stripe_account_id) {
    try {
      const acct = await getStripe().accounts.retrieve(seller.stripe_account_id);
      db.prepare('UPDATE sellers SET charges_enabled = ?, payouts_enabled = ?, status = ? WHERE id = ?')
        .run(acct.charges_enabled ? 1 : 0, acct.payouts_enabled ? 1 : 0,
          acct.charges_enabled && acct.payouts_enabled ? 'active' : 'onboarding', seller.id);
    } catch (e) {
      console.warn('[onboarding return] could not retrieve account:', e.message);
    }
  }
  const fresh = db.prepare('SELECT * FROM sellers WHERE id = ?').get(seller.id);
  const ready = fresh.charges_enabled && fresh.payouts_enabled;
  res.send(views.messagePage('Onboarding complete',
    `<p>Welcome aboard, ${views.esc(fresh.name)}.</p>
     <p>${ready
      ? '<strong>Your account is active.</strong> Charges and payouts are enabled — you can create listings now.'
      : 'Stripe is still reviewing your account. Charging and payouts stay gated until Stripe confirms them (the <code>account.updated</code> webhook updates this automatically).'}</p>
     <p><strong>Your seller dashboard token (save it — it is shown once):</strong> <code>${views.esc(fresh.dashboard_token)}</code></p>
     <p>Sign in at <a href="/seller/login">/seller/login</a> with your email and this token.</p>`));
});

/* ------------------------- seller area ------------------------- */
app.get('/seller/login', (req, res) => res.send(views.sellerLogin(null)));

app.post('/seller/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const token = (req.body.token || '').trim();
  const seller = db.prepare('SELECT * FROM sellers WHERE email = ? AND dashboard_token = ?').get(email, token);
  if (!seller) return res.status(401).send(views.sellerLogin('Email or token did not match.'));
  createSession(res, 'seller', seller.id);
  return res.redirect('/seller/dashboard');
});

app.get('/seller/logout', (req, res) => { destroySession(req, res); return res.redirect('/'); });

app.get('/seller/dashboard', requireSeller, (req, res) => {
  const seller = req.seller;
  const sums = totals(seller.id);
  const sales = db.prepare(`SELECT o.*, l.title FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
    WHERE o.seller_id = ? ORDER BY o.id DESC LIMIT 50`).all(seller.id);
  const subs = db.prepare('SELECT * FROM subscriptions WHERE seller_id = ? ORDER BY id DESC LIMIT 50').all(seller.id);
  const disputesList = db.prepare(`SELECT d.* FROM disputes d JOIN orders o ON o.id = d.order_id
    WHERE o.seller_id = ? ORDER BY d.id DESC LIMIT 50`).all(seller.id);
  const refundsList = db.prepare(`SELECT r.* FROM refunds r JOIN orders o ON o.id = r.order_id
    WHERE o.seller_id = ? ORDER BY r.id DESC LIMIT 50`).all(seller.id);
  const listings = db.prepare('SELECT * FROM listings WHERE seller_id = ? ORDER BY id DESC').all(seller.id);
  res.send(views.sellerDashboard(seller, sums, sales, subs, disputesList, refundsList, listings));
});

app.get('/seller/listings/new', requireSeller, (req, res) => res.send(views.listingForm(req.seller, null, null)));

app.post('/seller/listings/new', requireSeller, (req, res) => {
  const priceCents = Math.round(Number(req.body.price || 0) * 100);
  if (!req.body.title || !req.body.description || !Number.isInteger(priceCents) || priceCents < 50) {
    return res.status(400).send(views.listingForm(req.seller, null, 'Title, description and a price of at least $0.50 are required.'));
  }
  const info = db.prepare(`INSERT INTO listings
    (seller_id, owner, title, description, price_cents, billing, delivery_note, active)
    VALUES (?, 'seller', ?, ?, ?, ?, ?, ?)`)
    .run(req.seller.id, req.body.title.trim(), req.body.description.trim(), priceCents,
      ['one_time', 'monthly', 'annual'].includes(req.body.billing) ? req.body.billing : 'one_time',
      (req.body.delivery_note || '').trim(), req.body.active ? 1 : 0);
  return res.redirect(`/listing/${Number(info.lastInsertRowid)}`);
});

app.get('/seller/listings/:id/edit', requireSeller, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND seller_id = ?').get(req.params.id, req.seller.id);
  if (!listing) return res.status(404).send('Listing not found.');
  res.send(views.listingForm(req.seller, listing, null));
});

app.post('/seller/listings/:id/edit', requireSeller, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND seller_id = ?').get(req.params.id, req.seller.id);
  if (!listing) return res.status(404).send('Listing not found.');
  const priceCents = Math.round(Number(req.body.price || 0) * 100);
  if (!req.body.title || !req.body.description || !Number.isInteger(priceCents) || priceCents < 50) {
    return res.status(400).send(views.listingForm(req.seller, listing, 'Title, description and a price of at least $0.50 are required.'));
  }
  // Price changes create a NEW Stripe Price on the next subscription checkout;
  // existing subscriptions keep their original price.
  db.prepare(`UPDATE listings SET title = ?, description = ?, price_cents = ?, billing = ?,
    delivery_note = ?, active = ?, stripe_price_id = CASE WHEN price_cents != ? OR billing != ? THEN NULL ELSE stripe_price_id END
    WHERE id = ?`)
    .run(req.body.title.trim(), req.body.description.trim(), priceCents,
      ['one_time', 'monthly', 'annual'].includes(req.body.billing) ? req.body.billing : 'one_time',
      (req.body.delivery_note || '').trim(), req.body.active ? 1 : 0,
      priceCents, req.body.billing, listing.id);
  return res.redirect(`/listing/${listing.id}`);
});

/* ------------------------- owner admin ------------------------- */
app.get('/admin/login', (req, res) => res.send(views.adminLogin(null)));

app.post('/admin/login', (req, res) => {
  const configured = (process.env.ADMIN_PASSWORD || '').trim();
  if (!configured) {
    return res.status(500).send(views.adminLogin('ADMIN_PASSWORD is not set in .env — the owner dashboard is disabled until it is.'));
  }
  const given = Buffer.from(req.body.password || '');
  const expected = Buffer.from(configured);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return res.status(401).send(views.adminLogin('Wrong password.'));
  createSession(res, 'admin');
  return res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => { destroySession(req, res); return res.redirect('/'); });

app.get('/admin', requireAdmin, (req, res) => {
  const sums = totals(null);
  const sellers = db.prepare('SELECT * FROM sellers ORDER BY id DESC').all();
  const recent = db.prepare('SELECT * FROM ledger_entries ORDER BY id DESC LIMIT 50').all();
  const statements = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS period,
      COALESCE(SUM(gross_cents),0) AS gross,
      COALESCE(SUM(platform_fee_cents),0) AS platformFees,
      COALESCE(SUM(seller_share_cents),0) AS sellerShare,
      COALESCE(SUM(platform_net_cents),0) AS platformNet
    FROM ledger_entries GROUP BY period ORDER BY period DESC LIMIT 12`).all();
  const recurring = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN l.billing = 'monthly' THEN l.price_cents
      WHEN l.billing = 'annual' THEN l.price_cents / 12 ELSE 0 END), 0) AS mrr
    FROM subscriptions s JOIN listings l ON l.id = s.listing_id
    WHERE s.status = 'active'`).get().mrr;
  res.send(views.adminDashboard(sums, sellers, recent, statements, recurring));
});

app.get('/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare(`SELECT o.*, l.title FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
    ORDER BY o.id DESC LIMIT 200`).all();
  res.send(views.adminOrders(orders));
});

app.get('/admin/refunds', requireAdmin, (req, res) => {
  const orders = db.prepare(`SELECT o.*, l.title FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
    WHERE o.status IN ('paid','partially_refunded') ORDER BY o.id DESC`).all();
  res.send(views.adminRefunds(orders, null, null));
});

app.post('/admin/refunds', requireAdmin, async (req, res) => {
  const orders = db.prepare(`SELECT o.*, l.title FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
    WHERE o.status IN ('paid','partially_refunded') ORDER BY o.id DESC`).all();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.body.order_id);
  if (!order || !order.stripe_payment_intent_id) {
    return res.status(400).send(views.adminRefunds(orders, 'Pick a paid order with a Stripe payment intent.', null));
  }
  const stripe = stripeOrError(res);
  if (!stripe) return;
  try {
    // Policy (seller agreement §5): full refund, reverse_transfer: true,
    // refund_application_fee: false. The seller eats the refund; the
    // platform keeps its commission; Stripe keeps the processing fee.
    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      reverse_transfer: true,
      refund_application_fee: false,
    });
    const sale = db.prepare(
      "SELECT * FROM ledger_entries WHERE order_id = ? AND kind IN ('sale','renewal') ORDER BY id ASC LIMIT 1"
    ).get(order.id);
    const gross = sale ? sale.gross_cents : order.amount_cents;
    const platformNetAfter = refundNetCents({
      grossCents: gross,
      sellerShareCents: sale ? sale.seller_share_cents : calculateRevenueSplit(gross).sellerEarnings,
      platformFeeCents: sale ? sale.platform_fee_cents : calculateRevenueSplit(gross).platformFee,
      processingFeeCents: sale ? sale.processing_fee_cents : 0,
    });
    db.prepare(`INSERT INTO refunds (order_id, stripe_refund_id, amount_cents, reverse_transfer,
      refund_application_fee, platform_net_after_cents, reason) VALUES (?, ?, ?, 1, 0, ?, ?)`)
      .run(order.id, refund.id, refund.amount, platformNetAfter, (req.body.reason || '').trim());
    const done = `Refund ${refund.id} issued for order #${order.id} (${money(refund.amount)}). Platform net on this order after the refund: ${money(platformNetAfter)} (processing fee not returned by Stripe). The charge.refunded webhook will record the ledger entry.`;
    return res.send(views.adminRefunds(orders, null, done));
  } catch (e) {
    console.error('[refund] Stripe error:', e.message);
    return res.status(502).send(views.adminRefunds(orders, `Stripe returned an error: ${e.message}`, null));
  }
});

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/admin/export/revenue.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM ledger_entries ORDER BY id ASC').all();
  const head = 'id,event_id,order_id,seller_id,kind,gross_cents,processing_fee_cents,platform_fee_cents,seller_share_cents,platform_net_cents,currency,description,created_at';
  const body = rows.map((r) => [r.id, r.event_id, r.order_id, r.seller_id, r.kind, r.gross_cents,
    r.processing_fee_cents, r.platform_fee_cents, r.seller_share_cents, r.platform_net_cents,
    r.currency, r.description, r.created_at].map(csvCell).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="revenue.csv"');
  res.send(`${head}\n${body}\n`);
});

app.get('/admin/export/sellers.csv', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.email, s.stripe_account_id, s.status,
      COALESCE(SUM(e.gross_cents),0) AS gross,
      COALESCE(SUM(e.seller_share_cents),0) AS seller_share,
      COALESCE(SUM(e.platform_fee_cents),0) AS platform_fees,
      COUNT(DISTINCT o.id) AS orders
    FROM sellers s
    LEFT JOIN ledger_entries e ON e.seller_id = s.id
    LEFT JOIN orders o ON o.seller_id = s.id
    GROUP BY s.id ORDER BY s.id ASC`).all();
  const head = 'seller_id,name,email,stripe_account_id,status,gross_cents,seller_share_cents,platform_fees_cents,orders';
  const body = rows.map((r) => [r.id, r.name, r.email, r.stripe_account_id, r.status, r.gross,
    r.seller_share, r.platform_fees, r.orders].map(csvCell).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sellers.csv"');
  res.send(`${head}\n${body}\n`);
});

/* ------------------------- 404 / errors ------------------------- */
app.use((req, res) => res.status(404).send(views.messagePage('Page not found', '<p><a href="/">← Back to the marketplace</a></p>')));

app.use((err, req, res, _next) => {
  console.error('[server] error:', err);
  res.status(500).send(views.messagePage('Something went wrong', '<p>The error was logged. <a href="/">← Back to the marketplace</a></p>'));
});

app.listen(PORT, () => {
  console.log(`EightyTwenty listening on port ${PORT} (BASE_URL=${BASE_URL})`);
  console.log(`Stripe: ${stripeConfigured() ? 'test mode configured' : 'NOT configured — set sk_test_ keys in .env'}`);
});
