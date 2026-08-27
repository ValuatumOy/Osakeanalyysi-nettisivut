// Running out of report picks on the €19 tier left one option: upgrade the whole
// subscription for the sake of one more report. A tier is a permanent
// commitment, so the step belongs where the wall is — a top-up on the month's
// own meter, which resets with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const quota = require('../../server/members/quota.js');

const NOW = new Date('2026-09-14T08:00:00.000Z');

test('a top-up raises this month\'s meter and nothing else', () => {
  const t = quota.buildTopUpTransact({
    table: 't', userId: 'u1', now: NOW, kind: 'picks', units: 3, sessionId: 'cs_1',
  });
  const [meter, receipt] = t.TransactItems;
  // The month's usage row, so it resets when the meter does — a top-up must not
  // quietly promote anyone to a bigger plan.
  assert.equal(meter.Update.Key.sk, 'USAGE#2026-09');
  assert.equal(meter.Update.ExpressionAttributeNames['#f'], 'picksExtra');
  assert.equal(meter.Update.ExpressionAttributeValues[':units'], 3);
  assert.equal(meter.Update.UpdateExpression, 'ADD #f :units');

  assert.equal(receipt.Put.Item.sk, 'TOPUP#cs_1');
  assert.match(receipt.Put.ConditionExpression, /attribute_not_exists\(sk\)/,
    'a redelivered Stripe event must not credit the same checkout twice');
});

test('reads have their own field', () => {
  const t = quota.buildTopUpTransact({
    table: 't', userId: 'u1', now: NOW, kind: 'reads', units: 1, sessionId: 'cs_2',
  });
  assert.equal(t.TransactItems[0].Update.ExpressionAttributeNames['#f'], 'analystReadsExtra');
  assert.deepEqual(quota.TOPUP_FIELDS, { picks: 'picksExtra', reads: 'analystReadsExtra' });
});

test('an unknown meter is refused rather than silently credited somewhere', () => {
  assert.throws(() => quota.buildTopUpTransact({
    table: 't', userId: 'u1', now: NOW, kind: 'generations', units: 1, sessionId: 'cs_3',
  }), /unknown top-up kind/);
});

test('both meters read the top-up when they check their limit', () => {
  const src = readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
  // Both spend paths have to add the extra, or a member pays for picks that the
  // transact then refuses to let them spend.
  assert.equal((src.match(/withTopUps\(/g) || []).length, 2,
    'the pick path and the analyst-read path both call it');
  assert.match(src, /basePicks: \(limits\.basePicks \|\| 0\) \+ \(Number\(usage\?\.picksExtra\) \|\| 0\)/);
  assert.match(src, /analystReads: \(limits\.analystReads \|\| 0\) \+ \(Number\(usage\?\.analystReadsExtra\) \|\| 0\)/);
});

test('a meter the plan does not have at all cannot be topped up', () => {
  const src = readFileSync(new URL('../../server/lambda/members.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf('async function postBillingTopUpCheckout'));
  assert.match(route.slice(0, 2000), /Your plan does not include report picks/);
  assert.match(route.slice(0, 2000), /Your plan does not include reading other analysts/);
});
