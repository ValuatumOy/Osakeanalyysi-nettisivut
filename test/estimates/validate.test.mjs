import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateEstimateEdits, EstimatesError } = require('../../server/estimates.js');

const YEARS = [2025, 2026, 2027, 2028];

function rejects(edits, fragment) {
  assert.throws(
    () => validateEstimateEdits(edits, YEARS),
    err => err instanceof EstimatesError && err.status === 400 && err.message.includes(fragment),
    `expected a 400 mentioning "${fragment}"`,
  );
}

test('accepts well-formed edits and returns them', () => {
  const edits = [
    { varname: 'ns', year: 2027, value: 21000 },
    { varname: 'ebit', year: 2027, value: 900 },
  ];
  assert.deepEqual(validateEstimateEdits(edits, YEARS), edits);
});

test('accepts an empty list — that is the continue-without-changes path', () => {
  assert.deepEqual(validateEstimateEdits([], YEARS), []);
});

test('rejects a non-array body', () => {
  rejects(null, 'must be an array');
  rejects({ varname: 'ns', year: 2027, value: 1 }, 'must be an array');
});

test('rejects varnames outside the allowlist', () => {
  rejects([{ varname: 'ebitda', year: 2027, value: 1 }], 'varname must be one of');
  rejects([{ varname: 'NS', year: 2027, value: 1 }], 'varname must be one of');
  rejects([{ year: 2027, value: 1 }], 'varname must be one of');
});

test('rejects years outside the editable range', () => {
  rejects([{ varname: 'ns', year: 2024, value: 1 }], 'not an editable estimate year');
  rejects([{ varname: 'ns', year: 2030, value: 1 }], 'not an editable estimate year');
  // A history year is read-only context, not an editable cell.
  rejects([{ varname: 'ns', year: 2023, value: 1 }], 'not an editable estimate year');
});

test('rejects non-integer and non-numeric years', () => {
  rejects([{ varname: 'ns', year: 2027.5, value: 1 }], 'not an editable estimate year');
  rejects([{ varname: 'ns', year: '2027', value: 1 }], 'not an editable estimate year');
});

test('rejects values that are not finite numbers', () => {
  rejects([{ varname: 'ns', year: 2027, value: Number.NaN }], 'must be a finite number');
  rejects([{ varname: 'ns', year: 2027, value: Infinity }], 'must be a finite number');
  rejects([{ varname: 'ns', year: 2027, value: '21000' }], 'must be a finite number');
  rejects([{ varname: 'ebit', year: 2027, value: null }], 'must be a finite number');
});

test('rejects non-positive net sales but allows negative EBIT', () => {
  rejects([{ varname: 'ns', year: 2027, value: 0 }], 'must be positive');
  rejects([{ varname: 'ns', year: 2027, value: -5 }], 'must be positive');
  // A loss-making forecast is a legitimate thing for a customer to model.
  assert.doesNotThrow(() => validateEstimateEdits([{ varname: 'ebit', year: 2027, value: -120 }], YEARS));
});

test('rejects the same cell submitted twice', () => {
  rejects(
    [{ varname: 'ns', year: 2027, value: 1 }, { varname: 'ns', year: 2027, value: 2 }],
    'duplicate value for ns:2027',
  );
});

test('the same year for different varnames is not a duplicate', () => {
  assert.doesNotThrow(() => validateEstimateEdits([
    { varname: 'ns', year: 2027, value: 21000 },
    { varname: 'ebit', year: 2027, value: 900 },
  ], YEARS));
});
