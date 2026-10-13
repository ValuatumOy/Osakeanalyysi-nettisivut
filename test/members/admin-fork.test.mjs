// An admin's copy of someone else's report: a private order of the member's own
// on the same engine job, so they can revise it without touching the original
// or its owner's rounds — and without being able to publish it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

process.env.ADMIN_UPLOAD_PASSWORD = 'test-admin-secret';
process.env.SECRETS_SSM_PREFIX = '';

const state = { orders: {}, created: [], items: [], pubs: {}, transactions: [] };

stub('../../server/aws/catalog-aws.js', {});
stub('../../server/search.js', { searchCompanies: async () => [] });
stub('../../server/members/bounty.js', {});
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: { userId: 'markus', role: 'analyst', name: 'Markus' }, deny: null }),
});
stub('../../server/aws/orders-store.js', {
  STATUS: { DELIVERED: 'DELIVERED', FAILED: 'FAILED' },
  get: async (id) => state.orders[id] || null,
  create: async (order) => { state.created.push(order); state.orders[order.id] = order; },
  update: async () => {},
});
stub('../../server/members/store.js', {
  table: () => 'stub',
  listProfiles: async () => [
    { pk: 'USER#markus', sk: 'PROFILE', userId: 'markus', email: 'Markus@Example.com', name: 'Markus' },
  ],
  getProfile: async (userId) => (userId === 'markus' ? { userId: 'markus', email: 'markus@example.com' } : null),
  findPublicationIndex: async () => null,
  getPublication: async (userId, genId) => state.pubs[genId] || null,
  putItem: async (item) => { state.items.push(item); state.pubs[item.sk.replace(/^PUB#/, '')] = item; },
  // Evaluates only the one condition these tests are about: the submit
  // transaction refuses a PUB# row marked private.
  runTransact: async (params) => {
    state.transactions.push(params);
    const pubUpdate = params.TransactItems.find((t) => t.Update?.Key?.sk?.startsWith('PUB#'))?.Update;
    if (pubUpdate && /attribute_not_exists\(#private\)/.test(pubUpdate.ConditionExpression)) {
      return !state.pubs[pubUpdate.Key.sk.replace(/^PUB#/, '')]?.private;
    }
    return true;
  },
  audit: async () => {},
});

const { handler } = require('../../server/lambda/members.js');

const fork = (body, token = 'test-admin-secret') => handler({
  routeKey: 'POST /admin/members/fork',
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

test('the copy route sits behind the admin password', async () => {
  assert.equal((await fork({ genId: 'lauri-tsla', email: 'markus@example.com' }, 'nope')).statusCode, 401);
});

test('a delivered private report is copied to the member by email, privately', async () => {
  state.orders['lauri-tsla'] = {
    id: 'lauri-tsla', status: 'DELIVERED', jobId: 'job-tsla', ticker: 'TSLA', companyName: 'Tesla',
    pdfFileName: 'tesla-v4.pdf', revisionsUsed: 3, revisionsAllowed: 5,
  };
  const res = await fork({ genId: 'lauri-tsla', email: ' markus@example.com ', rounds: 4 });
  assert.equal(res.statusCode, 200, res.body);
  const { genId } = JSON.parse(res.body);
  assert.match(genId, /^[0-9a-f-]{36}$/, 'the order page treats only a UUID as a member run');

  const order = state.created.at(-1);
  assert.equal(order.id, genId);
  assert.equal(order.jobId, 'job-tsla');
  assert.equal(order.forkedFrom, 'lauri-tsla');
  assert.equal(order.visibility, 'private');
  assert.equal(order.revisionsAllowed, 4);
  assert.equal(order.pdfFileName, undefined, 'inheriting the PDF key would overwrite the original');

  const pub = state.items.at(-1);
  assert.equal(pub.pk, 'USER#markus');
  assert.equal(pub.sk, `PUB#${genId}`);
  assert.equal(pub.private, true);

  // The original is untouched.
  assert.equal(state.orders['lauri-tsla'].revisionsUsed, 3);
});

test('the copy cannot be published', async () => {
  const { genId } = JSON.parse((await fork({ genId: 'lauri-tsla', userId: 'markus' })).body);
  // Revised once, so the unchanged-fork rule is not what refuses it.
  state.orders[genId].revisionsUsed = 1;
  const res = await handler({
    routeKey: 'POST /generations/{genId}/submit',
    pathParameters: { genId },
    headers: { authorization: 'Bearer member' },
    body: JSON.stringify({ priceEur: 10 }),
  });
  assert.equal(res.statusCode, 409);
  const pubUpdate = state.transactions.at(-1).TransactItems[1].Update;
  assert.equal(pubUpdate.ExpressionAttributeNames['#private'], 'private');
});

test('a report still generating, or an unknown member, is refused', async () => {
  state.orders['busy'] = { id: 'busy', status: 'RENDERING', jobId: 'job-x' };
  assert.equal((await fork({ genId: 'busy', email: 'markus@example.com' })).statusCode, 409);
  assert.equal((await fork({ genId: 'lauri-tsla', email: 'nobody@example.com' })).statusCode, 404);
  assert.equal((await fork({ email: 'markus@example.com' })).statusCode, 400);
});

test('the copy opens on the original PDF until its first revision lands', async () => {
  const { genId } = JSON.parse((await fork({ genId: 'lauri-tsla', userId: 'markus' })).body);
  const res = await handler({
    routeKey: 'GET /generations/{genId}/order',
    pathParameters: { genId },
    headers: { authorization: 'Bearer member' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.pdfUrl, undefined);
  assert.match(payload.originalUrl, /tesla-v4\.pdf/);
  assert.equal(payload.revisionsAllowed, 5);
});
