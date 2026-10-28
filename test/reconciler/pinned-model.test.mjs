import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// ENGINE_FID_BY_TICKER: a listed ticker is rendered from its pinned Trunk
// model, every other ticker keeps the engine's own model choice.
// Same require.cache injection as failures.test.mjs: no network, no SES.
const require = createRequire(import.meta.url);

const RECONCILER_ID = require.resolve('../../server/reconciler.js');
const ORDERS_ID = require.resolve('../../server/orders.js');
const ENGINE_ID = require.resolve('../../server/engine-client.js');
const EMAIL_ID = require.resolve('../../server/email.js');
const PDF_STORE_ID = require.resolve('../../server/aws/pdf-store.js');

const ENV_KEYS = [
  'ORDERS_STATE_PATH', 'ORDERS_TABLE', 'REPORT_PDF_BUCKET', 'FRESH_IMPORT_ENABLED',
  'RECONCILER_POLL_WINDOW_MS', 'ENGINE_FID_BY_TICKER',
];

function fakeEngine() {
  const submitted = [];
  return {
    submitted,
    async submitJob(args) {
      submitted.push(args);
      return { jobId: `job_${submitted.length}` };
    },
  };
}

function loadReconciler(t, fidMap) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-fid-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const id of [RECONCILER_ID, ORDERS_ID, ENGINE_ID, EMAIL_ID, PDF_STORE_ID]) delete require.cache[id];
  });

  delete require.cache[RECONCILER_ID];
  delete require.cache[ORDERS_ID];
  process.env.ORDERS_STATE_PATH = path.join(dir, 'orders.json');
  delete process.env.ORDERS_TABLE;
  process.env.REPORT_PDF_BUCKET = 'test-bucket';
  process.env.FRESH_IMPORT_ENABLED = 'false';
  process.env.RECONCILER_POLL_WINDOW_MS = '0';
  if (fidMap === undefined) delete process.env.ENGINE_FID_BY_TICKER;
  else process.env.ENGINE_FID_BY_TICKER = fidMap;

  const engine = fakeEngine();
  require.cache[ENGINE_ID] = { id: ENGINE_ID, filename: ENGINE_ID, loaded: true, exports: engine };
  require.cache[EMAIL_ID] = { id: EMAIL_ID, filename: EMAIL_ID, loaded: true, exports: {} };
  require.cache[PDF_STORE_ID] = { id: PDF_STORE_ID, filename: PDF_STORE_ID, loaded: true, exports: {} };
  return { reconciler: require(RECONCILER_ID), engine };
}

async function newOrder(id, ticker) {
  const orders = require(ORDERS_ID);
  return orders.create({ id, email: 'buyer@example.com', companyName: ticker, ticker });
}

test('a pinned ticker is submitted with its fid, other tickers without one', async (t) => {
  const { reconciler, engine } = loadReconciler(t, '{"UPM.HE": 20798}');

  await reconciler.advance(await newOrder('cs_upm', 'UPM.HE'));
  await reconciler.advance(await newOrder('cs_nokia', 'NOKIA.HE'));

  assert.deepEqual(engine.submitted, [
    { companyCode: 'UPM.HE', params: { fid: 20798 } },
    { companyCode: 'NOKIA.HE' },
  ]);
  const stored = await require(ORDERS_ID).get('cs_upm');
  assert.equal(stored.status, 'RENDERING');
  assert.equal(stored.jobId, 'job_1');
});

test('a malformed map or a non-integer fid pins nothing', async (t) => {
  for (const raw of ['not json', '{"UPM.HE": "20798"}', '{"UPM.HE": -1}']) {
    const { reconciler, engine } = loadReconciler(t, raw);
    await reconciler.advance(await newOrder(`cs_${engine.submitted.length}_${raw.length}`, 'UPM.HE'));
    assert.deepEqual(engine.submitted, [{ companyCode: 'UPM.HE' }], raw);
  }
});
