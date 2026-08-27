// An analyst covering Tesla must not be able to read-and-score another analyst's
// Tesla analysis — the cheapest route up the ranking would be marking every rival
// down. Buying stays open; only the graded read is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

// Mutable per test: what the reviewer has generated, and whether they already paid
// for this read.
const state = { pubs: [], reads: {}, orders: {} };

stub('../../server/aws/catalog-aws.js', {});
stub('../../server/search.js', { searchCompanies: async () => [] });
stub('../../server/members/bounty.js', {});
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: { userId: 'reviewer', role: 'analyst' }, deny: null }),
});
stub('../../server/aws/orders-store.js', {
  get: async (id) => state.orders[id] || { status: 'DELIVERED', pdfFileName: null, jobId: 'job-1' },
  update: async () => {},
});
stub('../../server/members/store.js', {
  table: () => 'stub',
  findPublicationIndex: async () => ({
    genId: 'rival', userId: 'author', status: 'published', companyId: 'TSLA',
    sk: 'TSLA#2026-08-20#rival', publishedAt: '2026-08-20T00:00:00.000Z', priceEur: 5,
  }),
  getPublication: async () => ({ promptsText: 'prompts' }),
  listUserItems: async (userId, prefix) => (prefix === 'PUB#' ? state.pubs : []),
  listReviews: async () => [{ reviewerId: 'reviewer', score: 4, comment: 'x'.repeat(40) }],
  runTransact: async () => true,
  getProfile: async () => ({ userId: 'reviewer' }),
  getItem: async (pk, sk) => state.reads[sk] || null,
  audit: async () => {},
});

const { handler } = require('../../server/lambda/members.js');

const open = () => handler({
  routeKey: 'POST /analyses/{genId}/open',
  pathParameters: { genId: 'rival' },
  headers: { authorization: 'Bearer stub' },
});

test('an analyst who published on Tesla cannot open a rival Tesla analysis', async () => {
  state.pubs = [{ sk: 'PUB#mine', status: 'published', companyId: 'TSLA' }];
  state.reads = {};
  const res = await open();
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /buy it instead/);
});

test('a Tesla generation still running counts as coverage', async () => {
  state.pubs = [{ sk: 'PUB#mine', status: 'generating' }];
  state.orders = { mine: { ticker: 'tsla', status: 'RENDERING' } };
  state.reads = {};
  assert.equal((await open()).statusCode, 403);
  state.orders = {};
});

test('a failed run is not coverage', async () => {
  state.pubs = [{ sk: 'PUB#mine', status: 'failed', companyId: 'TSLA' }];
  state.reads = {};
  assert.equal((await open()).statusCode, 200);
});

test('a read already paid for still re-opens, even once the reader covers the company', async () => {
  state.pubs = [{ sk: 'PUB#mine', status: 'published', companyId: 'TSLA' }];
  state.reads = { 'READ#rival': { sk: 'READ#rival' } };
  const res = await open();
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).alreadyOpen, true);
});

test('a review cannot be edited once the reviewer covers the company', async () => {
  state.pubs = [{ sk: 'PUB#mine', status: 'published', companyId: 'TSLA' }];
  const res = await handler({
    routeKey: 'POST /analyses/{genId}/review/edit',
    pathParameters: { genId: 'rival' },
    headers: { authorization: 'Bearer stub' },
    body: JSON.stringify({ score: 2, comment: 'y'.repeat(40) }),
  });
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /no longer be changed/);
});

test('covering a different company blocks nothing', async () => {
  state.pubs = [{ sk: 'PUB#mine', status: 'published', companyId: 'NOKIA.HE' }];
  state.reads = {};
  assert.equal((await open()).statusCode, 200);
});
