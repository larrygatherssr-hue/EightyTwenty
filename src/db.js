'use strict';
/**
 * SQLite storage (Node 24 built-in node:sqlite, no native dependencies).
 *
 * The app keeps its OWN immutable double-entry ledger. Stripe's balances are
 * not a ledger of who owes whom; both dashboards, statements and exports
 * depend on this ledger. Ledger rows are append-only: no UPDATE or DELETE
 * code paths exist for them anywhere in the app.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DATABASE_PATH || './data/marketplace.db';
const resolved = path.resolve(process.cwd(), dbPath);
fs.mkdirSync(path.dirname(resolved), { recursive: true });

const db = new DatabaseSync(resolved);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  stripe_account_id TEXT UNIQUE,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  transfers_status TEXT NOT NULL DEFAULT 'pending',
  dashboard_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'onboarding',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER REFERENCES sellers(id),
  owner TEXT NOT NULL DEFAULT 'seller',           -- 'seller' or 'platform'
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  billing TEXT NOT NULL DEFAULT 'one_time',        -- one_time | monthly | annual
  delivery_note TEXT NOT NULL DEFAULT '',
  external_url TEXT,                               -- e.g. Gumroad link for platform listings
  active INTEGER NOT NULL DEFAULT 1,
  stripe_price_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER REFERENCES listings(id),
  seller_id INTEGER REFERENCES sellers(id),
  buyer_email TEXT,
  type TEXT NOT NULL DEFAULT 'one_time',           -- one_time | subscription
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | paid | refunded | partially_refunded | disputed | failed
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  seller_id INTEGER REFERENCES sellers(id),
  listing_id INTEGER REFERENCES listings(id),
  buyer_email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Immutable ledger. Append-only: gross, processing fee, platform fee,
-- seller share, refunds and disputes per transaction.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,                                   -- Stripe event.id (idempotency link)
  order_id INTEGER REFERENCES orders(id),
  seller_id INTEGER REFERENCES sellers(id),
  kind TEXT NOT NULL,                              -- sale | renewal | refund | dispute | dispute_fee | payout | adjustment
  gross_cents INTEGER NOT NULL DEFAULT 0,
  processing_fee_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  seller_share_cents INTEGER NOT NULL DEFAULT 0,
  platform_net_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  stripe_refund_id TEXT,
  amount_cents INTEGER NOT NULL,
  reverse_transfer INTEGER NOT NULL DEFAULT 1,
  refund_application_fee INTEGER NOT NULL DEFAULT 0,
  platform_net_after_cents INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  stripe_dispute_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'needs_response',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_payout_id TEXT NOT NULL UNIQUE,
  stripe_account_id TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  arrival_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Webhook idempotency: every processed Stripe event.id lands here first.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'platform',
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,                              -- 'admin' | 'seller'
  seller_id INTEGER REFERENCES sellers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Lightweight migration: existing databases created before the Accounts v2
// rewrite lack sellers.transfers_status. CREATE TABLE IF NOT EXISTS does not
// add columns to an existing table, so add it explicitly when missing.
// (charges_enabled / payouts_enabled are legacy v1 columns, kept for
// backwards compatibility but no longer read by the app.)
if (!db.prepare("SELECT 1 FROM pragma_table_info('sellers') WHERE name = 'transfers_status'").get()) {
  db.exec("ALTER TABLE sellers ADD COLUMN transfers_status TEXT NOT NULL DEFAULT 'pending'");
}

module.exports = { db };
