// fetchEstimateSeries against the real /rest/modeldata response for Neste
// (fid 10377, recorded from trunkdev), trimmed to the ns/ebit variables.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { jsonResponse, stubFetch } from './helpers.mjs';

const require = createRequire(import.meta.url);
const {
  fetchEstimateSeries,
  resolveFollowedModelId,
  estimatesConfigured,
  EstimatesError,
} = require('../../server/estimates.js');

const NESTE = JSON.parse(
  fs.readFileSync(new URL('./fixtures/modeldata-neste.json', import.meta.url), 'utf8'),
);

function clone() {
  return JSON.parse(JSON.stringify(NESTE));
}

test('reads the ns/ebit grid out of a real model-data response', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, NESTE));
  const series = await fetchEstimateSeries(10377);

  assert.equal(series.fid, 10377);
  assert.equal(series.currency, 'EUR');
  assert.equal(series.companyName, 'Neste');
  assert.equal(series.firstEstimateYear, 2025);

  // Three years of actualized context, then the editable range.
  assert.deepEqual(series.historyYears, [2022, 2023, 2024]);
  assert.deepEqual(series.estimateYears, [2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033]);

  // Absolute millions in the model currency, straight from the dataMap.
  assert.equal(series.series.ns['2026'], 19586);
  assert.equal(series.series.ebit['2026'], 524);
  assert.equal(series.series.ns['2024'], 20635);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://trunk.test/rest/modeldata');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    fids: [10377],
    varPoses: [],
    includeHistoryData: true,
    includeEstimates: true,
  });
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
});

test('caps the editable range at nine years even though the model runs to 2035', async (t) => {
  stubFetch(t, () => jsonResponse(200, NESTE));
  const series = await fetchEstimateSeries(10377);
  assert.equal(series.estimateYears.length, 9);
  assert.equal(series.estimateYears.at(-1), 2033);
  // Years past the horizon are not offered at all.
  assert.equal('2035' in series.series.ns, false);
});

test('keeps the estimate range contiguous when the model skips a year', async (t) => {
  const gappy = clone();
  delete gappy['10377'].dataMap['2027'];
  stubFetch(t, () => jsonResponse(200, gappy));

  const series = await fetchEstimateSeries(10377);
  // 2027 stays editable — otherwise the contiguous fill on import would demand
  // a value for a year the customer was never allowed to set.
  assert.ok(series.estimateYears.includes(2027));
  assert.equal(series.series.ns['2027'], null);
});

test('a missing variable becomes null rather than undefined', async (t) => {
  const partial = clone();
  delete partial['10377'].dataMap['2026'].ebit;
  stubFetch(t, () => jsonResponse(200, partial));

  const series = await fetchEstimateSeries(10377);
  assert.equal(series.series.ebit['2026'], null);
  assert.equal(series.series.ns['2026'], 19586);
});

test('quarterly and terminal poses are ignored', async (t) => {
  stubFetch(t, () => jsonResponse(200, NESTE));
  const series = await fetchEstimateSeries(10377);
  const years = [...series.historyYears, ...series.estimateYears];
  assert.ok(years.every(y => y >= 2022 && y <= 2033));
  assert.equal(Object.keys(series.series.ns).length, years.length);
});

test('accepts the lowercase currentyear spelling', async (t) => {
  const lower = clone();
  lower['10377'].currentyear = lower['10377'].currentYear;
  delete lower['10377'].currentYear;
  stubFetch(t, () => jsonResponse(200, lower));

  const series = await fetchEstimateSeries(10377);
  assert.equal(series.firstEstimateYear, 2025);
});

test('surfaces an upstream failure as a 502-class error', async (t) => {
  stubFetch(t, () => jsonResponse(500, { error: 'model data unavailable' }));
  await assert.rejects(
    fetchEstimateSeries(10377),
    err => err instanceof EstimatesError
      && err.status === 502
      && err.message.includes('model data unavailable'),
  );
});

test('errors when the response carries no entry for the requested fid', async (t) => {
  stubFetch(t, () => jsonResponse(200, {}));
  await assert.rejects(
    fetchEstimateSeries(10377),
    err => err instanceof EstimatesError && err.message.includes('no model data found for fid 10377'),
  );
});

test('errors when the model has no estimate years', async (t) => {
  const historyOnly = clone();
  for (const pos of Object.keys(historyOnly['10377'].dataMap)) {
    if (/^\d{4}$/.test(pos) && Number(pos) >= 2025) delete historyOnly['10377'].dataMap[pos];
  }
  stubFetch(t, () => jsonResponse(200, historyOnly));

  await assert.rejects(
    fetchEstimateSeries(10377),
    err => err instanceof EstimatesError && err.message.includes('no estimate years'),
  );
});

test('errors when the model has no currentYear', async (t) => {
  const undated = clone();
  delete undated['10377'].currentYear;
  stubFetch(t, () => jsonResponse(200, undated));

  await assert.rejects(
    fetchEstimateSeries(10377),
    err => err instanceof EstimatesError && err.message.includes('no currentYear'),
  );
});

test('errors when the trunk URL and token are not configured', async (t) => {
  stubFetch(t, () => jsonResponse(200, NESTE));
  delete process.env.VALUATUM_TRUNK_URL;
  delete process.env.WISDOM_REST_BASE;

  await assert.rejects(
    fetchEstimateSeries(10377),
    err => err instanceof EstimatesError && err.message.includes('not configured'),
  );
});

