import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canRevise } = require('../../server/aws/engine-jobs.js');
const state = {};
function reset() {
  Object.assign(state, {
    index: { genId: 'analysis', sk: 'TSLA#date#analysis', userId: 'author', status: 'published', companyId: 'TSLA', publishedAt: '2026-10-01T00:00:00Z', priceEur: 0 },
    publication: { status: 'published', publishedAt: '2026-10-01T00:00:00Z', freeAfterDays: 365 },
    failJobs: false, writes: 0,
  });
}
function stub(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
delete process.env.SECRETS_SSM_PREFIX;
stub('../../server/aws/catalog-aws.js', { buildCatalogAws: async () => ({
  catalog: { week: '2026-W44', reports: [
    { id: 'upm', fileName: 'upm.pdf', isFree: true, pdfUrl: 'private' },
    { id: 'old', fileName: 'old.pdf', isFree: false },
    { id: 'missing', fileName: 'missing.pdf', isFree: false },
  ] },
  sidecars: new Map([['upm.pdf', { provenance: { jobId: 'valid' } }], ['old.pdf', { provenance: { jobId: 'no-snapshot' } }]]),
}) });
stub('../../server/aws/engine-jobs.js', {
  getRevisionJobs: async () => {
    if (state.failJobs) throw new Error('unavailable');
    return new Map([
      ['valid', { status: 'DONE', username: 'osakeanalyysi-site', snapshotKey: 'snapshot', templateName: 'osakeanalyysi', params: {} }],
      ['no-snapshot', { status: 'DONE', username: 'osakeanalyysi-site', templateName: 'osakeanalyysi', params: {} }],
    ]);
  },
  canRevise,
});
stub('../../server/aws/orders-store.js', { get: async () => ({ status: 'DELIVERED', pdfFileName: 'tesla.pdf' }) });
stub('../../server/members/auth.js', { requireUser: async () => ({ profile: { userId: 'reader', role: 'reader' } }) });
stub('../../server/members/store.js', {
  table: () => 'Members',
  findPublicationIndex: async () => state.index,
  listPublicationIndex: async () => [state.index],
  getPublication: async () => state.publication,
  audit: async () => {},
  runTransact: async ({ TransactItems }) => {
    state.writes += 1;
    state.index.priceEur = TransactItems[1].Update.ExpressionAttributeValues[':price'];
    return true;
  },
});
const { handler } = require('../../server/lambda/members.js');
const request = (routeKey, body) => handler({ routeKey, pathParameters: { genId: 'analysis' }, headers: {}, body: body === undefined ? undefined : JSON.stringify(body) });

test('member library only offers revisions when the source snapshot is usable', async () => {
  reset();
  let result = JSON.parse((await request('GET /reports')).body).reports;
  assert.deepEqual(result.map(r => [r.id, r.revisable]), [['upm', true], ['old', false], ['missing', false]]);
  assert.ok(result.every(r => !('pdfUrl' in r)));
  state.failJobs = true;
  result = JSON.parse((await request('GET /reports')).body).reports;
  assert.ok(result.every(r => r.revisable === false));
});

test('zero-priced analysis is listed and opened for everyone, without using a member read', async () => {
  reset();
  const listed = JSON.parse((await request('GET /analyses')).body).analyses[0];
  assert.equal(listed.publicFree, true);
  assert.equal(listed.free, true);
  const publicResult = await request('GET /analyses/{genId}/free');
  assert.equal(publicResult.statusCode, 200);
  assert.match(JSON.parse(publicResult.body).url, /tesla\.pdf$/);
  const memberResult = await request('POST /analyses/{genId}/open');
  assert.equal(memberResult.statusCode, 200);
  assert.equal(JSON.parse(memberResult.body).free, true);
  assert.equal(state.writes, 0);
  state.index.priceEur = 10;
  assert.equal((await request('GET /analyses/{genId}/free')).statusCode, 403);
  state.index.priceEur = 0;
  state.index.status = 'takendown';
  assert.equal((await request('GET /analyses/{genId}/free')).statusCode, 404);
});

test('repricing requires an explicit valid amount before changing public access', async () => {
  reset();
  for (const priceEur of [undefined, null, '', -1]) {
    assert.equal((await request('POST /generations/{genId}/price', { priceEur })).statusCode, 400);
  }
  assert.equal(state.writes, 0);
  assert.equal((await request('POST /generations/{genId}/price', { priceEur: 10 })).statusCode, 200);
  assert.equal((await request('GET /analyses/{genId}/free')).statusCode, 403);
  assert.equal((await request('POST /generations/{genId}/price', { priceEur: 0 })).statusCode, 200);
  assert.equal((await request('GET /analyses/{genId}/free')).statusCode, 200);
});
