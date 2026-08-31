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
const ENGINE_ID = require.resolve('../../server/engine-client.js');
// order-editing.js holds its own reference to the engine client, so it has
// to be reloaded whenever the fake engine is swapped.
const ORDER_EDITING_ID = require.resolve('../../server/order-editing.js');

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
    async claimEdit(id, edit) {
      const order = orders.get(id);
      if (!order) return null;
      if (order.status !== STATUS.DELIVERED) return null;
      order.status = STATUS.REVISING;
      order.pendingEdit = edit;
      return order;
    },
  };
}

function fakeEngine(overrides = {}) {
  return {
    calls: { getJob: [], fetchPreviewHtml: [] },
    async getJob(jobId) {
      this.calls.getJob.push(jobId);
      return overrides.getJob ? overrides.getJob(jobId) : { jobId, status: 'DONE', s3Url: 'https://s3.example/x.pdf', previewUrl: 'https://s3.example/x.preview.html' };
    },
    async fetchPreviewHtml(url) {
      this.calls.fetchPreviewHtml.push(url);
      return '<!doctype html><html><body><p data-pointer="recommendation/prose/0">Hello</p></body></html>';
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

function loadApi({ orders = new Map(), secret = 'test-secret', engine = fakeEngine() } = {}) {
  delete require.cache[API_ID];
  delete require.cache[ORDER_EDITING_ID];
  process.env.CATALOG_SYNC_SECRET = secret;
  delete process.env.WORKER_FUNCTION_NAME; // invokeWorkerAsync becomes a no-op
  delete process.env.SECRETS_SSM_PREFIX; // ensureSecrets becomes a no-op

  const ordersStore = fakeOrdersStore(orders);
  const pdfStore = fakePdfStore();
  require.cache[ORDERS_STORE_ID] = { id: ORDERS_STORE_ID, filename: ORDERS_STORE_ID, loaded: true, exports: ordersStore };
  require.cache[PDF_STORE_ID] = { id: PDF_STORE_ID, filename: PDF_STORE_ID, loaded: true, exports: pdfStore };
  require.cache[ENGINE_ID] = { id: ENGINE_ID, filename: ENGINE_ID, loaded: true, exports: engine };

  return { handler: require(API_ID).handler, orders, pdfStore, engine };
}

function cleanup(t) {
  t.after(() => { for (const id of [API_ID, ORDERS_STORE_ID, PDF_STORE_ID, ENGINE_ID, ORDER_EDITING_ID]) delete require.cache[id]; });
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

  // The cap is a DynamoDB-item guard, not an editorial one: a long briefing
  // has to get through, a pasted document does not.
  const longButFine = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_1', body: { comments: 'x'.repeat(20000) } }));
  assert.notEqual(longButFine.statusCode, 400);

  const tooLong = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_1', body: { comments: 'x'.repeat(40001) } }));
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

// ── Hand edits ─────────────────────────────────────────────────────────

test('GET /api/orders/{id} says whether the text can be edited, which version is current, and labels every history entry', async (t) => {
  const orders = new Map([
    ['cs_e', {
      id: 'cs_e', status: STATUS.DELIVERED, jobId: 'job_3', pdfFileName: 'latest.pdf', revisionsAllowed: 0, revisionsUsed: 0, editsUsed: 1,
      revisionHistory: [
        { version: 2, comments: 'first change', pdfFileName: 'rev1.pdf', completedAt: '2026-01-01T00:00:00.000Z', changes: null },
        { version: 3, kind: 'edit', authorship: 'analyst', editedBy: 'Maija', editedFrom: 2, pdfFileName: 'edit1.pdf', completedAt: '2026-01-02T00:00:00.000Z',
          changes: null, edits: [{ pointer: 'recommendation/prose/0', before: 'a', after: 'b' }], editWarnings: { unknownPointers: [] }, fit: { shrunk: [], clipped: [] } },
      ],
    }],
    ['cs_old', { id: 'cs_old', status: STATUS.DELIVERED, jobId: 'job_1', pdfFileName: 'a.pdf', hasPreview: false }],
    ['cs_busy', { id: 'cs_busy', status: STATUS.REVISING, jobId: 'job_1', pdfFileName: 'a.pdf', pendingEdit: { edits: { 'a/b': 'x' } } }],
  ]);
  const { handler } = loadApi({ orders });
  cleanup(t);

  const body = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_e' }))).body);
  assert.equal(body.editable, true);
  assert.equal(body.currentVersion, 3);
  assert.equal(body.activity, null);
  assert.equal(body.editsUsed, 1);
  const [edit, revision] = body.revisionHistory;
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.authorship, 'analyst');
  assert.equal(edit.editedBy, 'Maija');
  assert.equal(edit.editedFrom, 2);
  assert.deepEqual(edit.edits, [{ pointer: 'recommendation/prose/0', before: 'a', after: 'b' }]);
  assert.equal(edit.pdfUrl, 'https://signed.example/edit1.pdf');
  assert.equal(revision.kind, 'revision'); // written before edits existed: an AI revision
  assert.equal(revision.authorship, 'ai');
  assert.equal(revision.edits, undefined);

  const old = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_old' }))).body);
  assert.equal(old.editable, false);

  const busy = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_busy' }))).body);
  assert.equal(busy.editable, false);
  assert.equal(busy.activity, 'editing');
});

test('POST /api/orders/{id}/edits validates, claims the order without touching the allowance, and records the version edited from', async (t) => {
  const orders = new Map([
    ['cs_1', { id: 'cs_1', status: STATUS.DELIVERED, jobId: 'job_1', pdfFileName: 'a.pdf', revisionsAllowed: 0, revisionsUsed: 0, revisionHistory: [{ version: 2 }] }],
  ]);
  const { handler } = loadApi({ orders });
  cleanup(t);

  const bad = await handler(event('POST /api/orders/{id}/edits', { id: 'cs_1', body: { edits: { 'no good': 'x' } } }));
  assert.equal(bad.statusCode, 400);
  assert.equal(orders.get('cs_1').status, STATUS.DELIVERED);

  const res = await handler(event('POST /api/orders/{id}/edits', {
    id: 'cs_1',
    body: { edits: { 'recommendation/prose/0': 'BUY.' }, originals: { 'recommendation/prose/0': 'HOLD.' }, editedBy: 'Maija' },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).version, 3);
  const order = orders.get('cs_1');
  assert.equal(order.status, STATUS.REVISING);
  assert.deepEqual(order.pendingEdit, {
    edits: { 'recommendation/prose/0': 'BUY.' }, originals: { 'recommendation/prose/0': 'HOLD.' }, editedBy: 'Maija', fromVersion: 2,
  });

  const again = await handler(event('POST /api/orders/{id}/edits', { id: 'cs_1', body: { edits: { 'a/b': 'x' } } }));
  assert.equal(again.statusCode, 409);
});

test('GET /api/orders/{id}/preview proxies the engine HTML, and explains when there is none', async (t) => {
  const orders = new Map([
    ['cs_ok', { id: 'cs_ok', status: STATUS.DELIVERED, jobId: 'job_ok', pdfFileName: 'a.pdf', revisionHistory: [] }],
    ['cs_none', { id: 'cs_none', status: STATUS.DELIVERED, jobId: 'job_none', pdfFileName: 'a.pdf' }],
    ['cs_busy', { id: 'cs_busy', status: STATUS.REVISING, jobId: 'job_ok', pdfFileName: 'a.pdf' }],
  ]);
  const engine = fakeEngine({
    getJob: (jobId) => (jobId === 'job_none'
      ? { jobId, status: 'DONE', s3Url: 'https://s3.example/x.pdf' }
      : { jobId, status: 'DONE', s3Url: 'https://s3.example/x.pdf', previewUrl: 'https://s3.example/signed.preview.html' }),
  });
  const { handler } = loadApi({ orders, engine });
  cleanup(t);

  const ok = await handler(event('GET /api/orders/{id}/preview', { id: 'cs_ok' }));
  assert.equal(ok.statusCode, 200);
  assert.match(ok.headers['content-type'], /text\/html/);
  assert.equal(ok.headers['x-report-version'], '1');
  assert.match(ok.body, /data-pointer/);
  assert.deepEqual(engine.calls.fetchPreviewHtml, ['https://s3.example/signed.preview.html']);

  const none = await handler(event('GET /api/orders/{id}/preview', { id: 'cs_none' }));
  assert.equal(none.statusCode, 409);
  assert.match(JSON.parse(none.body).error, /before text editing was supported/);

  const busy = await handler(event('GET /api/orders/{id}/preview', { id: 'cs_busy' }));
  assert.equal(busy.statusCode, 409);

  const unauthorised = await handler(event('GET /api/orders/{id}/preview', { id: 'cs_ok', secret: 'wrong' }));
  assert.equal(unauthorised.statusCode, 401);
});
