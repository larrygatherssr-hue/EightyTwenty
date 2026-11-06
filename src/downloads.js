'use strict';
/**
 * Buyer file delivery for platform catalog products.
 *
 * How a buyer gets their files after paying (the delivery mechanism):
 *  - Each catalog product ships as files committed in the repo:
 *      downloads/<SKU>.pdf  — the course + workbook as one PDF
 *      downloads/<SKU>.zip  — the full package (PDF, workbook, templates, cover)
 *    The repo is the durable store: on Render's free plan the SQLite DB and
 *    the container disk are ephemeral, but a redeploy checks the repo out
 *    again, so the files (like the seed listings) always come back.
 *  - The files are NOT served statically. The only way to fetch one is
 *    GET /download/:checkoutSessionId?file=pdf|zip, which proves a real
 *    payment before serving the file (see resolveDownload). The listing
 *    page and the homepage never link to the files — only the post-payment
 *    success page does.
 *
 * Security tradeoff, stated plainly: the download link is tied to the
 * buyer's Stripe Checkout Session id, not to a buyer account (the app has
 * no buyer accounts). Anyone who obtains that link can download the files
 * for that one purchase — the same as sharing a receipt link. The file
 * URLs themselves are not guessable (a random cs_ session id is required)
 * and no directory listing exists, but there is no per-buyer login gate.
 * A signed, expiring per-order link would be the next step if sharing
 * ever becomes a problem; it is not built here.
 */
const fs = require('fs');
const path = require('path');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]+$/;
const SKU_RE = /^[A-Z]{2,3}-\d{2}$/; // RE-01 (2 letters) and FIN-02 / BEA-01 / GRN-02 / PET-03 (3 letters)
const FILE_KINDS = { pdf: '.pdf', zip: '.zip' };

/** Absolute path of a product file on disk, or null (bad sku/kind, or missing file). */
function downloadFilePath(sku, kind) {
  if (!SKU_RE.test(sku || '') || !FILE_KINDS[kind]) return null;
  const p = path.join(DOWNLOADS_DIR, `${sku}${FILE_KINDS[kind]}`);
  return fs.existsSync(p) ? p : null;
}

/** A listing is downloadable when it is an active platform one-time listing with a sku. */
function downloadableListing(db, listingId) {
  return db.prepare(
    "SELECT * FROM listings WHERE id = ? AND active = 1 AND owner = 'platform' AND billing = 'one_time' AND sku IS NOT NULL"
  ).get(listingId) || null;
}

/**
 * Resolve a download request to a file, or null when it must be refused.
 * Verification, in order:
 *  1. Stripe Checkout Session (when a stripe client is supplied): the
 *     session must exist, payment_status must be 'paid', and its metadata
 *     must name the listing. This is the fast path — it works in the
 *     seconds before the checkout.session.completed webhook lands.
 *  2. Local paid order: an orders row with this checkout session id and
 *     status 'paid' (created by the webhook). This is the durable path and
 *     the fallback when Stripe cannot be reached.
 * Either path proves a real payment for that listing; anything else is refused.
 */
async function resolveDownload(db, { sessionId, kind, stripe }) {
  if (!SESSION_ID_RE.test(sessionId || '')) return null;
  if (!FILE_KINDS[kind]) return null;
  let listingId = null;
  if (stripe) {
    try {
      const s = await stripe.checkout.sessions.retrieve(sessionId);
      if (s && s.payment_status === 'paid' && s.metadata && s.metadata.listing_id) {
        listingId = Number(s.metadata.listing_id);
      }
    } catch (e) {
      console.warn('[download] Stripe session lookup failed, falling back to local order:', e.message);
    }
  }
  if (!listingId) {
    const order = db.prepare(
      "SELECT listing_id FROM orders WHERE stripe_checkout_session_id = ? AND status = 'paid'"
    ).get(sessionId);
    if (order) listingId = order.listing_id;
  }
  if (!listingId) return null;
  const listing = downloadableListing(db, listingId);
  if (!listing) return null;
  const filePath = downloadFilePath(listing.sku, kind);
  if (!filePath) return null;
  return { listing, filePath, kind };
}

module.exports = { resolveDownload, downloadFilePath, downloadableListing, DOWNLOADS_DIR };
