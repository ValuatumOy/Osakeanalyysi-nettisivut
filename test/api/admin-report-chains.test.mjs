// Fifteen Tesla rows and no way to tell which was which: every revised copy of
// an order sat in the catalog as its own anonymous entry. The admin listing now
// says how each file came to exist, who asked for it, and which order's chain
// it belongs to — so the page can fold revisions behind their report.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.ADMIN_UPLOAD_PASSWORD = 'pw';

function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

const entry = (over) => ({
  id: 'x', companyName: 'Tesla', ticker: 'TSLA', reportDate: '2026-08-20',
  fileName: 'f.pdf', pdfUrl: 'u', availability: 'available', publicationStatus: 'ready',
  price: 20, tags: [], provenanceSessionId: null, isRevision: false, ...over,
});

stub('../../server/aws/catalog-aws.js', {
  buildCatalogAws: async () => ({
    catalog: { generatedAt: 'now', week: 1, reports: [
      entry({ id: 'tesla-20082026', fileName: 'Tesla_20082026.pdf', provenanceSessionId: 'order-1' }),
      entry({ id: 'tesla-20082026-rev-1', fileName: 'Tesla_20082026_rev-ab.pdf', provenanceSessionId: 'order-1', isRevision: true }),
      entry({ id: 'tesla-20082026-edit-1', fileName: 'Tesla_20082026_edit-cd.pdf', provenanceSessionId: 'order-1', isRevision: true }),
      entry({ id: 'nokia-05062026', fileName: 'Nokia_05062026.pdf' }),
      // A fork of order-1: it revises the parent's engine job, so it has no
      // original of its own — only revised copies, numbered from 2.
      entry({ id: 'tesla-03092026-rev-2', fileName: 'Tesla_03092026_rev-fork.pdf', provenanceSessionId: 'fork-1', isRevision: true }),
      entry({ id: 'tesla-04092026-rev-2', fileName: 'Tesla_04092026_rev-fork.pdf', provenanceSessionId: 'fork-1', isRevision: true }),
    ] },
    state: { purchases: [] },
  }),
});
const ORDERS = [
    {
      id: 'order-1', email: 'buyer@example.com', visibility: undefined,
      pdfFileName: 'Tesla_20082026_rev-ab.pdf', originalPdfFileName: 'Tesla_20082026.pdf',
      deliveredEmailAt: '2026-08-20T12:10:09.000Z',
      revisionHistory: [
        { version: 2, kind: 'revision', pdfFileName: 'Tesla_20082026_rev-ab.pdf', completedAt: '2026-08-20T13:54:00.000Z' },
        { version: 3, kind: 'edit', pdfFileName: 'Tesla_20082026_edit-cd.pdf', completedAt: '2026-08-20T14:02:00.000Z' },
      ],
    },
    {
      id: 'fork-1', email: 'analyst@example.com', visibility: 'private', forkedFrom: 'order-1',
      pdfFileName: 'Tesla_04092026_rev-fork.pdf', originalPdfFileName: null, deliveredEmailAt: null,
      revisionHistory: [
        { version: 2, kind: 'revision', pdfFileName: 'Tesla_03092026_rev-fork.pdf', completedAt: '2026-09-03T13:50:40.000Z' },
        { version: 3, kind: 'revision', pdfFileName: 'Tesla_04092026_rev-fork.pdf', completedAt: '2026-09-04T05:18:34.000Z' },
      ],
    },
];
stub('../../server/aws/orders-store.js', {
  STATUS: { DELIVERED: 'DELIVERED' },
  list: async () => ORDERS,
  get: async (id) => ORDERS.find((o) => o.id === id) || null,
});
stub('../../server/aws/pdf-store.js', {});
stub('../../server/stripe-pricing.js', { getStripePricing: async () => ({}) });

const { handler } = require('../../server/lambda/api.js');

