import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// A paid generation (POST /generations/fresh) carries the member's name like the
// free one does: the engine prints it on a revised report's cover, and without
// it a revision of a report the member paid for said nobody steered it.
const require = createRequire(import.meta.url);
const state = { creates: [], checkouts: [], publications: new Map(), orders: new Map(), confirmations: [], claim: null, event: null, transactionFails: false, failOrderOnce: false, race: null };
function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
process.env.WORKER_FUNCTION_NAME = 'stub-worker';
process.env.MEMBERS_STRIPE_PRICES = JSON.stringify({ fresh: { member: 'price_member', list: 'price_list' } });
process.env.MEMBERS_STRIPE_WEBHOOK_SECRET = 'test';
delete process.env.SECRETS_SSM_PREFIX;

const profile = { userId: 'u1', role: 'subscriber', tier: 'none', email: 'panu@example.com', name: 'Panu Analyst' };
const session = {
  id: 'cs_fresh', payment_status: 'paid',
  metadata: { site: 'aiequityreports', isFresh: 'true', userId: 'u1', company: 'Nokia Oyj', ticker: 'NOKIA.HE', exchange: 'HEL', industry: 'Technology' },
};

const stripeId = createRequire(require.resolve('../../server/lambda/members.js')).resolve('stripe');
require.cache[stripeId] = { id: stripeId, filename: stripeId, loaded: true, exports: function Stripe() {
  return { checkout: { sessions: {
    retrieve: async () => structuredClone(session),
    create: async (params) => { state.checkouts.push(params); return { id: 'cs_new', url: 'https://checkout.example/cs_new' }; },
  } }, webhooks: { constructEvent: () => state.event } };
} };
stub('../../server/aws/clients.js', { lambda: () => ({ send: async () => {} }) });
stub('../../server/search.js', {
  searchCompanies: async () => [{ ticker: 'NOKIA.HE', companyName: 'Nokia Oyj', industry: 'Technology' }],
});
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: structuredClone(profile), deny: null }),
  frontendUrl: () => 'https://www.aiequityreports.com/members.html',
});
stub('../../server/email.js', { reportError: async () => {}, sendFreshConfirmEmail: async (to, meta) => state.confirmations.push({ to, meta }) });
stub('../../server/aws/catalog-aws.js', {});
stub('../../server/aws/orders-store.js', {
  STATUS: { FAILED: 'FAILED' },
  create: async (order) => {
    state.creates.push(structuredClone(order));
    if (state.failOrderOnce) { state.failOrderOnce = false; throw new Error('temporary order failure'); }
    if (!state.orders.has(order.id)) state.orders.set(order.id, { ...order, status: 'NEW' });
    return structuredClone(state.orders.get(order.id));
  },
  get: async id => state.orders.get(id) || null,
});
stub('../../server/members/store.js', {
  table: () => 'Members',
  getPublication: async (userId, genId) => state.publications.get(genId) || null,
  getProfile: async id => id === profile.userId ? structuredClone(profile) : null,
  listPublicationIndex: async () => [],
  audit: async () => {},
  runTransact: async params => {
    if (state.transactionFails) return false;
    const item = params.TransactItems.find(row => row.Put?.Item?.sk?.startsWith('PUB#'))?.Put.Item;
    if (state.race) { const race = state.race; state.race = null; race(item); }
    const guard = params.TransactItems.find(row => row.ConditionCheck)?.ConditionCheck;
    if (guard?.ExpressionAttributeNames?.['#role'] === 'role') {
      const publishing = [guard.ExpressionAttributeValues[':analyst'], guard.ExpressionAttributeValues[':coaching']].includes(profile.role);
      if (guard.ConditionExpression.includes('#role IN') ? !publishing : publishing) return false;
    }
    if (item && state.publications.has(item.sk.slice(4))) return false;
    if (item) { state.publications.set(item.sk.slice(4), item); }
    return true;
  },
  claimStripeEvent: async () => state.claim === 'done' ? { state: 'done' } : { state: 'claimed', leaseId: 'lease' },
  finishStripeEvent: async () => { state.claim = 'done'; },
  releaseStripeEvent: async () => { state.claim = null; },
});

const { handler } = require('../../server/lambda/members.js');

test('a paid generation order carries the analyst name and the industry', async () => {
  const res = await handler({ routeKey: 'POST /generations/fresh', headers: {}, body: JSON.stringify({ sessionId: 'cs_fresh' }) });
  assert.equal(res.statusCode, 200, res.body);
  const order = state.creates.at(-1);
  assert.equal(order.analystName, 'Panu Analyst');
  assert.equal(order.industry, 'Technology');
  assert.equal(order.ticker, 'NOKIA.HE');
});

