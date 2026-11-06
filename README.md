# EightyTwenty

An independent, scalable online marketplace. **Sellers keep 80% of every
eligible sale; the platform keeps 20%** — on initial purchases, repeat
purchases, monthly and annual subscriptions, subscription renewals, and
eligible add-on purchases.

Built on **Stripe Connect (Accounts v2, Express-equivalent sellers)** +
**Stripe Billing**, with destination charges, signature-verified webhooks,
and the app's own immutable double-entry ledger. Plain server-rendered
pages (Express + SQLite, no heavy framework).

> **TEST MODE ONLY.** The app refuses to start with live keys. Live launch
> is owner-only, after the checklist at the bottom.

## How the money splits

Larry's exact split function (in `src/fees.js`):

```js
platformFee = Math.round(amountInCents * 0.20);
sellerEarnings = amountInCents - platformFee;
```

The split is correct — but Stripe's processing fee (2.9% + $0.30 per
successful US card charge, +0.7% per subscription invoice) is paid by the
platform **out of its 20%**. The platform's true net on a $100 sale is
**$16.80**, not $20. On a $10/month renewal it is **$1.34**. The dashboards
show both the 20% commission and the true net, so nobody is surprised.

**Honest comparison:** Gumroad direct sales cost a seller 10% + $0.50 +
processing (seller keeps $86.30 on $100 vs $80.00 here). Do **not** market
the 80/20 as a fee saving — the pitch is a fixed 80% with transparent
dashboards, subscription splits, and seller ownership of the customer
relationship.

## What is built

- **Seller onboarding** — Stripe Accounts v2 (Express dashboard,
  `fees_collector`/`losses_collector: application`, `card_payments` +
  `stripe_balance.stripe_transfers` capabilities together). Hosted Account
  Link flow; charging and payouts gated on `charges_enabled` AND
  `payouts_enabled`; `account.updated` webhook keeps flags in sync.
- **Listings** — sellers create/edit digital products (one-time, monthly,
  annual). Platform-owned listings keep 100%; the split applies only to
  third-party sellers.
- **Checkout** — Stripe Checkout Sessions. One-time: destination-charge
  PaymentIntent with `application_fee_amount` = 20% and
  `transfer_data[destination]` = seller. Subscriptions: created on the
  platform account with `application_fee_percent: 20` and
  `transfer_data[destination]`, so **every renewal splits automatically**.
  Full price shown before checkout; the 80/20 split and fees disclosed on
  every listing page.
- **Webhooks** — `/webhooks/stripe` (platform events) and
  `/webhooks/stripe-connect` (Connect events, separate secret). Raw body,
  SDK signature verification (5-minute tolerance), HTTP 400 on failure,
  idempotency keyed by `event.id`. Revenue is recorded **only** on
  `payment_intent.succeeded` / `invoice.payment_succeeded` — never on
  invoice creation. Full event list in `src/webhooks.js`.
- **Dashboards** — owner dashboard (revenue, commission, true net, recurring
  revenue, seller performance, monthly statements, CSV exports, refund
  flow) and seller dashboard (earnings, sales, subscriptions, refunds,
  disputes, payout status). Both driven by the immutable ledger.
- **Refunds** — admin flow with the seller-agreement policy:
  `reverse_transfer: true`, `refund_application_fee: false`. The platform
  net after a refund is shown (for example, −$3.20 on a refunded $100 sale).
- **Disputes** — tracked from `charge.dispute.*` events with the $15
  received fee shown. Dispute rate above 0.75% is the real exposure.
- **Legal pages** — `/terms` and `/seller-agreement`, including Stripe's
  required payments disclosure, the **adult-content ban (non-negotiable —
  Stripe prohibits adult content including AI-generated adult content)**,
  and exclusion of CBD, dating, crypto and crowdfunding.
- **Seed data** — the two platform-owned listings only: Smart Money Budget
  Planner ($7) and Daily Wins Habit Tracker ($5). No fake sellers, no fake
  sales; the ledger starts empty.

## Run it locally

```bash
cd ~/workspace/marketplace/app
npm install
cp .env.example .env        # fill in sk_test_ / pk_test_ keys + webhook secrets
npm run seed                # idempotent; seeds the two platform listings
npm start                   # http://localhost:3000
```

