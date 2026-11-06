'use strict';
/**
 * Seller onboarding on the Accounts v2 API (Stripe SDK 21+).
 *
 * Verified shape (live test API, 2026-11-06): the request below creates a
 * seller account once the owner has enabled Connect + Accounts v2 AND
 * acknowledged negative balance liability ("Platform manages losses") in the
 * platform profile. Without the liability acknowledgement the create fails
 * with `account_creation_losses_collector_unavailable`; without the
 * toggles it fails with `non_connect_platform_accounts_v2_access_blocked`.
 * Do NOT attempt to enable any of these from code — all are owner-only
 * dashboard steps.
 *
 * Shape (per STRIPE-SPEC.md §1–2, confirmed live 2026-11-06):
 *  - identity.country: 'us' (required before any configuration is set)
 *  - dashboard: 'express' (string)
 *  - defaults.responsibilities.fees_collector / losses_collector: 'application'
 *  - configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested: true
 *  - configuration.merchant.capabilities.card_payments.requested: true
 *    (REQUIRED alongside stripe_transfers for this platform — the live API
 *    rejects transfers-only with `capability_not_available_without_other_capability`
 *    unless Stripe approves the platform for transfers-only accounts.
 *    card_payments is requested but NEVER used: the platform stays merchant
 *    of record on destination charges, so the seller's card_payments
 *    capability carries no charges. Do NOT drop it to "simplify" — account
 *    creation fails without it.)
 *
 * Shape (per STRIPE-SPEC.md §1–2):
 *  - dashboard: 'express' (string)
 *  - defaults.responsibilities.fees_collector / losses_collector: 'application'
 *  - configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested: true
 *  - Do NOT request merchant / card_payments for marketplace sellers:
 *    the platform is the merchant of record (destination charges without
 *    on_behalf_of); sellers only need the recipient configuration.
 *
 * Readiness is the transfers capability status at
 * configuration.recipient.capabilities.stripe_balance.stripe_transfers.status
 * ('active' means the seller can be charged and paid out). The v1
 * charges_enabled / payouts_enabled flags do not exist on v2 accounts.
 */
const { db } = require('./db');

/** The seller is ready for checkout/subscriptions when transfers are active. */
function sellerReady(seller) {
  return !!seller && seller.transfers_status === 'active';
}

/**
 * Create the seller's connected account (Accounts v2).
 * Returns the v2 account object. Throws the Stripe enablement error until
 * the owner enables Connect + Accounts v2 — callers surface that message.
 */
async function createSellerAccount(stripe, seller) {
  return stripe.v2.core.accounts.create({
    contact_email: seller.email,
    display_name: seller.name,
    dashboard: 'express',
    identity: { country: 'us' },
    defaults: {
      responsibilities: {
        fees_collector: 'application',
        losses_collector: 'application',
      },
    },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: {
            stripe_transfers: { requested: true },
          },
        },
      },
      // Required alongside stripe_transfers for this platform (see header).
      // Requested but never used — the platform stays merchant of record.
      merchant: {
        capabilities: {
          card_payments: { requested: true },
        },
      },
    },
    metadata: { seller_id: String(seller.id), marketplace: 'eightytwenty' },
  });
}

/**
 * Create a hosted-onboarding account link (Accounts v2).
 * `baseUrl` is the app's public base URL (BASE_URL).
 */
async function createOnboardingLink(stripe, seller, baseUrl) {
  const accountId = seller.stripe_account_id;
  if (!accountId) throw new Error('Seller has no Stripe account yet.');
  const link = await stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        // Must match the configurations applied to the account (recipient +
        // merchant — see createSellerAccount). Listing only 'recipient'
        // fails with "You must correctly specify the applied configurations".
        configurations: ['recipient', 'merchant'],
        refresh_url: `${baseUrl}/sell/refresh?seller=${seller.id}`,
        return_url: `${baseUrl}/sell/return?seller=${seller.id}`,
      },
    },
  });
  return link;
}

/**
 * Read the transfers capability status for a v2 account.
 * Returns one of 'active' | 'pending' | 'restricted' | 'inactive' | null
 * (null when the capability is not present in the response).
 */
async function getTransfersStatus(stripe, accountId) {
  const acct = await stripe.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.recipient'],
  });
  const cap = acct
    && acct.configuration
    && acct.configuration.recipient
    && acct.configuration.recipient.capabilities
    && acct.configuration.recipient.capabilities.stripe_balance
    && acct.configuration.recipient.capabilities.stripe_balance.stripe_transfers;
  return cap && typeof cap.status === 'string' ? cap.status : null;
}

/**
 * Sync one seller's readiness from Stripe into the DB.
 * Returns the status string, or null when Stripe could not be reached
 * (e.g. Accounts v2 not enabled yet — the seller simply stays pending).
 */
async function syncSellerFromStripe(stripe, seller) {
  if (!seller || !seller.stripe_account_id) return null;
  try {
    const status = await getTransfersStatus(stripe, seller.stripe_account_id);
    if (!status) return null;
    db.prepare("UPDATE sellers SET transfers_status = ?, status = ? WHERE id = ?")
      .run(status, status === 'active' ? 'active' : 'onboarding', seller.id);
    return status;
  } catch (e) {
    console.warn('[onboarding] could not sync seller', seller.id, '-', e.message);
    return null;
  }
}

module.exports = {
  sellerReady,
  createSellerAccount,
  createOnboardingLink,
  getTransfersStatus,
  syncSellerFromStripe,
};
