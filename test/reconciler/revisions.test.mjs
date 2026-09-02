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
    calls: { submitRevision: [], submitEdit: [], getJob: [], downloadPdf: [], fetchChangeMemo: [] },
    async submitJob() { throw new Error('not used in these tests'); },
    async submitEdit(args) {
      this.calls.submitEdit.push(args);
      return overrides.submitEdit ? overrides.submitEdit(args) : { jobId: 'job_edit1' };
    },
    async submitRevision(args) {
      this.calls.submitRevision.push(args);
      return overrides.submitRevision ? overrides.submitRevision(args) : { jobId: 'job_rev1' };
    },
    async getJob(jobId) {
      this.calls.getJob.push(jobId);
      return overrides.getJob
        ? overrides.getJob(jobId)
        : { jobId, status: 'DONE', s3Url: 'https://s3.example/x.pdf', changesUrl: 'https://s3.example/changes.json', completedAt: '2026-01-01T00:00:00.000Z' };
    },
    async downloadPdf(s3Url) {
      this.calls.downloadPdf.push(s3Url);
      return Buffer.from('PDFDATA');
    },
    async fetchChangeMemo(changesUrl) {
      this.calls.fetchChangeMemo.push(changesUrl);
      if (overrides.fetchChangeMemo) return overrides.fetchChangeMemo(changesUrl);
      return {
        jobId: 'job_rev1', revisionOf: 'job_base', revisionNumber: 2, scope: 'estimates',
        comment: 'assume 8% EBIT margin from 2027',
        headline: { targetPrice: { before: 12.3, after: 14.1, currency: 'EUR' }, rating: { before: 'BUY', after: 'HOLD' } },
        differences: { summary: 'moved the margin assumption', items: [{ area: 'Estimates', what: 'EBIT margin raised' }], unchanged: 'peer set' },
        forecastRevision: {
          baseFid: 1, resultFid: 2, writeup: '## Assumptions\n\n- higher margin',
          wrote: [{ varname: 'ebit', year: 2027, before: 100, after: 108 }],
          dropped: [], recomputed: [],
        },
      };
    },
  };
}

function fakeEmail() {
  return {
    calls: { sendReportRevisedEmail: [], sendRevisionFailedEmail: [], sendGenerationFailedEmail: [], reportError: [] },
    async sendReportEmail() {},
    async sendReportRevisedEmail(to, meta) { this.calls.sendReportRevisedEmail.push({ to, meta }); },
    async sendRevisionFailedEmail(to, meta) { this.calls.sendRevisionFailedEmail.push({ to, meta }); },
    async sendGenerationFailedEmail(to, meta) { this.calls.sendGenerationFailedEmail.push({ to, meta }); },
    async sendAdminNotification() {},
    async sendAdminDeliveryNotice() {},
    async reportError(where, err, details) { this.calls.reportError.push({ where, message: err?.message, details }); return true; },
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
    analystName: 'Esa Virtanen',
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
  // The revised report names the analyst who steered it; a shop order has no
  // name and stays engine-bylined.
  assert.equal(engine.calls.submitRevision[0].analystName, 'Esa Virtanen');

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

  // The change memo is fetched and stored as the first revisionHistory entry.
  assert.equal(engine.calls.fetchChangeMemo.length, 1);
  assert.equal(engine.calls.fetchChangeMemo[0], 'https://s3.example/changes.json');
  assert.equal(order.revisionHistory.length, 1);
  const entry = order.revisionHistory[0];
  assert.equal(entry.version, 2);
  assert.equal(entry.jobId, 'job_rev1');
  assert.equal(entry.comments, 'assume 8% EBIT margin from 2027');
  assert.equal(entry.pdfFileName, order.pdfFileName);
  assert.equal(entry.changes.headline.targetPrice.after, 14.1);
  assert.equal(order.activeRevisionComment, null);
});

