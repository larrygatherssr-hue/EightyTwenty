'use strict';
/**
 * Stripe client — accepts both test and live keys.
 *
 * - No key configured: Stripe calls throw a clear, user-facing error and the
 *   app keeps serving pages (listings, dashboards, legal) without Stripe.
 * - Test keys (sk_test_ / rk_test_) run the app in test mode.
 * - Live keys (sk_live_ / rk_live_) run the app in live mode. Live mode was
 *   owner-approved 2026-11-06: the tax ID is on file in Stripe, Connect is
 *   enabled, and the owner supplied live keys to flip the marketplace live.
 * - stripeMode() reports 'live' or 'test' so /health and the page footer
 *   show the real mode.
 */
let stripe = null;

function stripeMode() {
  const secret = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (/^(sk|rk)_live_/.test(secret)) return 'live';
  return 'test';
}

function initStripe() {
  const secret = (process.env.STRIPE_SECRET_KEY || '').trim();

  if (!secret) {
    console.warn('[stripe] STRIPE_SECRET_KEY not set — Stripe calls are disabled. Set a Stripe secret key in .env to enable checkout, onboarding and webhook processing.');
    return null;
  }
  if (!/^(sk|rk)_(test|live)_/.test(secret)) {
    console.error('FATAL: STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_ / rk_test_ / sk_live_ / rk_live_).');
    process.exit(1);
  }

  // Use the fetch-based HTTP client: the SDK's default Node client ignores
  // proxy env vars, so API calls fail in proxied environments (this sandbox
  // routes egress through a proxy; Render and normal networks are direct).
  // The fetch client honours NODE_USE_ENV_PROXY and works in both cases.
  const Stripe = require('stripe');
  stripe = new Stripe(secret, { httpClient: Stripe.createFetchHttpClient() });
  console.log(`[stripe] ${stripeMode()}-mode client ready.`);
  return stripe;
}

function getStripe() {
  if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in .env.');
  return stripe;
}

function stripeConfigured() {
  return !!stripe;
}

function publishableKey() {
  return (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
}

module.exports = { initStripe, getStripe, stripeConfigured, publishableKey, stripeMode };
