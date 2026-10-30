import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// The admin revising from the order page. The customer's order is never
// touched: the first revision or edit creates a private admin copy on the same
// engine job, and later ones go to that copy. Same require.cache fakes as
// orders-route.test.mjs.
const require = createRequire(import.meta.url);

const API_ID = require.resolve('../../server/lambda/api.js');
const ORDERS_STORE_ID = require.resolve('../../server/aws/orders-store.js');
const ENGINE_ID = require.resolve('../../server/engine-client.js');
const ORDER_EDITING_ID = require.resolve('../../server/order-editing.js');

const STATUS = Object.freeze({
  NEW: 'NEW', IMPORTING: 'IMPORTING', RENDERING: 'RENDERING',
  DELIVERED: 'DELIVERED', REVISING: 'REVISING', FAILED: 'FAILED',
});
const ADMIN = 'admin-secret';

function loadApi(orders) {
  for (const id of [API_ID, ORDER_EDITING_ID]) delete require.cache[id];
  process.env.ADMIN_UPLOAD_PASSWORD = ADMIN;
  process.env.CATALOG_SYNC_SECRET = 'sync-secret';
  delete process.env.WORKER_FUNCTION_NAME;
  delete process.env.SECRETS_SSM_PREFIX;

  const created = [];
  const ordersStore = {
    STATUS,
    async get(id) { return orders.get(id) || null; },
    async create(input) {
      const order = { ...input, revisionsUsed: 0, revisionHistory: [], pdfFileName: null };
      created.push(order);
      orders.set(order.id, order);
      return order;
    },
    async claimRevision(id, comment, valuationOverrides = null, scope) {
      const order = orders.get(id);
      if (!order || order.status !== STATUS.DELIVERED) return null;
      if ((order.revisionsUsed || 0) >= (order.revisionsAllowed || 0)) return null;
      Object.assign(order, { status: STATUS.REVISING, pendingRevisionComment: comment, pendingValuationOverrides: valuationOverrides, pendingRevisionScope: scope });
      return order;
    },
    async claimEdit(id, edit) {
      const order = orders.get(id);
      if (!order || order.status !== STATUS.DELIVERED) return null;
      Object.assign(order, { status: STATUS.REVISING, pendingEdit: edit });
      return order;
    },
  };
  const engine = {
    calls: [],
    async previewValuation(args) { this.calls.push(args); return { targetPrice: 500 }; },
  };
  require.cache[ORDERS_STORE_ID] = { id: ORDERS_STORE_ID, filename: ORDERS_STORE_ID, loaded: true, exports: ordersStore };
  require.cache[ENGINE_ID] = { id: ENGINE_ID, filename: ENGINE_ID, loaded: true, exports: engine };
  return { handler: require(API_ID).handler, created, engine };
}

function cleanup(t) {
  t.after(() => { for (const id of [API_ID, ORDERS_STORE_ID, ENGINE_ID, ORDER_EDITING_ID]) delete require.cache[id]; });
}

const event = (routeKey, id, body, secret = ADMIN) => ({
  routeKey,
  pathParameters: { id },
  headers: { authorization: `Bearer ${secret}` },
  body: body ? JSON.stringify(body) : undefined,
});

const laurisOrder = () => ({
  id: 'lauri-tsla', status: STATUS.DELIVERED, jobId: 'job-v4', engineUsername: 'hand',
  companyName: 'Tesla', ticker: 'TSLA', pdfFileName: 'tesla-v4.pdf',
  revisionsAllowed: 5, revisionsUsed: 5, email: 'lauri@example.com', analystName: 'Lauri',
});

test('the admin routes sit behind the admin password', async (t) => {
  cleanup(t);
  const { handler } = loadApi(new Map([['lauri-tsla', laurisOrder()]]));
  for (const route of ['POST /api/admin/orders/{id}/revisions', 'POST /api/admin/orders/{id}/edits', 'POST /api/admin/orders/{id}/valuation', 'GET /api/admin/orders/{id}/preview']) {
    assert.equal((await handler(event(route, 'lauri-tsla', { comments: 'x' }, 'sync-secret'))).statusCode, 401, route);
  }
});

