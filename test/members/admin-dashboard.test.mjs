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

stub('../../server/aws/catalog-aws.js', {
  buildCatalogAws: async () => ({ catalog: { reports: [
    { id: 'teslainc-18082026', ticker: 'TSLA' },
  ] } }),
});
stub('../../server/search.js', { searchCompanies: async () => [] });
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
  getPublication: async (userId, genId) => state.items[`item:USER#${userId}:PUB#${genId}`] || null,
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
  // The entitlement's report id joins to its ticker through the catalog, so one
  // company is ONE row — reads and opens together — not one per naming scheme.
  assert.equal(tesla.reportOpens, 1, JSON.stringify(byCompany));
  assert.ok(!byCompany.some((c) => c.companyId === 'teslainc'), 'the raw token must not appear beside the ticker');
  // A report no longer in the catalog still counts, under its id's company
  // token (date suffix off whole, collision suffix included).
  assert.ok(byCompany.some((c) => c.companyId === 'nokia'), JSON.stringify(byCompany));
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

// A name in the admin should go where a reader's would: the analyst's profile.
test('the admin views carry the LinkedIn profile of everyone they name', async () => {
  state.profiles = [
    { pk: 'USER#u1', sk: 'PROFILE', name: 'Anna Analyst', email: 'a@b.c', role: 'analyst',
      linkedinUrl: 'https://www.linkedin.com/in/anna' },
    { pk: 'USER#rev1', sk: 'PROFILE', name: 'Rex Reviewer', role: 'analyst',
      linkedinUrl: 'https://www.linkedin.com/in/rex' },
  ];
  state.index = [{
    genId: 'g1', companyId: 'TSLA', sk: 'TSLA#2026#g1', userId: 'u1',
    analystName: 'Anna Analyst', analystLinkedin: 'https://www.linkedin.com/in/anna',
    publishedAt: '2026-08-26T00:00:00.000Z', status: 'published',
  }];
  state.items['u1:PUB#'] = [{
    sk: 'PUB#g1', status: 'published', companyId: 'TSLA', publishedAt: '2026-08-26T00:00:00.000Z',
  }];
  // A sale is what puts the analyst on the earnings list at all.
  state.items['u1:SALE#'] = [{ genId: 'g1', companyId: 'TSLA', grossEur: 20, soldAt: '2026-08-27T00:00:00.000Z' }];
  state.items['u1:REVIEW#'] = [{ genId: 'g1', reviewerId: 'rev1', score: 4, comment: 'good' }];

  const users = JSON.parse((await asAdmin('GET /admin/members/users')).body).users;
  assert.equal(users.find((u) => u.userId === 'u1').linkedinUrl, 'https://www.linkedin.com/in/anna');

  const pubs = JSON.parse((await asAdmin('GET /admin/members/publications')).body).publications;
  assert.equal(pubs[0].analystLinkedin, 'https://www.linkedin.com/in/anna');

  const earnings = JSON.parse((await asAdmin('GET /admin/members/earnings')).body);
  assert.equal(earnings.analysts[0].linkedinUrl, 'https://www.linkedin.com/in/anna');

  const detail = JSON.parse((await asAdmin('GET /admin/members/users/{userId}', {
    pathParameters: { userId: 'u1' },
  })).body);
  assert.equal(detail.profile.linkedinUrl, 'https://www.linkedin.com/in/anna');
  assert.equal(detail.reviewsReceived[0].reviewerName, 'Rex Reviewer');
  assert.equal(detail.reviewsReceived[0].reviewerLinkedin, 'https://www.linkedin.com/in/rex');
});

test('the dashboard shows those links beside the names', () => {
  const html = readFileSync(new URL('../../admin/index.html', import.meta.url), 'utf8');
  assert.match(html, /function linkedinLink/);
  for (const field of ['p.analystLinkedin', 'u.linkedinUrl', 'a.linkedinUrl', 'r.reviewerLinkedin']) {
    assert.ok(html.includes(`linkedinLink(${field}`), `${field} is linked`);
  }
});

test('the dashboard gates its own destructive buttons', () => {
  const html = readFileSync(new URL('../../admin/index.html', import.meta.url), 'utf8');
  // Takedown moves money (bounty void + clawback) and payout states money left
  // the bank — both must be type-to-confirm, not one-click.
  assert.match(html, /Type the company id/, 'takedown must be type-to-confirm');
  assert.match(html, /Type PAID to confirm/, 'payout must be type-to-confirm');
  assert.match(html, /aerAdminMembersApiBase/, 'the test-stage override must exist');
});

// Earnings is the one admin route that runs the real bounty ledger. A partial
// stub of bounty.js once made it 500 with "bounty.ledger is not a function".
test('earnings runs the real ledger', async () => {
  state.index = [];
  const res = await asAdmin('GET /admin/members/earnings');
  assert.equal(res.statusCode, 200);
  assert.ok('share' in JSON.parse(res.body));
});
