// Company Coverage sold four report updates a year and nothing in the system
// produced one: the yearly counter only ever let a subscriber open a report
// somebody else had already generated. POST /generations/coverage is the other
// half — the subscriber asks, one of the four is spent, an engine run starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const quota = require('../../server/members/quota.js');

function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

const state = { profile: null, created: [], committed: true };

stub('../../server/aws/catalog-aws.js', {
  fetchCatalog: async () => [],
});
stub('../../server/search.js', {
  searchCompanies: async () => [{ ticker: 'NOKIA.HE', companyName: 'Nokia Oyj', exchange: 'Helsinki', industry: 'Tech' }],
});
stub('../../server/members/bounty.js', { readRateEur: () => 0.5 });
stub('../../server/members/auth.js', {
  requireUser: async () => ({ profile: state.profile, deny: null }),
});
stub('../../server/aws/orders-store.js', {
  STATUS: { NEW: 'NEW', FAILED: 'FAILED', DELIVERED: 'DELIVERED' },
  create: async (order) => { state.created.push(order); return order; },
  get: async () => null,
  update: async () => {},
});
stub('../../server/members/store.js', {
  table: () => 'stub',
  runTransact: async () => state.committed,
  listUserItems: async () => [],
  listPublicationIndex: async () => [],
  getItem: async () => null,
  getProfile: async () => state.profile,
  audit: async () => {},
});

const { handler } = require('../../server/lambda/members.js');

const request = () => handler({
  routeKey: 'POST /generations/coverage',
  headers: { authorization: 'Bearer stub' },
  // A ticker in the body must change nothing: the company is what they pay for.
  body: JSON.stringify({ ticker: 'AAPL', company: 'Apple' }),
});

const subscriber = {
  userId: 'u1', email: 'holder@example.com', tier: 'coverage', tierStatus: 'active',
  coverageCompanyId: 'NOKIA.HE',
};

test('a Company Coverage subscriber can ask for an update', async () => {
  state.profile = { ...subscriber };
  state.created = [];
  state.committed = true;
  const res = await request();
  assert.equal(res.statusCode, 200);
  assert.equal(state.created.length, 1);
  // Never the body's ticker.
  assert.equal(state.created[0].ticker, 'NOKIA.HE');
  assert.equal(state.created[0].visibility, 'private');
  assert.equal(state.created[0].revisionsAllowed, 0);
});

test('nobody else can — an update is what the subscription is', async () => {
  for (const profile of [
    { ...subscriber, tier: 'investor_plus' },
    { ...subscriber, tierStatus: 'canceled' },
    { userId: 'u1', email: 'a@b.c', role: 'analyst' },
  ]) {
    state.profile = profile;
    state.created = [];
    assert.equal((await request()).statusCode, 403, JSON.stringify(profile));
    assert.equal(state.created.length, 0, 'a refused update must not start an engine run');
  }
});

test('the year\'s four are four — a refused quota starts no run', async () => {
  state.profile = { ...subscriber };
  state.created = [];
  state.committed = false;
  const res = await request();
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /4 coverage updates/);
  assert.equal(state.created.length, 0);
  state.committed = true;
});

test('a subscription with no company chosen yet cannot spend an update', async () => {
  state.profile = { ...subscriber, coverageCompanyId: '' };
  state.created = [];
  assert.equal((await request()).statusCode, 409);
  assert.equal(state.created.length, 0);
});

test('the update comes off the year, and a failed run gives it back to that year', () => {
  const now = new Date('2027-01-04T00:00:00.000Z');
  const spend = quota.buildCoverageGenerationTransact({ table: 't', userId: 'u1', now, genId: 'g1' });
  assert.equal(spend.TransactItems[0].Update.Key.sk, 'USAGE#Y#2027');
  assert.equal(spend.TransactItems[0].Update.ExpressionAttributeValues[':max'], quota.COVERAGE_UPDATES_PER_YEAR);
  const pub = spend.TransactItems[1].Put.Item;
  assert.equal(pub.coverage, true, 'the restore path keys on this');
  assert.equal(pub.private, true);

  // Spent in December, failed in January: credited back where it was taken from.
  const back = quota.buildReleaseCoverageTransact({
    table: 't', userId: 'u1', now, reservedAt: '2026-12-30T00:00:00.000Z',
  });
  assert.equal(back.TransactItems[0].Update.Key.sk, 'USAGE#Y#2026');
  assert.match(back.TransactItems[0].Update.ConditionExpression, /coverageUpdates > :zero/);
});
