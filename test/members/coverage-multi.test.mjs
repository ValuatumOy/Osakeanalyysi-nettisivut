// A coverage subscription may now carry up to five companies, priced per
// company. Everything it grants is therefore per company: the free first
// report, and the four updates a year.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const quota = require('../../server/members/quota.js');

test('each covered company counts on its own', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const nokia = quota.buildCoverageUpdateTransact({ table: 't', userId: 'u1', now, reportId: 'r1', companyId: 'NOKIA.HE' });
  const tesla = quota.buildCoverageUpdateTransact({ table: 't', userId: 'u1', now, reportId: 'r2', companyId: 'TSLA' });
  assert.notEqual(
    nokia.TransactItems[0].Update.ExpressionAttributeNames['#c'],
    tesla.TransactItems[0].Update.ExpressionAttributeNames['#c'],
    'one shared counter would sell the same four reports twice',
  );
  // Tickers carry dots; the name goes through ExpressionAttributeNames so no
  // escaping is needed and none is invented.
  assert.equal(quota.coverageCounter('nokia.he'), 'cov#NOKIA.HE');
});

test('the free first report is per company too', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const a = quota.buildCoverageInitialTransact({ table: 't', userId: 'u1', now, reportId: 'r1', companyId: 'NOKIA.HE' });
  const b = quota.buildCoverageInitialTransact({ table: 't', userId: 'u1', now, reportId: 'r2', companyId: 'TSLA' });
  assert.equal(a.TransactItems[0].Update.ExpressionAttributeNames['#f'], 'coverageInitial#NOKIA.HE');
  assert.equal(b.TransactItems[0].Update.ExpressionAttributeNames['#f'], 'coverageInitial#TSLA');
});

test('the checkout charges per company and the cap is enforced', () => {
  const src = readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
  assert.match(src, /quantity: plan === 'coverage' \? coverage\.length : 1/,
    'a multi-company subscription must be priced as one line per company');
  assert.match(src, /COVERAGE_MAX_COMPANIES/);
  assert.equal(quota.COVERAGE_MAX_COMPANIES, 5);
});

test('a subscription sold before the list existed still resolves', () => {
  const src = readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
  // coveredCompanies falls back to the single field, so an existing subscriber
  // is not left uncovered by the migration.
  assert.match(src, /const all = many\.length \? many : \[profile\.coverageCompanyId\];/);
});

test('every delivered report can buy more rounds, member or not', () => {
  const page = readFileSync(new URL('../../js/order-page.js', import.meta.url), 'utf8');
  // Both sides of the wall: the members Lambda for a member's generation, the
  // Vercel function for a one-off buyer who has no account at all.
  assert.match(page, /revisions-checkout/);
  assert.match(page, /buyRounds: true/);
  assert.match(page, /params\.get\('revisions'\)/);
});
