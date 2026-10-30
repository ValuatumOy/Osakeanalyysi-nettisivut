import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const apiRequire = createRequire(require.resolve('../../api/report-download.js'));
const stripeId = apiRequire.resolve('stripe');
const state = { purchases: [], memberOnly: false, eventSession: null, revisionAvailable: true };
const session = { id: 'cs_paid', payment_status: 'paid', metadata: {
  site: 'aiequityreports', reportId: 'nokia-old', reportName: 'Nokia', ticker: 'NOKIA', withRevisions: 'true', revisionsAllowed: '2',
} };
require.cache[stripeId] = { id: stripeId, filename: stripeId, loaded: true, exports: function Stripe() {
  return { checkout: { sessions: { retrieve: async () => session } }, webhooks: { constructEvent: () => ({ type: 'checkout.session.completed', data: { object: state.eventSession || session } }) } };
} };
function stub(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('../../server/catalog-client.js', {
  getCatalogReport: async () => null,
  getOrderState: async () => { if (state.memberOnly) throw Object.assign(new Error('Sign in'), { status: 403 }); return { revisionAvailable: state.revisionAvailable }; },
  requestReportDownload: async () => ({ url: 'https://signed.example/report.pdf', fileName: 'nokia.pdf' }),
  recordCatalogPurchase: async purchase => state.purchases.push(purchase),
});
stub('../../server/email.js', { sendReportEmail: async () => {}, reportError: async () => {} });
process.env.STRIPE_WEBHOOK_SECRET = 'test';
const download = require('../../api/report-download.js');
const getLink = require('../../api/get-report-link.js');
const webhook = require('../../api/webhook.js');
const revision = require('../../api/order-revision.js');
function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader() {}, json(value) { this.body = value; return this; },
    redirect(code, url) { this.statusCode = code; this.url = url; return this; },
    send(value) { this.body = value; return this; }, end() { return this; },
  };
}

test('a paid report remains downloadable after it leaves the public catalog', async () => {
  const res = response();
  await download({ method: 'GET', query: { session_id: 'cs_paid' } }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.url, 'https://signed.example/report.pdf');
  const link = response();
  await getLink({ method: 'GET', query: { session_id: 'cs_paid' } }, link);
  assert.equal(link.statusCode, 200);
  assert.equal(link.body.reportName, 'Nokia');
});

test('a publicly exposed legacy receipt cannot reveal its download or customer information', async () => {
  state.memberOnly = true;
  const report = response();
  await download({ method: 'GET', query: { session_id: 'cs_paid' } }, report);
  assert.equal(report.statusCode, 403);
  const link = response();
  await getLink({ method: 'GET', query: { session_id: 'cs_paid' } }, link);
  assert.equal(link.statusCode, 403);
  state.memberOnly = false;
});

test('a guest cannot pay for extra revisions when the source snapshot is unavailable', async () => {
  state.revisionAvailable = false;
  const res = response();
  await revision({ method: 'POST', body: { session_id: 'cs_paid', buyRounds: true, rounds: 2 } }, res);
  assert.equal(res.statusCode, 409);
  state.revisionAvailable = true;
});

test('a fresh report bought without revisions still links to its workspace', async () => {
  const metadata = session.metadata;
  session.metadata = { site: 'aiequityreports', isFresh: 'true', company: 'Nokia', withRevisions: 'false' };
  const res = response();
  await getLink({ method: 'GET', query: { session_id: 'cs_paid' } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.orderUrl, /session_id=cs_paid/);
  session.metadata = metadata;
});

test('the payment webhook still creates the revision entitlement when the report retires during checkout', async () => {
  const res = response();
  await webhook({ method: 'POST', headers: { 'stripe-signature': 'test' }, body: '{}' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.purchases[0].reportId, 'nokia-old');
  assert.equal(state.purchases[0].fileName, 'nokia.pdf');
  assert.equal(state.purchases[0].withRevisions, true);
});

test('the catalog webhook ignores member fork, top-up and fresh sessions', async () => {
  const before = state.purchases.length;
  for (const metadata of [{ site: 'aiequityreports', fork: 'true', analysisGenId: 'parent' },
    { site: 'aiequityreports', extraRevisions: '2', generationId: 'order' },
    { site: 'aiequityreports', isFresh: 'true', userId: 'u1', company: 'Nokia' }]) {
    state.eventSession = { id: 'cs_member', payment_status: 'paid', metadata };
    const res = response();
    await webhook({ method: 'POST', headers: { 'stripe-signature': 'test' }, body: '{}' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, true);
  }
  state.eventSession = null;
  assert.equal(state.purchases.length, before);
});
