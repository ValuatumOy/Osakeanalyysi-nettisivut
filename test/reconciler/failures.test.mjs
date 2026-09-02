import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// What the reconciler tells people when an engine run does not deliver.
// Same require.cache injection as revisions.test.mjs: no network, no SES.
const require = createRequire(import.meta.url);

const RECONCILER_ID = require.resolve('../../server/reconciler.js');
const ORDERS_ID = require.resolve('../../server/orders.js');
const ENGINE_ID = require.resolve('../../server/engine-client.js');
const EMAIL_ID = require.resolve('../../server/email.js');
const PDF_STORE_ID = require.resolve('../../server/aws/pdf-store.js');

const ENV_KEYS = ['ORDERS_STATE_PATH', 'ORDERS_TABLE', 'REPORT_PDF_BUCKET', 'RECONCILER_MAX_ATTEMPTS', 'RECONCILER_MAX_POLLS', 'SITE_URL'];

function fakeEmail({ failUserEmail = false } = {}) {
  const calls = {
    sendGenerationFailedEmail: [], sendRevisionFailedEmail: [], sendAdminNotification: [], reportError: [],
  };
  return {
    calls,
    async sendReportEmail() {},
    async sendReportRevisedEmail() {},
    async sendAdminDeliveryNotice() {},
    async sendGenerationFailedEmail(to, meta) {
      calls.sendGenerationFailedEmail.push({ to, meta });
      if (failUserEmail) throw new Error('SES down');
    },
    async sendRevisionFailedEmail(to, meta) { calls.sendRevisionFailedEmail.push({ to, meta }); },
    async sendAdminNotification(meta, customerEmail) { calls.sendAdminNotification.push({ meta, customerEmail }); },
    async reportError(where, err, details) { calls.reportError.push({ where, message: err?.message, details }); return true; },
  };
}

function loadReconciler({ statePath, email, engine }) {
  delete require.cache[RECONCILER_ID];
  delete require.cache[ORDERS_ID];
  process.env.ORDERS_STATE_PATH = statePath;
  delete process.env.ORDERS_TABLE;
  process.env.REPORT_PDF_BUCKET = 'test-bucket';
  process.env.RECONCILER_MAX_POLLS = '5';
  process.env.SITE_URL = 'https://www.example.test';
  require.cache[ENGINE_ID] = { id: ENGINE_ID, filename: ENGINE_ID, loaded: true, exports: engine || {} };
  require.cache[EMAIL_ID] = { id: EMAIL_ID, filename: EMAIL_ID, loaded: true, exports: email };
  require.cache[PDF_STORE_ID] = { id: PDF_STORE_ID, filename: PDF_STORE_ID, loaded: true, exports: {} };
  return require(RECONCILER_ID);
}

function isolate(t) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-fail-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[RECONCILER_ID];
    delete require.cache[ORDERS_ID];
    delete require.cache[ENGINE_ID];
    delete require.cache[EMAIL_ID];
    delete require.cache[PDF_STORE_ID];
  });
  return path.join(dir, 'orders.json');
}

// create() only keeps the fields a new order has, so everything that
// describes an in-flight run (revisionJobId, activeEdit, attempts, ...) goes
// on through update(), the way the reconciler itself writes them.
async function seed(fields) {
  const orders = require(ORDERS_ID);
  await orders.create({ id: 'cs_test_1', email: 'buyer@example.com', companyName: 'Tesla', ticker: 'TSLA' });
  return orders.update('cs_test_1', fields);
}

test('a failed generation emails the customer and then the admin, who is told the customer knows', async (t) => {
  const email = fakeEmail();
  const reconciler = loadReconciler({ statePath: isolate(t), email });
  const order = await seed({ status: 'RENDERING', jobId: 'job_1', revisionsAllowed: 2 });

  await reconciler.fail(order, 'engine job FAILED: out of memory');

  assert.equal(email.calls.sendGenerationFailedEmail.length, 1);
  const [{ to, meta }] = email.calls.sendGenerationFailedEmail;
  assert.equal(to, 'buyer@example.com');
  assert.equal(meta.company, 'Tesla');
  assert.equal(meta.orderUrl, 'https://www.example.test/order/index.html?session_id=cs_test_1');

  assert.equal(email.calls.sendAdminNotification.length, 1);
  const [{ meta: adminMeta, customerEmail }] = email.calls.sendAdminNotification;
  assert.equal(customerEmail, 'buyer@example.com');
  assert.equal(adminMeta.error, 'engine job FAILED: out of memory');
  assert.equal(adminMeta.orderId, 'cs_test_1');
  assert.equal(adminMeta.customerNotified, true);

  const stored = await require(ORDERS_ID).get('cs_test_1');
  assert.equal(stored.status, 'FAILED');
});

