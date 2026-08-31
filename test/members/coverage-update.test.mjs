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
// Echoes whatever was asked for, so a test can assert which company the route
// actually chose rather than which one the stub happens to return.
stub('../../server/search.js', {
  searchCompanies: async (q) => [{
    ticker: String(q).toUpperCase(), companyName: String(q).toUpperCase(),
    exchange: 'Helsinki', industry: 'Tech',
  }],
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

// With no ticker the single covered company is used; with one it must be a
// company the subscription actually carries.
const request = (ticker) => handler({
  routeKey: 'POST /generations/coverage',
  headers: { authorization: 'Bearer stub' },
  body: ticker === undefined ? undefined : JSON.stringify({ ticker }),
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

test('a company the subscription does not carry cannot be generated', async () => {
  state.profile = { ...subscriber };
  state.created = [];
  const res = await request('AAPL');
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body).covers, ['NOKIA.HE']);
  assert.equal(state.created.length, 0, 'a refused update must not start an engine run');
});

test('one of several covered companies can be named', async () => {
  state.profile = { ...subscriber, coverageCompanyIds: ['NOKIA.HE', 'TSLA'] };
  state.created = [];
  assert.equal((await request('TSLA')).statusCode, 200);
  assert.equal(state.created[0].ticker, 'TSLA');
});

test('the year\'s four are four — a refused quota starts no run', async () => {
  state.profile = { ...subscriber };
  state.created = [];
  state.committed = false;
  const res = await request();
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /All 4 updates on NOKIA\.HE/);
  assert.equal(state.created.length, 0);
  state.committed = true;
});

test('a subscription with no company chosen yet cannot spend an update', async () => {
  state.profile = { ...subscriber, coverageCompanyId: '', coverageCompanyIds: [] };
  state.created = [];
  assert.equal((await request()).statusCode, 409);
  assert.equal(state.created.length, 0);
});

test('the update comes off the year, and a failed run gives it back to that year', () => {
  const now = new Date('2027-01-04T00:00:00.000Z');
  const spend = quota.buildCoverageGenerationTransact({
    table: 't', userId: 'u1', now, genId: 'g1', companyId: 'NOKIA.HE',
  });
  assert.equal(spend.TransactItems[0].Update.Key.sk, 'USAGE#Y#2027');
  assert.equal(spend.TransactItems[0].Update.ExpressionAttributeValues[':max'], quota.COVERAGE_UPDATES_PER_YEAR);
  // The counter is that one company's, so a second covered company has its own four.
  assert.equal(spend.TransactItems[0].Update.ExpressionAttributeNames['#c'], 'cov#NOKIA.HE');
  const pub = spend.TransactItems[1].Put.Item;
  assert.equal(pub.coverage, true, 'the restore path keys on this');
  assert.equal(pub.coverageCompanyId, 'NOKIA.HE');
  assert.equal(pub.private, true);

  // Spent in December, failed in January: credited back where it was taken from,
  // and to the company it was taken off.
  const back = quota.buildReleaseCoverageTransact({
    table: 't', userId: 'u1', now, reservedAt: '2026-12-30T00:00:00.000Z', companyId: 'NOKIA.HE',
  });
  assert.equal(back.TransactItems[0].Update.Key.sk, 'USAGE#Y#2026');
  assert.equal(back.TransactItems[0].Update.ExpressionAttributeNames['#c'], 'cov#NOKIA.HE');
  assert.match(back.TransactItems[0].Update.ConditionExpression, /#c > :zero/);
});
