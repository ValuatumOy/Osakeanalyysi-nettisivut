#!/usr/bin/env node
// One-time setup: create the report shop's products/prices in Stripe and set
// each product's default price. server/stripe-pricing.js finds every one of
// them by its `kind` metadata tag, so nothing needs to be pasted into env
// vars. In live mode the two base products already exist under the names
// below and are adopted (tagged), not recreated.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-revisions.mjs
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup-revisions.mjs --live
//
// Test mode is the default; a live key is refused without --live. Idempotent:
// a product already tagged with the kind is reused, and an existing price with
// the same amount is reused rather than duplicated. A product whose default
// price differs from the amount below gets a new default price — the old one
// stays active in Stripe so past sessions keep resolving.

import Stripe from 'stripe';

const live = process.argv.includes('--live');
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY');
  process.exit(1);
}
if (live && !key.startsWith('sk_live_')) {
  console.error('Refusing: --live given but STRIPE_SECRET_KEY is not a live key');
  process.exit(1);
}
if (!live && !key.startsWith('sk_test_')) {
  console.error('Refusing: STRIPE_SECRET_KEY is not a test key (pass --live to touch the live account)');
  process.exit(1);
}

const stripe = new Stripe(key);
const stage = live ? 'prod' : 'test';
const suffix = live ? '' : ' (test)';

// Amounts are the current business decision for each tier, in cents.
// `revisions` is how many revision requests a "+ Revisions" tier includes;
// it is written to the product's metadata, which is where the app reads it.
const TIERS = [
  {
    kind: 'ready',
    name: `AI Equity Report (Ready)${suffix}`,
    unitAmount: 2000,
    envProduct: 'STRIPE_READY_REPORT_PRODUCT_ID',
    envPrice: 'STRIPE_READY_REPORT_PRICE_ID',
  },
  {
    kind: 'fresh',
    name: `AI Equity Report (Freshly Generated)${suffix}`,
    unitAmount: 5000,
    envProduct: 'STRIPE_FRESH_REPORT_PRODUCT_ID',
    envPrice: 'STRIPE_FRESH_REPORT_PRICE_ID',
  },
  {
    kind: 'ready-revisions',
    name: `AI Equity Report (Ready) + Revisions${suffix}`,
    unitAmount: 2500,
    revisions: 2,
    envProduct: 'STRIPE_READY_REPORT_REVISIONS_PRODUCT_ID',
    envPrice: 'STRIPE_READY_REPORT_REVISIONS_PRICE_ID',
  },
  {
    kind: 'fresh-revisions',
    name: `AI Equity Report (Fresh) + Revisions${suffix}`,
    unitAmount: 5500,
    revisions: 2,
    envProduct: 'STRIPE_FRESH_REPORT_REVISIONS_PRODUCT_ID',
    envPrice: 'STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID',
  },
  {
    kind: 'free-revisions',
    name: `AI Equity Report (Free) + Revisions${suffix}`,
    unitAmount: 1000,
    revisions: 3,
    envProduct: 'STRIPE_FREE_REPORT_REVISIONS_PRODUCT_ID',
    envPrice: 'STRIPE_FREE_REPORT_REVISIONS_PRICE_ID',
  },
  {
    kind: 'extra-revision',
    name: `Extra Revision Round${suffix}`,
    unitAmount: 500,
    envProduct: 'STRIPE_EXTRA_REVISION_PRODUCT_ID',
    envPrice: 'STRIPE_EXTRA_REVISION_PRICE_ID',
  },
];

async function findOrCreateProduct(name, kind, revisions) {
  // The app resolves by metadata.kind, so that is the identity here too. A
  // product created by hand under the right name (before the tag existed) is
  // adopted and tagged rather than duplicated. List + exact equality, because
  // products.search does token matching and these names share most tokens.
  const metadata = { kind, stage, ...(revisions ? { revisions: String(revisions) } : {}) };
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.data.find(p => p.metadata?.kind === kind) || products.data.find(p => p.name === name);
  if (!existing) return stripe.products.create({ name, metadata });
  const stale = Object.entries(metadata).some(([k, v]) => existing.metadata?.[k] !== v);
  return stale ? stripe.products.update(existing.id, { metadata }) : existing;
}

async function findOrCreatePrice(productId, unitAmount) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = prices.data.find(p => p.unit_amount === unitAmount && p.currency === 'eur' && !p.recurring);
  if (match) return match;
  return stripe.prices.create({ product: productId, currency: 'eur', unit_amount: unitAmount });
}

const envLines = [];
for (const tier of TIERS) {
  const product = await findOrCreateProduct(tier.name, tier.kind, tier.revisions);
  const price = await findOrCreatePrice(product.id, tier.unitAmount);
  // The app reads a product's default_price, so changing the price in the
  // Stripe dashboard later updates checkout without a code change.
  // products.create() does not set this automatically.
  if (product.default_price !== price.id) {
    await stripe.products.update(product.id, { default_price: price.id });
  }
  console.error(`${tier.kind}: product ${product.id}, price ${price.id} (${tier.unitAmount / 100} EUR${tier.revisions ? `, ${tier.revisions} revisions` : ''}, ${stage})`);
  envLines.push(`${tier.envProduct}=${product.id}`);
  envLines.push(`${tier.envPrice}=${price.id}`);
}

console.error(
  '\nDone. server/stripe-pricing.js finds these products by their `kind` metadata tag, '
  + 'so no env vars are needed. For reference, or to override which product/price is used:\n',
);
console.log(envLines.join('\n'));
