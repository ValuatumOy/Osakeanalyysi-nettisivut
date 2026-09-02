import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const checkout = require('../../server/checkout.js');
const { CheckoutError, createReadyReportCheckout, createExtraRoundsCheckout, createFreshReportCheckout, cancelPath } = checkout;

// A Stripe client that knows the revision products by their `kind` tag and
// records every checkout session it is asked to create.
function fakeStripe({ products = [] } = {}) {
  const created = [];
  return {
    created,
    products: {
      retrieve: async () => { throw new Error('no product configured'); },
      list: async () => ({ data: products }),
    },
    prices: { retrieve: async () => { throw new Error('no price configured'); } },
    checkout: {
      sessions: {
        create: async (params) => { created.push(params); return { id: 'cs_test', url: 'https://checkout.example/cs_test', ...params }; },
      },
    },
  };
}

function product(kind, unitAmount) {
  const slug = kind.replace(/-/g, '');
  return { id: `prod_${slug}`, metadata: { kind }, default_price: { id: `price_${slug}`, unit_amount: unitAmount, currency: 'eur' } };
}

const ALL_PRODUCTS = [
  product('ready-revisions', 2500),
  product('fresh-revisions', 5500),
  product('free-revisions', 1000),
  product('extra-revision', 500),
];

const freeReport = { id: 'tesla-01092026', name: 'Tesla', ticker: 'TSLA', isFree: true, price: 0, revisable: true };
const paidReport = { id: 'nokia-15072026', name: 'Nokia', ticker: 'NOKIA', isFree: false, price: 20, revisable: true };

test.beforeEach(() => {
  delete process.env.REPORT_REVISIONS_INCLUDED;
  delete process.env.FREE_REPORT_REVISIONS_INCLUDED;
  delete process.env.EXTRA_REVISION_EUR;
  process.env.SITE_URL = 'https://site.example/';
});

test('a free report cannot be bought on its own', async () => {
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await assert.rejects(() => createReadyReportCheckout(stripe, freeReport, { withRevisions: false }), (err) => {
    assert.ok(err instanceof CheckoutError);
    assert.equal(err.status, 400);
    return true;
  });
  assert.equal(stripe.created.length, 0);
});

test('a free report with revisions sells the free-revisions tier with the included count', async () => {
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  const session = await createReadyReportCheckout(stripe, freeReport, { withRevisions: true });
  assert.equal(session.url, 'https://checkout.example/cs_test');
  const [params] = stripe.created;
  assert.deepEqual(params.line_items, [{ price: 'price_freerevisions', quantity: 1 }]);
  assert.equal(params.metadata.reportId, 'tesla-01092026');
  assert.equal(params.metadata.site, 'aiequityreports', 'every session names the site the shared account webhook should match');
  assert.equal(params.metadata.kind, 'free-revisions');
  assert.equal(checkout.isRevisionsOnly({ metadata: params.metadata }), true);
  assert.equal(params.metadata.withRevisions, 'true');
  assert.equal(params.metadata.revisionsAllowed, "3");
  assert.equal(params.metadata.price, '10');
  assert.equal(params.success_url, 'https://site.example/checkout/success.html?session_id={CHECKOUT_SESSION_ID}');
});

test('a free report that the engine cannot revise refuses revisions', async () => {
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await assert.rejects(
    () => createReadyReportCheckout(stripe, { ...freeReport, revisable: false }, { withRevisions: true }),
    (err) => err instanceof CheckoutError && err.status === 400,
  );
});

test('a missing report is a 404, not a crash', async () => {
  await assert.rejects(
    () => createReadyReportCheckout(fakeStripe(), null, {}),
    (err) => err instanceof CheckoutError && err.status === 404,
  );
});

test('a paid report with revisions sells the ready-revisions tier', async () => {
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await createReadyReportCheckout(stripe, paidReport, { withRevisions: true });
  assert.deepEqual(stripe.created[0].line_items, [{ price: 'price_readyrevisions', quantity: 1 }]);
  assert.equal(stripe.created[0].metadata.kind, 'ready-revisions');
  assert.equal(checkout.isRevisionsOnly({ metadata: stripe.created[0].metadata }), false);
});

