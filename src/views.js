'use strict';
/**
 * Server-rendered HTML views. Plain templates, no framework.
 * Every price shown to a customer is the FULL price before checkout, and
 * every third-party listing discloses the 80/20 split and the fee math.
 */
const { money, chargeBreakdown } = require('./fees');
const { stripeMode } = require('./stripeClient');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function layout(title, body, { nav = true } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — EightyTwenty</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:960px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5}
a{color:#0b5fff}.card{border:1px solid #ddd;border-radius:10px;padding:16px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.muted{color:#666;font-size:.9em}.fee{background:#f6f8ff;border:1px solid #dbe4ff;border-radius:8px;padding:12px;margin:12px 0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:.92em}
th{background:#f5f5f5}input,select,textarea{width:100%;padding:10px;margin:6px 0 12px;border:1px solid #ccc;border-radius:6px;font-size:1em}
button{background:#0b5fff;color:#fff;border:0;border-radius:6px;padding:12px 20px;font-size:1em;cursor:pointer}
button.secondary{background:#eee;color:#222}.danger{background:#c0392b}
nav{margin-bottom:20px;font-size:.95em}nav a{margin-right:14px}
.stat{display:inline-block;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:6px 12px 6px 0}
.stat b{font-size:1.3em;display:block}.warn{background:#fff7e6;border:1px solid #f0c36d;border-radius:8px;padding:12px;margin:12px 0}
</style></head><body>
${nav ? `<nav><a href="/">Marketplace</a><a href="/sell">Sell on the marketplace</a><a href="/seller/login">Seller dashboard</a><a href="/admin">Owner dashboard</a><a href="/terms">Terms</a><a href="/seller-agreement">Seller agreement</a></nav>` : ''}
<h1>${esc(title)}</h1>
${body}
<footer class="muted"><hr><p>EightyTwenty — sellers keep 80% of eligible sales; the platform keeps 20%. Payments processed by Stripe. ${stripeMode() === 'live' ? 'Live mode.' : 'Test mode.'}</p></footer>
</body></html>`;
}

function splitBox(listing) {
  if (listing.owner === 'platform') {
    return `<div class="fee"><strong>Platform listing.</strong> This product is sold directly by the marketplace, so the 80/20 seller split does not apply — the platform keeps 100% of this sale.</div>`;
  }
  const b = chargeBreakdown(listing.price_cents, { billing: listing.billing !== 'one_time' });
  const per = listing.billing === 'one_time' ? 'one-time' : `per ${listing.billing === 'monthly' ? 'month' : 'year'}`;
  return `<div class="fee"><strong>How the money splits on this ${per} ${money(listing.price_cents)} purchase:</strong>
  <ul>
    <li>You pay: <strong>${money(listing.price_cents)}</strong> (full price, shown before checkout)</li>
    <li>Seller receives: <strong>${money(b.sellerEarnings)}</strong> (80%)</li>
    <li>Platform commission: <strong>${money(b.platformFee)}</strong> (20%)</li>
    <li>Stripe card processing (paid by the platform out of its 20%): about ${money(b.processingFee)} — the platform's net is about ${money(b.platformNet)}</li>
  </ul><p class="muted">The seller never sees your card details. Payments are processed by Stripe. Refunds follow the marketplace refund policy in the <a href="/seller-agreement">seller agreement</a>.</p></div>`;
}

function home(listings) {
  const cards = listings.map((l) => `
    <div class="card">
      <h3><a href="/listing/${l.id}">${esc(l.title)}</a></h3>
      <p>${esc(l.description.slice(0, 160))}${l.description.length > 160 ? '…' : ''}</p>
      <p><strong>${money(l.price_cents)}</strong> ${l.billing === 'one_time' ? 'one-time' : `per ${l.billing === 'monthly' ? 'month' : 'year'}`}</p>
      <p class="muted">${l.owner === 'platform' ? 'Sold by the marketplace' : 'Sold by an independent seller — 80/20 split'}</p>
      <p><a href="/listing/${l.id}">View product</a></p>
    </div>`).join('');
  return layout('Marketplace', `
    <p><img src="/hero.jpg" alt="EightyTwenty — Premium Digital Products Marketplace: Learn, Invest, Grow, Thrive" style="width:100%;height:auto;border-radius:10px;display:block"></p>
    <p>Digital products from independent sellers. <strong>Sellers keep 80% of every eligible sale. The platform keeps 20%.</strong> That split applies to first purchases, repeat purchases, subscriptions and every renewal.</p>
    <div class="grid">${cards || '<p>No listings yet.</p>'}</div>
    <p><a href="/sell">Sell your digital product here</a> — onboarding takes a few minutes with Stripe.</p>`);
}

function listingDetail(l, sellerName) {
  const isSub = l.billing !== 'one_time';
  const action = l.external_url
    ? `<p><a href="${esc(l.external_url)}" target="_blank" rel="noopener"><button>Buy on Gumroad — ${money(l.price_cents)}</button></a></p><p class="muted">This platform listing currently checks out on Gumroad. Marketplace checkout for platform listings is coming with fulfilment.</p>`
    : (isSub
      ? `<form method="post" action="/subscribe/${l.id}"><button type="submit">Subscribe — ${money(l.price_cents)} per ${l.billing === 'monthly' ? 'month' : 'year'}</button></form>`
      : `<form method="post" action="/checkout/${l.id}"><button type="submit">Buy now — ${money(l.price_cents)}</button></form>`);
  return layout(l.title, `
    <p class="muted">${l.owner === 'platform' ? 'Sold by the marketplace' : `Sold by ${esc(sellerName || 'an independent seller')}`}</p>
    <p>${esc(l.description)}</p>
    <p><strong>Price: ${money(l.price_cents)}</strong> ${isSub ? `per ${l.billing === 'monthly' ? 'month' : 'year'}, renewing automatically until cancelled` : 'one-time'}</p>
    ${l.delivery_note ? `<p><strong>Delivery:</strong> ${esc(l.delivery_note)}</p>` : ''}
    ${splitBox(l)}
    ${action}
    <p><a href="/">← Back to all products</a></p>`);
}

function sellForm(error) {
  return layout('Sell on the marketplace', `
    <p>Onboard as a seller in a few minutes. Stripe collects your identity, tax and bank details in its own hosted flow — this marketplace never sees them.</p>
    <p><strong>Your earnings:</strong> you keep 80% of every eligible sale, including subscription renewals. The platform keeps 20%. Stripe card processing (2.9% + $0.30) is paid by the platform out of its 20%.</p>
    <p><strong>Before you start:</strong> read the <a href="/seller-agreement">seller agreement</a>. Adult content and the restricted categories listed there are banned — a violation can close the platform's Stripe account.</p>
    ${error ? `<div class="warn">${esc(error)}</div>` : ''}
    <form method="post" action="/sell">
      <label>Your name (or business name)<input name="name" required></label>
      <label>Email<input type="email" name="email" required></label>
      <label><input type="checkbox" name="agree" value="1" required style="width:auto"> I have read and agree to the <a href="/seller-agreement">seller agreement</a>, including the adult-content ban.</label>
      <button type="submit">Start onboarding with Stripe</button>
    </form>`);
}

function sellerLogin(error) {
  return layout('Seller sign in', `
    <p>Sign in with the email you onboarded with and your dashboard token (shown once after onboarding).</p>
    ${error ? `<div class="warn">${esc(error)}</div>` : ''}
    <form method="post" action="/seller/login">
      <label>Email<input type="email" name="email" required></label>
      <label>Dashboard token<input name="token" required></label>
      <button type="submit">Sign in</button>
    </form>`);
}

function sellerDashboard(seller, sums, sales, subs, disputesList, refundsList, listings) {
  const gate = seller.transfers_status === 'active'
    ? '<p><strong>Account status: active.</strong> Your Stripe transfers capability is active — you can sell.</p>'
    : `<div class="warn"><strong>Account status: onboarding incomplete.</strong> Charging and payouts are gated until your Stripe transfers capability is active (currently: ${esc(seller.transfers_status || 'pending')}). <a href="/sell/resume/${seller.id}">Resume onboarding</a></div>`;
  const rows = sales.map((o) => `<tr><td>${o.id}</td><td>${esc(o.title || '')}</td><td>${money(o.amount_cents)}</td><td>${esc(o.status)}</td><td>${esc(o.created_at)}</td></tr>`).join('');
  const subRows = subs.map((s) => `<tr><td>${esc(s.stripe_subscription_id)}</td><td>${esc(s.buyer_email || '')}</td><td>${esc(s.status)}</td><td>${esc(s.current_period_end || '')}</td></tr>`).join('');
  const dispRows = disputesList.map((d) => `<tr><td>${esc(d.stripe_dispute_id)}</td><td>${money(d.amount_cents)}</td><td>${money(d.fee_cents)}</td><td>${esc(d.status)}</td><td>${esc(d.reason || '')}</td></tr>`).join('');
  const refRows = refundsList.map((r) => `<tr><td>${r.id}</td><td>${money(r.amount_cents)}</td><td>${r.platform_net_after_cents != null ? money(r.platform_net_after_cents) : '—'}</td><td>${esc(r.created_at)}</td></tr>`).join('');
  const listRows = listings.map((l) => `<tr><td>${esc(l.title)}</td><td>${money(l.price_cents)}</td><td>${esc(l.billing)}</td><td>${l.active ? 'Active' : 'Paused'}</td><td><a href="/seller/listings/${l.id}/edit">Edit</a></td></tr>`).join('');
  return layout(`Seller dashboard — ${seller.name}`, `
    ${gate}
    <p class="muted">Stripe account: ${esc(seller.stripe_account_id || 'not created yet')}</p>
    <div>
      <span class="stat">Gross sales<b>${money(sums.gross)}</b></span>
      <span class="stat">Your share (80%)<b>${money(sums.sellerShare)}</b></span>
      <span class="stat">Platform fees (20%)<b>${money(sums.platformFees)}</b></span>
      <span class="stat">Refunds / disputes<b>${money(sums.gross - sums.sellerShare - sums.platformFees)}</b></span>
    </div>
    <h2>Your listings</h2>
    <p><a href="/seller/listings/new"><button>New listing</button></a></p>
    <table><tr><th>Title</th><th>Price</th><th>Billing</th><th>Status</th><th></th></tr>${listRows || '<tr><td colspan="5">No listings yet.</td></tr>'}</table>
    <h2>Recent sales</h2>
    <table><tr><th>Order</th><th>Product</th><th>Amount</th><th>Status</th><th>Date</th></tr>${rows || '<tr><td colspan="5">No sales yet.</td></tr>'}</table>
    <h2>Subscriptions</h2>
    <table><tr><th>Subscription</th><th>Customer</th><th>Status</th><th>Period ends</th></tr>${subRows || '<tr><td colspan="4">No subscriptions yet.</td></tr>'}</table>
    <h2>Refunds</h2>
    <table><tr><th>Refund</th><th>Amount</th><th>Platform net after refund</th><th>Date</th></tr>${refRows || '<tr><td colspan="4">No refunds.</td></tr>'}</table>
    <h2>Disputes</h2>
    <table><tr><th>Dispute</th><th>Amount</th><th>Fees</th><th>Status</th><th>Reason</th></tr>${dispRows || '<tr><td colspan="5">No disputes.</td></tr>'}</table>
    <p><a href="/seller/logout">Sign out</a></p>`);
}

function listingForm(seller, listing, error) {
  const l = listing || { title: '', description: '', price_cents: '', billing: 'one_time', delivery_note: '', active: 1 };
  const priceDollars = l.price_cents === '' ? '' : (l.price_cents / 100).toFixed(2);
  return layout(listing ? 'Edit listing' : 'New listing', `
    ${error ? `<div class="warn">${esc(error)}</div>` : ''}
    <form method="post" action="${listing ? `/seller/listings/${listing.id}/edit` : '/seller/listings/new'}">
      <label>Title<input name="title" value="${esc(l.title)}" required></label>
      <label>Description<textarea name="description" rows="4" required>${esc(l.description)}</textarea></label>
      <label>Price (USD)<input name="price" type="number" step="0.01" min="0.50" value="${esc(priceDollars)}" required></label>
      <label>Billing<select name="billing">
        <option value="one_time" ${l.billing === 'one_time' ? 'selected' : ''}>One-time purchase</option>
        <option value="monthly" ${l.billing === 'monthly' ? 'selected' : ''}>Monthly subscription</option>
        <option value="annual" ${l.billing === 'annual' ? 'selected' : ''}>Annual subscription</option>
      </select></label>
      <label>Delivery note (how the buyer gets the product)<input name="delivery_note" value="${esc(l.delivery_note)}"></label>
      <label><input type="checkbox" name="active" value="1" ${l.active ? 'checked' : ''} style="width:auto"> Active (visible in the marketplace)</label>
      <button type="submit">${listing ? 'Save changes' : 'Create listing'}</button>
    </form>
    <p class="muted">The 80/20 split applies automatically at checkout. Subscriptions split 20% to the platform on every renewal. The platform manages subscriptions (cancellations, plan changes) — sellers on Express cannot.</p>`);
}

function adminLogin(error) {
  return layout('Owner sign in', `
    ${error ? `<div class="warn">${esc(error)}</div>` : ''}
    <form method="post" action="/admin/login">
      <label>Admin password<input type="password" name="password" required></label>
      <button type="submit">Sign in</button>
    </form>`);
}

function adminDashboard(sums, sellers, recent, statements, recurring) {
  const sellerRows = sellers.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.email)}</td><td>${s.transfers_status === 'active' ? 'Active' : `Onboarding (${esc(s.transfers_status || 'pending')})`}</td><td>${esc(s.stripe_account_id || '—')}</td></tr>`).join('');
  const recentRows = recent.map((e) => `<tr><td>${e.id}</td><td>${esc(e.kind)}</td><td>${money(e.gross_cents)}</td><td>${money(e.platform_fee_cents)}</td><td>${money(e.seller_share_cents)}</td><td>${money(e.platform_net_cents)}</td><td>${esc(e.created_at)}</td></tr>`).join('');
  const stmtRows = statements.map((s) => `<tr><td>${esc(s.period)}</td><td>${money(s.gross)}</td><td>${money(s.platformFees)}</td><td>${money(s.sellerShare)}</td><td>${money(s.platformNet)}</td></tr>`).join('');
  return layout('Owner dashboard', `
    <div>
      <span class="stat">Gross volume<b>${money(sums.gross)}</b></span>
      <span class="stat">Commission (20%)<b>${money(sums.platformFees)}</b></span>
      <span class="stat">Platform net (after Stripe processing)<b>${money(sums.platformNet)}</b></span>
      <span class="stat">Paid to sellers (80%)<b>${money(sums.sellerShare)}</b></span>
      <span class="stat">Recurring revenue / mo<b>${money(recurring)}</b></span>
    </div>
    <h2>Monthly statements</h2>
    <table><tr><th>Period</th><th>Gross</th><th>Commission</th><th>Seller share</th><th>Platform net</th></tr>${stmtRows || '<tr><td colspan="5">No activity yet.</td></tr>'}</table>
    <p><a href="/admin/export/revenue.csv">Download full revenue CSV</a> · <a href="/admin/export/sellers.csv">Download seller performance CSV</a></p>
    <h2>Sellers</h2>
    <table><tr><th>Name</th><th>Email</th><th>Status</th><th>Stripe account</th></tr>${sellerRows || '<tr><td colspan="4">No sellers yet.</td></tr>'}</table>
    <h2>Recent ledger entries</h2>
    <table><tr><th>#</th><th>Kind</th><th>Gross</th><th>Commission</th><th>Seller share</th><th>Platform net</th><th>Date</th></tr>${recentRows || '<tr><td colspan="7">No entries yet.</td></tr>'}</table>
    <p><a href="/admin/refunds">Issue a refund</a> · <a href="/admin/orders">All orders</a> · <a href="/admin/logout">Sign out</a></p>`);
}

function adminOrders(orders) {
  const rows = orders.map((o) => `<tr><td>${o.id}</td><td>${esc(o.title || '')}</td><td>${esc(o.buyer_email || '')}</td><td>${money(o.amount_cents)}</td><td>${esc(o.type)}</td><td>${esc(o.status)}</td><td>${esc(o.created_at)}</td></tr>`).join('');
  return layout('All orders', `<table><tr><th>Order</th><th>Product</th><th>Buyer</th><th>Amount</th><th>Type</th><th>Status</th><th>Date</th></tr>${rows || '<tr><td colspan="7">No orders yet.</td></tr>'}</table><p><a href="/admin">← Owner dashboard</a></p>`);
}

function adminRefunds(orders, error, done) {
  const opts = orders.map((o) => `<option value="${o.id}">Order #${o.id} — ${esc(o.title || '')} — ${money(o.amount_cents)} (${esc(o.status)})</option>`).join('');
  return layout('Issue a refund', `
    <p><strong>Refund policy (from the seller agreement):</strong> full refund, <code>reverse_transfer: true</code>, <code>refund_application_fee: false</code>. The seller's share is pulled back, the platform keeps its 20% commission, and Stripe does not return the card-processing fee — so a refunded order costs the platform the processing fee (for example, −$3.20 on a refunded $100 sale).</p>
    ${error ? `<div class="warn">${esc(error)}</div>` : ''}
    ${done ? `<div class="fee">${esc(done)}</div>` : ''}
    <form method="post" action="/admin/refunds">
      <label>Order<select name="order_id">${opts || '<option value="">No paid orders yet</option>'}</select></label>
      <label>Reason<input name="reason" placeholder="e.g. customer request"></label>
      <button type="submit" class="danger">Issue full refund</button>
    </form>
    <p><a href="/admin">← Owner dashboard</a></p>`);
}

function termsPage() {
  return layout('Terms of Service', `
    <h2>1. The marketplace</h2>
    <p>EightyTwenty is an online marketplace for digital products. Independent sellers list products; customers buy them; the platform operates the marketplace and processes payments through Stripe.</p>
    <h2>2. The 80/20 split</h2>
    <p>On every eligible transaction the seller receives 80% and the platform receives a 20% commission. This applies to initial purchases, repeat purchases, monthly and annual subscriptions, subscription renewals, and eligible add-on purchases.</p>
    <h2>3. Prices and fees</h2>
    <p>Customers always see the full price before checkout. The split and the platform's commission are disclosed on every listing page. Stripe card-processing fees (2.9% + $0.30 per successful US card charge, plus 0.7% per subscription invoice) are paid by the platform out of its 20% commission — they are not added to the price shown to the customer.</p>
    <h2>4. Payments</h2>
    <p>Payments are processed by Stripe, Inc. Sellers contract with Stripe for payment processing services. The platform is the merchant of record for sales made through this marketplace and is responsible for sales-tax collection and remittance where required.</p>
    <h2>5. Subscriptions</h2>
    <p>Subscriptions renew automatically at the listed price and interval until cancelled. The platform manages subscriptions (cancellation, plan changes) on behalf of sellers. Renewals split 80/20 on every successful payment — a renewal is only counted as paid when Stripe confirms payment succeeded.</p>
    <h2>6. Refunds</h2>
    <p>Refund requests are handled by the platform. Approved refunds return the full purchase price to the customer; the seller's share is pulled back and the platform keeps its commission (see the seller agreement for the exact policy).</p>
    <h2>7. Prohibited products</h2>
    <p>Adult content and services, including AI-generated adult content, are prohibited. So are CBD, dating services, cryptocurrency products, crowdfunding campaigns, and any product Stripe's prohibited-businesses list forbids. Listings are moderated; violations can remove the seller and the listing.</p>
    <h2>8. Disputes</h2>
    <p>Chargebacks are handled through Stripe's dispute process. Dispute fees charged by Stripe are visible to the affected seller in their dashboard.</p>
    <h2>9. Changes</h2>
    <p>These terms may change; the version in force at the time of a transaction applies to that transaction.</p>
    <p class="muted">This is a working product's terms page, not legal advice. Get a legal review before the first live sale.</p>`);
}

function sellerAgreementPage() {
  return layout('Seller agreement', `
    <h2>1. Parties and payments disclosure</h2>
    <p><strong>Required Stripe disclosure:</strong> by selling on this marketplace you agree that Stripe, Inc. provides payment processing services for your sales, and you contract directly with Stripe for those services under Stripe's Connected Account Agreement. The platform creates and manages your Stripe connected account (Express dashboard) for payouts. The platform never holds your bank details — Stripe collects them in its hosted onboarding flow.</p>
    <h2>2. The 80/20 revenue share</h2>
    <p>You receive 80% of every eligible transaction; the platform receives 20%. This covers initial purchases, repeat purchases, monthly and annual subscriptions, subscription renewals, and eligible add-on purchases. The split is calculated on the gross price the customer pays, per transaction, at the moment Stripe confirms payment succeeded. A renewal is never treated as paid merely because an invoice was generated.</p>
    <h2>3. Fees</h2>
    <p>Stripe's card-processing fee (2.9% + $0.30 per successful US card charge; +0.7% per subscription invoice) is paid by the platform out of its 20% commission. Connect costs ($2 per monthly active account, 0.25% + $0.25 per payout) are also paid by the platform. You are not charged anything to list or to join.</p>
    <h2>4. Payouts</h2>
    <p>Your 80% share is transferred to your connected Stripe account automatically when a payment succeeds, and paid out to your bank on Stripe's payout schedule. Payouts are gated on your Stripe transfers capability being active.</p>
    <h2>5. Refund policy</h2>
    <p>Approved refunds are processed as: full refund to the customer, <code>reverse_transfer: true</code> (your share is pulled back to cover the refund), <code>refund_application_fee: false</code> (the platform keeps its commission). You can see every refund against your sales in your dashboard, including the platform's resulting net.</p>
    <h2>6. Disputes</h2>
    <p>If a customer disputes a charge, the platform may reverse your share of that transaction to cover the disputed amount. Stripe dispute fees ($15 received fee, plus a $15 countered fee refunded only if the dispute is won) are shown in your dashboard. Keep your dispute rate below 0.75% — higher rates put the whole platform at risk.</p>
    <h2>7. Subscriptions</h2>
    <p>For subscription products the platform manages the subscription (cancellation, plan changes, customer portal) because Express sellers cannot manage customer subscriptions directly. Your 80% applies to every successful renewal automatically.</p>
    <h2>8. Prohibited products — non-negotiable</h2>
    <p><strong>Adult content and services are banned, including any AI-generated adult content</strong> (Stripe's prohibited-businesses list, updated September 22, 2026). Also banned: CBD products, dating services, cryptocurrency products or services, crowdfunding, and anything else on Stripe's prohibited or restricted lists without Stripe's prior approval. One seller listing banned content puts the entire platform's Stripe account at risk of closure and held funds. Violations mean immediate removal and forfeiture of pending payouts related to the violation.</p>
    <h2>9. Taxes</h2>
    <p>The platform is the merchant of record and handles sales-tax collection where required. For income-tax reporting: because the platform controls pricing, Stripe does not file 1099-K forms for sellers — the platform is responsible for issuing them where the law requires. You must provide accurate tax information when Stripe or the platform asks for it.</p>
    <h2>10. Your responsibilities</h2>
    <p>You own your product, its description, and its delivery. Listings must be accurate and lawful. You must not misrepresent AI-generated content as human-made, and you must not list products you do not have the right to sell.</p>
    <h2>11. Termination</h2>
    <p>Either side may end this agreement. On termination, active subscriptions you sold are cancelled by the platform unless the customer is transferred to another arrangement. Pending payouts for lawful completed sales are still paid out.</p>
    <p class="muted">This is a working product's seller agreement, not legal advice. Get a legal review before the first live sale.</p>`);
}

function messagePage(title, body) {
  return layout(title, body);
}

module.exports = {
  layout, esc, home, listingDetail, sellForm, sellerLogin, sellerDashboard,
  listingForm, adminLogin, adminDashboard, adminOrders, adminRefunds,
  termsPage, sellerAgreementPage, messagePage,
};
