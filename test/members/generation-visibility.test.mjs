// A membership generation must never be resold from the catalog, even when the
// stage has resale switched on. This drives reconciler.deliver() with stubbed
// AWS/engine modules and asserts on the sidecar it writes.
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

function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

stub('../../server/engine-client.js', { downloadPdf: async () => Buffer.from('%PDF-stub') });
stub('../../server/fmp-client.js', {});
stub('../../server/email.js', {
  sendReportEmail: async (to, report) => emailed.push({ to, report }),
  sendAdminDeliveryNotice: async () => {},
  sendAdminNotification: async () => {},
});
stub('../../server/aws/pdf-store.js', {
  putPdf: async () => {},
  writeSidecar: async (fileName, sidecar) => written.push({ fileName, sidecar }),
});
stub('../../server/aws/orders-store.js', {
  STATUS: { NEW: 'NEW', IMPORTING: 'IMPORTING', RENDERING: 'RENDERING', DELIVERED: 'DELIVERED', FAILED: 'FAILED' },
  update: async (id, patch) => updates.push({ id, patch }),
  listPending: async () => [],
  get: async () => null,
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

test('the member is emailed their delivered report', () => {
  assert.ok(emailed.some(e => e.to === 'member@example.com'));
});
