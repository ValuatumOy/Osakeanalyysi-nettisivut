#!/usr/bin/env node
// One-time prod rollout: create the membership products/prices and the members
// webhook endpoint in Stripe LIVE mode, and print the two SSM parameters.
// Mirror of stripe-setup-members-test.mjs with live names (no "(test)" suffix).
//
//   STRIPE_SECRET_KEY=sk_live_... MEMBERS_API_URL=https://members.aiequityreports.com \
//     node scripts/stripe-setup-members-live.mjs
//
// Idempotent-ish: looks up existing products by name and the webhook by URL
// before creating. The webhook signing secret is only shown by Stripe at
// creation time, so an existing endpoint prints a warning instead of a secret.

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
const apiUrl = (process.env.MEMBERS_API_URL || '').replace(/\/$/, '');
if (!key || !key.startsWith('sk_live_')) {
  console.error('Refusing: STRIPE_SECRET_KEY must be an sk_live_ key for the prod rollout');
  process.exit(1);
}
if (!apiUrl.startsWith('https://')) {
  console.error('Set MEMBERS_API_URL, e.g. https://members.aiequityreports.com');
  process.exit(1);
}

const stripe = new Stripe(key);

const PLANS = [
  { plan: 'investor', name: 'AI Equity Reports — Investor', prices: { month: 1900, year: 19000 } },
  { plan: 'investor_plus', name: 'AI Equity Reports — Investor Plus', prices: { month: 3900, year: 39000 } },
  { plan: 'coverage', name: 'AI Equity Reports — Company Coverage', prices: { year: 5900 } },
];
const ONE_OFF = [
  { plan: 'fresh', name: 'AI Equity Reports — Fresh Report', prices: { list: 5000, member: 4000 } },
];

async function findOrCreateProduct(name, plan) {
  const existing = await stripe.products.search({ query: `name:"${name}" AND active:"true"` });
  if (existing.data[0]) return existing.data[0];
  return stripe.products.create({ name, metadata: { plan, stage: 'prod' } });
}

async function findOrCreatePrice(productId, interval, unitAmount) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = prices.data.find(p =>
    p.recurring?.interval === interval && p.unit_amount === unitAmount && p.currency === 'eur');
  if (match) return match;
  return stripe.prices.create({
    product: productId, currency: 'eur', unit_amount: unitAmount, recurring: { interval },
  });
}

async function findOrCreateOneOffPrice(productId, unitAmount) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = prices.data.find(p => !p.recurring && p.unit_amount === unitAmount && p.currency === 'eur');
  if (match) return match;
  return stripe.prices.create({ product: productId, currency: 'eur', unit_amount: unitAmount });
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
for (const { plan, name, prices } of ONE_OFF) {
  const product = await findOrCreateProduct(name, plan);
  out[plan] = {};
  for (const [name2, unitAmount] of Object.entries(prices)) {
    const price = await findOrCreateOneOffPrice(product.id, unitAmount);
    out[plan][name2] = price.id;
    console.error(`${plan} ${name2}: ${price.id} (${unitAmount / 100} €)`);
  }
}

// The exact event set server/lambda/members.js switches on.
const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];
const webhookUrl = `${apiUrl}/billing/webhook`;
const hooks = await stripe.webhookEndpoints.list({ limit: 100 });
let hook = hooks.data.find(h => h.url === webhookUrl);
let hookSecret = null;
if (hook) {
  console.error(`webhook already exists (${hook.id}) — its signing secret is only shown at creation; roll it in the dashboard if it is lost`);
} else {
  hook = await stripe.webhookEndpoints.create({ url: webhookUrl, enabled_events: EVENTS });
  hookSecret = hook.secret;
  console.error(`webhook created: ${hook.id}`);
}

console.log(JSON.stringify({ prices: out, webhookSecret: hookSecret }));
