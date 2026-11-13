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

function upstreamReturns(rows, t) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, async json() { return { results: rows }; } });
  t.after(() => {
    global.fetch = originalFetch;
  });
}

const ALL_PRODUCTS = [
  product('ready-revisions', 2500),
  product('fresh-revisions', 5500),
  product('free-revisions', 1000),
  product('extra-revision', 500),
];

const freeReport = { id: 'tesla-01092026', name: 'Tesla', ticker: 'TSLA', isFree: true, price: 0, revisable: true };
const paidReport = { id: 'nokia-15072026', name: 'Nokia', ticker: 'NOKIA', isFree: false, price: 20, revisable: true };

test('only a paid or completed zero-total checkout grants the purchase', () => {
  assert.equal(checkout.isCompletedCheckout({ payment_status: 'paid' }), true);
  assert.equal(checkout.isCompletedCheckout({ status: 'complete', payment_status: 'no_payment_required', amount_total: 0 }), true);
  assert.equal(checkout.isCompletedCheckout({ status: 'open', payment_status: 'unpaid', amount_total: 0 }), false);
  assert.equal(checkout.isCompletedCheckout({ status: 'open', payment_status: 'unpaid' }), false);
});

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
  assert.equal(params.metadata.revisable, 'true');
  assert.equal(params.metadata.site, 'aiequityreports', 'every session names the site the shared account webhook should match');
  assert.equal(params.metadata.kind, 'free-revisions');
  assert.equal(checkout.isRevisionsOnly({ metadata: params.metadata }), true);
  assert.equal(params.metadata.withRevisions, 'true');
  assert.equal(params.metadata.revisionsAllowed, "3");
  assert.equal(params.metadata.price, '10');
  assert.equal(params.success_url, 'https://site.example/checkout/success.html?session_id={CHECKOUT_SESSION_ID}');
  assert.deepEqual(params.automatic_tax, { enabled: true }, 'Stripe Tax on every session');
  assert.deepEqual(params.tax_id_collection, { enabled: true }, 'EU buyers can enter a VAT id');
  assert.equal(params.billing_address_collection, 'required');
  assert.equal(params.customer_creation, 'always', 'invoice creation needs a Customer');
  assert.equal(params.invoice_creation.enabled, true);
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
    assert.equal(item.price_data.tax_behavior, 'inclusive', 'inline prices match the dashboard prices');
    assert.equal(item.price_data.product_data.tax_code, 'txcd_10000000');
    assert.match(item.price_data.product_data.name, /Nokia/);
    assert.equal(stripe.created[0].metadata.revisionsAllowed, '0');
  } finally {
    for (const [k, v] of [['STRIPE_READY_REPORT_PRODUCT_ID', saved.p], ['STRIPE_READY_REPORT_PRICE_ID', saved.k]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('ready+/fresh+ include two revisions by default and a free report three', async (t) => {
  upstreamReturns([{ companyName: 'Nokia', ticker: 'NOKIA.HE' }], t);
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await createReadyReportCheckout(stripe, paidReport, { withRevisions: true });
  await createFreshReportCheckout(stripe, { company: 'Nokia', ticker: 'NOKIA.HE', withRevisions: true });
  await createReadyReportCheckout(stripe, freeReport, { withRevisions: true });
  assert.equal(stripe.created[0].metadata.revisionsAllowed, '2');
  assert.equal(stripe.created[1].metadata.revisionsAllowed, '2');
  assert.equal(stripe.created[2].metadata.revisionsAllowed, '3');
  assert.deepEqual(stripe.created[1].line_items, [{ price: 'price_freshrevisions', quantity: 1 }]);
});

test('the env fallbacks apply per kind', async (t) => {
  upstreamReturns([{ companyName: 'Nokia', ticker: 'NOKIA.HE' }], t);
  process.env.REPORT_REVISIONS_INCLUDED = '5';
  process.env.FREE_REPORT_REVISIONS_INCLUDED = '4';
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await createFreshReportCheckout(stripe, { company: 'Nokia', ticker: 'NOKIA.HE', withRevisions: true });
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

test('a fresh order needs a selected ticker before creating a checkout', async () => {
  const stripe = fakeStripe();
  await assert.rejects(
    () => createFreshReportCheckout(stripe, { company: 'Nokia' }),
    err => err instanceof CheckoutError && err.status === 400 && /Select a company/.test(err.message),
  );
  assert.equal(stripe.created.length, 0);
});

test('fresh checkout resolves approved US and Nordic/Baltic listings and uses the canonical company', async (t) => {
  const tickers = ['TSLA', 'NOKIA.HE', 'VOLV-B.ST', 'EQNR.OL', 'NOVO-B.CO', 'SFG1T.TL'];
  upstreamReturns(tickers.map(ticker => ({ companyName: `Canonical ${ticker}`, ticker })), t);
  for (const ticker of tickers) {
    const stripe = fakeStripe({ products: ALL_PRODUCTS });
    await createFreshReportCheckout(stripe, {
      company: 'Client-supplied name', ticker: ` ${ticker.toLowerCase()} `,
      email: 'buyer@example.com', source: 'coverage', returnTo: '/reports/example-equity-report.html',
    });
    assert.equal(stripe.created.length, 1);
    assert.equal(stripe.created[0].metadata.company, `Canonical ${ticker}`);
    assert.equal(stripe.created[0].metadata.ticker, ticker);
    assert.equal(stripe.created[0].metadata.source, 'coverage');
    assert.equal(stripe.created[0].customer_email, 'buyer@example.com');
    assert.equal(stripe.created[0].cancel_url, 'https://site.example/reports/example-equity-report.html');
  }
});

test('fresh checkout uses the configured search upstream without a local Wisdom token', async (t) => {
  const originalToken = process.env.WISDOM_API_TOKEN;
  delete process.env.WISDOM_API_TOKEN;
  t.after(() => {
    if (originalToken === undefined) delete process.env.WISDOM_API_TOKEN;
    else process.env.WISDOM_API_TOKEN = originalToken;
  });
  upstreamReturns([], t);
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://files.valuatum.com/api/search-companies?q=AALLON.HE');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    return { ok: true, async json() { return { results: [{ companyName: 'Aallon Group', ticker: 'AALLON.HE' }] }; } };
  };
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await createFreshReportCheckout(stripe, { company: 'Aallon', ticker: 'AALLON.HE' });
  assert.equal(stripe.created.length, 1);
  assert.equal(stripe.created[0].metadata.company, 'Aallon Group');
  assert.equal(stripe.created[0].metadata.ticker, 'AALLON.HE');
});

test('a short ticker hidden by prefix results can be resolved by name without accepting another ticker', async (t) => {
  upstreamReturns([], t);
  global.fetch = async (url) => {
    const query = new URL(String(url)).searchParams.get('q');
    return { ok: true, async json() { return { results: query === 'F' ? [{ ticker: 'FXX', companyName: 'Other' }] : [{ ticker: 'F', companyName: 'Ford Motor Company' }] }; } };
  };
  const stripe = fakeStripe({ products: ALL_PRODUCTS });
  await createFreshReportCheckout(stripe, { company: 'Ford Motor Company', ticker: 'F' });
  assert.equal(stripe.created[0].metadata.ticker, 'F');
  assert.equal(stripe.created[0].metadata.company, 'Ford Motor Company');
});

test('fresh checkout refuses unsupported listings before a Stripe session even if Wisdom knows them', async (t) => {
  upstreamReturns([{ companyName: 'Ferrari', ticker: 'RACE.MI' }, { companyName: 'Rheinmetall', ticker: 'RHM.DE' }], t);
  for (const ticker of ['RACE.MI', 'RHM.DE', 'FARN.L']) {
    const stripe = fakeStripe();
    await assert.rejects(
      () => createFreshReportCheckout(stripe, { company: 'Example', ticker }),
      err => err instanceof CheckoutError && err.status === 400 && /request coverage/.test(err.message),
    );
    assert.equal(stripe.created.length, 0);
  }
});

test('an approved suffix alone cannot create a checkout for a missing or prefix-only Wisdom match', async (t) => {
  upstreamReturns([{ companyName: 'Different share class', ticker: 'MISSING-A' }], t);
  const stripe = fakeStripe();
  await assert.rejects(
    () => createFreshReportCheckout(stripe, { company: 'Missing', ticker: 'MISSING' }),
    err => err instanceof CheckoutError && err.status === 400 && /not covered/.test(err.message),
  );
  assert.equal(stripe.created.length, 0);
});

test('a failed Wisdom lookup returns a retryable error without creating a Stripe session', async (t) => {
  upstreamReturns([], t);
  global.fetch = async () => { throw new Error('upstream unavailable'); };
  const stripe = fakeStripe();
  await assert.rejects(
    () => createFreshReportCheckout(stripe, { company: 'Nokia', ticker: 'NOKIA.HE' }),
    err => err instanceof CheckoutError && err.status === 503 && /try again/.test(err.message),
  );
  assert.equal(stripe.created.length, 0);
});

test('an invalid upstream response cannot create a Stripe session', async (t) => {
  upstreamReturns([], t);
  global.fetch = async () => ({ ok: true, async json() { return { unexpected: [] }; } });
  const stripe = fakeStripe();
  await assert.rejects(
    () => createFreshReportCheckout(stripe, { company: 'Aallon', ticker: 'AALLON.HE' }),
    err => err instanceof CheckoutError && err.status === 503,
  );
  assert.equal(stripe.created.length, 0);
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