With test keys, exercise the flows with Stripe's test cards
(`4242 4242 4242 4242`, any future date, any CVC) and test the webhooks
with the Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
stripe listen --forward-to localhost:3000/webhooks/stripe-connect \
  --events account.updated,capability.updated,payout.created,payout.paid,payout.failed
stripe trigger payment_intent.succeeded
stripe trigger invoice.payment_succeeded
stripe trigger charge.refunded
stripe trigger charge.dispute.created
```

## Deploy (Render, one-click)

1. Push this folder to a Git repo (or use the Dockerfile directly).
2. In Render: **New → Blueprint** → point at the repo (`render.yaml`).
3. Set the env vars in the Render dashboard: `STRIPE_SECRET_KEY`
   (`sk_test_...` for testing, `sk_live_...` only at real launch),
   `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_CONNECT_WEBHOOK_SECRET`, `ADMIN_PASSWORD`, `BASE_URL`
   (your Render URL, then your custom domain).
4. In Stripe: create the two webhook endpoints pointing at
   `https://<your-domain>/webhooks/stripe` and
   `https://<your-domain>/webhooks/stripe-connect` (the second with
   "Listen to events on Connected accounts" enabled) and paste the
   `whsec_...` secrets into Render.
5. The persistent disk in `render.yaml` keeps the SQLite file across
   deploys. Back it up before any major change.

## Owner checklist (all owner-only — the app cannot do these)

- [ ] **Tax ID before Nov 30, 2026** — Stripe will pause payouts for
  Laurentius Colligit Family Trust Corp otherwise. Without payouts the
  marketplace cannot pay sellers. Add it in the Stripe dashboard.
- [ ] **Enable Connect** on the platform Stripe account and complete
  platform verification.
- [ ] **Test mode end-to-end first:** onboarding, purchase, subscription
  renewal (`invoice.payment_succeeded`), refund with both flags, dispute,
  payout — all with test keys before any live transaction.
- [ ] **Live keys + webhook secrets** provisioned to the host (never
  committed to code). Only then remove the test-mode guard's effect by
  deploying with live keys — the guard itself stays in the code.
- [ ] **Seller agreement / Terms adopted** with legal review (the pages
  ship with the required Stripe disclosure and the adult-content ban).
- [ ] **Tax advisor consulted** on 1099-K filing (the platform files for
  sellers, not Stripe, because the platform controls pricing) and on
  sales-tax handling (the platform is merchant of record).
- [ ] **Domain + HTTPS** (Stripe webhooks require HTTPS in production).
- [ ] **Name the marketplace** — it currently ships as the neutral working
  name "EightyTwenty".

## Project layout

```
src/server.js       Express app + all routes (marketplace, checkout, seller, admin)
src/db.js           SQLite schema (sellers, listings, orders, subscriptions,
                    ledger_entries, refunds, disputes, payouts, processed_events)
src/fees.js         Larry's exact split function + Stripe fee math + platform net
src/ledger.js       Immutable ledger writers + totals + monthly statements
src/stripeClient.js Stripe client with the TEST-MODE-ONLY guard
src/webhooks.js     Signature-verified webhook handlers (both endpoints)
src/views.js        Server-rendered HTML (full price + split disclosed everywhere)
src/seed.js         Platform-owned listings only (planner $7, tracker $5)
Dockerfile          Node 24, production image
render.yaml         Render Blueprint (web service + persistent disk for SQLite)
```

## Verification status

- App starts, serves pages, seeds the two listings, split math unit-checked
  ($100 → $20.00 platform / $80.00 seller / $16.80 platform net).
- Webhook signature verification exercised with locally HMAC-signed test
  events (valid signature → 200 + ledger entry; bad signature → 400;
  duplicate `event.id` → acknowledged once).
- **Not yet run against Stripe's test API** — no test keys were available in
  this environment and the live key was deliberately not used. Before
  launch, run the Stripe CLI triggers above with `sk_test_` keys and
  confirm: onboarding link generation, checkout session creation,
  `payment_intent.succeeded` ledger entry, renewal split, refund with both
  flags, and dispute handling.
