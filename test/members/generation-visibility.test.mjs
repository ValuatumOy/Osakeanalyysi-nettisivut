// A reader's generation remains private; a publishing analyst's original
// engine report can be sold without exposing their later revisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.ORDERS_TABLE = 'stub-orders';
process.env.REPORT_PDF_BUCKET = 'stub-bucket';
process.env.RESALE_ENABLED = 'true';
process.env.RESALE_PRICE_EUR = '20';
process.env.REPORT_PDF_BASE_URL = 'https://files-test.example.com/reports/pdfs';

const written = [];
const emailed = [];
const updates = [];
const dispatched = [];
let dispatchFails = false;

function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

stub('../../server/engine-client.js', { downloadPdf: async () => Buffer.from('%PDF-stub') });
stub('../../server/fmp-client.js', {});
stub('../../server/email.js', {
  sendReportEmail: async (to, report) => emailed.push({ to, report }),
  sendReportRevisedEmail: async () => {},
  sendAdminDeliveryNotice: async () => {},
  sendAdminRevisionNotice: async () => {},
  sendAdminNotification: async () => {},
});
stub('../../server/aws/pdf-store.js', {
  putPdf: async () => {},
  putPdfIfAbsent: async () => true,
  writeSidecar: async (fileName, sidecar) => written.push({ fileName, sidecar }),
});
stub('../../server/aws/orders-store.js', {
  STATUS: { NEW: 'NEW', IMPORTING: 'IMPORTING', RENDERING: 'RENDERING', DELIVERED: 'DELIVERED', FAILED: 'FAILED' },
  update: async (id, patch) => updates.push({ id, patch }),
  listPending: async () => [],
  get: async () => null,
});
stub('../../server/report-page-dispatch.js', {
  dispatchReportPages: async () => {
    dispatched.push(true);
    if (dispatchFails) throw new Error('dispatch failed');
    return { dispatched: true };
  },
});

const reconciler = require('../../server/reconciler.js');

const baseOrder = {
  id: 'order-1',
  email: 'member@example.com',
  companyName: 'Nokia Oyj',
  ticker: 'NOKIA.HE',
  jobId: 'job-1',
};

test('a private membership generation is written hidden and unpriced', async () => {
  written.length = 0;
  await reconciler.deliver({ ...baseOrder, visibility: 'private' }, { s3Url: 's3://stub' });

  assert.equal(written.length, 1);
  const { sidecar } = written[0];
  assert.equal(sidecar.hidden, true);
  assert.equal(sidecar.publicationStatus, 'hidden');
  assert.equal(sidecar.forceVisible, undefined, 'a private report must not skip the visibility delay');
  assert.equal(sidecar.price, undefined, 'a private report must not be priced for resale');
  assert.equal(sidecar.excludeFromFree, true);
});

test('an ordinary paid order still goes on sale when resale is enabled', async () => {
  written.length = 0;
  await reconciler.deliver({ ...baseOrder, id: 'order-2' }, { s3Url: 's3://stub' });

  const { sidecar } = written[0];
  assert.equal(sidecar.hidden, false);
  assert.equal(sidecar.publicationStatus, 'ready');
  assert.equal(sidecar.forceVisible, true);
  assert.equal(sidecar.price, 20);
});

test('an analyst’s original fresh engine report is sold and wakes the page sync', async () => {
  written.length = 0;
  dispatched.length = 0;
  updates.length = 0;
  await reconciler.deliver({
    ...baseOrder, visibility: 'private', origin: 'fresh', publicEngineBase: true,
  }, { s3Url: 's3://stub', reportQuality: { deliverable: true } });

  const { fileName, sidecar } = written[0];
  assert.equal(sidecar.hidden, false);
  assert.equal(sidecar.publicationStatus, 'ready');
  assert.equal(sidecar.price, 20);
  assert.equal(sidecar.excludeFromFree, true);
  assert.equal(sidecar.provenance.jobId, 'job-1');
  assert.equal(updates.find(x => x.patch.status === 'DELIVERED').patch.originalPdfFileName, fileName);
  assert.equal(dispatched.length, 1);
});

