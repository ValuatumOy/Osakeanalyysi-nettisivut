import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildContiguousValues, EstimatesError } = require('../../server/estimates.js');

// Baseline shaped like fetchEstimateSeries output: per-varname, keyed by year.
const BASELINE = {
  ns: { 2025: 18487, 2026: 19586, 2027: 20761, 2028: 20985 },
  ebit: { 2025: 1017, 2026: 524, 2027: 645, 2028: 1279 },
};

test('fills every year from the first estimate year through the last edited one', () => {
  const values = buildContiguousValues(
    [{ varname: 'ns', year: 2027, value: 25000 }],
    BASELINE,
    2025,
  );
  assert.deepEqual(values, [
    { varname: 'ns', year: 2025, value: 18487 },
    { varname: 'ns', year: 2026, value: 19586 },
    { varname: 'ns', year: 2027, value: 25000 },
  ]);
});

test('stops at the last edited year rather than running to the end of the model', () => {
  const values = buildContiguousValues(
    [{ varname: 'ns', year: 2026, value: 20000 }],
    BASELINE,
    2025,
  );
  assert.deepEqual(values.map(v => v.year), [2025, 2026]);
});

test('fills each edited varname independently', () => {
  const values = buildContiguousValues(
    [
      { varname: 'ns', year: 2028, value: 30000 },
      { varname: 'ebit', year: 2026, value: 700 },
    ],
    BASELINE,
    2025,
  );
  assert.deepEqual(values.filter(v => v.varname === 'ns').map(v => v.year), [2025, 2026, 2027, 2028]);
  assert.deepEqual(values.filter(v => v.varname === 'ebit').map(v => v.year), [2025, 2026]);
});

test('an untouched varname is not sent at all', () => {
  const values = buildContiguousValues(
    [{ varname: 'ebit', year: 2026, value: 700 }],
    BASELINE,
    2025,
  );
  assert.equal(values.some(v => v.varname === 'ns'), false);
});

test('an edit in the first estimate year sends only that year', () => {
  const values = buildContiguousValues(
    [{ varname: 'ns', year: 2025, value: 19000 }],
    BASELINE,
    2025,
  );
  assert.deepEqual(values, [{ varname: 'ns', year: 2025, value: 19000 }]);
});

test('edited years win over the baseline', () => {
  const values = buildContiguousValues(
    [
      { varname: 'ns', year: 2025, value: 19000 },
      { varname: 'ns', year: 2027, value: 25000 },
    ],
    BASELINE,
    2025,
  );
  assert.deepEqual(values.map(v => v.value), [19000, 19586, 25000]);
});

test('a gap year with no model value is a 400, not a silently dropped year', () => {
  const gappy = { ns: { 2025: 18487, 2027: 20761 }, ebit: {} };
  assert.throws(
    () => buildContiguousValues([{ varname: 'ns', year: 2027, value: 25000 }], gappy, 2025),
    err => err instanceof EstimatesError
      && err.status === 400
      && err.message.includes('cannot fill ns 2026'),
  );
});

test('a null baseline value counts as missing', () => {
  const nulled = { ns: { 2025: 18487, 2026: null, 2027: 20761 }, ebit: {} };
  assert.throws(
    () => buildContiguousValues([{ varname: 'ns', year: 2027, value: 25000 }], nulled, 2025),
    err => err instanceof EstimatesError && err.message.includes('cannot fill ns 2026'),
  );
});

test('a baseline zero is a real value, not a gap', () => {
  const zeroed = { ns: {}, ebit: { 2025: 0, 2026: 0, 2027: 645 } };
  const values = buildContiguousValues(
    [{ varname: 'ebit', year: 2027, value: 900 }],
    zeroed,
    2025,
  );
  assert.deepEqual(values.map(v => v.value), [0, 0, 900]);
});

test('no edits means nothing to import', () => {
  assert.deepEqual(buildContiguousValues([], BASELINE, 2025), []);
});
