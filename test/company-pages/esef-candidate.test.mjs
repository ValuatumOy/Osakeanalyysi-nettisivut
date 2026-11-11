import assert from 'node:assert/strict';
import test from 'node:test';
import { extractEsefCandidate } from '../../scripts/company-pages/esef-candidate.mjs';

const lei = '213800QRC7LNX935OZ09';
const options = { lei, currency: 'EUR', periodStart: '2025-01-01', periodEnd: '2025-12-31' };
const namespaces = {
  standard: 'https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full',
  iso: 'http://www.xbrl.org/2003/iso4217',
  lei: 'http://standards.iso.org/iso/17442',
  custom: 'https://example.com/company',
};
const annual = '2025-01-01T00:00:00/2026-01-01T00:00:00';
const instant = '2026-01-01T00:00:00';
function fact(concept, value, period = annual, overrides = {}) {
  return { value, dimensions: { concept, entity: `lei:${lei}`, period, unit: 'iso:EUR', ...overrides } };
}
function document(facts) { return { documentInfo: { documentType: 'https://xbrl.org/2021/xbrl-json', namespaces }, facts }; }

test('extracts the annual statement and the end-exclusive balance-sheet instant', () => {
  const result = extractEsefCandidate(document({
    revenue: fact('standard:Revenue', '3877000000.0'),
    ebit: fact('standard:ProfitLossFromOperatingActivities', '178000000'),
    earnings: fact('standard:ProfitLossAttributableToOwnersOfParent', '28000000'),
    equity: fact('standard:EquityAttributableToOwnersOfParent', '2741000000', instant),
    previousEquity: fact('standard:EquityAttributableToOwnersOfParent', '3085000000', '2025-01-01T00:00:00'),
    quarter: fact('standard:Revenue', '999', '2025-10-01T00:00:00/2026-01-01T00:00:00'),
    segment: fact('standard:Revenue', '999', annual, { 'custom:OperatingSegments': 'custom:Segment' }),
    adjusted: fact('custom:ProfitLossFromOperatingActivitiesBeforeValueAdjustment', '570000000'),
  }), options);
  assert.deepEqual(result.valuesInCurrencyUnits, {
    revenue: '3877000000.0', ebit: '178000000', netEarnings: '28000000', bookValue: '2741000000',
  });
  assert.match(result.note, /Unreviewed candidate/);
});

test('allows equal numeric duplicates but refuses conflicting facts', () => {
  const equal = document({ a: fact('standard:Revenue', '1000.0'), b: fact('standard:Revenue', '1e3') });
  assert.equal(extractEsefCandidate(equal, options).valuesInCurrencyUnits.revenue, '1e3');
  const conflict = document({ a: fact('standard:Revenue', '1000'), b: fact('standard:Revenue', '1001') });
  assert.throws(() => extractEsefCandidate(conflict, options), /conflicting facts/);
  const nilConflict = document({ a: fact('standard:Revenue', null), b: fact('standard:Revenue', '1000') });
  assert.throws(() => extractEsefCandidate(nilConflict, options), /conflicting facts/);
  assert.equal(extractEsefCandidate(document({ a: fact('standard:Revenue', null) }), options).valuesInCurrencyUnits.revenue, null);
});

test('refuses a different entity, currency or invalid fiscal date', () => {
  const wrongEntity = document({ a: fact('standard:Revenue', '100', annual, { entity: 'lei:12345678901234567890' }) });
  const wrongCurrency = document({ a: fact('standard:Revenue', '100', annual, { unit: 'iso:SEK' }) });
  assert.throws(() => extractEsefCandidate(wrongEntity, options), /unexpected filing entity/);
  assert.throws(() => extractEsefCandidate(wrongCurrency, options), /unexpected reporting currency/);
  assert.throws(() => extractEsefCandidate(wrongCurrency, { ...options, periodEnd: '2025-02-29' }), /Invalid fiscal period date/);
  assert.throws(() => extractEsefCandidate({ documentInfo: { namespaces }, facts: {} }, options), /Invalid xBRL-JSON document/);
});

test('rejects mismatched annual starts and JSON numbers that may already be rounded', () => {
  const mismatch = document({
    revenue: fact('standard:Revenue', '10', '2025-01-10T00:00:00/2026-01-01T00:00:00'),
    ebit: fact('standard:ProfitLossFromOperatingActivities', '2'),
  });
  assert.throws(() => extractEsefCandidate(mismatch, options), /conflicting annual period start/);
  const rounded = document({ revenue: fact('standard:Revenue', 9007199254740993) });
  assert.throws(() => extractEsefCandidate(rounded, options), /numeric facts must be strings/);
  assert.throws(() => extractEsefCandidate(rounded, { ...options, periodStart: '2025-07-01' }), /annual duration/);
});

test('keeps missing fields unavailable and never substitutes adjusted operating profit', () => {
  const data = document({
    a: fact('standard:Revenue', '100'),
    b: fact('custom:ProfitLossFromOperatingActivitiesBeforeAdjustments', '999'),
    c: fact('standard:ProfitLossFromOperatingActivities', '123', annual, { 'custom:Axis': 'custom:Member' }),
  });
  assert.deepEqual(extractEsefCandidate(data, options).valuesInCurrencyUnits, {
    revenue: '100', ebit: null, netEarnings: null, bookValue: null,
  });
  assert.throws(() => extractEsefCandidate(document({ b: data.facts.b }), options), /No supported facts/);
});
