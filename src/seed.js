'use strict';
/**
 * Seed data — platform-owned listings ONLY. No fake sellers, no fake sales,
 * no fake transactions. The ledger starts empty (zero fake revenue).
 *
 * The two seed listings are Larry's own live Gumroad products. They are
 * marked owner='platform', so the platform keeps 100% on them and the 80/20
 * split does not apply. The engine can point buyers here later; checkout
 * for these listings completes on Gumroad via external_url until/unless
 * Larry moves fulfilment onto this marketplace.
 */
require('dotenv').config();
const { db } = require('./db');

const SEED_LISTINGS = [
  {
    owner: 'platform',
    seller_id: null,
    title: 'Smart Money Budget Planner',
    description: 'A 6-page printable PDF budget planner: monthly budget with 10 expense categories, expense tracker, debt payoff tracker (snowball method), savings goals, and a monthly review. Undated and reusable for 12 months.',
    price_cents: 700,
    billing: 'one_time',
    delivery_note: 'Delivered instantly as a PDF download after purchase.',
    external_url: 'https://geniusly.gumroad.com/l/vrkwyz',
  },
  {
    owner: 'platform',
    seller_id: null,
    title: 'Daily Wins Habit Tracker',
    description: 'A printable daily habit tracker PDF. Track your daily wins, build streaks, and stay consistent — one page per day, print at home.',
    price_cents: 500,
    billing: 'one_time',
    delivery_note: 'Delivered instantly as a PDF download after purchase.',
    external_url: 'https://geniusly.gumroad.com/l/eoblm',
  },
];

function seed() {
  const insert = db.prepare(`
    INSERT INTO listings (seller_id, owner, title, description, price_cents, billing, delivery_note, external_url, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const exists = db.prepare('SELECT id FROM listings WHERE title = ? AND owner = ?');
  let created = 0;
  let skipped = 0;
  for (const l of SEED_LISTINGS) {
    if (exists.get(l.title, l.owner)) { skipped++; continue; }
    insert.run(l.seller_id, l.owner, l.title, l.description, l.price_cents, l.billing, l.delivery_note, l.external_url);
    created++;
  }
  console.log(`Seed complete: ${created} created, ${skipped} already existed.`);
  return { created, skipped };
}

if (require.main === module) seed();
module.exports = { seed, SEED_LISTINGS };
