// A subscriber's monthly analyst read is revenue we collected, so it pays the
// analyst who wrote what they read. A read spent from an analyst's or reader's
// own free allowance is not revenue and pays nobody.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bounty = require('../../server/members/bounty.js');
const quota = require('../../server/members/quota.js');

const NOW = new Date('2026-09-20T00:00:00.000Z');
const pubs = [{
  sk: 'PUB#g1', status: 'published', publishedAt: '2026-08-01T00:00:00.000Z', companyId: 'TSLA',
}];
const read = (readerId, openedAt, rateEur = 0.5) => ({
  sk: `SUBREAD#g1#${readerId}`, genId: 'g1', companyId: 'TSLA', readerId, openedAt, rateEur,
});

test('a matured subscriber read is payable at the rate stamped on it', () => {
  const { readEntries, totals } = bounty.ledger(pubs, {
    now: NOW,
    reads: [read('sub1', '2026-09-01T00:00:00.000Z'), read('sub2', '2026-09-19T00:00:00.000Z', 0.8)],
  });
  assert.equal(readEntries[0].state, 'eligible');
  assert.equal(readEntries[0].amount, 0.5);
  // Inside the 14-day window the second one is still held.
  assert.equal(readEntries[1].state, 'pending');
  assert.equal(totals.readEligible, 0.5);
  assert.equal(totals.readPending, 0.8);
  assert.equal(totals.readsCount, 2);
});

test('a later rate change does not rewrite what an earlier read was worth', () => {
  const { readEntries } = bounty.ledger(pubs, {
    now: NOW, reads: [read('sub1', '2026-09-01T00:00:00.000Z', 0.25)],
  });
  assert.equal(readEntries[0].amount, 0.25);
});

test('a taken-down analysis earns nothing for the reads it collected', () => {
  const down = [{ ...pubs[0], status: 'takendown' }];
  const { readEntries } = bounty.ledger(down, {
    now: NOW, reads: [read('sub1', '2026-09-01T00:00:00.000Z')],
  });
  assert.equal(readEntries[0].state, 'void');
  assert.equal(readEntries[0].amount, 0);
});

test('reopening does not resurrect reads taken before the cutoff', () => {
  const reopened = [{ ...pubs[0], voidSalesBefore: '2026-09-05T00:00:00.000Z' }];
  const { readEntries } = bounty.ledger(reopened, {
    now: NOW,
    reads: [read('sub1', '2026-09-01T00:00:00.000Z'), read('sub2', '2026-09-05T12:00:00.000Z')],
  });
  assert.equal(readEntries[0].state, 'void');
  assert.equal(readEntries[1].state, 'eligible');
});

test('a paid read is not offered for payment twice', () => {
  const opts = { now: NOW, reads: [read('sub1', '2026-09-01T00:00:00.000Z')] };
  assert.deepEqual(
    bounty.payableItems(pubs, opts).map((p) => [p.kind, p.id, p.amount]),
    [['read', 'SUBREAD#g1#sub1', 0.5]],
  );
  const settled = { ...opts, paidGenIds: ['SUBREAD#g1#sub1'], paidAmounts: { 'SUBREAD#g1#sub1': 0.5 } };
  assert.deepEqual(bounty.payableItems(pubs, settled), []);
  assert.equal(bounty.ledger(pubs, settled).totals.readPaid, 0.5);
});

test('no rate, no mirror row — a free-allowance read leaves nothing payable', () => {
  const free = quota.buildOpenAnalysisTransact({
    table: 't', userId: 'u', now: NOW, limit: 20, genId: 'g1', ownerId: 'author', readRateEur: 0,
  });
  assert.equal(free.TransactItems.length, 3);
  const paidRead = quota.buildOpenAnalysisTransact({
    table: 't', userId: 'u', now: NOW, limit: 20, genId: 'g1', ownerId: 'author',
    readRateEur: 0.5, companyId: 'tsla',
  });
  assert.equal(paidRead.TransactItems.length, 4);
  const mirror = paidRead.TransactItems[3].Put.Item;
  assert.equal(mirror.pk, 'USER#author');
  assert.equal(mirror.sk, 'SUBREAD#g1#u');
  assert.equal(mirror.rateEur, 0.5);
  assert.equal(mirror.companyId, 'TSLA');
});
