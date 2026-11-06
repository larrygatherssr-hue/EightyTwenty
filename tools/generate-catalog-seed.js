'use strict';
/**
 * Generate src/catalog-seed.js from the built product folders.
 *
 * Reads ~/workspace/digital-marketplace/products/<SKU>/listing.json for each
 * SKU (in storefront display order, see DISPLAY_ORDER below) and writes a
 * committed JS module the app's seed() uses to create the 50 platform-owned
 * listings. Run: node tools/generate-catalog-seed.js
 *
 * Products dir can be overridden: node tools/generate-catalog-seed.js /path/to/products
 */
const fs = require('fs');
const path = require('path');

const PRODUCTS_DIR = process.argv[2]
  || path.resolve(__dirname, '..', '..', '..', 'digital-marketplace', 'products');
const OUT = path.resolve(__dirname, '..', 'src', 'catalog-seed.js');

// Storefront display order: the catalog's top-10 ranking first, then the
// remaining products in the build-batch order (roughly price-descending, so
// the flagship products show first on the homepage).
const DISPLAY_ORDER = [
  'RE-01', 'FIN-02', 'RE-02', 'FIN-03', 'RE-03', 'PET-04', 'FIN-01', 'BEA-01', 'FIN-05', 'PET-01',
  'BEA-02', 'GRN-01', 'FIN-06', 'RE-04', 'RE-05',
  'RE-06', 'BEA-03', 'PET-02', 'PET-05', 'BEA-04',
  'BEA-07', 'FIN-07', 'FIN-09', 'RE-08', 'PET-03',
  'BEA-05', 'BEA-06', 'PET-09', 'RE-09', 'GRN-02',
  'BEA-08', 'FIN-08', 'RE-07', 'GRN-03', 'PET-06',
  'BEA-09', 'GRN-06', 'GRN-07', 'BEA-10', 'GRN-04',
  'GRN-05', 'PET-08', 'FIN-04', 'RE-10', 'GRN-10',
  'FIN-10', 'GRN-08', 'GRN-09', 'PET-07', 'PET-10',
];

function main() {
  const listings = [];
  let totalCents = 0;
  for (const sku of DISPLAY_ORDER) {
    const listingPath = path.join(PRODUCTS_DIR, sku, 'listing.json');
    if (!fs.existsSync(listingPath)) throw new Error(`missing listing.json for ${sku} (${listingPath})`);
    const d = JSON.parse(fs.readFileSync(listingPath, 'utf8'));
    if (d.sku !== sku) throw new Error(`listing.json sku mismatch in ${sku}: got ${d.sku}`);
    if (d.billing !== 'one_time') throw new Error(`${sku}: expected billing one_time, got ${d.billing}`);
    if (!Number.isInteger(d.price_cents) || d.price_cents < 50) {
      throw new Error(`${sku}: bad price_cents ${d.price_cents}`);
    }
    totalCents += d.price_cents;
    listings.push({
      sku,
      category: d.category,
      owner: 'platform',
      seller_id: null,
      title: d.name,
      // Headline first (punchy card text), then the full description.
      description: `${(d.headline || '').trim()} ${(d.description || '').trim()}`.trim(),
      price_cents: d.price_cents,
      billing: 'one_time',
      delivery_note: (d.delivery_note || '').trim(),
      image_url: `/covers/${sku}.jpg`,
      external_url: null,
    });
  }
  if (listings.length !== 50) throw new Error(`expected 50 products, got ${listings.length}`);
  const header = `'use strict';
/**
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *   node tools/generate-catalog-seed.js
 * Source: ~/workspace/digital-marketplace/products/<SKU>/listing.json
 * (50 platform-owned listings; the platform keeps 100% on these.)
 * Total catalog value: $${(totalCents / 100).toFixed(2)} (${listings.length} products).
 */
`;
  const body = `const CATALOG_LISTINGS = ${JSON.stringify(listings, null, 2)};\n\nmodule.exports = { CATALOG_LISTINGS };\n`;
  fs.writeFileSync(OUT, header + body);
  console.log(`Wrote ${OUT}: ${listings.length} listings, total $${(totalCents / 100).toFixed(2)}.`);
}

main();