test("a revision on the customer's order goes to a new private copy, even with their rounds used up", async (t) => {
  cleanup(t);
  const orders = new Map([['lauri-tsla', laurisOrder()]]);
  const { handler, created } = loadApi(orders);

  const res = await handler(event('POST /api/admin/orders/{id}/revisions', 'lauri-tsla', { comments: 'Lower the Robotaxi probability' }));
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.copied, true);
  assert.notEqual(body.orderId, 'lauri-tsla');

  const copy = created[0];
  assert.equal(copy.id, body.orderId);
  assert.equal(copy.adminCopy, true);
  assert.equal(copy.visibility, 'private');
  assert.equal(copy.forkedFrom, 'lauri-tsla');
  assert.equal(copy.jobId, 'job-v4');
  assert.equal(copy.engineUsername, 'hand');
  assert.equal(copy.email, undefined, 'no customer email on the copy');
  assert.equal(copy.status, STATUS.REVISING);
  assert.equal(copy.pendingRevisionComment, 'Lower the Robotaxi probability');

  const original = orders.get('lauri-tsla');
  assert.equal(original.status, STATUS.DELIVERED);
  assert.equal(original.revisionsUsed, 5);
  assert.equal(original.pendingRevisionComment, undefined);
});

test('an admin copy of a market-first report is market-first from the start', async (t) => {
  cleanup(t);
  const orders = new Map([['lauri-tsla', { ...laurisOrder(), marketFirst: true, hasPreview: true }]]);
  const { handler, created } = loadApi(orders);

  const res = await handler(event('POST /api/admin/orders/{id}/revisions', 'lauri-tsla', { comments: 'Lower the margin' }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(created[0].marketFirst, true);
  assert.equal(created[0].hasPreview, true);
});

test('on an admin copy the next revision and edit stay on that copy', async (t) => {
  cleanup(t);
  const orders = new Map([['copy-1', {
    ...laurisOrder(), id: 'copy-1', adminCopy: true, forkedFrom: 'lauri-tsla', revisionsAllowed: 20, revisionsUsed: 1,
  }]]);
  const { handler, created } = loadApi(orders);

  const res = await handler(event('POST /api/admin/orders/{id}/revisions', 'copy-1', { comments: 'Again' }));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual([JSON.parse(res.body).orderId, JSON.parse(res.body).copied], ['copy-1', false]);
  assert.equal(created.length, 0);

  orders.get('copy-1').status = STATUS.DELIVERED;
  const edit = await handler(event('POST /api/admin/orders/{id}/edits', 'copy-1', { edits: { 'recommendation/prose/0': 'New text' } }));
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(JSON.parse(edit.body).orderId, 'copy-1');
  assert.equal(created.length, 0);
});

test('the calculator runs on the original without copying it', async (t) => {
  cleanup(t);
  const orders = new Map([['lauri-tsla', laurisOrder()]]);
  const { handler, created, engine } = loadApi(orders);
  const res = await handler(event('POST /api/admin/orders/{id}/valuation', 'lauri-tsla', { overrides: {} }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(engine.calls[0].jobId, 'job-v4');
  assert.equal(engine.calls[0].username, 'hand');
  assert.equal(created.length, 0);
});

test('a report still generating cannot be copied', async (t) => {
  cleanup(t);
  const { handler, created } = loadApi(new Map([['busy', { ...laurisOrder(), id: 'busy', status: STATUS.RENDERING }]]));
  const res = await handler(event('POST /api/admin/orders/{id}/revisions', 'busy', { comments: 'x' }));
  assert.equal(res.statusCode, 409);
  assert.equal(created.length, 0);
});

// Any version can be revised: the engine revises any finished job, so a
// revision from an older version is a new copy on that version's job.
const historyOrder = () => ({
  ...laurisOrder(),
  originalJobId: 'job-v1', originalPdfFileName: 'tesla-v1.pdf',
  revisionHistory: [
    { version: 2, kind: 'revision', jobId: 'job-v2', pdfFileName: 'tesla-v2.pdf', completedAt: '2026-10-01T10:00:00.000Z' },
    { version: 3, kind: 'edit', pdfFileName: 'tesla-v3.pdf', completedAt: '2026-10-02T10:00:00.000Z' },
    { version: 4, kind: 'revision', jobId: 'job-v4', pdfFileName: 'tesla-v4.pdf', completedAt: '2026-10-03T10:00:00.000Z' },
  ],
});

test('a revision from an older version goes to a new copy on that version\'s job', async (t) => {
  cleanup(t);
  const orders = new Map([['lauri-tsla', historyOrder()]]);
  const { handler, created } = loadApi(orders);

  const res = await handler(event('POST /api/admin/orders/{id}/revisions', 'lauri-tsla', { comments: 'From v2', fromVersion: 2 }));
  assert.equal(res.statusCode, 200, res.body);
  const copy = created[0];
  assert.equal(JSON.parse(res.body).orderId, copy.id);
  assert.deepEqual([copy.jobId, copy.forkedFromVersion, copy.basePdfFileName], ['job-v2', 2, 'tesla-v2.pdf']);
  assert.equal(copy.status, STATUS.REVISING);
  assert.equal(copy.fromVersion, undefined);
  assert.equal(copy.pendingRevisionComment, 'From v2');

  const v1 = await handler(event('POST /api/admin/orders/{id}/revisions', 'lauri-tsla', { comments: 'From v1', fromVersion: 1 }));
  assert.equal(v1.statusCode, 200, v1.body);
  assert.deepEqual([created[1].jobId, created[1].forkedFromVersion], ['job-v1', 1]);
});

test('on an admin copy an older version still makes a new copy', async (t) => {
  cleanup(t);
  const orders = new Map([['copy-1', { ...historyOrder(), id: 'copy-1', adminCopy: true, revisionsAllowed: 20 }]]);
  const { handler, created } = loadApi(orders);

  const res = await handler(event('POST /api/admin/orders/{id}/revisions', 'copy-1', { comments: 'Branch', fromVersion: 2 }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).copied, true);
  assert.equal(created[0].forkedFrom, 'copy-1');
  assert.equal(orders.get('copy-1').status, STATUS.DELIVERED);

  const latest = await handler(event('POST /api/admin/orders/{id}/revisions', 'copy-1', { comments: 'In place', fromVersion: 4 }));
  assert.equal(latest.statusCode, 200, latest.body);
  assert.equal(JSON.parse(latest.body).copied, false);
  assert.equal(created.length, 1);
});

test('an older version is refused for edits, locks, unknown versions and versions with no job', async (t) => {
  cleanup(t);
  const orders = new Map([['lauri-tsla', historyOrder()]]);
  const { handler, created } = loadApi(orders);
  const cases = [
    ['POST /api/admin/orders/{id}/edits', { edits: { 'recommendation/prose/0': 'x' }, fromVersion: 2 }, 400],
    ['POST /api/admin/orders/{id}/revisions', { comments: 'x', fromVersion: 2, valuationOverrides: { rows: [] } }, 400],
    ['POST /api/admin/orders/{id}/revisions', { comments: 'x', fromVersion: 5 }, 400],
    ['POST /api/admin/orders/{id}/revisions', { comments: 'x', fromVersion: 'two' }, 400],
    ['POST /api/admin/orders/{id}/revisions', { comments: 'x', fromVersion: 3 }, 409],
  ];
  for (const [route, body, status] of cases) {
    const res = await handler(event(route, 'lauri-tsla', body));
    assert.equal(res.statusCode, status, `${JSON.stringify(body)}: ${res.body}`);
  }
  assert.equal(created.length, 0);
});

test('the admin view says which versions can be revised', async (t) => {
  cleanup(t);
  const { handler } = loadApi(new Map([['lauri-tsla', historyOrder()]]));
  const res = await handler(event('GET /api/admin/orders/{id}', 'lauri-tsla'));
  assert.equal(res.statusCode, 200, res.body);
  const flags = Object.fromEntries(JSON.parse(res.body).revisionHistory.map((e) => [e.version, e.revisable]));
  assert.deepEqual(flags, { 1: true, 2: true, 3: false, 4: true });
});
