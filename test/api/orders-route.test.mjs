import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// server/lambda/api.js is CommonJS and requires its collaborators at module
// load time, so ordersStore/pdfStore are faked via require.cache injection —
// the same trick test/reconciler/revisions.test.mjs uses — before requiring
// the handler fresh. Nothing here touches real AWS.
const require = createRequire(import.meta.url);

const API_ID = require.resolve('../../server/lambda/api.js');
const ORDERS_STORE_ID = require.resolve('../../server/aws/orders-store.js');
const PDF_STORE_ID = require.resolve('../../server/aws/pdf-store.js');

const STATUS = Object.freeze({
  NEW: 'NEW', IMPORTING: 'IMPORTING', RENDERING: 'RENDERING',
  DELIVERED: 'DELIVERED', REVISING: 'REVISING', FAILED: 'FAILED',
});

function fakeOrdersStore(orders) {
  return {
    STATUS,
    async get(id) { return orders.get(id) || null; },
    async claimRevision(id, comment) {
      const order = orders.get(id);
      if (!order) return null;
      if (order.status !== STATUS.DELIVERED) return null;
      if ((order.revisionsUsed || 0) >= (order.revisionsAllowed || 0)) return null;
      order.status = STATUS.REVISING;
      order.pendingRevisionComment = comment;
      return order;
    },
  };
}

function fakePdfStore() {
  return {
    calls: { presignPdfDownload: [] },
    async presignPdfDownload(fileName) {
      this.calls.presignPdfDownload.push(fileName);
      return `https://signed.example/${fileName}`;
    },
  };
}

function loadApi({ orders = new Map(), secret = 'test-secret' } = {}) {
  delete require.cache[API_ID];
  process.env.CATALOG_SYNC_SECRET = secret;
  delete process.env.WORKER_FUNCTION_NAME; // invokeWorkerAsync becomes a no-op
  delete process.env.SECRETS_SSM_PREFIX; // ensureSecrets becomes a no-op

  const ordersStore = fakeOrdersStore(orders);
  const pdfStore = fakePdfStore();
  require.cache[ORDERS_STORE_ID] = { id: ORDERS_STORE_ID, filename: ORDERS_STORE_ID, loaded: true, exports: ordersStore };
  require.cache[PDF_STORE_ID] = { id: PDF_STORE_ID, filename: PDF_STORE_ID, loaded: true, exports: pdfStore };

  return { handler: require(API_ID).handler, orders, pdfStore };
}