// ── resolveFollowedModelId ───────────────────────────────────────────────────

// The real /rest/company?ticker=NESTE response: two company rows, each with its
// own model — which is why the exact ticker has to win.
const COMPANIES = [
  { companyId: 351, companyName: 'Neste', ticker: 'NESTE', models: [{ followedModelId: 730, analystName: 'Petri Gostowski' }] },
  { companyId: 3630, companyName: 'Neste', ticker: 'NESTE.HE', models: [{ followedModelId: 10377, analystName: 'ValuatumDataSources' }] },
];

test('prefers the company whose ticker matches exactly', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, COMPANIES));
  assert.equal(await resolveFollowedModelId('NESTE.HE'), 10377);
  assert.equal(calls[0].url, 'https://trunk.test/rest/company?ticker=NESTE.HE');

  assert.equal(await resolveFollowedModelId('NESTE'), 730);
});

test('ticker matching is case-insensitive', async (t) => {
  stubFetch(t, () => jsonResponse(200, COMPANIES));
  assert.equal(await resolveFollowedModelId('neste.he'), 10377);
});

test('prefers the configured analyst when one company has several models', async (t) => {
  stubFetch(t, () => jsonResponse(200, [{
    ticker: 'ACME.HE',
    models: [
      { followedModelId: 111, analystName: 'Someone Else' },
      { followedModelId: 222, analystName: 'ValuatumDataSources' },
    ],
  }]));
  assert.equal(await resolveFollowedModelId('ACME.HE'), 222);
});

test('falls back to the first model when the preferred analyst has none', async (t) => {
  stubFetch(t, () => jsonResponse(200, [{
    ticker: 'ACME.HE',
    models: [{ followedModelId: 111, analystName: 'Someone Else' }],
  }]));
  assert.equal(await resolveFollowedModelId('ACME.HE'), 111);
});

test('falls back to the first company when no ticker matches exactly', async (t) => {
  stubFetch(t, () => jsonResponse(200, COMPANIES));
  assert.equal(await resolveFollowedModelId('NESTE.XX'), 730);
});

test('errors on an unknown ticker, a model-less company and a bad model id', async (t) => {
  let payload = [];
  stubFetch(t, () => jsonResponse(200, payload));

  await assert.rejects(
    resolveFollowedModelId('NOPE'),
    err => err instanceof EstimatesError && err.message.includes('no company found'),
  );

  payload = [{ ticker: 'NOPE', models: [] }];
  await assert.rejects(
    resolveFollowedModelId('NOPE'),
    err => err instanceof EstimatesError && err.message.includes('no models found'),
  );

  payload = [{ ticker: 'NOPE', models: [{ followedModelId: 0 }] }];
  await assert.rejects(
    resolveFollowedModelId('NOPE'),
    err => err instanceof EstimatesError && err.message.includes('invalid model id'),
  );
});

test('a blank ticker is a 400, not an upstream call', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, COMPANIES));
  await assert.rejects(
    resolveFollowedModelId(''),
    err => err instanceof EstimatesError && err.status === 400,
  );
  assert.equal(calls.length, 0);
});

// ── feature gate ─────────────────────────────────────────────────────────────

test('the gate needs both the flag and somewhere to talk to', async (t) => {
  stubFetch(t, () => jsonResponse(200, COMPANIES));

  // stubFetch sets the URL and token; the flag is still missing.
  assert.equal(estimatesConfigured(), false);

  for (const on of ['true', 'TRUE', '1', 'yes', 'on']) {
    process.env.FORECAST_GATE_ENABLED = on;
    assert.equal(estimatesConfigured(), true, `expected ${on} to enable the gate`);
  }
  for (const off of ['false', '0', 'no', '']) {
    process.env.FORECAST_GATE_ENABLED = off;
    assert.equal(estimatesConfigured(), false, `expected ${off} to leave the gate off`);
  }

  process.env.FORECAST_GATE_ENABLED = 'true';
  delete process.env.VALUATUM_TRUNK_URL;
  assert.equal(estimatesConfigured(), false);
});

test('the gate falls back to the shared Wisdom settings when the trunk ones are unset', async (t) => {
  stubFetch(t, () => jsonResponse(200, COMPANIES), { FORECAST_GATE_ENABLED: 'true' });
  delete process.env.VALUATUM_TRUNK_URL;
  delete process.env.VALUATUM_TRUNK_TOKEN;

  assert.equal(estimatesConfigured(), false);

  process.env.WISDOM_REST_BASE = 'https://wisdom.test';
  process.env.WISDOM_API_TOKEN = 'wisdom-token';
  assert.equal(estimatesConfigured(), true);
});

test('the fallback settings are what the request actually uses', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, COMPANIES), {
    WISDOM_REST_BASE: 'https://wisdom.test',
    WISDOM_API_TOKEN: 'wisdom-token',
  });
  delete process.env.VALUATUM_TRUNK_URL;
  delete process.env.VALUATUM_TRUNK_TOKEN;

  await resolveFollowedModelId('NESTE.HE');
  assert.equal(calls[0].url, 'https://wisdom.test/rest/company?ticker=NESTE.HE');
  assert.equal(calls[0].init.headers.authorization, 'Bearer wisdom-token');
});
