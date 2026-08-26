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

test('submit publishes and releases the obligation, and indexes the publication', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  const params = quota.buildSubmitTransact({
    table: TABLE, userId: 'u1', now, genId: 'g1', promptsText: 'prompts',
    companyId: 'nokia.he', jobId: '01JOB', priceEur: 12.4, freeAfterDays: 30, analystName: 'A',
  });
  const [profileUpdate, pubUpdate, indexPut] = params.TransactItems.map(i => i.Update || i.Put);

  // Tolerant of an admin having cleared the obligation to unblock the next run.
  assert.equal(profileUpdate.ConditionExpression,
    'attribute_not_exists(openObligationId) OR openObligationId = :genId');
  assert.equal(pubUpdate.ExpressionAttributeValues[':price'], 12);
  assert.equal(pubUpdate.ExpressionAttributeValues[':days'], 30);
  assert.equal(pubUpdate.ExpressionAttributeValues[':freeFrom'], '2026-10-01T00:00:00.000Z');
  assert.equal(indexPut.Item.pk, 'PUBINDEX');
  assert.equal(indexPut.Item.sk, 'NOKIA.HE#2026-09-01T00:00:00.000Z#g1');
  assert.equal(indexPut.Item.reviewCount, 0);
});

test('the engine rating is recorded on both rows, and only the three it issues', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  const build = (extra) => quota.buildSubmitTransact({
    table: TABLE, userId: 'u1', now, genId: 'g1', promptsText: 'p',
    companyId: 'NOKIA.HE', jobId: '01JOB', analystName: 'A', ...extra,
  });

  const [, pubUpdate, indexPut] = build({ recommendation: 'buy', targetPrice: ' 12.00 EUR ' })
    .TransactItems.map(i => i.Update || i.Put);
  // Upper-cased and trimmed, and on the index row too -- GET /analyses reads that one.
  assert.equal(pubUpdate.ExpressionAttributeValues[':rec'], 'BUY');
  assert.equal(pubUpdate.ExpressionAttributeValues[':target'], '12.00 EUR');
  assert.equal(indexPut.Item.recommendation, 'BUY');
  assert.equal(indexPut.Item.targetPrice, '12.00 EUR');

  // Anything that is not BUY/HOLD/SELL is stored as unknown rather than shown. A rating is
  // a published claim; an unrecognised one must not reach a company page.
  for (const junk of ['STRONG BUY', 'OUTPERFORM', 'accumulate', '', null, undefined, 5]) {
    const [, pub, idx] = build({ recommendation: junk }).TransactItems.map(i => i.Update || i.Put);
    assert.equal(pub.ExpressionAttributeValues[':rec'], null, `rejected: ${junk}`);
    assert.equal(idx.Item.recommendation, null, `rejected: ${junk}`);
  }

  // Absent, not undefined: DynamoDB rejects undefined, and null reads back as "not known".
  const [, pubBare, idxBare] = build({}).TransactItems.map(i => i.Update || i.Put);
  assert.equal(pubBare.ExpressionAttributeValues[':rec'], null);
  assert.equal(pubBare.ExpressionAttributeValues[':target'], null);
  assert.equal(idxBare.Item.recommendation, null);
  assert.equal(idxBare.Item.targetPrice, null);
});

test('free decay is capped at a year and defaults to it', () => {
  assert.equal(quota.clampFreeAfterDays(30), 30);
  assert.equal(quota.clampFreeAfterDays(9999), 365);
  assert.equal(quota.clampFreeAfterDays(0), 365);
  assert.equal(quota.clampFreeAfterDays(undefined), 365);
  assert.equal(quota.clampFreeAfterDays(-5), 365);
});

test('admin grant clears both gates unconditionally', () => {
  const params = quota.buildGrantGenerationTransact({
    table: TABLE, userId: 'u1', now: new Date('2026-08-20T00:00:00Z'),
  });
  const [profile, usage] = params.TransactItems.map(i => i.Update);
  assert.match(profile.UpdateExpression, /REMOVE openObligationId/);
  assert.equal(profile.ConditionExpression, undefined); // must work whichever gate blocked
  assert.equal(usage.Key.sk, 'USAGE#2026-08');
  assert.equal(usage.UpdateExpression, 'REMOVE genReserved, genId');
});

test('self-service downgrade is blocked while a report is unpublished', () => {
  const params = quota.buildRoleChangeTransact({ table: TABLE, userId: 'u1', role: 'reader' });
  const [update] = params.TransactItems.map(i => i.Update);
  assert.equal(update.ConditionExpression, 'attribute_not_exists(openObligationId)');
  assert.equal(update.ExpressionAttributeValues[':role'], 'reader');
});

