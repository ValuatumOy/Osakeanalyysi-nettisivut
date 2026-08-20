#!/usr/bin/env node
// One-time setup: create the "+ Revisions" report products/prices in Stripe
// TEST mode and print the env vars to set (STRIPE_{READY,FRESH}_REPORT_REVISIONS_*).
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-revisions-test.mjs
//
// Idempotent-ish: looks up existing products by name before creating.
//
// The unit amounts below are placeholders for testing checkout, not a
// business pricing decision — adjust freely, this only touches Stripe TEST
// mode.

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY (must be an sk_test_ key)');
  process.exit(1);
}
if (!key.startsWith('sk_test_')) {
  console.error('Refusing: STRIPE_SECRET_KEY is not a TEST mode key');
  process.exit(1);
}

const stripe = new Stripe(key);

const TIERS = [
  {
    kind: 'ready-revisions',
    name: 'AI Equity Report + Revisions (test)',
    unitAmount: 3500, // placeholder: standard ready report is €20
    envProduct: 'STRIPE_READY_REPORT_REVISIONS_PRODUCT_ID',
    envPrice: 'STRIPE_READY_REPORT_REVISIONS_PRICE_ID',
  },
  {
    kind: 'fresh-revisions',
    name: 'Fresh AI Equity Report + Revisions (test)',
    unitAmount: 7500, // placeholder: standard fresh report is €50
    envProduct: 'STRIPE_FRESH_REPORT_REVISIONS_PRODUCT_ID',
    envPrice: 'STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID',
  },
];

async function findOrCreateProduct(name, kind) {
  // stripe.products.search does token matching, not exact-phrase matching —
  // "AI Equity Report + Revisions (test)" and "Fresh AI Equity Report +
  // Revisions (test)" share every token except "Fresh", so a search-based
  // lookup can return the wrong product. List + exact-equality instead.
  const products = await stripe.products.list({ active: true, limit: 100 });
  const match = products.data.find(p => p.name === name);
  if (match) return match;
  return stripe.products.create({ name, metadata: { kind, stage: 'test' } });
}

async function findOrCreatePrice(productId, unitAmount) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = prices.data.find(p => p.unit_amount === unitAmount && p.currency === 'eur' && !p.recurring);
  if (match) return match;
  return stripe.prices.create({ product: productId, currency: 'eur', unit_amount: unitAmount });
}

const envLines = [];
for (const tier of TIERS) {
  const product = await findOrCreateProduct(tier.name, tier.kind);
  const price = await findOrCreatePrice(product.id, tier.unitAmount);
  // Product IDs are meant to be the primary pricing source (see
  // .env.example): the app reads a product's default_price, so changing the
  // price in the Stripe dashboard later updates checkout without a code
  // change. products.create() does not set this automatically.
  if (product.default_price !== price.id) {
    await stripe.products.update(product.id, { default_price: price.id });
  }
  console.error(`${tier.kind}: product ${product.id}, price ${price.id} (${tier.unitAmount / 100} EUR)`);
  envLines.push(`${tier.envProduct}=${product.id}`);
  envLines.push(`${tier.envPrice}=${price.id}`);
}

console.error(
  '\nDone. server/stripe-pricing.js finds these products by their `kind` metadata tag, '
  + 'so no env vars are needed. For reference, or to override which product/price is used:\n',
);
console.log(envLines.join('\n'));
