import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const quota = require('../../server/members/quota.js');

const now = new Date('2026-09-02T09:00:00.000Z');
const build = (overrides = {}) => quota.buildRestoreFailedGenerationTransact({
  table: 'Members', userId: 'u1', genId: 'g1', reservedAt: '2026-08-20T12:04:11.311Z', now, ...overrides,
});

test('the month cleared is the one the generation was reserved in, not the one it failed in', () => {
  const [, , usage] = build().TransactItems;
  assert.equal(usage.Update.Key.sk, 'USAGE#2026-08');
  assert.equal(usage.Update.UpdateExpression, 'REMOVE genReserved, genId');
});

test('every clause names this generation, so a newer reservation survives', () => {
  const [pub, profile, usage] = build().TransactItems;
  assert.match(pub.Update.ConditionExpression, /#status = :generating/);
  assert.equal(profile.Update.ExpressionAttributeValues[':genId'], 'g1');
  assert.equal(usage.Update.ExpressionAttributeValues[':genId'], 'g1');
});

test('a private generation carries no obligation, and that is not a reason to abort', () => {
  const [, profile] = build().TransactItems;
  assert.match(profile.Update.ConditionExpression, /attribute_not_exists\(openObligationId\) OR/);
});

test('the publication row moves out of generating, so the month is given back exactly once', () => {
  const [pub] = build().TransactItems;
  assert.equal(pub.Update.ExpressionAttributeValues[':failed'], 'failed');
  assert.equal(pub.Update.ExpressionAttributeValues[':generating'], 'generating');
});

test('a generation reserved and failed in the same month clears that month', () => {
  const [, , usage] = build({ reservedAt: '2026-09-01T10:00:00.000Z' }).TransactItems;
  assert.equal(usage.Update.Key.sk, 'USAGE#2026-09');
});
