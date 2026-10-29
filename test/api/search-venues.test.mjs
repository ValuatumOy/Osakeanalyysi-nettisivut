import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.WISDOM_API_TOKEN = 'test-token';
const { searchCompanies, venueOf } = require('../../server/search.js');

function wisdomReturns(rows, t) {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: true, status: 200, async json() { return rows; } });
}

test('venueOf reads the listing from the ticker suffix', () => {
  assert.equal(venueOf('UPM.HE'), 'HE');
  assert.equal(venueOf('TSLA'), 'US');
  assert.equal(venueOf('BRK-B'), 'US');
  assert.equal(venueOf('7203.T'), 'T');
});

test('search offers only US and Nordic/Baltic listings', async (t) => {
  wisdomReturns([
    { companyName: 'UPM', ticker: 'UPM.HE', companyCode: 'FI0009005987' },
    { companyName: 'Toyota Motor Corp.', ticker: '7203.T', companyCode: 'US8923313071' },
    { companyName: 'Barclays PLC', ticker: 'BARC.L' },
    { companyName: 'Tesla', ticker: 'TSLA' },
    { companyName: 'Volvo', ticker: 'VOLV-B.ST' },
    { companyName: 'Equinor', ticker: 'EQNR.OL' },
    { companyName: 'Novo Nordisk', ticker: 'NOVO-B.CO' },
    { companyName: 'Turkcell', ticker: 'TCELL.IS' },
  ], t);

  const tickers = (await searchCompanies('venue-test-1')).map((r) => r.ticker);

  assert.deepEqual(tickers, ['UPM.HE', 'TSLA', 'VOLV-B.ST', 'EQNR.OL', 'NOVO-B.CO']);
});

test('hidden listings do not use up the result limit', async (t) => {
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => ({ companyName: `Japan ${i}`, ticker: `${1000 + i}.T` })),
    { companyName: 'Nokia', ticker: 'NOKIA.HE' },
  ];
  wisdomReturns(rows, t);

  const result = await searchCompanies('venue-test-2');

  assert.deepEqual(result.map((r) => r.ticker), ['NOKIA.HE']);
});

test('SEARCH_TICKER_VENUES overrides the list', async (t) => {
  process.env.SEARCH_TICKER_VENUES = 'HE';
  t.after(() => { delete process.env.SEARCH_TICKER_VENUES; });
  wisdomReturns([{ ticker: 'UPM.HE' }, { ticker: 'TSLA' }], t);

  const result = await searchCompanies('venue-test-3');

  assert.deepEqual(result.map((r) => r.ticker), ['UPM.HE']);
});