test('opening another analysis costs a read and leaves a review obligation', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const params = quota.buildOpenAnalysisTransact({
    table: TABLE, userId: 'u1', now, limit: 20, genId: 'g9', ownerId: 'u2',
  });
  const [usage, profile, read] = params.TransactItems.map(i => i.Update || i.Put);
  assert.equal(usage.ConditionExpression, 'attribute_not_exists(analystReads) OR analystReads < :limit');
  assert.equal(usage.ExpressionAttributeValues[':limit'], 20);
  assert.equal(profile.ConditionExpression, 'attribute_not_exists(openReviewId)');
  assert.equal(read.Item.sk, 'READ#g9');
  assert.equal(read.Item.ownerId, 'u2');
});

test('a review clears its own obligation and counts towards the ordering', () => {
  const params = quota.buildReviewTransact({
    table: TABLE, userId: 'u1', now: new Date('2026-08-07T00:00:00Z'), genId: 'g9',
    ownerId: 'u2', indexSk: 'NOKIA.HE#2026-08-01T00:00:00.000Z#g9', score: 4, comment: 'adds value because…',
  });
  const [profile, review, index] = params.TransactItems.map(i => i.Update || i.Put);
  assert.equal(profile.ConditionExpression, 'openReviewId = :genId');
  assert.equal(review.Item.pk, 'USER#u2'); // stored under the analysis it reviews
  assert.equal(review.ConditionExpression, 'attribute_not_exists(sk)'); // one review per reviewer
  assert.equal(index.UpdateExpression, 'ADD reviewCount :one, scoreSum :score');
  assert.equal(index.ExpressionAttributeValues[':score'], 4);
});

test('featuring an analysis opens a free window on both the item and the index', () => {
  const params = quota.buildFeatureTransact({
    table: TABLE, userId: 'u1', now: new Date('2026-08-01T00:00:00Z'), genId: 'g1',
    indexSk: 'NOKIA.HE#2026-07-01T00:00:00.000Z#g1', days: 10,
  });
  const [pub, index] = params.TransactItems.map(i => i.Update);
  assert.equal(pub.ConditionExpression, '#status = :published');
  assert.equal(pub.ExpressionAttributeValues[':until'], '2026-08-11T00:00:00.000Z');
  assert.equal(index.ExpressionAttributeValues[':until'], '2026-08-11T00:00:00.000Z');
});

