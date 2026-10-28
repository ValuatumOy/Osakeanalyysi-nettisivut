import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = {};
function reset() {
  Object.assign(state, {
    profile: { userId: 'u1', role: 'analyst', name: 'Analyst', email: 'analyst@example.com' },
    index: { genId: 'parent', userId: 'author', status: 'published', companyId: 'NOKIA.HE', analystName: 'Author', priceEur: 20 },
    orders: new Map([['parent', { id: 'parent', status: 'DELIVERED', jobId: 'job', pdfFileName: 'parent.pdf', ticker: 'NOKIA.HE' }]]),
    publications: new Map(), receipts: new Map(), checkouts: [], sales: new Map(), lineItems: [], claim: null, failCreate: false, revisable: true,
    retrieved: null, legacyIndex: null,
  });
}
function stub(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
process.env.ORDERS_TABLE = 'Orders';
process.env.MEMBERS_TABLE = 'Members';
process.env.MEMBERS_STRIPE_WEBHOOK_SECRET = 'test';
delete process.env.SECRETS_SSM_PREFIX;
delete process.env.WORKER_FUNCTION_NAME;
const stripeId = createRequire(require.resolve('../../server/lambda/members.js')).resolve('stripe');
require.cache[stripeId] = { id: stripeId, filename: stripeId, loaded: true, exports: function Stripe() {
  return {
    checkout: { sessions: {
      create: async params => { state.checkouts.push(params); return { id: 'cs_fork', url: 'https://checkout.example' }; },
      retrieve: async () => state.retrieved,
      listLineItems: async () => ({ data: state.lineItems }),
    } },
    webhooks: { constructEvent: () => state.event },
  };
} };
stub('../../server/members/auth.js', {
  requireUser: async event => event.headers?.authorization === 'Bearer valid'
    ? { profile: state.profile }
    : { deny: { statusCode: 401, body: '{}' } },
  frontendUrl: () => 'https://site.example/members.html',
});
stub('../../server/aws/orders-store.js', {
  STATUS: { DELIVERED: 'DELIVERED' },
  get: async id => state.orders.get(id) || null,
  create: async order => {
    if (state.failCreate) { state.failCreate = false; throw new Error('temporary order failure'); }
    state.orders.set(order.id, order);
    return order;
  },
});
stub('../../server/aws/engine-jobs.js', {
  getRevisionJobs: async ids => new Map(ids.map(id => [id, { id }])),
  canRevise: () => state.revisable,
  isOrderRevisable: async () => state.revisable,
});
stub('../../server/members/store.js', {
  table: () => 'Members',
  findPublicationIndex: async () => state.index,
  findPublicationForOrder: async () => state.legacyIndex,
  getProfile: async id => id === state.profile.userId ? state.profile : null,
  getPublication: async () => ({ status: 'generating' }),
  getItem: async (pk, sk) => state.publications.get(`${pk}|${sk}`) || state.receipts.get(`${pk}|${sk}`) || null,
  listReviews: async () => [], listPublicationIndex: async () => [],
  audit: async () => {},
  putSale: async (owner, key, sale) => {
    if (state.sales.has(key)) return false;
    state.sales.set(key, sale);
    return true;
  },
  runTransact: async params => {
    const put = params.TransactItems.find(item => item.Put)?.Put?.Item;
    if (String(put?.pk || '').startsWith('STRIPEREVISION#')) {
      const key = `${put.pk}|${put.sk}`;
      if (state.receipts.has(key)) return false;
      const update = params.TransactItems.find(item => item.Update?.TableName === 'Orders').Update;
      const order = state.orders.get(update.Key.orderId);
      if (!order) return false;
      order.revisionsAllowed = (order.revisionsAllowed || 0) + update.ExpressionAttributeValues[':rounds'];
      state.receipts.set(key, put);
    }
    if (put?.sk?.startsWith('PUB#')) {
      const key = `${put.pk}|${put.sk}`;
      if (state.publications.has(key)) return false;
      state.publications.set(key, put);
    }
    return true;
  },
  claimStripeEvent: async () => {
    if (state.claim === 'done') return { state: 'done' };
    if (state.claim === 'busy') return { state: 'busy' };
    state.claim = 'busy';
    return { state: 'claimed', leaseId: 'lease' };
  },
  finishStripeEvent: async () => { state.claim = 'done'; },
  releaseStripeEvent: async () => { state.claim = null; },
});
stub('../../server/email.js', { reportError: async () => {} });
const { handler } = require('../../server/lambda/members.js');
const fork = authorization => handler({
  routeKey: 'POST /analyses/{genId}/fork-checkout', pathParameters: { genId: 'parent' },
  headers: authorization ? { authorization } : {}, body: '{}',
});
const webhook = () => handler({ routeKey: 'POST /billing/webhook', headers: { 'stripe-signature': 'test' }, body: '{}' });

test('a visitor or signed-in analyst can buy a revision; stale logins do not silently become guests', async () => {
  reset();
  assert.equal((await fork()).statusCode, 200);
  assert.equal(state.checkouts.at(-1).metadata.forkUserId, '');
  assert.equal((await fork('Bearer valid')).statusCode, 200);
  assert.equal(state.checkouts.at(-1).metadata.forkUserId, 'u1');
  assert.equal((await fork('Bearer expired')).statusCode, 401);
  state.profile.openObligationId = 'other';
  assert.equal((await fork('Bearer valid')).statusCode, 200);
  state.revisable = false;
  assert.equal((await fork()).statusCode, 409);
});

test('an exposed legacy fork receipt cannot unlock the parent without the owner signing in', async () => {
  reset();
  state.retrieved = { id: 'cs_old', payment_status: 'paid', metadata: { analysisGenId: 'parent', fork: 'true', forkUserId: 'u1' } };
  state.orders.set('cs_old', { id: 'cs_old', ticker: 'NOKIA.HE', forkedFrom: 'parent' });
  state.legacyIndex = { status: 'published' };
  const purchased = authorization => handler({
    routeKey: 'GET /analyses/{genId}/purchased', pathParameters: { genId: 'parent' },
    queryStringParameters: { session_id: 'cs_old' }, headers: authorization ? { authorization } : {},
  });
  assert.equal((await purchased()).statusCode, 403);
  assert.equal((await purchased('Bearer valid')).statusCode, 200);
  state.profile.userId = 'other';
  assert.equal((await purchased('Bearer valid')).statusCode, 403);
  state.legacyIndex = null;
  state.orders.get('cs_old').memberOnly = true;
  assert.equal((await purchased()).statusCode, 403);
  state.orders.delete('cs_old');
  state.legacyIndex = { status: 'published' };
  assert.equal((await purchased()).statusCode, 403);
});

test('free-window fork charges only the revision fee', async () => {
  reset();
  state.index.freeUntil = '2099-01-01T00:00:00Z';
  const response = await fork();
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).priceEur, 10);
  assert.equal(state.checkouts[0].metadata.saleGrossEur, '0');
  assert.equal(state.checkouts[0].line_items.length, 1);
});

