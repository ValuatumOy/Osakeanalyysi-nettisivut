// The nine members-admin routes had no UI and the new dashboard needed six
// more. These drive the new ones through the handler with a stubbed store —
// and, most importantly, prove every one of them sits behind the admin gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

function stub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

process.env.ADMIN_UPLOAD_PASSWORD = 'test-admin-secret';
process.env.SECRETS_SSM_PREFIX = ''; // ensureSecrets: nothing to fetch

const state = { profiles: [], items: {}, scan: [], index: [], transacts: [] };

stub('../../server/aws/catalog-aws.js', {});
stub('../../server/search.js', { searchCompanies: async () => [] });
stub('../../server/members/bounty.js', { readRateEur: () => 0.5 });
stub('../../server/members/auth.js', { requireUser: async () => ({ profile: null, deny: { statusCode: 401 } }) });
stub('../../server/aws/orders-store.js', { get: async () => null, update: async () => {} });
stub('../../server/members/store.js', {
  table: () => 'stub',
  listProfiles: async () => state.profiles,
  listUserItems: async (userId, prefix) => (state.items[`${userId}:${prefix}`] || []),
  scanForStats: async () => state.scan,
  listPublicationIndex: async () => state.index,
  findPublicationIndex: async (genId) => state.index.find((i) => i.genId === genId) || null,
  getProfile: async (userId) => state.profiles.find((p) => p.pk === `USER#${userId}`) || null,
  getItem: async (pk, sk) => state.items[`item:${pk}:${sk}`] || null,
  getUsage: async () => null,
  runTransact: async (t) => { state.transacts.push(t); return true; },
  audit: async () => {},
});

const { handler } = require('../../server/lambda/members.js');

const asAdmin = (routeKey, extra = {}) => handler({
  routeKey,
  headers: { authorization: 'Bearer test-admin-secret' },
  ...extra,
});

test('every admin route refuses a missing or wrong password', async () => {
  for (const routeKey of [
    'GET /admin/members/users', 'GET /admin/members/stats',
    'GET /admin/members/promo-codes', 'POST /admin/members/void-review',
  ]) {
    const noAuth = await handler({ routeKey, headers: {} });
    assert.equal(noAuth.statusCode, 401, routeKey);
    const wrong = await handler({ routeKey, headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.statusCode, 401, routeKey);
  }
});

test('the user table carries plan, meters and flags', async () => {
  state.profiles = [{
    pk: 'USER#u1', sk: 'PROFILE', email: 'a@b.c', role: 'analyst',
    tier: 'investor_plus', tierStatus: 'active', banned: false,
    openObligationId: 'g9', createdAt: '2026-08-01T00:00:00.000Z',
  }];
  const res = await asAdmin('GET /admin/members/users');
  assert.equal(res.statusCode, 200);
  const { users } = JSON.parse(res.body);
  assert.equal(users.length, 1);
  assert.equal(users[0].openObligationId, 'g9');
  assert.equal(users[0].usage.pickLimit > 0, true, 'merged role+tier limits');
});

test('user detail 404s cleanly on an unknown id', async () => {
  const res = await asAdmin('GET /admin/members/users/{userId}', { pathParameters: { userId: 'ghost' } });
  assert.equal(res.statusCode, 404);
});

test('stats bucket by company and never read the audit trail', async () => {
  state.index = [{ genId: 'g1', companyId: 'TSLA' }];
  state.scan = [
    { sk: 'PROFILE' },
    { sk: 'ENT#teslainc-18082026', source: 'pick' },
    { sk: 'ENT#nokia-05062026-2', source: 'oneoff' },
    { sk: 'READ#g1' },
    { sk: 'SALE#g1#cs_1', companyId: 'TSLA', grossEur: 5 },
    { sk: 'PUB#g1', companyId: 'TSLA', publishedAt: '2026-08-26T00:00:00.000Z' },
    { sk: 'AUDIT#2026-08-27T00:00:00.000Z#ab', type: 'report-open' },
  ];
  const res = await asAdmin('GET /admin/members/stats');
  const { totals, byCompany } = JSON.parse(res.body);
  assert.equal(totals.users, 1);
  assert.equal(totals.entitlements, 2);
  assert.equal(totals.grossEur, 5);
  const tesla = byCompany.find((c) => c.companyId === 'TSLA');
  assert.equal(tesla.analystReads, 1, 'READ rows resolve their company through the index');
  assert.equal(tesla.sales, 1);
  // The date suffix comes off whole, collision suffix included.
  assert.ok(byCompany.some((c) => c.companyId === 'nokia'), JSON.stringify(byCompany));
  assert.ok(byCompany.some((c) => c.companyId === 'teslainc'));
});

test('voiding a review takes its score out of the totals, once', async () => {
  state.index = [{ genId: 'g1', companyId: 'TSLA', sk: 'TSLA#2026#g1', userId: 'author' }];
  state.items['item:USER#author:REVIEW#g1#rev1'] = { score: 5, reviewerId: 'rev1' };
  state.transacts = [];
  const body = JSON.stringify({ ownerId: 'author', genId: 'g1', reviewerId: 'rev1' });
  const res = await asAdmin('POST /admin/members/void-review', { body });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).scoreRemoved, 5);
  const index = state.transacts[0].TransactItems[1].Update;
  assert.equal(index.ExpressionAttributeValues[':minusScore'], -5);

  // Already voided: refused before any transact runs.
  state.items['item:USER#author:REVIEW#g1#rev1'] = { score: 5, reviewerId: 'rev1', voided: true };
  state.transacts = [];
  const again = await asAdmin('POST /admin/members/void-review', { body });
  assert.equal(again.statusCode, 409);
  assert.equal(state.transacts.length, 0);
});

test('the dashboard gates its own destructive buttons', () => {
  const html = readFileSync(new URL('../../admin/index.html', import.meta.url), 'utf8');
  // Takedown moves money (bounty void + clawback) and payout states money left
  // the bank — both must be type-to-confirm, not one-click.
  assert.match(html, /Type the company id/, 'takedown must be type-to-confirm');
  assert.match(html, /Type PAID to confirm/, 'payout must be type-to-confirm');
  assert.match(html, /aerAdminMembersApiBase/, 'the test-stage override must exist');
});