test('a standard ready report falls back to an inline amount when Stripe has no price', async () => {
  const saved = { p: process.env.STRIPE_READY_REPORT_PRODUCT_ID, k: process.env.STRIPE_READY_REPORT_PRICE_ID };
  process.env.STRIPE_READY_REPORT_PRODUCT_ID = '';
  process.env.STRIPE_READY_REPORT_PRICE_ID = '';
  try {
    const stripe = fakeStripe();
    await createReadyReportCheckout(stripe, paidReport, {});
    const [item] = stripe.created[0].line_items;
    assert.equal(item.price_data.unit_amount, 2000);
    assert.match(item.price_data.product_data.name, /Nokia/);
    assert.equal(stripe.created[0].metadata.revisionsAllowed, '0');
  } finally {
    for (const [k, v] of [['STRIPE_READY_REPORT_PRODUCT_ID', saved.p], ['STRIPE_READY_REPORT_PRICE_ID', saved.k]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('ready+/fresh+ include two revisions by default and a free report three', async () => {
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await createReadyReportCheckout(stripe, paidReport, { withRevisions: true });
  await createFreshReportCheckout(stripe, { company: 'Nokia', withRevisions: true });
  await createReadyReportCheckout(stripe, freeReport, { withRevisions: true });
  assert.equal(stripe.created[0].metadata.revisionsAllowed, '2');
  assert.equal(stripe.created[1].metadata.revisionsAllowed, '2');
  assert.equal(stripe.created[2].metadata.revisionsAllowed, '3');
  assert.deepEqual(stripe.created[1].line_items, [{ price: 'price_freshrevisions', quantity: 1 }]);
});

test('the env fallbacks apply per kind', async () => {
  process.env.REPORT_REVISIONS_INCLUDED = '5';
  process.env.FREE_REPORT_REVISIONS_INCLUDED = '4';
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await createFreshReportCheckout(stripe, { company: 'Nokia', withRevisions: true });
  await createReadyReportCheckout(stripe, freeReport, { withRevisions: true });
  assert.equal(stripe.created[0].metadata.revisionsAllowed, '5');
  assert.equal(stripe.created[1].metadata.revisionsAllowed, '4');
});

test('the Stripe product\'s own metadata.revisions wins over every fallback', async () => {
  process.env.REPORT_REVISIONS_INCLUDED = '5';
  const tagged = ALL_PRODUCTS.map(p => (p.metadata.kind === 'ready-revisions' ? { ...p, metadata: { ...p.metadata, revisions: '7' } } : p));
  const stripe = fakeStripe({ products: tagged });
  await createReadyReportCheckout(stripe, paidReport, { withRevisions: true });
  assert.equal(stripe.created[0].metadata.revisionsAllowed, '7');
});

test('a fresh order needs a company name', async () => {
  await assert.rejects(
    () => createFreshReportCheckout(fakeStripe(), { company: '  ' }),
    (err) => err instanceof CheckoutError && err.status === 400,
  );
});

test('extra rounds use the extra-revision product and clamp the quantity', async () => {
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  const result = await createExtraRoundsCheckout(stripe, {
    orderId: 'cs_order', rounds: 25, email: 'a@b.c', companyLabel: 'Tesla',
    successUrl: 'https://site.example/ok', cancelUrl: 'https://site.example/no',
    extraMetadata: { userId: 'u1', generationId: 'spoofed' },
  });
  assert.equal(result.rounds, 10);
  assert.equal(result.priceEur, 50);
  const [params] = stripe.created;
  assert.deepEqual(params.line_items, [{ price: 'price_extrarevision', quantity: 10 }]);
  assert.equal(params.metadata.extraRevisions, '10');
  assert.equal(params.metadata.generationId, 'cs_order', 'caller metadata cannot override the credited order');
  assert.equal(params.metadata.userId, 'u1');
  assert.equal(params.customer_email, 'a@b.c');
});

test('extra rounds fall back to the env price when no product exists yet', async () => {
  process.env.EXTRA_REVISION_EUR = '7';
  const stripe = fakeStripe();
  const result = await createExtraRoundsCheckout(stripe, {
    orderId: 'cs_order', rounds: 2, successUrl: 'https://s/ok', cancelUrl: 'https://s/no',
  });
  assert.equal(result.priceEur, 14);
  const [item] = stripe.created[0].line_items;
  assert.equal(item.quantity, 2);
  assert.equal(item.price_data.unit_amount, 700);
});

test('the cancel path only ever points back at this site', () => {
  assert.equal(cancelPath('/reports/tesla-equity-report.html'), '/reports/tesla-equity-report.html');
  assert.equal(cancelPath('https://evil.example/'), '/reports.html#order-fresh');
  assert.equal(cancelPath('//evil.example'), '/reports.html#order-fresh');
  assert.equal(cancelPath('/a/../b'), '/reports.html#order-fresh');
  assert.equal(cancelPath(''), '/reports.html#order-fresh');
});

test('the webhook recognises its own sessions by the site tag, with the pre-tag fields as fallback', () => {
  assert.equal(checkout.isOurSession({ metadata: { site: 'aiequityreports' } }), true);
  assert.equal(checkout.isOurSession({ metadata: { reportId: 'tesla-01092026' } }), true);
  assert.equal(checkout.isOurSession({ metadata: { isFresh: 'true' } }), true);
  assert.equal(checkout.isOurSession({ metadata: { reportType: 'dk_ai_credit_risk', companyName: 'JYSK A/S' } }), false);
  assert.equal(checkout.isOurSession({ metadata: { analysisGenId: 'g1' } }), false);
  assert.equal(checkout.isOurSession({}), false);
});