test('only the original fresh generation qualifies for public resale', async () => {
  for (const overrides of [
    { origin: 'ready' },
    { forkedFrom: 'another-analysis' },
    { adminCopy: true },
    { originalJobId: 'different-original' },
  ]) {
    written.length = 0;
    dispatched.length = 0;
    await reconciler.deliver({
      ...baseOrder, visibility: 'private', origin: 'fresh', publicEngineBase: true, ...overrides,
    }, { s3Url: 's3://stub' });
    assert.equal(written[0].sidecar.publicationStatus, 'hidden');
    assert.equal(dispatched.length, 0);
  }
});

test('a report marked undeliverable does not become a public baseline', async () => {
  written.length = 0;
  dispatched.length = 0;
  await reconciler.deliver({
    ...baseOrder, visibility: 'private', origin: 'fresh', publicEngineBase: true,
  }, { s3Url: 's3://stub', reportQuality: { deliverable: false } });
  assert.equal(written[0].sidecar.publicationStatus, 'hidden');
  assert.equal(dispatched.length, 0);
});

test('an analyst revision stays hidden and cannot wake the base page sync', async () => {
  written.length = 0;
  dispatched.length = 0;
  await reconciler.deliverRevision({
    ...baseOrder, origin: 'fresh', visibility: 'private', publicEngineBase: true,
    pdfFileName: 'Nokia_28102026.pdf', originalPdfFileName: 'Nokia_28102026.pdf',
    originalJobId: 'job-1', revisionHistory: [],
  }, { s3Url: 's3://revision', jobId: 'job-revision' });
  assert.equal(written.length, 1);
  assert.notEqual(written[0].fileName, 'Nokia_28102026.pdf');
  assert.equal(written[0].sidecar.publicationStatus, 'hidden');
  assert.equal(written[0].sidecar.provenance.jobId, 'job-revision');
  assert.equal(dispatched.length, 0);
});

test('the catalog sells the original while excluding the analyst’s revision', async () => {
  written.length = 0;
  await reconciler.deliver({
    ...baseOrder, visibility: 'private', origin: 'fresh', publicEngineBase: true,
  }, { s3Url: 's3://original' });
  const original = written[0];
  await reconciler.deliverRevision({
    ...baseOrder, origin: 'fresh', visibility: 'private', publicEngineBase: true,
    pdfFileName: original.fileName, originalPdfFileName: original.fileName,
    originalJobId: 'job-1', revisionHistory: [],
  }, { s3Url: 's3://revision', jobId: 'job-revision' });

  const { buildCatalog } = require('../../server/catalog.js');
  const reports = buildCatalog({
    scannedFiles: written.map(item => ({ fileName: item.fileName, uploadedAt: new Date().toISOString(), size: 100 })),
    readSidecar: name => written.find(item => item.fileName === name)?.sidecar,
    manifest: { reports: [] }, state: { purchases: [], freeSelections: {} }, persistState: false,
  }).reports;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].fileName, original.fileName);
  assert.equal(reports[0].price, 20);
  assert.equal(reports[0].revisable, true);
});

test('a failed page wake-up does not prevent delivery', async () => {
  written.length = 0;
  updates.length = 0;
  dispatchFails = true;
  try {
    await reconciler.deliver({
      ...baseOrder, visibility: 'private', origin: 'fresh', publicEngineBase: true,
    }, { s3Url: 's3://stub' });
  } finally {
    dispatchFails = false;
  }
  assert.equal(written[0].sidecar.publicationStatus, 'ready');
  assert.ok(updates.some(x => x.patch.status === 'DELIVERED'));
});

test('the member is emailed their delivered report', () => {
  assert.ok(emailed.some(e => e.to === 'member@example.com'));
});