test('a member cannot pay for extra revisions when the source snapshot is unavailable', async () => {
  reset();
  state.revisable = false;
  const result = await handler({ routeKey: 'POST /generations/{genId}/revisions-checkout',
    pathParameters: { genId: 'parent' }, headers: { authorization: 'Bearer valid' }, body: '{"rounds":2}' });
  assert.equal(result.statusCode, 409);
  assert.equal(state.checkouts.length, 0);
});

test('a failed fork delivery can be retried without losing the analyst publication or double-counting a sale', async () => {
  reset();
  state.event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: {
    id: 'cs_fork', status: 'complete', payment_status: 'paid', amount_total: 1500, currency: 'eur',
    metadata: { analysisGenId: 'parent', ownerId: 'author', companyId: 'NOKIA.HE', fork: 'true', forkUserId: 'u1' },
  } } };
  state.lineItems = [{ description: 'NOKIA.HE — analyst analysis by Author', amount_total: 1000 }];
  state.failCreate = true;
  assert.equal((await webhook()).statusCode, 500);
  assert.equal(state.sales.size, 1);
  assert.equal([...state.sales.values()][0].grossEur, 10);
  assert.equal((await webhook()).statusCode, 200);
  assert.equal(state.sales.size, 1);
  assert.equal(state.orders.get('cs_fork').visibility, undefined);
  assert.equal(state.orders.get('cs_fork').publicationLocked, false);
  assert.equal((await webhook()).statusCode, 200);
  assert.equal(state.sales.size, 1);
});

test('a free parent has no analyst sale even when an older checkout recorded the list price', async () => {
  reset();
  state.event = { id: 'evt_2', type: 'checkout.session.completed', data: { object: {
    id: 'cs_fork', status: 'complete', payment_status: 'paid', amount_total: 1000, currency: 'eur',
    metadata: { analysisGenId: 'parent', ownerId: 'author', companyId: 'NOKIA.HE', fork: 'true', saleGrossEur: '20' },
  } } };
  state.lineItems = [{ description: 'Build on NOKIA.HE — derivation', amount_total: 1000 }];
  assert.equal((await webhook()).statusCode, 200);
  assert.equal(state.sales.size, 0);
  assert.equal(state.orders.get('cs_fork').visibility, 'private');
});

test('the same extra-rounds checkout cannot be credited twice by different events', async () => {
  reset();
  state.orders.set('order', { id: 'order', revisionsAllowed: 1 });
  const session = { id: 'cs_extra', status: 'complete', payment_status: 'no_payment_required', amount_total: 0,
    metadata: { extraRevisions: '2', generationId: 'order' } };
  state.event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: session } };
  assert.equal((await webhook()).statusCode, 200);
  state.claim = null;
  state.event.id = 'evt_2';
  state.event.type = 'checkout.session.async_payment_succeeded';
  assert.equal((await webhook()).statusCode, 200);
  assert.equal(state.orders.get('order').revisionsAllowed, 3);
});