function event(routeKey, { id, body, secret = 'test-secret' } = {}) {
  return {
    routeKey,
    pathParameters: id ? { id } : {},
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
}

test('GET /api/orders/{id} rejects a missing/wrong bearer', async (t) => {
  const { handler } = loadApi();
  t.after(() => { delete require.cache[API_ID]; delete require.cache[ORDERS_STORE_ID]; delete require.cache[PDF_STORE_ID]; });

  const res = await handler(event('GET /api/orders/{id}', { id: 'cs_1', secret: 'wrong' }));
  assert.equal(res.statusCode, 401);
});

test('GET /api/orders/{id} returns 404 for an unknown order', async (t) => {
  const { handler } = loadApi();
  t.after(() => { delete require.cache[API_ID]; delete require.cache[ORDERS_STORE_ID]; delete require.cache[PDF_STORE_ID]; });

  const res = await handler(event('GET /api/orders/{id}', { id: 'cs_missing' }));
  assert.equal(res.statusCode, 404);
});

test('GET /api/orders/{id} presigns a PDF link only when DELIVERED', async (t) => {
  const orders = new Map([
    ['cs_delivered', { id: 'cs_delivered', status: STATUS.DELIVERED, pdfFileName: 'a.pdf', revisionsAllowed: 2, revisionsUsed: 1 }],
    ['cs_revising', { id: 'cs_revising', status: STATUS.REVISING, pdfFileName: 'a.pdf', revisionsAllowed: 2, revisionsUsed: 1 }],
  ]);
  const { handler } = loadApi({ orders });
  t.after(() => { delete require.cache[API_ID]; delete require.cache[ORDERS_STORE_ID]; delete require.cache[PDF_STORE_ID]; });

  const delivered = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_delivered' }))).body);
  assert.equal(delivered.pdfUrl, 'https://signed.example/a.pdf');
  assert.equal(delivered.revisionsAllowed, 2);
  assert.equal(delivered.revisionsUsed, 1);

  const revising = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_revising' }))).body);
  assert.equal(revising.pdfUrl, undefined);
  assert.equal(revising.status, STATUS.REVISING);
});

test('GET /api/orders/{id} returns revisionHistory newest-first with a presigned pdfUrl per entry', async (t) => {
  const orders = new Map([
    ['cs_history', {
      id: 'cs_history', status: STATUS.DELIVERED, pdfFileName: 'latest.pdf', revisionsAllowed: 3, revisionsUsed: 2,
      revisionHistory: [
        { version: 2, comments: 'first change', pdfFileName: 'rev1.pdf', completedAt: '2026-01-01T00:00:00.000Z', changes: { headline: {} } },
        { version: 3, comments: 'second change', pdfFileName: 'rev2.pdf', completedAt: '2026-01-02T00:00:00.000Z', changes: null },
      ],
    }],
  ]);
  const { handler, pdfStore } = loadApi({ orders });
  t.after(() => { delete require.cache[API_ID]; delete require.cache[ORDERS_STORE_ID]; delete require.cache[PDF_STORE_ID]; });

  const body = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_history' }))).body);
  assert.equal(body.revisionHistory.length, 2);
  assert.equal(body.revisionHistory[0].version, 3); // newest first
  assert.equal(body.revisionHistory[0].pdfUrl, 'https://signed.example/rev2.pdf');
  assert.equal(body.revisionHistory[0].changes, null);
  assert.equal(body.revisionHistory[1].version, 2);
  assert.equal(body.revisionHistory[1].comments, 'first change');
  assert.deepEqual(pdfStore.calls.presignPdfDownload.sort(), ['latest.pdf', 'rev1.pdf', 'rev2.pdf']);
});

test('POST /api/orders/{id}/revisions rejects empty, oversized and control-character comments', async (t) => {
  const orders = new Map([
    ['cs_1', { id: 'cs_1', status: STATUS.DELIVERED, pdfFileName: 'a.pdf', revisionsAllowed: 2, revisionsUsed: 0 }],
  ]);
  const { handler } = loadApi({ orders });
  t.after(() => { delete require.cache[API_ID]; delete require.cache[ORDERS_STORE_ID]; delete require.cache[PDF_STORE_ID]; });

  const empty = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_1', body: { comments: '   ' } }));
  assert.equal(empty.statusCode, 400);

  const tooLong = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_1', body: { comments: 'x'.repeat(4001) } }));
  assert.equal(tooLong.statusCode, 400);

  const controlChar = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_1', body: { comments: 'bad\x07comment' } }));
  assert.equal(controlChar.statusCode, 400);
});

test('POST /api/orders/{id}/revisions succeeds and claims the order', async (t) => {
  const orders = new Map([
    ['cs_1', { id: 'cs_1', status: STATUS.DELIVERED, pdfFileName: 'a.pdf', revisionsAllowed: 2, revisionsUsed: 0 }],
  ]);
  const { handler } = loadApi({ orders });
  t.after(() => { delete require.cache[API_ID]; delete require.cache[ORDERS_STORE_ID]; delete require.cache[PDF_STORE_ID]; });

  const res = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_1', body: { comments: 'raise margins' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(orders.get('cs_1').status, STATUS.REVISING);
  assert.equal(orders.get('cs_1').pendingRevisionComment, 'raise margins');
});

test('POST /api/orders/{id}/revisions 409s a double-submit', async (t) => {
  const orders = new Map([
    ['cs_1', { id: 'cs_1', status: STATUS.REVISING, pdfFileName: 'a.pdf', revisionsAllowed: 2, revisionsUsed: 0 }],
  ]);
  const { handler } = loadApi({ orders });
  t.after(() => { delete require.cache[API_ID]; delete require.cache[ORDERS_STORE_ID]; delete require.cache[PDF_STORE_ID]; });

  const res = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_1', body: { comments: 'again' } }));
  assert.equal(res.statusCode, 409);
});
