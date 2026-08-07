import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const quota = require('../../server/members/quota.js');

const TABLE = 'MembersTest';

test('monthKey: UTC calendar month, resets at month boundary', () => {
  assert.equal(quota.monthKey(new Date('2026-08-06T12:00:00Z')), '2026-08');
  assert.equal(quota.monthKey(new Date('2026-12-31T23:59:59Z')), '2026-12');
  assert.equal(quota.monthKey(new Date('2027-01-01T00:00:00Z')), '2027-01');
});

test('yearKey', () => {
  assert.equal(quota.yearKey(new Date('2026-12-31T23:59:59Z')), '2026');
  assert.equal(quota.yearKey(new Date('2027-01-01T00:00:00Z')), '2027');
});

test('tier pick limits: freemium 2, investor 5, plus 15', () => {
  assert.equal(quota.PICK_LIMITS.free, 2);
  assert.equal(quota.pickLimitForTier('investor'), 5);
  assert.equal(quota.pickLimitForTier('investor_plus'), 15);
  assert.equal(quota.pickLimitForTier('none'), 0);
  assert.equal(quota.pickLimitForTier(undefined), 0);
});

test('freemium age gate: only reports 30 days or older', () => {
  assert.equal(quota.freemiumPickEligible({ ageDays: 29 }), false);
  assert.equal(quota.freemiumPickEligible({ ageDays: 30 }), true);
  assert.equal(quota.freemiumPickEligible({ ageDays: 400 }), true);
  assert.equal(quota.freemiumPickEligible({}), false);
  assert.equal(quota.freemiumPickEligible(null), false);
});

test('pick transaction: conditional quota increment + exactly-once entitlement', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const params = quota.buildPickTransact({
    table: TABLE, userId: 'u1', now, limit: 5, reportId: 'r1', source: 'pick',
  });
  const [update, put] = params.TransactItems.map(item => item.Update || item.Put);

  assert.equal(update.Key.sk, 'USAGE#2026-08');
  assert.equal(update.ConditionExpression, 'attribute_not_exists(picks) OR picks < :limit');
  assert.equal(update.ExpressionAttributeValues[':limit'], 5);
  assert.equal(update.UpdateExpression, 'SET picks = if_not_exists(picks, :zero) + :one');

  assert.equal(put.Item.sk, 'ENT#r1');
  assert.equal(put.Item.source, 'pick');
  assert.equal(put.ConditionExpression, 'attribute_not_exists(sk)');
});

test('generation reservation: obligation gate + one per month + analyst only', () => {
  const now = new Date('2026-08-31T23:59:00Z');
  const params = quota.buildReserveGenerationTransact({
    table: TABLE, userId: 'u1', now, genId: 'g1',
  });
  const [profileUpdate, usageUpdate, pubPut] = params.TransactItems.map(i => i.Update || i.Put);

  assert.equal(profileUpdate.Key.sk, 'PROFILE');
  assert.match(profileUpdate.ConditionExpression, /attribute_not_exists\(openObligationId\)/);
  assert.match(profileUpdate.ConditionExpression, /#role = :analyst/);
  assert.match(profileUpdate.ConditionExpression, /attribute_not_exists\(banned\) OR banned = :false/);

  assert.equal(usageUpdate.Key.sk, 'USAGE#2026-08');
  assert.equal(usageUpdate.ConditionExpression, 'attribute_not_exists(genReserved)');

  assert.equal(pubPut.Item.sk, 'PUB#g1');
  assert.equal(pubPut.Item.status, 'generating');
});

test('submit releases the obligation only for the matching genId', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  const params = quota.buildSubmitTransact({
    table: TABLE, userId: 'u1', now, genId: 'g1', promptsText: 'prompts',
  });
  const [profileUpdate, pubUpdate] = params.TransactItems.map(i => i.Update);

  assert.equal(profileUpdate.UpdateExpression, 'REMOVE openObligationId');
  assert.equal(profileUpdate.ConditionExpression, 'openObligationId = :genId');
  assert.equal(pubUpdate.ConditionExpression, '#status = :generating');
  assert.equal(pubUpdate.ExpressionAttributeValues[':prompts'], 'prompts');
});

test('coverage: initial once per subscription, updates capped at 4 per year', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const initial = quota.buildCoverageInitialTransact({ table: TABLE, userId: 'u1', now, reportId: 'r1' });
  assert.equal(initial.TransactItems[0].Update.ConditionExpression, 'attribute_not_exists(coverageInitialGranted)');

  const update = quota.buildCoverageUpdateTransact({ table: TABLE, userId: 'u1', now, reportId: 'r2' });
  const usage = update.TransactItems[0].Update;
  assert.equal(usage.Key.sk, 'USAGE#Y#2026');
  assert.equal(usage.ConditionExpression, 'attribute_not_exists(coverageUpdates) OR coverageUpdates < :max');
  assert.equal(usage.ExpressionAttributeValues[':max'], 4);
});
