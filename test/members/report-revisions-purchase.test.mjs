import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Revisions bought from the member area belong to the member even when they pay
// Stripe with another email address: the purchase must reach their report list
// and be publishable from there (Markus, 3.11.2026).
const require = createRequire(import.meta.url);
const state = { checkouts: [], publications: new Map(), event: null, claim: null, transactionFails: false, revisable: true };
function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
process.env.MEMBERS_STRIPE_WEBHOOK_SECRET = 'test';
process.env.ORDERS_TABLE = 'Orders';
delete process.env.SECRETS_SSM_PREFIX;

const profile = { userId: 'u1', role: 'analyst', tier: 'none', email: 'linkedin@example.com', name: 'Analyst' };
const report = { id: 'fortum-1', companyName: 'Fortum', ticker: 'FORTUM.HE', fileName: 'Fortum.pdf', isFree: false, price: 20 };
const session = {
  id: 'cs_rev', payment_status: 'paid', amount_total: 2500, currency: 'eur',
  customer_details: { email: 'company@example.com' },
  metadata: { site: 'aiequityreports', reportId: 'fortum-1', ticker: 'FORTUM.HE', withRevisions: 'true', userId: 'u1' },
};
const order = { id: 'cs_rev', ticker: 'FORTUM.HE', companyName: 'Fortum', status: 'DELIVERED', jobId: 'job', pdfFileName: 'Fortum.pdf', updatedAt: 'v1', revisionsUsed: 1, revisionsAllowed: 2 };

const stripeId = createRequire(require.resolve('../../server/lambda/members.js')).resolve('stripe');
require.cache[stripeId] = { id: stripeId, filename: stripeId, loaded: true, exports: function Stripe() {
  return {
    products: { list: async () => ({ data: [{ id: 'prod', active: true, metadata: { kind: 'ready-revisions' }, default_price: { id: 'price_readyrevisions', unit_amount: 2500, currency: 'eur' } }] }) },
    prices: { retrieve: async () => { throw new Error('no price configured'); } },
    checkout: { sessions: {
      retrieve: async () => structuredClone(session),
      create: async (params) => { state.checkouts.push(params); return { id: 'cs_new', url: 'https://checkout.example/cs_new' }; },
    } },
    webhooks: { constructEvent: () => state.event },
  };
} };
stub('../../server/aws/clients.js', { lambda: () => ({ send: async () => {} }) });
stub('../../server/search.js', { searchCompanies: async () => [] });
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: structuredClone(profile), deny: null }),
  frontendUrl: () => 'https://www.aiequityreports.com/members.html',
});
stub('../../server/email.js', { reportError: async () => {} });
stub('../../server/aws/catalog-aws.js', {
  buildCatalogAws: async () => ({ catalog: { reports: [report] }, sidecars: new Map([['Fortum.pdf', { provenance: { jobId: 'job' } }]]) }),
});
stub('../../server/aws/engine-jobs.js', {
  getRevisionJobs: async () => new Map([['job', {}]]),
  canRevise: () => state.revisable,
});
stub('../../server/aws/orders-store.js', { STATUS: { FAILED: 'FAILED' }, get: async id => (id === order.id ? structuredClone(order) : null) });
stub('../../server/members/store.js', {
  table: () => 'Members',
  getPublication: async (userId, genId) => (userId === 'u1' ? state.publications.get(genId) || null : null),
  getProfile: async id => (id === profile.userId ? structuredClone(profile) : null),
  listUserItems: async () => [...state.publications.values()],
  listPublicationIndex: async () => [],
  findPublicationForOrder: async () => null,
  audit: async () => {},
  runTransact: async (params) => {
    if (state.transactionFails) return false;
    const item = params.TransactItems.find(row => row.Put?.Item?.sk?.startsWith('PUB#'))?.Put.Item;
    if (item) {
      if (state.publications.has(item.sk.slice(4))) return false;
      state.publications.set(item.sk.slice(4), item);
    }
    state.lastTransact = params;
    return true;
  },
  claimStripeEvent: async () => (state.claim === 'done' ? { state: 'done' } : { state: 'claimed', leaseId: 'lease' }),
  finishStripeEvent: async () => { state.claim = 'done'; },
  releaseStripeEvent: async () => { state.claim = null; },
});

const { handler } = require('../../server/lambda/members.js');
const webhook = () => handler({ routeKey: 'POST /billing/webhook', headers: { 'stripe-signature': 'test' }, body: '{}' });

function reset() {
  state.publications.clear();
  state.claim = null;
  state.transactionFails = false;
  state.revisable = true;
  state.event = { id: 'evt_rev', type: 'checkout.session.completed', data: { object: session } };
}

