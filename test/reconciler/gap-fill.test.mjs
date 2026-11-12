import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// GAP_FILL_ENABLED: before rendering, the reconciler asks the collector to fill
// the company's missing periods and waits for the outcome; the order renders
// whatever that outcome is. Same require.cache injection as pinned-model.test.mjs.
const require = createRequire(import.meta.url);

const RECONCILER_ID = require.resolve('../../server/reconciler.js');
const ORDERS_ID = require.resolve('../../server/orders.js');
const ENGINE_ID = require.resolve('../../server/engine-client.js');
const EMAIL_ID = require.resolve('../../server/email.js');
const PDF_STORE_ID = require.resolve('../../server/aws/pdf-store.js');
const COLLECTOR_ID = require.resolve('../../server/collector-client.js');
const FMP_ID = require.resolve('../../server/fmp-client.js');

const ENV_KEYS = [
  'ORDERS_STATE_PATH', 'ORDERS_TABLE', 'REPORT_PDF_BUCKET', 'FRESH_IMPORT_ENABLED',
  'RECONCILER_POLL_WINDOW_MS', 'ENGINE_FID_BY_TICKER', 'GAP_FILL_ENABLED',
  'GAP_FILL_MAX_WAIT_MS', 'GAP_FILL_RESEND_MS', 'GAP_FILL_SETTLE_MS', 'GAP_FILL_POLL_DELAY_MS',
];

const APPLE = { isin: 'US0378331005', name: 'Apple Inc.' };

// A collector whose checkGapFill answers from `states` in order (the last repeats).
function fakeCollector(states, { company = APPLE, configured = true } = {}) {
  const requests = [];
  const checks = [];
  return {
    requests,
    checks,
    isConfigured: () => configured,
    async resolveCompany() { return company; },
    async requestGapFill(entry) {
      requests.push(entry);
      return new Date(Date.now() - 1000 * requests.length).toISOString();
    },
    async checkGapFill(isin, requestedAt) {
      checks.push({ isin, requestedAt });
      return states[Math.min(checks.length - 1, states.length - 1)];
    },
  };
}

function load(t, collector, env = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-gapfill-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const id of [RECONCILER_ID, ORDERS_ID, ENGINE_ID, EMAIL_ID, PDF_STORE_ID, COLLECTOR_ID, FMP_ID]) {
      delete require.cache[id];
    }
  });

  delete require.cache[RECONCILER_ID];
  delete require.cache[ORDERS_ID];
  process.env.ORDERS_STATE_PATH = path.join(dir, 'orders.json');
  delete process.env.ORDERS_TABLE;
  delete process.env.ENGINE_FID_BY_TICKER;
  process.env.REPORT_PDF_BUCKET = 'test-bucket';
  process.env.FRESH_IMPORT_ENABLED = 'false';
  process.env.RECONCILER_POLL_WINDOW_MS = '0';
  process.env.GAP_FILL_ENABLED = 'true';
  process.env.GAP_FILL_SETTLE_MS = '0';
  process.env.GAP_FILL_RESEND_MS = String(10 * 60 * 1000);
  process.env.GAP_FILL_MAX_WAIT_MS = String(20 * 60 * 1000);
  Object.assign(process.env, env);

  const submitted = [];
  const engine = {
    async submitJob(args) { submitted.push(args); return { jobId: `job_${submitted.length}` }; },
  };
  const errors = [];
  const email = { async reportError(subject, err, ctx) { errors.push({ subject, message: err.message, ctx }); } };
  const fmpCalls = [];
  const fmp = { async fmpImport(ticker) { fmpCalls.push(ticker); return { status: 'SUCCESS' }; } };
  const inject = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
  inject(ENGINE_ID, engine);
  inject(EMAIL_ID, email);
  inject(PDF_STORE_ID, {});
  inject(COLLECTOR_ID, collector);
  inject(FMP_ID, fmp);
  return { reconciler: require(RECONCILER_ID), submitted, errors, fmpCalls };
}

async function newOrder(id, ticker = 'AAPL') {
  return require(ORDERS_ID).create({ id, email: 'buyer@example.com', companyName: 'Apple Inc.', ticker });
}
const stored = id => require(ORDERS_ID).get(id);

test('nothing missing: one request, then the order renders', async (t) => {
  const collector = fakeCollector([{ state: 'nothing_missing', detail: 'nothing missing' }]);
  const { reconciler, submitted, errors } = load(t, collector);

  await reconciler.advance(await newOrder('cs_1'));

  assert.deepEqual(collector.requests, [APPLE]);
  assert.deepEqual(submitted, [{ companyCode: 'AAPL' }]);
  const order = await stored('cs_1');
  assert.equal(order.status, 'RENDERING');
  assert.equal(order.gapFillStatus, 'NOTHING_MISSING');
  assert.equal(order.gapFill.isin, APPLE.isin);
  assert.deepEqual(errors, []);
});

test('a gap being filled holds the render until its groups are delivered', async (t) => {
  const collector = fakeCollector([
    { state: 'running', detail: 'acquiring 3 planned documents' },
    { state: 'importing', detail: '3 documents submitted', groups: [{ id: 'g1', outcome: 'pending' }] },
    { state: 'imported', detail: '3 documents submitted', groups: [{ id: 'g1', outcome: 'delivered' }] },
  ]);
  const { reconciler, submitted, errors } = load(t, collector);

  await reconciler.advance(await newOrder('cs_2'));
  assert.equal((await stored('cs_2')).status, 'IMPORTING');
  assert.equal((await stored('cs_2')).gapFill.state, 'running');

  await reconciler.advance(await stored('cs_2'));
  assert.equal((await stored('cs_2')).gapFill.state, 'importing');
  assert.deepEqual(submitted, []);

  await reconciler.advance(await stored('cs_2'));
  const order = await stored('cs_2');
  assert.equal(order.gapFillStatus, 'IMPORTED');
  assert.equal(order.status, 'RENDERING');
  assert.deepEqual(submitted, [{ companyCode: 'AAPL' }]);
  assert.equal(collector.requests.length, 1, 'polling never re-sends the request');
  assert.deepEqual(errors, []);
});