test('a change memo fetch failure does not block delivery — the entry just has changes: null', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine({
    getJob: (jobId) => ({ jobId, status: 'DONE', s3Url: 'https://s3.example/x.pdf', changesUrl: 'https://s3.example/gone.json' }),
    fetchChangeMemo: () => { throw new Error('404: not found'); },
  });
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore });
  const orders = require(ORDERS_ID);

  pdfStore.files.set('Base.pdf', Buffer.from('ORIGINAL'));
  orders.create({
    id: 'cs_rev_nomemo', email: 'buyer@example.com', companyName: 'Nokia', ticker: 'NOKIA.HE',
    status: orders.STATUS.DELIVERED, jobId: 'job_base', pdfFileName: 'Base.pdf', revisionsAllowed: 2,
  }, statePath);
  orders.claimRevision('cs_rev_nomemo', 'go faster', statePath);

  await reconciler.advance(orders.get('cs_rev_nomemo', statePath)); // submits
  await reconciler.advance(orders.get('cs_rev_nomemo', statePath)); // polls -> DONE -> delivers

  const order = orders.get('cs_rev_nomemo', statePath);
  assert.equal(order.status, orders.STATUS.DELIVERED);
  assert.equal(order.revisionHistory.length, 1);
  assert.equal(order.revisionHistory[0].changes, null);
  assert.equal(order.revisionHistory[0].comments, 'go faster');
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

// ── Hand edits ─────────────────────────────────────────────────────────

const EDIT = {
  edits: { 'recommendation/prose/0': 'BUY. Our target is EUR 13.', 'recommendation/prose/4': '' },
  originals: { 'recommendation/prose/0': 'HOLD. Our target is EUR 11.' },
  editedBy: 'Maija Analyst',
  fromVersion: 1,
};

function editJob(jobId) {
  return {
    jobId, status: 'DONE', s3Url: 'https://s3.example/edit.pdf', changesUrl: 'https://s3.example/edit-changes.json',
    completedAt: '2026-02-01T00:00:00.000Z', revisionScope: 'edit', authorship: 'analyst', editedBy: 'Maija Analyst',
    previewUrl: 'https://s3.example/edit.preview.html',
    fit: { shrunk: [{ page: 11, where: 'body', zoom: 0.92, over: 0 }], clipped: [] },
    editWarnings: { unknownPointers: [], overBudget: {}, changedNumbers: { 'recommendation/prose/0': { added: ['13'], retained: false } }, removed: ['recommendation/prose/4'], blanked: [] },
  };
}

test('a hand edit: submitted to the engine edit endpoint, delivered as a version of its own, free of charge and without email', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine({ getJob: editJob });
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore });
  const orders = require(ORDERS_ID);

  pdfStore.files.set('Base.pdf', Buffer.from('ORIGINAL'));
  orders.create({
    id: 'cs_edit_ok', email: 'buyer@example.com', companyName: 'Nokia', ticker: 'NOKIA.HE',
    status: orders.STATUS.DELIVERED, jobId: 'job_base', pdfFileName: 'Base.pdf', revisionsAllowed: 0,
  }, statePath);
  orders.claimEdit('cs_edit_ok', EDIT, statePath);

  // Tick 1: submits the edits, not a revision.
  await reconciler.advance(orders.get('cs_edit_ok', statePath));
  let order = orders.get('cs_edit_ok', statePath);
  assert.equal(order.status, orders.STATUS.REVISING);
  assert.equal(order.revisionJobId, 'job_edit1');
  assert.equal(order.pendingEdit, null);
  assert.deepEqual(order.activeEdit, EDIT);
  assert.equal(engine.calls.submitRevision.length, 0);
  assert.equal(engine.calls.submitEdit.length, 1);
  assert.deepEqual(engine.calls.submitEdit[0], { parentJobId: 'job_base', edits: EDIT.edits, editedBy: 'Maija Analyst' });

  // Tick 2: delivers.
  await reconciler.advance(order);
  order = orders.get('cs_edit_ok', statePath);
  assert.equal(order.status, orders.STATUS.DELIVERED);
  assert.equal(order.jobId, 'job_edit1');
  assert.equal(order.revisionsUsed, 0); // free
  assert.equal(order.editsUsed, 1);
  assert.equal(order.activeEdit, null);
  assert.equal(order.hasPreview, true);
  assert.equal(pdfStore.files.get('Base.pdf').toString(), 'ORIGINAL');
  assert.match(order.pdfFileName, /edit-/);
  assert.equal(pdfStore.sidecars.get(order.pdfFileName).provenance.editedBy, 'Maija Analyst');
  assert.equal(email.calls.sendReportRevisedEmail.length, 0);

  const entry = order.revisionHistory[0];
  assert.equal(entry.version, 2);
  assert.equal(entry.kind, 'edit');
  assert.equal(entry.authorship, 'analyst');
  assert.equal(entry.editedBy, 'Maija Analyst');
  assert.equal(entry.editedFrom, 1);
  assert.equal(entry.comments, '');
  assert.deepEqual(entry.edits, [
    { pointer: 'recommendation/prose/0', before: 'HOLD. Our target is EUR 11.', after: 'BUY. Our target is EUR 13.' },
    { pointer: 'recommendation/prose/4', before: null, after: '' },
  ]);
  assert.equal(entry.fit.shrunk[0].page, 11);
  assert.equal(entry.editWarnings.changedNumbers['recommendation/prose/0'].retained, false);
  assert.ok(entry.changes); // the engine's memo is kept alongside
});

