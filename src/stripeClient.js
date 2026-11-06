'use strict';
/**
 * Stripe client — TEST MODE ONLY, hard-guarded.
 *
 * - No key configured: Stripe calls throw a clear, user-facing error and the
 *   app keeps serving pages (listings, dashboards, legal) without Stripe.
 * - A live key (sk_live_ / pk_live_ / rk_live_) is REFUSED at startup: the
 *   process exits rather than risk a live charge against Larry's real
 *   account (acct_1UWhTx3cao97Pur2). Live mode is owner-only, after the
 *   tax-ID blocker is resolved and Connect is enabled.
 * - Only sk_test_ / pk_test_ keys are accepted.
 */
let stripe = null;

function initStripe() {
  const secret = (process.env.STRIPE_SECRET_KEY || '').trim();
  const publishable = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();

  if (/^(sk|pk|rk)_live_/.test(secret) || /^(sk|pk|rk)_live_/.test(publishable)) {
    console.error('FATAL: live Stripe keys detected. This app runs in TEST MODE ONLY.');
    console.error('Remove live keys from the environment and use sk_test_ / pk_test_ keys.');
    process.exit(1);
  }

  if (!secret) {
    console.warn('[stripe] STRIPE_SECRET_KEY not set — Stripe calls are disabled. Set a sk_test_ key in .env to enable checkout, onboarding and live webhook processing.');
    return null;
  }
  if (!secret.startsWith('sk_test_')) {
    console.error('FATAL: STRIPE_SECRET_KEY must be a test key (sk_test_...).');
    process.exit(1);
  }

  stripe = require('stripe')(secret);
  console.log('[stripe] Test-mode client ready.');
  return stripe;
}

function getStripe() {
  if (!stripe) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY (sk_test_...) in .env.');
  return stripe;
}

function stripeConfigured() {
  return !!stripe;
}

function publishableKey() {
  return (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
}

module.exports = { initStripe, getStripe, stripeConfigured, publishableKey };
