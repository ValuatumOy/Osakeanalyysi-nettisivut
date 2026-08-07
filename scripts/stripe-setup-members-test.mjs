#!/usr/bin/env node
// One-time setup: create the membership subscription products/prices in Stripe
// TEST mode and print the JSON for the members-stripe-prices SSM parameter.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-members-test.mjs
//
// Idempotent-ish: looks up existing products by name before creating.

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

const PLANS = [
  { plan: 'investor', name: 'AI Equity Reports — Investor (test)', prices: { month: 1900, year: 19000 } },
  { plan: 'investor_plus', name: 'AI Equity Reports — Investor Plus (test)', prices: { month: 3900, year: 39000 } },
  { plan: 'coverage', name: 'AI Equity Reports — Company Coverage (test)', prices: { year: 5900 } },
];

async function findOrCreateProduct(name, plan) {
  const existing = await stripe.products.search({ query: `name:"${name}" AND active:"true"` });
  if (existing.data[0]) return existing.data[0];
  return stripe.products.create({ name, metadata: { plan, stage: 'test' } });
}

async function findOrCreatePrice(productId, interval, unitAmount) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = prices.data.find(p =>
    p.recurring?.interval === interval && p.unit_amount === unitAmount && p.currency === 'eur');
  if (match) return match;
  return stripe.prices.create({
    product: productId,
    currency: 'eur',
    unit_amount: unitAmount,
    recurring: { interval },
  });
}

const out = {};
for (const { plan, name, prices } of PLANS) {
  const product = await findOrCreateProduct(name, plan);
  out[plan] = {};
  for (const [interval, unitAmount] of Object.entries(prices)) {
    const price = await findOrCreatePrice(product.id, interval, unitAmount);
    out[plan][interval] = price.id;
    console.error(`${plan} ${interval}: ${price.id} (${unitAmount / 100} €)`);
  }
}

console.error('\nStore this as the members-stripe-prices SSM parameter:\n');
console.log(JSON.stringify(out));
console.error(`\naws ssm put-parameter --profile valuatum-pdf --region eu-west-1 \\
  --name /aiequityreports/test/members-stripe-prices --type SecureString --overwrite \\
  --value '${JSON.stringify(out)}'`);