test('member generation reserves the month slot without a publish obligation', () => {
  const now = new Date('2026-08-06T12:00:00Z');
  const params = quota.buildReserveMemberGenerationTransact({
    table: TABLE, userId: 'u1', now, genId: 'g1',
  });
  const items = params.TransactItems;
  assert.equal(items.length, 2); // no PROFILE obligation write
  assert.equal(items[0].Update.Key.sk, 'USAGE#2026-08');
  assert.equal(items[0].Update.ConditionExpression, 'attribute_not_exists(genReserved)');
  assert.equal(items[1].Put.Item.private, true);
  assert.ok(!JSON.stringify(params).includes('openObligationId'));
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
  assert.match(profileUpdate.ConditionExpression, /#role IN \(:analyst, :coaching\)/);
  assert.match(profileUpdate.ConditionExpression, /attribute_not_exists\(banned\) OR banned = :false/);

  assert.equal(usageUpdate.Key.sk, 'USAGE#2026-08');
  assert.equal(usageUpdate.ConditionExpression, 'attribute_not_exists(genReserved)');

  assert.equal(pubPut.Item.sk, 'PUB#g1');
  assert.equal(pubPut.Item.status, 'generating');
});

test('takedown only applies to a published publication', () => {
  const params = quota.buildTakedownTransact({
    table: TABLE, userId: 'u1', now: new Date('2026-09-02T00:00:00Z'), genId: 'g1', reason: 'bad',
    indexSk: 'NOKIA.HE#2026-09-01T00:00:00.000Z#g1',
  });
  const [update, index] = params.TransactItems.map(i => i.Update);
  assert.equal(update.ConditionExpression, '#status = :published');
  assert.equal(update.ExpressionAttributeValues[':down'], 'takendown');
  // A taken-down analysis must also leave the company listing.
  assert.equal(index.Key.pk, 'PUBINDEX');
  assert.equal(index.ExpressionAttributeValues[':down'], 'takendown');
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

test('reopen returns a taken-down analysis to generating and restores the obligation', () => {
  const params = quota.buildReopenTransact({
    table: TABLE, userId: 'u1', now: new Date('2026-09-10T00:00:00Z'), genId: 'g1',
    indexSk: 'NOKIA.HE#2026-09-01T00:00:00.000Z#g1',
  });
  const [pub, profile] = params.TransactItems.map(i => i.Update);

  // Only a taken-down analysis can be reopened — never a live one.
  assert.equal(pub.ConditionExpression, '#status = :takendown');
  assert.equal(pub.ExpressionAttributeValues[':generating'], 'generating');
  assert.match(pub.UpdateExpression, /REMOVE publishedAt, takenDownAt, takedownReason/);
  // The cutoff that stops the voided sales becoming payable on republication.
  assert.equal(pub.ExpressionAttributeValues[':now'], '2026-09-10T00:00:00.000Z');
  assert.match(pub.UpdateExpression, /voidSalesBefore = :now/);

  // Republishing goes through the obligation, and must not displace another one.
  assert.equal(profile.Key.sk, 'PROFILE');
  assert.equal(profile.ConditionExpression,
    'attribute_not_exists(openObligationId) OR openObligationId = :genId');

  // The stale index row goes, or the republish leaves two rows for one analysis.
  const del = params.TransactItems.find(i => i.Delete);
  assert.equal(del.Delete.Key.pk, 'PUBINDEX');
  assert.equal(del.Delete.Key.sk, 'NOKIA.HE#2026-09-01T00:00:00.000Z#g1');
});

test('reopen without an index row still reopens the publication', () => {
  const params = quota.buildReopenTransact({
    table: TABLE, userId: 'u1', now: new Date('2026-09-10T00:00:00Z'), genId: 'g1',
  });
  assert.equal(params.TransactItems.length, 2);
  assert.ok(!params.TransactItems.some(i => i.Delete));
});

test('a fork owes a publication and does not touch the monthly generation', () => {
  const params = quota.buildForkTransact({
    table: TABLE, userId: 'u2', now: new Date('2026-09-10T00:00:00Z'),
    genId: 'fork1', parentGenId: 'g1', parentUserId: 'u1', companyId: 'nokia.he',
  });
  const profile = params.TransactItems.find(i => i.Update).Update;
  const put = params.TransactItems.find(i => i.Put).Put;

  // The fee is what limits forking, so genReserved is deliberately untouched:
  // the free monthly generation stays for work started from nothing.
  const json = JSON.stringify(params);
  assert.ok(!json.includes('genReserved'), 'a paid fork must not spend the free generation');
  assert.ok(!json.includes('USAGE#'), 'a paid fork must not touch the monthly usage row');

  // It still owes a publication, and cannot displace one already owed.
  assert.equal(profile.ConditionExpression,
    'attribute_not_exists(openObligationId) OR openObligationId = :genId');
  assert.equal(put.Item.status, 'generating');
  assert.equal(put.Item.forkedFrom, 'g1');
  assert.equal(put.Item.forkedFromUserId, 'u1');
  assert.equal(put.Item.companyId, 'NOKIA.HE');
  assert.equal(put.ConditionExpression, 'attribute_not_exists(sk)');
});

test('repricing moves the listing with the publication, and only while live', () => {
  const params = quota.buildRepriceTransact({
    table: TABLE, userId: 'u1', genId: 'g1',
    indexSk: 'NOKIA.HE#2026-09-01T00:00:00.000Z#g1',
    priceEur: 25, freeAfterDays: 30, publishedAt: '2026-09-01T00:00:00.000Z',
  });
  const [pub, index] = params.TransactItems.map(i => i.Update);

  assert.equal(pub.ConditionExpression, '#status = :published');
  assert.equal(pub.ExpressionAttributeValues[':price'], 25);
  // The listing is where every checkout reads the price, so it has to move too.
  assert.equal(index.Key.pk, 'PUBINDEX');
  assert.equal(index.ExpressionAttributeValues[':price'], 25);

  // freeFrom counts from publication, not from the reprice: otherwise repeated
  // repricing would push the free date away indefinitely.
  assert.equal(pub.ExpressionAttributeValues[':freeFrom'], '2026-10-01T00:00:00.000Z');
});

test('a price is clamped to whole euros at or above zero', () => {
  const of = (priceEur) => quota.buildRepriceTransact({
    table: TABLE, userId: 'u1', genId: 'g1', priceEur, freeAfterDays: 30,
    publishedAt: '2026-09-01T00:00:00.000Z',
  }).TransactItems[0].Update.ExpressionAttributeValues[':price'];

  assert.equal(of(-5), 0);
  assert.equal(of(19.6), 20);
  assert.equal(of('12'), 12);
  assert.equal(of(undefined), 0);
});