test('a failed generation without revisions links nowhere, and a lost customer email still reaches the admin', async (t) => {
  const email = fakeEmail({ failUserEmail: true });
  const reconciler = loadReconciler({ statePath: isolate(t), email });
  const order = await seed({ status: 'RENDERING', jobId: 'job_1' });

  await reconciler.fail(order, 'render did not finish');

  assert.equal(email.calls.sendGenerationFailedEmail[0].meta.orderUrl, null);
  assert.equal(email.calls.sendAdminNotification.length, 1);
  assert.equal(email.calls.sendAdminNotification[0].meta.customerNotified, false);
});

test('a failed revision emails the customer and alerts the admin, and the order stays DELIVERED', async (t) => {
  const email = fakeEmail();
  const reconciler = loadReconciler({ statePath: isolate(t), email });
  const order = await seed({
    status: 'REVISING', jobId: 'job_base', revisionJobId: 'job_rev', activeRevisionComment: 'lower margins',
    revisionsAllowed: 3, revisionsUsed: 1,
  });

  await reconciler.failRevision(order, 'engine job FAILED: forecast import job 28 failed');

  assert.equal(email.calls.sendRevisionFailedEmail.length, 1);
  const [{ to, meta }] = email.calls.sendRevisionFailedEmail;
  assert.equal(to, 'buyer@example.com');
  assert.equal(meta.ticker, 'TSLA');
  assert.match(meta.orderUrl, /session_id=cs_test_1$/);

  assert.equal(email.calls.reportError.length, 1);
  assert.equal(email.calls.reportError[0].where, 'reconciler: revision failed');
  assert.equal(email.calls.reportError[0].message, 'engine job FAILED: forecast import job 28 failed');
  assert.equal(email.calls.reportError[0].details.orderId, 'cs_test_1');

  const stored = await require(ORDERS_ID).get('cs_test_1');
  assert.equal(stored.status, 'DELIVERED');
  assert.equal(stored.revisionsUsed, 1);
  assert.equal(stored.jobId, 'job_base');
});

test('a failed hand edit alerts the admin but does not email the customer, who is on the page', async (t) => {
  const email = fakeEmail();
  const reconciler = loadReconciler({ statePath: isolate(t), email });
  const order = await seed({
    status: 'REVISING', jobId: 'job_base', revisionJobId: 'job_edit',
    activeEdit: { edits: { '/summary': 'new text' }, editedBy: 'Buyer' },
  });

  await reconciler.failRevision(order, 'engine job FAILED');

  assert.equal(email.calls.sendRevisionFailedEmail.length, 0);
  assert.equal(email.calls.reportError.length, 1);
  assert.equal(email.calls.reportError[0].where, 'reconciler: edit failed');
});

test('a transient error is reported to the admin on the first attempt only, and the order keeps its status', async (t) => {
  const email = fakeEmail();
  const engine = { async getJob() { throw new Error('ECONNRESET'); } };
  const reconciler = loadReconciler({ statePath: isolate(t), email, engine });
  await seed({ status: 'RENDERING', jobId: 'job_1' });

  await reconciler.tick();
  await reconciler.tick();
  await reconciler.tick();

  assert.equal(email.calls.reportError.length, 1);
  const [{ where, message, details }] = email.calls.reportError;
  assert.equal(where, 'reconciler: transient error');
  assert.equal(message, 'ECONNRESET');
  assert.equal(details.orderId, 'cs_test_1');
  assert.equal(details.status, 'RENDERING');

  const stored = await require(ORDERS_ID).get('cs_test_1');
  assert.equal(stored.status, 'RENDERING');
  assert.equal(stored.attempts, 3);
});
