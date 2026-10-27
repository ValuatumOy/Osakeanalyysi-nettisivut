import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// A paid generation (POST /generations/fresh) carries the member's name like the
// free one does: the engine prints it on a revised report's cover, and without
// it a revision of a report the member paid for said nobody steered it.
const require = createRequire(import.meta.url);
const state = { creates: [], checkouts: [] };
function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
process.env.WORKER_FUNCTION_NAME = 'stub-worker';
process.env.MEMBERS_STRIPE_PRICES = JSON.stringify({ fresh: { member: 'price_member', list: 'price_list' } });
delete process.env.SECRETS_SSM_PREFIX;

const profile = { userId: 'u1', role: 'subscriber', tier: 'none', email: 'panu@example.com', name: 'Panu Analyst' };
const session = {
  id: 'cs_fresh', payment_status: 'paid',
  metadata: { isFresh: 'true', userId: 'u1', company: 'Nokia Oyj', ticker: 'NOKIA.HE', exchange: 'HEL', industry: 'Technology' },
};

stub('stripe', function Stripe() {
  return { checkout: { sessions: {
    retrieve: async () => structuredClone(session),
    create: async (params) => { state.checkouts.push(params); return { id: 'cs_new', url: 'https://checkout.example/cs_new' }; },
  } } };
});
stub('../../server/aws/clients.js', { lambda: () => ({ send: async () => {} }) });
stub('../../server/search.js', {
  searchCompanies: async () => [{ ticker: 'NOKIA.HE', companyName: 'Nokia Oyj', industry: 'Technology' }],
});
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: structuredClone(profile), deny: null }),
  frontendUrl: () => 'https://www.aiequityreports.com/members.html',
});
stub('../../server/email.js', { reportError: async () => {} });
stub('../../server/aws/catalog-aws.js', {});
stub('../../server/aws/orders-store.js', {
  STATUS: { FAILED: 'FAILED' },
  create: async (order) => { state.creates.push(structuredClone(order)); return { ...order, status: 'NEW' }; },
  get: async () => null,
});
stub('../../server/members/store.js', {
  table: () => 'Members',
  getPublication: async () => null,
  listPublicationIndex: async () => [],
  audit: async () => {},
  runTransact: async () => true,
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
