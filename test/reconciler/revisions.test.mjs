import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// reconciler.js is CommonJS and reads config + picks its storage backends at
// module load time, so each case re-requires it with a fresh env and faked
// collaborators (engine-client, email, aws/pdf-store) injected straight into
// require.cache — same trick test/reaper/reaper.test.mjs uses for env, taken
// one step further so no real network/AWS/SES call can happen from a test.
const require = createRequire(import.meta.url);

const RECONCILER_ID = require.resolve('../../server/reconciler.js');
const ORDERS_ID = require.resolve('../../server/orders.js');
const ENGINE_ID = require.resolve('../../server/engine-client.js');
const EMAIL_ID = require.resolve('../../server/email.js');
const PDF_STORE_ID = require.resolve('../../server/aws/pdf-store.js');

const ENV_KEYS = ['ORDERS_STATE_PATH', 'ORDERS_TABLE', 'REPORT_PDF_BUCKET', 'RECONCILER_MAX_ATTEMPTS', 'RECONCILER_MAX_POLLS'];

function fakePdfStore() {
  const files = new Map();
  const sidecars = new Map();
  return {
    files, sidecars,
    async putPdf(name, buf) { files.set(name, buf); },
    async putPdfIfAbsent(name, buf) {
      if (files.has(name)) return false;
      files.set(name, buf);
      return true;
    },
    async writeSidecar(name, sidecar) { sidecars.set(name, sidecar); },
  };
}

function fakeEngine(overrides = {}) {
  return {
    calls: { submitRevision: [], getJob: [], downloadPdf: [] },
    async submitJob() { throw new Error('not used in these tests'); },
    async submitRevision(args) {
      this.calls.submitRevision.push(args);
      return overrides.submitRevision ? overrides.submitRevision(args) : { jobId: 'job_rev1' };
    },
    async getJob(jobId) {
      this.calls.getJob.push(jobId);
      return overrides.getJob ? overrides.getJob(jobId) : { jobId, status: 'DONE', s3Url: 'https://s3.example/x.pdf' };
    },
    async downloadPdf(s3Url) {
      this.calls.downloadPdf.push(s3Url);
      return Buffer.from('PDFDATA');
    },
  };
}

function fakeEmail() {
  return {
    calls: { sendReportRevisedEmail: [] },
    async sendReportEmail() {},
    async sendReportRevisedEmail(to, meta) { this.calls.sendReportRevisedEmail.push({ to, meta }); },
    async sendAdminNotification() {},
    async sendAdminDeliveryNotice() {},
  };
}

function loadReconciler({ statePath, engine, email, pdfStore, maxAttempts }) {
  delete require.cache[RECONCILER_ID];
  delete require.cache[ORDERS_ID];

  process.env.ORDERS_STATE_PATH = statePath;
  delete process.env.ORDERS_TABLE; // force the local JSON store
  process.env.REPORT_PDF_BUCKET = 'test-bucket'; // force the aws/pdf-store require path
  process.env.RECONCILER_MAX_POLLS = '5';
  if (maxAttempts != null) process.env.RECONCILER_MAX_ATTEMPTS = String(maxAttempts);

  require.cache[ENGINE_ID] = { id: ENGINE_ID, filename: ENGINE_ID, loaded: true, exports: engine };
  require.cache[EMAIL_ID] = { id: EMAIL_ID, filename: EMAIL_ID, loaded: true, exports: email };
  require.cache[PDF_STORE_ID] = { id: PDF_STORE_ID, filename: PDF_STORE_ID, loaded: true, exports: pdfStore };

  return require(RECONCILER_ID);
}

function isolate(t) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-test-'));
  const statePath = path.join(dir, 'orders.json');
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
  return statePath;
}

