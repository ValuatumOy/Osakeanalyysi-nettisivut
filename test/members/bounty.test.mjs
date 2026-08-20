import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bounty = require('../../server/members/bounty.js');

const AMOUNT = 50;
const opts = (now, extra = {}) => ({ now: new Date(now), amount: AMOUNT, ...extra });

const pub = (genId, publishedAt, companyId, extra = {}) => ({
  sk: `PUB#${genId}`, status: 'published', publishedAt, companyId, ...extra,
});

const stateOf = (res, genId) => res.entries.find((e) => e.genId === genId).state;

test('pending until the 14-day moderation window closes, then eligible', () => {
  const pubs = [pub('a', '2026-08-01T00:00:00Z', 'NOKIA.HE')];
  assert.equal(stateOf(bounty.ledger(pubs, opts('2026-08-14T23:59:00Z')), 'a'), 'pending');
  assert.equal(stateOf(bounty.ledger(pubs, opts('2026-08-15T00:00:01Z')), 'a'), 'eligible');
});

test('unpublished generations are not in the ledger at all', () => {
  const pubs = [{ sk: 'PUB#a', status: 'generating', reservedAt: '2026-08-01T00:00:00Z' }];
  assert.equal(bounty.ledger(pubs, opts('2026-09-01T00:00:00Z')).entries.length, 0);
});

test('takedown voids the bounty, and claws it back if already paid', () => {
  const down = [{ ...pub('a', '2026-08-01T00:00:00Z', 'NOKIA.HE'), status: 'takendown', takenDownAt: '2026-08-05T00:00:00Z' }];
  const now = '2026-09-01T00:00:00Z';
  assert.equal(stateOf(bounty.ledger(down, opts(now)), 'a'), 'void');

  const clawed = bounty.ledger(down, opts(now, { paidGenIds: ['a'] }));
  assert.equal(stateOf(clawed, 'a'), 'clawback');
  assert.equal(clawed.totals.clawback, -AMOUNT);
});

test('one bounty per company per quarter — the earliest publication wins', () => {
  const pubs = [
    pub('later', '2026-08-20T00:00:00Z', 'NOKIA.HE'),
    pub('first', '2026-07-05T00:00:00Z', 'NOKIA.HE'),
    pub('nextQ', '2026-10-05T00:00:00Z', 'NOKIA.HE'),
    pub('other', '2026-08-21T00:00:00Z', 'UPM.HE'),
  ];
  const res = bounty.ledger(pubs, opts('2026-12-01T00:00:00Z'));
  assert.equal(stateOf(res, 'first'), 'eligible');
  assert.equal(stateOf(res, 'later'), 'void');
  assert.equal(res.entries.find((e) => e.genId === 'later').reason, 'same-company-this-quarter');
  assert.equal(stateOf(res, 'nextQ'), 'eligible');   // Q4 is a fresh slot
  assert.equal(stateOf(res, 'other'), 'eligible');   // different company, same quarter
});

test('monthly cap bounds spend; the surplus is void, not deferred', () => {
  const pubs = ['A', 'B', 'C', 'D', 'E'].map((c, i) =>
    pub(c.toLowerCase(), `2026-08-0${i + 1}T00:00:00Z`, `${c}.HE`));
  const res = bounty.ledger(pubs, opts('2026-09-30T00:00:00Z', { monthlyCap: 4 }));
  assert.equal(res.totals.eligible, 4 * AMOUNT);
  assert.equal(stateOf(res, 'e'), 'void');
  assert.equal(res.entries.find((e) => e.genId === 'e').reason, 'monthly-cap');
});

test('the cap is per calendar month, not rolling', () => {
  const pubs = [
    ...['A', 'B', 'C', 'D'].map((c, i) => pub(`aug${i}`, `2026-08-0${i + 1}T00:00:00Z`, `${c}.HE`)),
    pub('sep', '2026-09-01T00:00:00Z', 'E.HE'),
  ];
  const res = bounty.ledger(pubs, opts('2026-10-01T00:00:00Z'));
  assert.equal(stateOf(res, 'sep'), 'eligible');
  assert.equal(res.totals.eligible, 5 * AMOUNT);
});

test('paid publications leave the payable set and stay out of it', () => {
  const pubs = [pub('a', '2026-08-01T00:00:00Z', 'NOKIA.HE'), pub('b', '2026-08-02T00:00:00Z', 'UPM.HE')];
  const now = '2026-09-01T00:00:00Z';
  assert.deepEqual(bounty.payableGenIds(pubs, opts(now)), ['a', 'b']);

  const after = bounty.ledger(pubs, opts(now, { paidGenIds: ['a'] }));
  assert.equal(stateOf(after, 'a'), 'paid');
  assert.equal(after.totals.paid, AMOUNT);
  assert.equal(after.totals.eligible, AMOUNT);
  assert.deepEqual(bounty.payableGenIds(pubs, opts(now, { paidGenIds: ['a'] })), ['b']);
});

test('a past payout keeps its own amount when the fee changes', () => {
  const pubs = [
    pub('a', '2026-08-01T00:00:00Z', 'NOKIA.HE'),
    { ...pub('b', '2026-08-02T00:00:00Z', 'UPM.HE'), status: 'takendown', takenDownAt: '2026-08-03T00:00:00Z' },
  ];
  const res = bounty.ledger(pubs, opts('2026-09-01T00:00:00Z', {
    amount: 75, paidGenIds: ['a', 'b'], paidAmounts: { a: 50, b: 50 },
  }));
  assert.equal(res.totals.paid, 50);       // paid at 50, not repriced to 75
  assert.equal(res.totals.clawback, -50);  // clawback returns what was paid
});

test('a paid publication still holds its quarter slot', () => {
  const pubs = [pub('a', '2026-08-01T00:00:00Z', 'NOKIA.HE'), pub('b', '2026-08-02T00:00:00Z', 'NOKIA.HE')];
  const res = bounty.ledger(pubs, opts('2026-09-01T00:00:00Z', { paidGenIds: ['a'] }));
  assert.equal(stateOf(res, 'b'), 'void');
});

test('quarterKey boundaries', () => {
  assert.equal(bounty.quarterKey('2026-03-31T23:59:59Z'), '2026-Q1');
  assert.equal(bounty.quarterKey('2026-04-01T00:00:00Z'), '2026-Q2');
  assert.equal(bounty.quarterKey('2026-12-31T23:59:59Z'), '2026-Q4');
});
