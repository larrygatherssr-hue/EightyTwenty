'use strict';
/**
 * Fee math for the EightyTwenty.
 *
 * Larry's exact split function (verbatim from the build spec) is
 * calculateRevenueSplit(). It is arithmetically correct for the 80/20 split
 * but omits Stripe's processing fees. The platform's REAL net is 20% MINUS
 * processing, so the helpers below layer the Stripe costs on top of the
 * split without ever changing the split itself.
 *
 * Stripe costs (US, verified Nov 2026, per STRIPE-SPEC.md):
 *  - Card processing: 2.9% + $0.30 per successful charge (paid by the
 *    platform out of its 20%).
 *  - Billing (subscriptions): +0.7% per recurring invoice.
 *  - Connect: $2 per monthly active account; 0.25% + $0.25 per payout.
 *  - Disputes: $15 received fee (never refunded) + $15 countered fee
 *    (refunded only if the platform wins).
 */

function calculateRevenueSplit(amountInCents) {
  if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
    throw new Error('Invalid transaction amount');
  }

  const platformFee = Math.round(amountInCents * 0.20);

  const sellerEarnings = amountInCents - platformFee;

  return {
    platformFee,
    sellerEarnings,
    commissionRate: 20,
    sellerRate: 80,
  };
}

/** Stripe card-processing fee estimate: 2.9% + $0.30 (US domestic card). */
function processingFeeCents(amountInCents, { billing = false } = {}) {
  if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
    throw new Error('Invalid transaction amount');
  }
  let fee = Math.round(amountInCents * 0.029) + 30;
  if (billing) fee += Math.round(amountInCents * 0.007); // Billing 0.7%
  return fee;
}

/**
 * Full breakdown for one successful charge.
 * Returns the split plus the platform's true net after Stripe processing.
 * Example ($100 one-time): gross 10000, platformFee 2000, seller 8000,
 * processing 320, platformNet 1680.
 */
function chargeBreakdown(amountInCents, { billing = false } = {}) {
  const split = calculateRevenueSplit(amountInCents);
  const processingFee = processingFeeCents(amountInCents, { billing });
  return {
    ...split,
    processingFee,
    platformNet: split.platformFee - processingFee,
    currency: 'usd',
  };
}

/**
 * Platform net after a FULL refund under the seller-agreement policy:
 * reverse_transfer: true, refund_application_fee: false.
 * The platform refunds the gross, pulls the seller's share back, keeps its
 * commission, and Stripe does NOT return the processing fee.
 * Example ($100 sale): -10000 + 8000 + 2000 - 320 = -320 cents.
 */
function refundNetCents({ grossCents, sellerShareCents, platformFeeCents, processingFeeCents }) {
  return -grossCents + sellerShareCents + platformFeeCents - processingFeeCents;
}

/** Format cents as $X.XX (handles negatives). */
function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

module.exports = {
  calculateRevenueSplit,
  processingFeeCents,
  chargeBreakdown,
  refundNetCents,
  money,
};
