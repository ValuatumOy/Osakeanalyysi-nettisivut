import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = {};
function reset(role = 'analyst') {
  Object.assign(state, {
    profile: { userId: 'u1', role, name: 'Analyst', email: 'analyst@example.com' },
    publication: { owner: 'u1', status: 'generating' },
    order: { id: 'g1', ticker: 'NOKIA.HE', status: 'DELIVERED', jobId: 'job', pdfFileName: 'report.pdf', updatedAt: 'v1', revisionsUsed: 0 },
    transactions: [], beforeCommit: null, session: null, existingIndex: null, publicCopy: null,
  });
}
function stub(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
process.env.ORDERS_TABLE = 'Orders';
delete process.env.SECRETS_SSM_PREFIX;
const stripeId = createRequire(require.resolve('../../server/lambda/members.js')).resolve('stripe');
require.cache[stripeId] = { id: stripeId, filename: stripeId, loaded: true, exports: function Stripe() {
  return { checkout: { sessions: { retrieve: async () => {
    if (!state.session) throw new Error('Unknown session');
    return state.session;
  } } } };
} };
stub('../../server/members/auth.js', { requireUser: async () => ({ profile: state.profile }) });
stub('../../server/aws/orders-store.js', { get: async () => state.order && { ...state.order } });
stub('../../server/members/store.js', {
  table: () => 'Members',
  getPublication: async (userId, genId) => genId === state.order?.id && state.publication?.owner === userId ? state.publication : null,
  findPublicationForOrder: async () => state.existingIndex,
  listPublicationIndex: async () => [],
  audit: async () => {},
  runTransact: async params => {
    state.transactions.push(params);
    if (state.beforeCommit) state.beforeCommit();
    const lock = params.TransactItems.find(item => item.Update?.TableName === 'Orders').Update;
    const optional = Boolean(params.TransactItems[0].ConditionCheck);
    if (!['analyst', 'coaching'].includes(state.profile.role) || (state.publication?.private && !(optional && (state.publication.paid || state.publication.publishableSource)))
      || state.order.status !== 'DELIVERED' || state.order.updatedAt !== lock.ExpressionAttributeValues[':updatedAt']
      || (lock.ExpressionAttributeValues[':job'] && state.order.lastPublishedJobId === lock.ExpressionAttributeValues[':job'])) return false;
    const copy = params.TransactItems.find(item => item.Put?.TableName === 'Orders')?.Put?.Item;
    if (copy) {
      state.publicCopy = copy;
      state.order.lastPublishedJobId = copy.jobId;
      if (state.publication) Object.assign(state.publication, { private: true, publishableSource: true, publishedAs: copy.orderId });
    } else {
      if (!state.publication) state.publication = { owner: state.profile.userId };
      state.publication.status = 'published';
      state.order.publicationLocked = true;
    }
    return true;
  },
});
const { handler } = require('../../server/lambda/members.js');
const submit = (genId = 'g1') => handler({
  routeKey: 'POST /generations/{genId}/submit', pathParameters: { genId }, body: '{}', headers: {},
});

test('only analysts and coaching analysts may publish their own eligible report', async () => {
  for (const role of ['reader', 'subscriber']) {
    reset(role);
    assert.equal((await submit()).statusCode, 403, role);
    assert.equal(state.transactions.length, 0);
  }
  for (const role of ['analyst', 'coaching']) {
    reset(role);
    assert.equal((await submit()).statusCode, 200, role);
    assert.equal(state.publication.status, 'generating');
    assert.equal(state.publication.publishableSource, true);
    assert.equal(state.publicCopy.publicationLocked, true);
    assert.equal(state.order.publicationLocked, undefined);
  }
  reset();
  state.publication.owner = 'someone-else';
  assert.equal((await submit()).statusCode, 404);
  assert.equal(state.transactions.length, 0);
});

test('private, unfinished and unchanged derivatives cannot be published', async () => {
  reset();
  state.publication.private = true;
  assert.equal((await submit()).statusCode, 409);
  reset();
  state.order.status = 'REVISING';
  assert.equal((await submit()).statusCode, 409);
  reset();
  state.order.forkedFrom = 'other';
  assert.equal((await submit()).statusCode, 409);
  state.order.revisionsUsed = 1;
  assert.equal((await submit()).statusCode, 200);
});

test('a concurrent revision prevents publishing the stale version', async () => {
  reset();
  state.beforeCommit = () => { state.order.status = 'REVISING'; state.order.updatedAt = 'v2'; };
  assert.equal((await submit()).statusCode, 409);
  assert.equal(state.publication.status, 'generating');
  assert.equal(state.order.publicationLocked, undefined);
});

test('an analyst can voluntarily publish their own paid report only after a change', async () => {
  reset();
  state.profile.openObligationId = 'another-report';
  state.publication = { owner: 'u1', status: 'generating', private: true, paid: true };
  assert.equal((await submit()).statusCode, 409);
  state.order.editsUsed = 1;
  assert.equal((await submit()).statusCode, 200);
  assert.equal(state.publication.status, 'generating');
  assert.equal(state.publicCopy.publicationLocked, true);
  assert.equal(state.profile.openObligationId, 'another-report');
  assert.ok(state.transactions[0].TransactItems[0].ConditionCheck);
});

test('a paid guest purchase can be claimed by its analyst after a revision', async () => {
  reset();
  state.publication = null;
  state.order.id = 'cs_guest';
  state.order.revisionsUsed = 1;
  state.session = { id: 'cs_guest', payment_status: 'paid', customer_details: { email: 'ANALYST@example.com' }, metadata: { site: 'aiequityreports', reportId: 'nokia' } };
  const result = await submit('cs_guest');
  assert.equal(result.statusCode, 200);
  const publicId = JSON.parse(result.body).genId;
  assert.match(publicId, /^[0-9a-f-]{36}$/);
  assert.notEqual(publicId, 'cs_guest');
  assert.equal(state.publicCopy.orderId, publicId);
  assert.equal(state.publicCopy.publicationLocked, true);
  assert.equal(state.order.publicationLocked, undefined);
  assert.equal(state.transactions[0].TransactItems[2].Put.Item.genId, publicId);
  assert.equal((await submit('cs_guest')).statusCode, 409);
  state.order.jobId = 'another-delivered-job';
  state.order.updatedAt = 'v2';
  assert.equal((await submit('cs_guest')).statusCode, 200);
});

test('a paid analyst fork remains privately editable after publishing a frozen copy', async () => {
  reset();
  state.order.id = 'cs_fork';
  state.order.forkedFrom = 'parent';
  state.order.revisionsUsed = 1;
  const result = await submit('cs_fork');
  assert.equal(result.statusCode, 200);
  assert.equal(state.publication.status, 'generating');
  assert.equal(state.publication.private, true);
  assert.equal(state.publication.publishableSource, true);
  assert.equal(state.publication.publishedAs, JSON.parse(result.body).genId);
  assert.equal(state.publicCopy.publicationLocked, true);
  assert.equal(state.order.publicationLocked, undefined);
});

test('another buyer’s guest receipt cannot be published under the analyst’s name', async () => {
  reset();
  state.publication = null;
  state.order.revisionsUsed = 1;
  state.session = { id: 'g1', payment_status: 'paid', customer_details: { email: 'other@example.com' },
    metadata: { site: 'aiequityreports', reportId: 'nokia' } };
  assert.equal((await submit()).statusCode, 403);
  delete state.session.customer_details;
  assert.equal((await submit()).statusCode, 403);
  assert.equal(state.transactions.length, 0);
});

test('another member’s checkout and an already published order cannot be claimed', async () => {
  reset();
  state.publication = null;
  state.order.revisionsUsed = 1;
  state.session = { id: 'g1', payment_status: 'paid', metadata: { site: 'aiequityreports', fork: 'true', forkUserId: 'other' } };
  assert.equal((await submit()).statusCode, 403);
  state.session.metadata.forkUserId = 'u1';
  state.existingIndex = { status: 'published' };
  assert.equal((await submit()).statusCode, 409);
  assert.equal(state.transactions.length, 0);
});