test('the member checkout carries the member and leaves the Stripe email to the buyer', async () => {
  reset();
  const res = await handler({ routeKey: 'POST /billing/report-revisions-checkout', headers: {}, body: JSON.stringify({ reportId: 'fortum-1' }) });
  assert.equal(res.statusCode, 200, res.body);
  const params = state.checkouts.at(-1);
  assert.equal(params.metadata.userId, 'u1');
  assert.equal(params.metadata.withRevisions, 'true');
  assert.equal(params.customer_email, undefined);
});

test('an unknown or unrevisable report opens no checkout', async () => {
  reset();
  const count = state.checkouts.length;
  const missing = await handler({ routeKey: 'POST /billing/report-revisions-checkout', headers: {}, body: JSON.stringify({ reportId: 'nope' }) });
  assert.equal(missing.statusCode, 404);
  state.revisable = false;
  const stale = await handler({ routeKey: 'POST /billing/report-revisions-checkout', headers: {}, body: JSON.stringify({ reportId: 'fortum-1' }) });
  assert.equal(stale.statusCode, 409);
  assert.equal(state.checkouts.length, count);
});

test('the paid purchase reaches the member list and can be published with a different Stripe email', async () => {
  reset();
  assert.equal((await webhook()).statusCode, 200);
  const publication = state.publications.get('cs_rev');
  assert.equal(publication.paid, true);
  assert.equal(publication.private, true);

  const list = JSON.parse((await handler({ routeKey: 'GET /generations', headers: {} })).body);
  assert.deepEqual(list.generations.map(g => g.genId), ['cs_rev']);

  const submit = await handler({ routeKey: 'POST /generations/{genId}/submit', pathParameters: { genId: 'cs_rev' }, headers: {}, body: '{}' });
  assert.equal(submit.statusCode, 200, submit.body);
});

test('a redelivered event is harmless and a failed link is retried', async () => {
  reset();
  assert.equal((await webhook()).statusCode, 200);
  state.claim = null;
  assert.equal((await webhook()).statusCode, 200);

  reset();
  state.transactionFails = true;
  assert.equal((await webhook()).statusCode, 500);
  state.transactionFails = false;
  assert.equal((await webhook()).statusCode, 200);
  assert.ok(state.publications.has('cs_rev'));
});

test('a guest purchase with another email still cannot be published', async () => {
  reset();
  const guest = structuredClone(session);
  delete guest.metadata.userId;
  const original = session.metadata;
  session.metadata = guest.metadata;
  try {
    const res = await handler({ routeKey: 'POST /generations/{genId}/submit', pathParameters: { genId: 'cs_rev' }, headers: {}, body: '{}' });
    assert.equal(res.statusCode, 403);
  } finally {
    session.metadata = original;
  }
});

test('the buy button uses the member door when signed in and the guest door otherwise', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const script = readFileSync(new URL('../../js/script.js', import.meta.url), 'utf8');
  const fn = script.match(/async function submitReadyReportCheckout[\s\S]*?\n}\r?\n/)[0];
  async function buy(token, respond, withRevisions = true) {
    const calls = [];
    const context = {
      localStorage: token ? { memberToken: token } : {},
      location: { hostname: 'www.aiequityreports.com', href: '' },
      window: { location: { href: '' } },
      trackEvent: () => {},
      checkoutFailureMessage: () => '',
      alert: () => {},
      fetch: async (url, options) => { calls.push({ url, auth: options.headers.authorization }); return respond(url); },
    };
    vm.createContext(context);
    vm.runInContext(fn, context);
    await context.submitReadyReportCheckout({ dataset: {}, style: {}, textContent: '' }, 'fortum-1', withRevisions);
    return calls;
  }
  const ok = { status: 200, json: async () => ({ url: 'https://checkout.example/x' }) };
  const member = await buy('tok', () => ok);
  assert.deepEqual(member, [{ url: 'https://members.aiequityreports.com/billing/report-revisions-checkout', auth: 'Bearer tok' }]);

  assert.deepEqual((await buy(null, () => ok)).map(c => c.url), ['/api/create-checkout']);
  assert.deepEqual((await buy('tok', () => ok, false)).map(c => c.url), ['/api/create-checkout']);

  const expired = await buy('tok', url => (url.startsWith('https://members') ? { status: 401, json: async () => ({}) } : ok));
  assert.deepEqual(expired.map(c => c.url), ['https://members.aiequityreports.com/billing/report-revisions-checkout', '/api/create-checkout']);

  const down = await buy('tok', (url) => { if (url.startsWith('https://members')) throw new TypeError('network'); return ok; });
  assert.equal(down.at(-1).url, '/api/create-checkout');
});