test('an AI revision after a hand edit is labelled as keeping it, and an edit with no name uses the analyst on the order', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine({
    getJob: (jobId) => (jobId === 'job_edit1'
      ? editJob(jobId)
      : { jobId, status: 'DONE', s3Url: 'https://s3.example/x.pdf', changesUrl: 'https://s3.example/changes.json', authorship: 'mixed', completedAt: '2026-03-01T00:00:00.000Z' }),
  });
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore });
  const orders = require(ORDERS_ID);

  orders.create({
    id: 'cs_mixed', email: 'a@example.com', companyName: 'Nokia', ticker: 'NOKIA.HE', analystName: 'Esa Virtanen',
    status: orders.STATUS.DELIVERED, jobId: 'job_base', pdfFileName: 'Base.pdf', revisionsAllowed: 1,
  }, statePath);
  orders.claimEdit('cs_mixed', { ...EDIT, editedBy: '' }, statePath);
  await reconciler.advance(orders.get('cs_mixed', statePath));
  assert.equal(engine.calls.submitEdit[0].editedBy, 'Esa Virtanen');
  await reconciler.advance(orders.get('cs_mixed', statePath));

  orders.claimRevision('cs_mixed', 'more conservative', statePath);
  await reconciler.advance(orders.get('cs_mixed', statePath));
  await reconciler.advance(orders.get('cs_mixed', statePath));

  const order = orders.get('cs_mixed', statePath);
  assert.equal(order.revisionHistory.length, 2);
  assert.equal(order.revisionHistory[0].kind, 'edit');
  assert.equal(order.revisionHistory[1].kind, 'revision');
  assert.equal(order.revisionHistory[1].authorship, 'mixed');
  assert.equal(order.revisionHistory[1].version, 3);
  assert.equal(order.revisionsUsed, 1);
  assert.equal(order.editsUsed, 1);
});

test('an engine 409 on an edit (nothing saved to edit) fails the edit with a plain message and leaves the order usable', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine({
    submitEdit: () => { const err = new Error('engine submitEdit 409: no snapshot'); err.status = 409; throw err; },
  });
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore });
  const orders = require(ORDERS_ID);

  orders.create({
    id: 'cs_edit_409', email: 'a@example.com', companyName: 'Nokia', ticker: 'NOKIA.HE',
    status: orders.STATUS.DELIVERED, jobId: 'job_base', pdfFileName: 'Base.pdf',
  }, statePath);
  orders.claimEdit('cs_edit_409', EDIT, statePath);
  await reconciler.advance(orders.get('cs_edit_409', statePath));

  const order = orders.get('cs_edit_409', statePath);
  assert.equal(order.status, orders.STATUS.DELIVERED);
  assert.equal(order.jobId, 'job_base');
  assert.equal(order.pendingEdit, null);
  assert.equal(order.activeEdit, null);
  assert.equal(order.editsUsed, 0);
  assert.match(order.revisionError, /before text editing was supported/);
});

test('a fresh delivery records the original job id and whether the engine produced an editable preview', async (t) => {
  const statePath = isolate(t);
  const engine = fakeEngine({
    getJob: (jobId) => ({ jobId, status: 'DONE', s3Url: 'https://s3.example/x.pdf', previewUrl: 'https://s3.example/x.preview.html', completedAt: '2026-01-01T00:00:00.000Z' }),
  });
  const email = fakeEmail();
  const pdfStore = fakePdfStore();
  const reconciler = loadReconciler({ statePath, engine, email, pdfStore });
  const orders = require(ORDERS_ID);

  orders.create({ id: 'cs_fresh', email: 'a@example.com', companyName: 'Nokia', ticker: 'NOKIA.HE', status: orders.STATUS.RENDERING, jobId: 'job_base' }, statePath);
  await reconciler.advance(orders.get('cs_fresh', statePath));

  const order = orders.get('cs_fresh', statePath);
  assert.equal(order.status, orders.STATUS.DELIVERED);
  assert.equal(order.originalJobId, 'job_base');
  assert.equal(order.hasPreview, true);
});