test('REVISING happy path: submits to the engine, then delivers to a private file, never touching the original', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine();
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore });
  const orders = require(ORDERS_ID);

  pdfStore.files.set('Base.pdf', Buffer.from('ORIGINAL'));
  orders.create({
    id: 'cs_rev_ok', email: 'buyer@example.com', companyName: 'Nokia', ticker: 'NOKIA.HE',
    status: orders.STATUS.DELIVERED, jobId: 'job_base', pdfFileName: 'Base.pdf', revisionsAllowed: 2,
  }, statePath);
  orders.claimRevision('cs_rev_ok', 'assume 8% EBIT margin from 2027', statePath);

  // Tick 1: REVISING with a pending comment -> submits to the engine.
  await reconciler.advance(orders.get('cs_rev_ok', statePath));
  let order = orders.get('cs_rev_ok', statePath);
  assert.equal(order.status, orders.STATUS.REVISING);
  assert.equal(order.revisionJobId, 'job_rev1');
  assert.equal(order.pendingRevisionComment, null);
  assert.equal(engine.calls.submitRevision.length, 1);
  assert.equal(engine.calls.submitRevision[0].parentJobId, 'job_base');
  assert.equal(engine.calls.submitRevision[0].comments, 'assume 8% EBIT margin from 2027');

  // Tick 2: polls the revision job, which is already DONE -> delivers.
  await reconciler.advance(order);
  order = orders.get('cs_rev_ok', statePath);
  assert.equal(order.status, orders.STATUS.DELIVERED);
  assert.equal(order.revisionsUsed, 1);
  assert.equal(order.jobId, 'job_rev1');
  assert.equal(order.revisionJobId, null);

  // The original catalog/order file must survive untouched.
  assert.equal(pdfStore.files.get('Base.pdf').toString(), 'ORIGINAL');
  assert.notEqual(order.pdfFileName, 'Base.pdf');
  assert.match(order.pdfFileName, /rev-/);
  assert.equal(pdfStore.sidecars.get(order.pdfFileName).hidden, true);

  assert.equal(email.calls.sendReportRevisedEmail.length, 1);
  assert.equal(email.calls.sendReportRevisedEmail[0].to, 'buyer@example.com');
});

test('a hard-failed revision reverts to DELIVERED without consuming the allowance', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine({ getJob: (jobId) => ({ jobId, status: 'FAILED', error: 'no valuatum credentials' }) });
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore });
  const orders = require(ORDERS_ID);

  orders.create({
    id: 'cs_rev_fail', email: 'buyer@example.com', companyName: 'Nokia', ticker: 'NOKIA.HE',
    status: orders.STATUS.DELIVERED, jobId: 'job_base', pdfFileName: 'Base.pdf', revisionsAllowed: 2,
  }, statePath);
  orders.claimRevision('cs_rev_fail', 'go faster', statePath);

  await reconciler.advance(orders.get('cs_rev_fail', statePath)); // submits
  await reconciler.advance(orders.get('cs_rev_fail', statePath)); // polls -> FAILED

  const order = orders.get('cs_rev_fail', statePath);
  assert.equal(order.status, orders.STATUS.DELIVERED);
  assert.equal(order.jobId, 'job_base'); // untouched — still the good, delivered job
  assert.equal(order.pdfFileName, 'Base.pdf'); // untouched
  assert.equal(order.revisionsUsed, 0); // the failed attempt was free
  assert.equal(order.revisionJobId, null);
  assert.match(order.revisionError, /FAILED/);
  assert.equal(email.calls.sendReportRevisedEmail.length, 0);
});

test('exhausting revisionAttempts gives up without marking the order terminally FAILED', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine();
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore, maxAttempts: 1 });
  const orders = require(ORDERS_ID);

  orders.create({
    id: 'cs_rev_exhausted', status: orders.STATUS.DELIVERED, jobId: 'job_base',
    pdfFileName: 'Base.pdf', revisionsAllowed: 2,
  }, statePath);
  orders.claimRevision('cs_rev_exhausted', 'try again', statePath);
  orders.update('cs_rev_exhausted', { revisionAttempts: 1 }, statePath); // already at the (test) ceiling

  await reconciler.advance(orders.get('cs_rev_exhausted', statePath));

  const order = orders.get('cs_rev_exhausted', statePath);
  assert.equal(order.status, orders.STATUS.DELIVERED); // not FAILED
  assert.equal(order.jobId, 'job_base');
  assert.equal(engine.calls.submitRevision.length, 0); // gave up before calling the engine again
  assert.match(order.revisionError, /exceeded 1 retry attempts/);
});

test('a delivered order with prior generation attempts is unaffected by revision retry accounting', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine();
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore, maxAttempts: 1 });
  const orders = require(ORDERS_ID);

  // This order needed a retry during original generation (attempts: 1 already
  // at the ceiling used above) — a later revision must not inherit that budget.
  orders.create({
    id: 'cs_rev_separate_budget', status: orders.STATUS.DELIVERED, jobId: 'job_base',
    pdfFileName: 'Base.pdf', revisionsAllowed: 2,
  }, statePath);
  orders.update('cs_rev_separate_budget', { attempts: 1 }, statePath);
  orders.claimRevision('cs_rev_separate_budget', 'one change please', statePath);

  await reconciler.advance(orders.get('cs_rev_separate_budget', statePath));
  const order = orders.get('cs_rev_separate_budget', statePath);
  assert.equal(order.status, orders.STATUS.REVISING); // proceeded normally
  assert.equal(engine.calls.submitRevision.length, 1);
});
