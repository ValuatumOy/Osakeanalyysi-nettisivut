import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tiers = require('../../server/members/tiers.js');

test('the four numbers: analyst gets the full set, reader about half', () => {
  const analyst = tiers.limitsFor({ role: 'analyst', tier: 'none' });
  assert.deepEqual(analyst, { generations: 1, basePicks: 10, analystReads: 20, revisions: 5 });

  const reader = tiers.limitsFor({ role: 'reader', tier: 'none' });
  assert.equal(reader.generations, 1); // a reader still gets one generation
  assert.equal(reader.basePicks, 5);
  assert.equal(reader.analystReads, 10);
  assert.equal(reader.revisions, 2);
});

test('revision rounds follow who generates: plans without a generation get none', () => {
  assert.equal(tiers.limitsFor({ role: 'subscriber', tier: 'investor' }).revisions, 0);
  assert.equal(tiers.limitsFor({ role: 'subscriber', tier: 'investor_plus' }).revisions, 2);
  // An analyst who also subscribes keeps the larger revision allowance.
  assert.equal(tiers.limitsFor({ role: 'analyst', tier: 'investor_plus' }).revisions, 5);
});

test('annual subscriptions get the larger allowance', () => {
  assert.equal(tiers.limitsFor({ role: 'subscriber', tier: 'investor' }).basePicks, 3);
  assert.equal(tiers.limitsFor({ role: 'subscriber', tier: 'investor', interval: 'year' }).basePicks, 5);
  assert.equal(tiers.limitsFor({ role: 'subscriber', tier: 'investor_plus' }).basePicks, 10);
  assert.equal(
    tiers.limitsFor({ role: 'subscriber', tier: 'investor_plus', interval: 'year' }).basePicks, 15);
});

test('unknown role and tier grant nothing', () => {
  assert.deepEqual(tiers.limitsFor({ role: 'nobody', tier: 'nonsense' }),
    { generations: 0, basePicks: 0, analystReads: 0, revisions: 0 });
  assert.deepEqual(tiers.limitsFor({}), { generations: 0, basePicks: 0, analystReads: 0, revisions: 0 });
});

test('a subscribing analyst keeps the larger of each number — an upgrade never takes away', () => {
  const both = tiers.limitsFor({ role: 'analyst', tier: 'investor' });
  assert.equal(both.generations, 1); // from the role
  assert.equal(both.basePicks, 10); // from the role, larger than Investor's 3
  assert.equal(both.analystReads, 20);
});

test('MEMBERS_LIMITS_JSON retunes any subset without a code change', () => {
  process.env.MEMBERS_LIMITS_JSON = '{"analyst":{"basePicks":25}}';
  try {
    const analyst = tiers.limitsFor({ role: 'analyst', tier: 'none' });
    assert.equal(analyst.basePicks, 25);
    assert.equal(analyst.generations, 1); // untouched keys keep their default
  } finally {
    delete process.env.MEMBERS_LIMITS_JSON;
  }
});

test('broken MEMBERS_LIMITS_JSON falls back to the defaults instead of locking everyone out', () => {
  process.env.MEMBERS_LIMITS_JSON = '{not json';
  try {
    assert.equal(tiers.limitsFor({ role: 'analyst', tier: 'none' }).basePicks, 10);
  } finally {
    delete process.env.MEMBERS_LIMITS_JSON;
  }
});

test('publishing roles carry the obligation; readers do not', () => {
  assert.equal(tiers.isPublishingRole('analyst'), true);
  assert.equal(tiers.isPublishingRole('coaching'), true);
  assert.equal(tiers.isPublishingRole('reader'), false);
  assert.equal(tiers.isPublishingRole('subscriber'), false);
  assert.equal(tiers.isLinkedinRole('reader'), true);
  assert.equal(tiers.isLinkedinRole('subscriber'), false);
});
