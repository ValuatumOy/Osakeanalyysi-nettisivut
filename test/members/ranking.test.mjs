import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ranking = require('../../server/members/ranking.js');

const NOW = new Date('2026-09-01T00:00:00Z');
const pub = (genId, extra = {}) => ({
  genId, status: 'published', publishedAt: '2026-08-30T00:00:00Z', reviewCount: 0, scoreSum: 0, ...extra,
});

test('taken-down analyses never appear on a company page', () => {
  const ordered = ranking.orderAnalyses([
    pub('a'), pub('b', { status: 'takendown' }), pub('c', { status: 'generating' }),
  ], NOW);
  assert.deepEqual(ordered.map(i => i.genId), ['a']);
});

test('well-reviewed beats unreviewed, and a single bad review does not bury an analysis', () => {
  const good = pub('good', { reviewCount: 4, scoreSum: 20 }); // four 5s
  const unreviewed = pub('plain');
  const oneBad = pub('onebad', { reviewCount: 1, scoreSum: 1 });

  const ordered = ranking.orderAnalyses([unreviewed, oneBad, good], NOW);
  assert.deepEqual(ordered.map(i => i.genId), ['good', 'plain', 'onebad']);
  assert.ok(ranking.peerScore(oneBad) > 1); // the neutral prior keeps it in the list
});

test('a dated take slides down as it ages', () => {
  const fresh = pub('fresh', { publishedAt: '2026-08-30T00:00:00Z', reviewCount: 2, scoreSum: 8 });
  const old = pub('old', { publishedAt: '2025-08-30T00:00:00Z', reviewCount: 2, scoreSum: 8 });
  assert.ok(ranking.score(fresh, NOW) > ranking.score(old, NOW));
  assert.deepEqual(ranking.orderAnalyses([old, fresh], NOW).map(i => i.genId), ['fresh', 'old']);
});

test('ties break on publication order, so the ranking is stable', () => {
  const first = pub('first', { publishedAt: '2026-08-01T00:00:00Z' });
  const second = pub('second', { publishedAt: '2026-08-01T00:00:00Z' });
  assert.deepEqual(ranking.orderAnalyses([second, first], NOW).map(i => i.genId), ['first', 'second']);
});

test('free now: inside a hand-picked window, or after the analyst\'s own decay', () => {
  assert.equal(ranking.isFreeNow({ freeUntil: '2026-09-02T00:00:00Z' }, NOW), true);
  assert.equal(ranking.isFreeNow({ freeUntil: '2026-08-31T00:00:00Z' }, NOW), false);
  assert.equal(ranking.isFreeNow({ freeFrom: '2026-08-01T00:00:00Z' }, NOW), true);
  assert.equal(ranking.isFreeNow({ freeFrom: '2026-12-01T00:00:00Z' }, NOW), false);
  assert.equal(ranking.isFreeNow({}, NOW), false);
});

test('decimal peer scores order as written — 4.5 beats 4.2', () => {
  const better = pub('better', { reviewCount: 2, scoreSum: 9.0 }); // two 4.5s
  const worse = pub('worse', { reviewCount: 2, scoreSum: 8.4 });   // two 4.2s
  const [first] = ranking.orderAnalyses([worse, better], NOW);
  assert.equal(first.genId, 'better');
  assert.equal(Math.round(first.peerScore * 100) / 100, 3.75);
});
