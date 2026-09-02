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
      entry({ id: 'nokia-05062026', fileName: 'Nokia_05062026.pdf' }),
    ] },
    state: { purchases: [] },
  }),
});
stub('../../server/aws/orders-store.js', {
  STATUS: { DELIVERED: 'DELIVERED' },
  list: async () => [
    {
      id: 'order-1', email: 'buyer@example.com', visibility: undefined,
      pdfFileName: 'Tesla_20082026_rev-ab.pdf', originalPdfFileName: 'Tesla_20082026.pdf',
      deliveredEmailAt: '2026-08-20T12:10:09.000Z',
      revisionHistory: [{ version: 2, pdfFileName: 'Tesla_20082026_rev-ab.pdf', completedAt: '2026-08-20T13:54:00.000Z' }],
    },
  ],
  get: async () => null,
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

  // The public catalog must not leak any of it.
  const pub = await handler({ routeKey: 'GET /api/reports', headers: {} });
  const first = JSON.parse(pub.body).reports[0];
  for (const field of ['groupId', 'origin', 'generatedBy', 'provenanceSessionId']) {
    assert.ok(!(field in first), `${field} leaked into the public listing`);
  }
});
