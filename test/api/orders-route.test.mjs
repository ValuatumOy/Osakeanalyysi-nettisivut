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
const MEMBERS_STORE_ID = require.resolve('../../server/members/store.js');

const STATUS = Object.freeze({
  NEW: 'NEW', IMPORTING: 'IMPORTING', RENDERING: 'RENDERING',
  DELIVERED: 'DELIVERED', REVISING: 'REVISING', FAILED: 'FAILED',
});

function fakeOrdersStore(orders) {
  return {
    STATUS,
    async get(id) { return orders.has(id) ? { ...orders.get(id) } : null; },
    async claimRevision(id, comment, valuationOverrides = null, scope, images = []) {
      const order = orders.get(id);
      if (!order) return null;
      if (order.publicationLocked) return null;
      if (order.status !== STATUS.DELIVERED) return null;
      if ((order.revisionsUsed || 0) >= (order.revisionsAllowed || 0)) return null;
      order.status = STATUS.REVISING;
      order.pendingRevisionComment = comment;
      order.pendingValuationOverrides = valuationOverrides;
      order.pendingRevisionScope = scope;
      order.pendingRevisionImages = images.length ? images : null;
      return order;
    },
    async claimEdit(id, edit) {
      const order = orders.get(id);
      if (!order) return null;
      if (order.publicationLocked) return null;
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

function loadApi({ orders = new Map(), secret = 'test-secret', engine = fakeEngine(), legacyPublications = null } = {}) {
  delete require.cache[API_ID];
  delete require.cache[ORDER_EDITING_ID];
  process.env.CATALOG_SYNC_SECRET = secret;
  delete process.env.WORKER_FUNCTION_NAME; // invokeWorkerAsync becomes a no-op
  delete process.env.SECRETS_SSM_PREFIX; // ensureSecrets becomes a no-op
  process.env.MEMBERS_TABLE = 'Members';

  const ordersStore = fakeOrdersStore(orders);
  const pdfStore = fakePdfStore();
  require.cache[ORDERS_STORE_ID] = { id: ORDERS_STORE_ID, filename: ORDERS_STORE_ID, loaded: true, exports: ordersStore };
  require.cache[PDF_STORE_ID] = { id: PDF_STORE_ID, filename: PDF_STORE_ID, loaded: true, exports: pdfStore };
  require.cache[ENGINE_ID] = { id: ENGINE_ID, filename: ENGINE_ID, loaded: true, exports: engine };
  require.cache[MEMBERS_STORE_ID] = { id: MEMBERS_STORE_ID, filename: MEMBERS_STORE_ID, loaded: true,
    exports: { findPublicationForOrder: async id => legacyPublications?.get(id) || null } };

  return { handler: require(API_ID).handler, orders, pdfStore, engine };
}

function cleanup(t) {
  t.after(() => { for (const id of [API_ID, ORDERS_STORE_ID, PDF_STORE_ID, ENGINE_ID, ORDER_EDITING_ID, MEMBERS_STORE_ID]) delete require.cache[id]; });
}

test('published orders are frozen and exposed legacy receipts require member authentication', async (t) => {
  cleanup(t);
  const orders = new Map([
    ['cs_locked', { id: 'cs_locked', status: STATUS.DELIVERED, jobId: 'job', publicationLocked: true, revisionsAllowed: 3, revisionsUsed: 1 }],
    ['cs_legacy', { id: 'cs_legacy', ticker: 'NOKIA.HE', status: STATUS.DELIVERED, jobId: 'job', forkedFrom: 'parent', revisionsAllowed: 3, revisionsUsed: 1 }],
    ['cs_private', { id: 'cs_private', ticker: 'NOKIA.HE', status: STATUS.DELIVERED, jobId: 'job', forkedFrom: 'parent', revisionsAllowed: 3, revisionsUsed: 1 }],
  ]);
  const { handler } = loadApi({ orders, legacyPublications: new Map([
    ['cs_legacy', { status: 'published' }], ['cs_missing', { status: 'published' }],
  ]) });
  const state = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_locked' }))).body);
  assert.equal(state.publicationLocked, true);
  assert.equal(state.editable, false);
  assert.equal((await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_locked', body: { comments: 'Revise' } }))).statusCode, 409);
  for (const route of ['GET /api/orders/{id}', 'GET /api/orders/{id}/preview', 'POST /api/orders/{id}/revisions', 'POST /api/orders/{id}/edits', 'POST /api/orders/{id}/valuation']) {
    const body = route.includes('revisions') ? { comments: 'Revise' } : route.includes('edits') ? { edits: { 'recommendation/prose/0': 'Changed' } } : {};
    assert.equal((await handler(event(route, { id: 'cs_legacy', body }))).statusCode, 403, route);
  }
  orders.get('cs_legacy').memberOnly = true;
  orders.get('cs_legacy').publicationLocked = false;
  assert.equal((await handler(event('GET /api/orders/{id}', { id: 'cs_legacy' }))).statusCode, 403);
  assert.equal((await handler(event('GET /api/orders/{id}', { id: 'cs_missing' }))).statusCode, 403);
  assert.equal((await handler(event('GET /api/orders/{id}/preview', { id: 'cs_missing' }))).statusCode, 403);
  assert.equal((await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_private', body: { comments: 'Revise' } }))).statusCode, 200);
});

function event(routeKey, { id, body, secret = 'test-secret' } = {}) {
  return {
    routeKey,
    pathParameters: id ? { id } : {},
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
}

test('shop revisions validate scope before claiming and default to forecasts', async (t) => {
  cleanup(t);
  const orders = new Map([
    ['cs_scope', { id: 'cs_scope', status: STATUS.DELIVERED, revisionsAllowed: 2, revisionsUsed: 0 }],
  ]);
  const { handler } = loadApi({ orders });
  for (const scope of ['edit', 'narrative', '', null, 42, {}]) {
    const response = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_scope', body: { comments: 'Clearer wording', scope } }));
    assert.equal(response.statusCode, 400, JSON.stringify(scope));
    assert.equal(orders.get('cs_scope').status, STATUS.DELIVERED);
  }
  for (const scope of ['content', 'estimates', undefined]) {
    orders.get('cs_scope').status = STATUS.DELIVERED;
    const response = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_scope', body: { comments: 'Clearer wording', scope } }));
    assert.equal(response.statusCode, 200);
    assert.equal(orders.get('cs_scope').pendingRevisionScope, scope || 'estimates');
  }
  orders.get('cs_scope').status = STATUS.DELIVERED;
  const valuationOverrides = { 'core auto': { selectedMultiple: 12 } };
  const response = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_scope', body: { comments: 'Use my assumptions', scope: 'content', valuationOverrides } }));
  assert.equal(response.statusCode, 200);
  assert.equal(orders.get('cs_scope').pendingRevisionScope, 'narrative');
});

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

test('GET /api/orders/{id} returns a permanent PDF link only when DELIVERED', async (t) => {
  const orders = new Map([
    ['cs_delivered', { id: 'cs_delivered', status: STATUS.DELIVERED, pdfFileName: 'a.pdf', revisionsAllowed: 2, revisionsUsed: 1 }],
    ['cs_revising', { id: 'cs_revising', status: STATUS.REVISING, pdfFileName: 'a.pdf', revisionsAllowed: 2, revisionsUsed: 1 }],
  ]);
  const { handler } = loadApi({ orders });
  t.after(() => { delete require.cache[API_ID]; delete require.cache[ORDERS_STORE_ID]; delete require.cache[PDF_STORE_ID]; });

  const delivered = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_delivered' }))).body);
  // Same permanent, unsigned link the delivery email carries (server/reconciler.js
  // PDF_BASE_URL) — not a presigned S3 URL, which expired on the order page while
  // the identical file stayed reachable forever at this address anyway.
  assert.equal(delivered.pdfUrl, 'https://files.aiequityreports.com/reports/pdfs/a.pdf');
  assert.equal(delivered.revisionsAllowed, 2);
  assert.equal(delivered.revisionsUsed, 1);

  const revising = JSON.parse((await handler(event('GET /api/orders/{id}', { id: 'cs_revising' }))).body);
  assert.equal(revising.pdfUrl, undefined);
  assert.equal(revising.status, STATUS.REVISING);
});

test('GET /api/orders/{id} returns revisionHistory newest-first with a permanent pdfUrl per entry', async (t) => {
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
  assert.equal(body.revisionHistory[0].pdfUrl, 'https://files.aiequityreports.com/reports/pdfs/rev2.pdf');
  assert.equal(body.revisionHistory[0].changes, null);
  assert.equal(body.revisionHistory[1].version, 2);
  assert.equal(body.revisionHistory[1].comments, 'first change');
  // pdfStore.presignPdfDownload is no longer on this path at all — permanentPdfUrl
  // builds the link locally, no S3/CloudFront call.
  assert.deepEqual(pdfStore.calls.presignPdfDownload, []);
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
  const badOverrides = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_1', body: { comments: 'lock', valuationOverrides: { 'core auto': { selectedMultiple: 'x' } } } }));
  assert.equal(badOverrides.statusCode, 400);
  assert.match(JSON.parse(badOverrides.body).error, /finite number/);
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
  assert.equal(edit.pdfUrl, 'https://files.aiequityreports.com/reports/pdfs/edit1.pdf');
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

test('images sent with a revision are stored first and the claim carries only their keys', async (t) => {
  cleanup(t);
  const CLIENTS_ID = require.resolve('../../server/aws/clients.js');
  const IMAGES_ID = require.resolve('../../server/revision-images.js');
  const puts = [];
  delete require.cache[IMAGES_ID];
  require.cache[CLIENTS_ID] = { id: CLIENTS_ID, filename: CLIENTS_ID, loaded: true,
    exports: { s3: () => ({ async send(command) { puts.push(command.input); return {}; } }) } };
  t.after(() => { delete require.cache[CLIENTS_ID]; delete require.cache[IMAGES_ID]; });
  process.env.REPORT_PDF_BUCKET = 'stage-bucket';
  const orders = new Map([['cs_img', { id: 'cs_img', status: STATUS.DELIVERED, revisionsAllowed: 2, revisionsUsed: 0 }]]);
  const { handler } = loadApi({ orders });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const bad = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_img', body: { comments: 'Add it', images: [{ data: png, mimeType: 'image/gif' }] } }));
  assert.equal(bad.statusCode, 400);
  assert.equal(orders.get('cs_img').status, STATUS.DELIVERED, 'a refused image claims nothing');
  const res = await handler(event('POST /api/orders/{id}/revisions', { id: 'cs_img', body: { comments: 'Put this map on the robotaxi page', images: [{ data: png, mimeType: 'image/png' }] } }));
  assert.equal(res.statusCode, 200);
  const keys = orders.get('cs_img').pendingRevisionImages;
  assert.deepEqual(keys, [{ key: puts[0].Key, mimeType: 'image/png' }]);
  assert.equal(puts[0].Bucket, 'stage-bucket');
  assert.doesNotMatch(JSON.stringify(orders.get('cs_img')), new RegExp(png.slice(0, 8)), 'no image bytes on the order');
});