test('the settle delay after delivery holds the render', async (t) => {
  const collector = fakeCollector([{ state: 'imported', detail: 'delivered', groups: [{ id: 'g1', outcome: 'delivered' }] }]);
  const { reconciler, submitted } = load(t, collector, { GAP_FILL_SETTLE_MS: String(60 * 1000) });

  await reconciler.advance(await newOrder('cs_settle'));

  const order = await stored('cs_settle');
  assert.equal(order.status, 'IMPORTING');
  assert.equal(order.gapFillStatus, null);
  assert.ok(Date.parse(order.gapFill.settleUntil) > Date.now());
  assert.deepEqual(submitted, []);
});

test('a deferred request is sent again once the resend interval has passed', async (t) => {
  const collector = fakeCollector([
    { state: 'deferred', detail: 'the company has an open import group' },
    { state: 'nothing_missing', detail: 'nothing missing' },
  ]);
  const { reconciler, submitted } = load(t, collector, { GAP_FILL_RESEND_MS: '0' });

  await reconciler.advance(await newOrder('cs_3'));
  assert.equal(collector.requests.length, 2);
  const waiting = await stored('cs_3');
  assert.equal(waiting.gapFill.resends, 1);
  assert.equal(waiting.status, 'IMPORTING');

  await reconciler.advance(waiting);
  assert.equal(collector.checks[1].requestedAt, waiting.gapFill.requestedAt, 'checks the re-sent request');
  assert.equal((await stored('cs_3')).gapFillStatus, 'NOTHING_MISSING');
  assert.deepEqual(submitted, [{ companyCode: 'AAPL' }]);
});

test('an import that cannot be done still renders, and admin is told', async (t) => {
  const collector = fakeCollector([{ state: 'unavailable', detail: 'exhausted: no document found' }]);
  const { reconciler, submitted, errors } = load(t, collector);

  await reconciler.advance(await newOrder('cs_4'));

  assert.equal((await stored('cs_4')).gapFillStatus, 'UNAVAILABLE');
  assert.deepEqual(submitted, [{ companyCode: 'AAPL' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /UNAVAILABLE: exhausted/);
  assert.equal(errors[0].ctx.isin, APPLE.isin);
});

test('a gap fill past the maximum wait times out and renders', async (t) => {
  const collector = fakeCollector([{ state: 'running', detail: 'acquiring' }]);
  const { reconciler, submitted, errors } = load(t, collector, { GAP_FILL_MAX_WAIT_MS: '0' });

  await reconciler.advance(await newOrder('cs_5'));

  assert.equal((await stored('cs_5')).gapFillStatus, 'TIMEOUT');
  assert.deepEqual(submitted, [{ companyCode: 'AAPL' }]);
  assert.equal(errors.length, 1);
});

test('a ticker Wisdom cannot resolve to an ISIN renders without a request', async (t) => {
  const collector = fakeCollector([], { company: null });
  const { reconciler, submitted, errors } = load(t, collector);

  await reconciler.advance(await newOrder('cs_6', 'NOPE'));

  assert.deepEqual(collector.requests, []);
  assert.equal((await stored('cs_6')).gapFillStatus, 'NO_ISIN');
  assert.deepEqual(submitted, [{ companyCode: 'NOPE' }]);
  assert.equal(errors.length, 1);
});

test('with the gap fill on, the FMP import is skipped even when its flag is on', async (t) => {
  const collector = fakeCollector([{ state: 'nothing_missing', detail: '' }]);
  const { reconciler, fmpCalls } = load(t, collector, { FRESH_IMPORT_ENABLED: 'true' });

  await reconciler.advance(await newOrder('cs_7'));

  assert.deepEqual(fmpCalls, []);
  assert.equal((await stored('cs_7')).status, 'RENDERING');
});

test('with the gap fill off, nothing is requested', async (t) => {
  const collector = fakeCollector([{ state: 'nothing_missing', detail: '' }]);
  const { reconciler, submitted } = load(t, collector, { GAP_FILL_ENABLED: 'false' });

  await reconciler.advance(await newOrder('cs_8'));

  assert.deepEqual(collector.requests, []);
  assert.equal((await stored('cs_8')).gapFillStatus, null);
  assert.deepEqual(submitted, [{ companyCode: 'AAPL' }]);
});

test('orders in one tick share its poll window, so a waiting order cannot starve the next', async (t) => {
  const collector = fakeCollector([{ state: 'running', detail: 'acquiring' }]);
  const { reconciler } = load(t, collector, {
    RECONCILER_POLL_WINDOW_MS: '300',
    GAP_FILL_POLL_DELAY_MS: '50',
  });
  await newOrder('cs_a');
  await newOrder('cs_b', 'ADBE');

  const started = Date.now();
  await reconciler.tick();
  const took = Date.now() - started;

  assert.ok(took < 600, `the tick used one window, not one per order (${took} ms)`);
  assert.equal(collector.requests.length, 2, 'both orders were requested in the same tick');
  assert.equal((await stored('cs_a')).status, 'IMPORTING');
  assert.equal((await stored('cs_b')).status, 'IMPORTING');
});