test('the paid checkout records the resolved industry for the order to pick up', async () => {
  const res = await handler({ routeKey: 'POST /billing/fresh-checkout', headers: {}, body: JSON.stringify({ company: 'Nokia', ticker: 'NOKIA.HE' }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(state.checkouts.at(-1).metadata.industry, 'Technology');
});

test('a member fresh purchase is fulfilled privately even when the buyer never returns', async () => {
  profile.role = 'analyst';
  state.publications.clear();
  state.orders.clear();
  state.claim = null;
  state.event = { id: 'evt_fresh', type: 'checkout.session.completed', data: { object: session } };
  const event = { routeKey: 'POST /billing/webhook', headers: { 'stripe-signature': 'test' }, body: '{}' };
  assert.equal((await handler(event)).statusCode, 200);
  const order = state.orders.get('cs_fresh');
  assert.equal(order.visibility, 'private');
  assert.ok(order.revisionsAllowed > 0);
  assert.equal(state.publications.get('cs_fresh').paid, true);
  assert.equal(state.confirmations.at(-1).to, profile.email);
  const count = state.creates.length;
  assert.equal((await handler(event)).statusCode, 200);
  assert.equal(state.creates.length, count);
  profile.role = 'subscriber';
});

test('a failed ownership transaction is retried instead of acknowledging a paid event', async () => {
  state.publications.clear();
  state.orders.clear();
  state.claim = null;
  state.transactionFails = true;
  state.event = { id: 'evt_conflict', type: 'checkout.session.completed', data: { object: session } };
  const event = { routeKey: 'POST /billing/webhook', headers: { 'stripe-signature': 'test' }, body: '{}' };
  assert.equal((await handler(event)).statusCode, 500);
  assert.equal(state.orders.size, 0);
  state.transactionFails = false;
  assert.equal((await handler(event)).statusCode, 200);
  assert.equal(state.publications.get('cs_fresh').paid, true);
});

test('a failed order write retries after the private ownership row was created', async () => {
  state.publications.clear();
  state.orders.clear();
  state.claim = null;
  state.failOrderOnce = true;
  state.event = { id: 'evt_retry', type: 'checkout.session.completed', data: { object: session } };
  const event = { routeKey: 'POST /billing/webhook', headers: { 'stripe-signature': 'test' }, body: '{}' };
  assert.equal((await handler(event)).statusCode, 500);
  assert.equal(state.publications.get('cs_fresh').paid, true);
  assert.equal(state.orders.size, 0);
  assert.equal((await handler(event)).statusCode, 200);
  assert.equal(state.orders.get('cs_fresh').visibility, 'private');
});

test('an asynchronous payment creates the member order only after payment succeeds', async () => {
  state.publications.clear();
  state.orders.clear();
  state.claim = null;
  state.event = { id: 'evt_unpaid', type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'unpaid' } } };
  const event = { routeKey: 'POST /billing/webhook', headers: { 'stripe-signature': 'test' }, body: '{}' };
  assert.equal((await handler(event)).statusCode, 200);
  assert.equal(state.orders.size, 0);
  state.claim = null;
  state.event = { id: 'evt_paid', type: 'checkout.session.async_payment_succeeded', data: { object: session } };
  assert.equal((await handler(event)).statusCode, 200);
  assert.equal(state.orders.get('cs_fresh').visibility, 'private');
});

const collect = () => handler({ routeKey: 'POST /generations/fresh', headers: {}, body: JSON.stringify({ sessionId: session.id, publicEngineBase: true }) });

test('paid generation baseline eligibility comes from the role and keeps the workspace private', async () => {
  for (const role of ['analyst', 'coaching', 'reader', 'subscriber']) {
    profile.role = role;
    state.publications.clear();
    state.orders.clear();
    assert.equal((await collect()).statusCode, 200);
    const expected = ['analyst', 'coaching'].includes(role);
    assert.equal(state.publications.get(session.id).publicEngineBase, expected);
    assert.equal(state.orders.get(session.id).publicEngineBase, expected);
    assert.equal(state.orders.get(session.id).visibility, 'private');
    assert.equal(state.publications.get(session.id).private, true);
  }
  profile.role = 'subscriber';
});

test('paid recovery uses the original reservation after a role change or a legacy missing marker', async () => {
  for (const original of [true, false, undefined]) {
    state.publications.clear();
    state.orders.clear();
    profile.role = original ? 'analyst' : 'subscriber';
    state.failOrderOnce = true;
    assert.equal((await collect()).statusCode, 500);
    if (original === undefined) delete state.publications.get(session.id).publicEngineBase;
    profile.role = original ? 'subscriber' : 'coaching';
    assert.equal((await collect()).statusCode, 200);
    assert.equal(state.orders.get(session.id).publicEngineBase, original === true);
    profile.role = original ? 'coaching' : 'subscriber';
    assert.equal((await collect()).statusCode, 200);
    assert.equal(state.orders.get(session.id).publicEngineBase, original === true);
  }
  profile.role = 'subscriber';
});

test('a paid reservation race preserves the winning reservation baseline decision', async () => {
  for (const winnerEligible of [true, false]) {
    state.publications.clear();
    state.orders.clear();
    profile.role = winnerEligible ? 'subscriber' : 'analyst';
    state.race = item => state.publications.set(session.id, { ...item, publicEngineBase: winnerEligible });
    assert.equal((await collect()).statusCode, 200);
    assert.equal(state.orders.get(session.id).publicEngineBase, winnerEligible);
    assert.equal(state.publications.get(session.id).publicEngineBase, winnerEligible);
  }
  profile.role = 'subscriber';
});

test('a role change before paid reservation commit cannot persist stale baseline eligibility', async () => {
  for (const [before, after] of [['analyst', 'reader'], ['coaching', 'subscriber'], ['reader', 'coaching'], ['subscriber', 'analyst']]) {
    profile.role = before;
    state.publications.clear();
    state.orders.clear();
    state.race = () => { profile.role = after; };
    assert.equal((await collect()).statusCode, 500);
    assert.equal(state.publications.size, 0);
    assert.equal(state.orders.size, 0);
    assert.equal((await collect()).statusCode, 200);
    assert.equal(state.orders.get(session.id).publicEngineBase, ['analyst', 'coaching'].includes(after));
  }
  profile.role = 'subscriber';
});
