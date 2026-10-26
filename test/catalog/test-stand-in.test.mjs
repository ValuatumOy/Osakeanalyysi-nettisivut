// The test site serves report pages built from the production catalog, so its
// buttons name production report ids. With a Stripe test key — and only then —
// the checkout stands in the test catalog's own report for the same company.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.CATALOG_API_URL = 'https://api-test.example';

const PROD = {
  'tesla-prod': { id: 'tesla-prod', ticker: 'TSLA', isFree: true, revisable: true },
  'nokia-prod': { id: 'nokia-prod', ticker: 'NOKIA.HE', isFree: false, revisable: true },
};
const TEST = [
  { id: 'tesla-old', ticker: 'TSLA', reportDate: '2026-08-20', isFree: false, revisable: true },
  { id: 'tesla-free', ticker: 'TSLA', reportDate: '2026-09-05', isFree: true, revisable: true },
  { id: 'tesla-newest', ticker: 'TSLA', reportDate: '2026-09-09', isFree: false, revisable: true },
  { id: 'nokia-unrevisable', ticker: 'NOKIA.HE', reportDate: '2026-07-15', isFree: false, revisable: false },
];

globalThis.fetch = async (url) => {
  const u = String(url);
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  if (u.startsWith('https://api.aiequityreports.com/api/reports/')) {
    const r = PROD[decodeURIComponent(u.split('/').pop())];
    return r ? reply(200, { report: r }) : reply(404, { error: 'Report not found' });
  }
  if (u === 'https://api-test.example/api/reports') return reply(200, { reports: TEST });
  throw new Error(`unexpected fetch ${u}`);
};

const { findTestStandIn } = require('../../server/catalog-client.js');

test('never with a live key', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_x';
  assert.equal(await findTestStandIn('tesla-prod', { withRevisions: true }), null);
});

test('same company, same free status first, then the newest', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  assert.equal((await findTestStandIn('tesla-prod', { withRevisions: true })).id, 'tesla-free');
  PROD['tesla-prod'].isFree = false;
  assert.equal((await findTestStandIn('tesla-prod', { withRevisions: true })).id, 'tesla-newest');
  PROD['tesla-prod'].isFree = true;
});

test('revisions only from a revisable report; unknown ids get nothing', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  assert.equal(await findTestStandIn('nokia-prod', { withRevisions: true }), null);
  assert.equal((await findTestStandIn('nokia-prod', { withRevisions: false })).id, 'nokia-unrevisable');
  assert.equal(await findTestStandIn('no-such-report', {}), null);
});