test('the admin listing carries chain, origin and author; the public one does not', async () => {
  const res = await handler({
    routeKey: 'GET /api/admin/reports',
    headers: { authorization: 'Bearer pw' },
  });
  assert.equal(res.statusCode, 200);
  const { reports } = JSON.parse(res.body);

  const base = reports.find((r) => r.id === 'tesla-20082026');
  const rev = reports.find((r) => r.id === 'tesla-20082026-rev-1');
  const upload = reports.find((r) => r.id === 'nokia-05062026');

  // One order, one chain: base and revision fold together.
  assert.equal(base.groupId, 'order-1');
  assert.equal(rev.groupId, 'order-1');
  assert.equal(rev.isRevision, true);
  assert.equal(base.isRevision, false);

  // Who and how.
  assert.equal(base.origin, 'order');
  assert.equal(base.generatedBy, 'buyer@example.com');
  assert.equal(upload.origin, 'uploaded');
  assert.equal(upload.groupId, 'nokia-05062026', 'an upload stands alone under its own id');

  // Every row links to its PDF, paid and revised copies included: the public
  // payload's free-only rule would have left the revision with no link at all.
  assert.match(base.pdfUrl, /\/Tesla_20082026\.pdf$/);
  assert.match(rev.pdfUrl, /\/Tesla_20082026_rev-ab\.pdf$/);

  // When each file was produced comes from the order, not the bucket.
  assert.equal(base.generatedAt, '2026-08-20T12:10:09.000Z');
  assert.equal(rev.generatedAt, '2026-08-20T13:54:00.000Z');
  assert.equal(upload.generatedAt, null);

  // A revised copy says what made it; an original has no kind.
  const edited = reports.find((r) => r.id === 'tesla-20082026-edit-1');
  assert.equal(rev.kind, 'revision');
  assert.equal(edited.kind, 'edit');
  assert.equal(base.kind, null);
  assert.equal(upload.kind, null);

  // Which version each file is comes from the order, not from counting files.
  assert.equal(base.version, 1);
  assert.equal(rev.version, 2);
  assert.equal(edited.version, 3);
  assert.equal(upload.version, null);
  assert.equal(base.forkedFrom, null);

  // A fork has no version 1 of its own: its latest file must not pass for an
  // original, and its pdfFileName (the newest revision) is not one either.
  const forkV2 = reports.find((r) => r.id === 'tesla-03092026-rev-2');
  const forkV3 = reports.find((r) => r.id === 'tesla-04092026-rev-2');
  assert.equal(forkV2.version, 2);
  assert.equal(forkV3.version, 3);
  assert.equal(forkV3.forkedFrom, 'order-1');
  assert.equal(forkV3.isRevision, true);
  assert.equal(forkV3.generatedAt, '2026-09-04T05:18:34.000Z');

  // The public catalog must not leak any of it.
  const pub = await handler({ routeKey: 'GET /api/reports', headers: {} });
  const first = JSON.parse(pub.body).reports[0];
  for (const field of ['groupId', 'origin', 'generatedBy', 'provenanceSessionId', 'version', 'forkedFrom']) {
    assert.ok(!(field in first), `${field} leaked into the public listing`);
  }
});

// The revision history — forecast writeups, change memos — was readable only
// by the customer who asked for the revisions. The admin can now open any
// order's history from the catalog, behind the admin password, read-only.
test('the admin can read any order\'s revision history; the password is required', async () => {
  const res = await handler({
    routeKey: 'GET /api/admin/orders/{id}',
    pathParameters: { id: 'fork-1' },
    headers: { authorization: 'Bearer pw' },
  });
  assert.equal(res.statusCode, 200);
  const order = JSON.parse(res.body);
  assert.equal(order.readOnly, true);
  assert.equal(order.email, 'analyst@example.com');
  assert.equal(order.forkedFrom, 'order-1');
  // Newest first, and the fork has no original to append.
  assert.deepEqual(order.revisionHistory.map((e) => e.version), [3, 2]);
  assert.match(order.revisionHistory[0].pdfUrl, /Tesla_04092026_rev-fork\.pdf$/);

  // A real original is appended as version 1, same as the customer sees.
  const parent = JSON.parse((await handler({
    routeKey: 'GET /api/admin/orders/{id}',
    pathParameters: { id: 'order-1' },
    headers: { authorization: 'Bearer pw' },
  })).body);
  assert.deepEqual(parent.revisionHistory.map((e) => e.version), [3, 2, 1]);
  assert.equal(parent.revisionHistory[2].original, true);

  const denied = await handler({
    routeKey: 'GET /api/admin/orders/{id}',
    pathParameters: { id: 'order-1' },
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(denied.statusCode, 401);

  const missing = await handler({
    routeKey: 'GET /api/admin/orders/{id}',
    pathParameters: { id: 'nope' },
    headers: { authorization: 'Bearer pw' },
  });
  assert.equal(missing.statusCode, 404);
});
