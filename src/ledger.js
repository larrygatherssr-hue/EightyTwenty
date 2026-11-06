'use strict';
/**
 * Immutable ledger helpers. Every money movement in the marketplace is
 * recorded here as an append-only entry. Revenue is recorded ONLY from
 * payment_succeeded events (webhooks), never from invoice creation or
 * checkout initiation.
 */
const { db } = require('./db');
const { chargeBreakdown, refundNetCents } = require('./fees');

function recordSale({ eventId, orderId, sellerId, grossCents, processingFeeCents, billing = false, kind = 'sale', description }) {
  const b = chargeBreakdown(grossCents, { billing });
  // Use the exact processing fee from Stripe's balance transaction when we
  // have it; otherwise the estimate from chargeBreakdown.
  const processingFee = Number.isInteger(processingFeeCents) ? processingFeeCents : b.processingFee;
  const platformNet = b.platformFee - processingFee;
  const stmt = db.prepare(`
    INSERT INTO ledger_entries
      (event_id, order_id, seller_id, kind, gross_cents, processing_fee_cents,
       platform_fee_cents, seller_share_cents, platform_net_cents, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(
    eventId || null, orderId || null, sellerId || null, kind, grossCents,
    processingFee, b.platformFee, b.sellerEarnings, platformNet,
    description || `${kind} — gross ${grossCents}c`,
  );
  return { entryId: Number(info.lastInsertRowid), ...b, processingFee, platformNet };
}

function recordRefund({ eventId, orderId, sellerId, grossCents, sellerShareCents, platformFeeCents, processingFeeCents, description }) {
  const platformNetAfter = refundNetCents({ grossCents, sellerShareCents, platformFeeCents, processingFeeCents });
  const stmt = db.prepare(`
    INSERT INTO ledger_entries
      (event_id, order_id, seller_id, kind, gross_cents, processing_fee_cents,
       platform_fee_cents, seller_share_cents, platform_net_cents, description)
    VALUES (?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(
    eventId || null, orderId || null, sellerId || null,
    -grossCents, 0, 0, -sellerShareCents, platformNetAfter,
    description || `refund — gross ${grossCents}c`,
  );
  return { entryId: Number(info.lastInsertRowid), platformNetAfter };
}

function recordDisputeFee({ eventId, orderId, sellerId, amountCents, description }) {
  const stmt = db.prepare(`
    INSERT INTO ledger_entries
      (event_id, order_id, seller_id, kind, gross_cents, processing_fee_cents,
       platform_fee_cents, seller_share_cents, platform_net_cents, description)
    VALUES (?, ?, ?, 'dispute_fee', 0, ?, 0, 0, ?, ?)`);
  const info = stmt.run(
    eventId || null, orderId || null, sellerId || null,
    amountCents, -amountCents,
    description || `dispute fee ${amountCents}c`,
  );
  return Number(info.lastInsertRowid);
}

function totals(sellerId = null) {
  const where = sellerId ? 'WHERE seller_id = ?' : '';
  const args = sellerId ? [sellerId] : [];
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(gross_cents), 0) AS gross,
      COALESCE(SUM(processing_fee_cents), 0) AS processing,
      COALESCE(SUM(platform_fee_cents), 0) AS platformFees,
      COALESCE(SUM(seller_share_cents), 0) AS sellerShare,
      COALESCE(SUM(platform_net_cents), 0) AS platformNet
    FROM ledger_entries ${where}`).get(...args);
  return row;
}

function monthlyStatement(year, month) {
  // month: 1-12. Sums ledger entries in that calendar month (UTC).
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
  return db.prepare(`
    SELECT kind, COUNT(*) AS n,
      COALESCE(SUM(gross_cents),0) AS gross,
      COALESCE(SUM(processing_fee_cents),0) AS processing,
      COALESCE(SUM(platform_fee_cents),0) AS platformFees,
      COALESCE(SUM(seller_share_cents),0) AS sellerShare,
      COALESCE(SUM(platform_net_cents),0) AS platformNet
    FROM ledger_entries
    WHERE created_at >= ? AND created_at < ?
    GROUP BY kind ORDER BY kind`).all(start, end);
}

module.exports = { recordSale, recordRefund, recordDisputeFee, totals, monthlyStatement };
