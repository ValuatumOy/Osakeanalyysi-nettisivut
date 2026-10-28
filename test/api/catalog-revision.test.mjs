import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
function stub(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const reports = [
  { id: 'good', fileName: 'good.pdf', revisable: true, availability: 'available' },
  { id: 'old', fileName: 'old.pdf', revisable: true, availability: 'available' },
];
const sidecars = new Map([
  ['good.pdf', { provenance: { jobId: 'good-job' } }],
  ['old.pdf', { provenance: { jobId: 'old-job' } }],
]);
const createdOrders = [];
let sidecarError = true;
stub('../../server/aws/catalog-aws.js', { buildCatalogAws: async () => ({ catalog: { reports: structuredClone(reports) }, sidecars }) });
stub('../../server/aws/engine-jobs.js', {
  getRevisionJobs: async () => new Map([['good-job', { usable: true }], ['old-job', { usable: false }]]),
  canRevise: job => Boolean(job?.usable),
});
stub('../../server/aws/catalog-state-store.js', { recordPurchase: async input => input });
stub('../../server/aws/pdf-store.js', { readSidecar: async () => {
  if (sidecarError) throw new Error('temporary S3 error');
  return { provenance: { jobId: 'good-job' } };
} });
stub('../../server/aws/orders-store.js', {
  STATUS: { DELIVERED: 'DELIVERED' },
  create: async order => { createdOrders.push(order); },
});
stub('../../server/email.js', { sendAdminAlert: async () => {}, reportError: async () => {} });
delete process.env.SECRETS_SSM_PREFIX;
process.env.CATALOG_SYNC_SECRET = 'test-secret';
const { handler } = require('../../server/lambda/api.js');

test('catalog list and checkout lookup only advertise reports the engine can really revise', async () => {
  const list = JSON.parse((await handler({ routeKey: 'GET /api/reports', headers: {} })).body).reports;
  assert.equal(list.find(r => r.id === 'good').revisable, true);
  assert.equal(list.find(r => r.id === 'old').revisable, false);
  assert.equal(JSON.stringify(list).includes('good-job'), false);
  const lookup = JSON.parse((await handler({ routeKey: 'GET /api/reports/{id}', pathParameters: { id: 'old' }, headers: {} })).body).report;
  assert.equal(lookup.revisable, false);
});

test('failure to create a paid revision order returns an error for Stripe retry', async () => {
  const result = await handler({
    routeKey: 'POST /api/report-purchases', headers: { authorization: 'Bearer test-secret' },
    body: JSON.stringify({ type: 'existing', withRevisions: true, sessionId: 'cs_paid', fileName: 'good.pdf', reportId: 'good' }),
  });
  assert.equal(result.statusCode, 500);
});

test('a standard ready report can later buy revision rounds without purchasing the report again', async () => {
  sidecarError = false;
  const result = await handler({
    routeKey: 'POST /api/report-purchases', headers: { authorization: 'Bearer test-secret' },
    body: JSON.stringify({ type: 'existing', revisable: true, withRevisions: false, sessionId: 'cs_standard', fileName: 'good.pdf', reportId: 'good' }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(createdOrders.at(-1).id, 'cs_standard');
  assert.equal(createdOrders.at(-1).revisionsAllowed, 0);
  assert.equal(createdOrders.at(-1).jobId, 'good-job');
});
