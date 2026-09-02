import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getStripePricing, getPublicPricing } = require('../../server/stripe-pricing.js');

function failingStripe() {
  return {
    products: {
      retrieve: async () => { throw new Error('no network in tests'); },
      list: async () => { throw new Error('no network in tests'); },
    },
    prices: { retrieve: async () => { throw new Error('no network in tests'); } },
  };
}

test('ready/fresh kinds fall back to their hardcoded unit amount when Stripe is unreachable', async () => {
  const pricing = await getStripePricing(failingStripe(), 'ready', { bypassCache: true });
  assert.equal(pricing.unitAmount, 2000);
  assert.equal(pricing.currency, 'eur');
});

test('a "+ revisions" kind throws instead of silently falling back when unconfigured', async () => {
  const saved = {
    p: process.env.STRIPE_FRESH_REPORT_REVISIONS_PRODUCT_ID,
    k: process.env.STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID,
  };
  delete process.env.STRIPE_FRESH_REPORT_REVISIONS_PRODUCT_ID;
  delete process.env.STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID;
  try {
    await assert.rejects(
      () => getStripePricing(failingStripe(), 'fresh-revisions', { bypassCache: true }),
      /No Stripe price configured for "fresh-revisions"/,
    );
  } finally {
    if (saved.p !== undefined) process.env.STRIPE_FRESH_REPORT_REVISIONS_PRODUCT_ID = saved.p;
    if (saved.k !== undefined) process.env.STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID = saved.k;
  }
});

test('a "+ revisions" kind resolves once a real price id is configured', async () => {
  const saved = process.env.STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID;
  process.env.STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID = 'price_test123';
  try {
    const stripe = {
      products: { retrieve: async () => { throw new Error('no product configured'); } },
      prices: { retrieve: async (id) => ({ id, unit_amount: 3000, currency: 'eur' }) },
    };
    const pricing = await getStripePricing(stripe, 'fresh-revisions', { bypassCache: true });
    assert.equal(pricing.unitAmount, 3000);
    assert.equal(pricing.priceId, 'price_test123');
  } finally {
    if (saved === undefined) delete process.env.STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID;
    else process.env.STRIPE_FRESH_REPORT_REVISIONS_PRICE_ID = saved;
  }
});

test('a "+ revisions" kind resolves by metadata.kind with no env vars set at all', async () => {
  const saved = {
    p: process.env.STRIPE_READY_REPORT_REVISIONS_PRODUCT_ID,
    k: process.env.STRIPE_READY_REPORT_REVISIONS_PRICE_ID,
  };
  delete process.env.STRIPE_READY_REPORT_REVISIONS_PRODUCT_ID;
  delete process.env.STRIPE_READY_REPORT_REVISIONS_PRICE_ID;
  try {
    const stripe = {
      products: {
        list: async () => ({
          data: [
            { id: 'prod_other1', metadata: { kind: 'fresh-revisions' }, default_price: { id: 'price_other1', unit_amount: 7500, currency: 'eur' } },
            { id: 'prod_readyrev1', metadata: { kind: 'ready-revisions' }, default_price: { id: 'price_readyrev1', unit_amount: 3500, currency: 'eur' } },
          ],
        }),
      },
    };
    const pricing = await getStripePricing(stripe, 'ready-revisions', { bypassCache: true });
    assert.equal(pricing.unitAmount, 3500);
    assert.equal(pricing.priceId, 'price_readyrev1');
  } finally {
    if (saved.p !== undefined) process.env.STRIPE_READY_REPORT_REVISIONS_PRODUCT_ID = saved.p;
    if (saved.k !== undefined) process.env.STRIPE_READY_REPORT_REVISIONS_PRICE_ID = saved.k;
  }
});

test('the free-revisions kind resolves by metadata.kind like the other revision tiers', async () => {
  const stripe = {
    products: {
      retrieve: async () => { throw new Error('should not be called'); },
      list: async () => ({ data: [
        { id: 'prod_x', metadata: { kind: 'ready-revisions' }, default_price: { id: 'price_x', unit_amount: 2500, currency: 'eur' } },
        { id: 'prod_f', metadata: { kind: 'free-revisions' }, default_price: { id: 'price_f', unit_amount: 1000, currency: 'eur' } },
      ] }),
    },
    prices: { retrieve: async () => { throw new Error('no price configured'); } },
  };
  const pricing = await getStripePricing(stripe, 'free-revisions', { bypassCache: true });
  assert.equal(pricing.priceId, 'price_f');
  assert.equal(pricing.unitAmount, 1000);
});

test('the extra-revision kind falls back to EXTRA_REVISION_EUR instead of throwing', async () => {
  const saved = process.env.EXTRA_REVISION_EUR;
  process.env.EXTRA_REVISION_EUR = '6';
  try {
    const pricing = await getStripePricing(failingStripe(), 'extra-revision', { bypassCache: true });
    assert.equal(pricing.priceId, null);
    assert.equal(pricing.unitAmount, 600);
  } finally {
    if (saved === undefined) delete process.env.EXTRA_REVISION_EUR;
    else process.env.EXTRA_REVISION_EUR = saved;
  }
});

test('getPublicPricing lists the products once and exposes the free tier', async () => {
  const saved = process.env.FORECAST_REVISIONS_ENABLED;
  process.env.FORECAST_REVISIONS_ENABLED = 'true';
  let lists = 0;
  const stripe = {
    products: {
      retrieve: async () => { throw new Error('no network in tests'); },
      list: async () => { lists += 1; return { data: [
        { id: 'prod_f', metadata: { kind: 'free-revisions' }, default_price: { id: 'price_f', unit_amount: 1000, currency: 'eur' } },
      ] }; },
    },
    prices: { retrieve: async () => { throw new Error('no network in tests'); } },
  };
  try {
    const pricing = await getPublicPricing(stripe, { bypassCache: true });
    assert.equal(lists, 1);
    assert.equal(pricing.freeRevisions.label, '€10.00');
    assert.equal(pricing.freeRevisions.included, 3);
    assert.equal(pricing.readyRevisions, null);
    assert.equal(pricing.revisionsIncluded, 2);
  } finally {
    if (saved === undefined) delete process.env.FORECAST_REVISIONS_ENABLED;
    else process.env.FORECAST_REVISIONS_ENABLED = saved;
  }
});

test('under a test key the base kinds resolve by metadata.kind instead of the live product id', async () => {
  const otherMode = (id) => new Error(`No such product: '${id}'; a similar object exists in live mode, but a test mode key was used to make this request.`);
  const stripe = {
    products: {
      retrieve: async (id) => { throw otherMode(id); },
      list: async () => ({ data: [
        { id: 'prod_t', metadata: { kind: 'ready' }, default_price: { id: 'price_t', unit_amount: 2000, currency: 'eur' } },
      ] }),
    },
    prices: { retrieve: async () => { throw new Error('should not be reached'); } },
  };
  const pricing = await getStripePricing(stripe, 'ready', { bypassCache: true });
  assert.equal(pricing.priceId, 'price_t');
});
