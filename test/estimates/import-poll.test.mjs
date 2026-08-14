import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fakeClock, jsonResponse, stubFetch } from './helpers.mjs';

const require = createRequire(import.meta.url);
const {
  submitForecastImport,
  pollForecastImport,
  generateEstimates,
  EstimatesError,
} = require('../../server/estimates.js');

const VALUES = [
  { varname: 'ns', year: 2025, value: 18487 },
  { varname: 'ns', year: 2026, value: 25000 },
];

// ── submit ───────────────────────────────────────────────────────────────────

test('submitting returns the job id and its first state', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(202, { jobId: 991, status: 'PENDING' }));
  const job = await submitForecastImport(10377, VALUES);

  assert.deepEqual(job, { jobId: 991, status: 'PENDING', resultFid: null, errorMessage: null });
  assert.equal(calls[0].url, 'https://trunk.test/rest/estimates/import');
  assert.deepEqual(JSON.parse(calls[0].init.body), { baseFid: 10377, values: VALUES });
});

test('an import that is already finished needs no extra round trip', async (t) => {
  stubFetch(t, () => jsonResponse(200, { jobId: 991, status: 'OK', resultFid: 10500 }));
  const job = await submitForecastImport(10377, VALUES);
  assert.equal(job.status, 'OK');
  assert.equal(job.resultFid, 10500);
});

test('a rejected import surfaces the upstream message', async (t) => {
  stubFetch(t, () => jsonResponse(400, { error: 'baseFid is not a followed model' }));
  await assert.rejects(
    submitForecastImport(10377, VALUES),
    err => err instanceof EstimatesError && err.message.includes('baseFid is not a followed model'),
  );
});

test('a submit response without a usable job id is an error', async (t) => {
  stubFetch(t, () => jsonResponse(202, { status: 'PENDING' }));
  await assert.rejects(
    submitForecastImport(10377, VALUES),
    err => err instanceof EstimatesError && err.message.includes('invalid jobId'),
  );
});

// ── poll ─────────────────────────────────────────────────────────────────────

test('polling a running job reports it as still running', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { jobId: 991, status: 'RUNNING' }));
  const job = await pollForecastImport(991);

  assert.equal(job.status, 'RUNNING');
  assert.equal(job.resultFid, null);
  assert.equal(calls[0].url, 'https://trunk.test/rest/estimates/imports/991');
  assert.equal(calls[0].init.method, 'GET');
});

test('a finished job yields the new fid', async (t) => {
  stubFetch(t, () => jsonResponse(200, { jobId: 991, status: 'OK', resultFid: 10500 }));
  const job = await pollForecastImport(991);
  assert.equal(job.status, 'OK');
  assert.equal(job.resultFid, 10500);
});

test('a failed job carries its error message', async (t) => {
  stubFetch(t, () => jsonResponse(200, { jobId: 991, status: 'ERROR', errorMessage: 'model locked' }));
  const job = await pollForecastImport(991);
  assert.equal(job.status, 'ERROR');
  assert.equal(job.errorMessage, 'model locked');
});

test('OK without a usable resultFid is an error, not a silent pass', async (t) => {
  stubFetch(t, () => jsonResponse(200, { jobId: 991, status: 'OK' }));
  await assert.rejects(
    pollForecastImport(991),
    err => err instanceof EstimatesError && err.message.includes('without a valid resultFid'),
  );
});

test('an unknown status is an error rather than an indefinite wait', async (t) => {
  stubFetch(t, () => jsonResponse(200, { jobId: 991, status: 'SLEEPING' }));
  await assert.rejects(
    pollForecastImport(991),
    err => err instanceof EstimatesError && err.message.includes('unknown status: SLEEPING'),
  );
});

test('a job that disappears mid-poll is an error', async (t) => {
  stubFetch(t, () => jsonResponse(404, {}));
  await assert.rejects(
    pollForecastImport(991),
    err => err instanceof EstimatesError && err.message.includes('disappeared while polling'),
  );
});

test('polling the wrong job never returns that job\'s result fid', async (t) => {
  stubFetch(t, () => jsonResponse(200, { jobId: 992, status: 'OK', resultFid: 10500 }));
  await assert.rejects(
    pollForecastImport(991),
    err => err instanceof EstimatesError && err.message.includes('wrong job (expected 991, got 992)'),
  );
});

test('a non-200 poll surfaces the upstream detail', async (t) => {
  stubFetch(t, () => jsonResponse(503, { message: 'trunk is restarting' }));
  await assert.rejects(
    pollForecastImport(991),
    err => err instanceof EstimatesError && err.message.includes('trunk is restarting'),
  );
});

test('a request timeout is reported as a timeout', async (t) => {
  stubFetch(t, () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  await assert.rejects(
    pollForecastImport(991),
    err => err instanceof EstimatesError && err.message.includes('timed out'),
  );
});

// The point of splitting submit from poll: a worker invocation that runs out of
// time resumes from the stored job id instead of importing a second time.
test('resuming from a stored job id never re-submits the import', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { jobId: 991, status: 'OK', resultFid: 10500 }));
  const job = await pollForecastImport(991);

  assert.equal(job.resultFid, 10500);
  assert.equal(calls.length, 1);
  assert.equal(calls.every(c => !c.url.endsWith('/rest/estimates/import')), true);
});

// ── generate ─────────────────────────────────────────────────────────────────

test('generation polls until the job finishes', async (t) => {
  const states = [
    jsonResponse(202, { jobId: 42, status: 'PENDING' }),
    jsonResponse(200, { jobId: 42, status: 'RUNNING' }),
    jsonResponse(200, { jobId: 42, status: 'OK' }),
  ];
  const calls = stubFetch(t, (_url, _init, n) => states[n - 1]);
  const clock = fakeClock();

  await generateEstimates(10377, clock);

  assert.equal(calls[0].url, 'https://trunk.test/rest/estimates/generate/10377');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[1].url, 'https://trunk.test/rest/estimates/jobs/42');
  assert.deepEqual(clock.slept, [10000, 10000]);
});

test('a failed generation throws with the upstream message', async (t) => {
  stubFetch(t, () => jsonResponse(200, { jobId: 42, status: 'ERROR', errorMessage: 'no data' }));
  await assert.rejects(
    generateEstimates(10377, fakeClock()),
    err => err instanceof EstimatesError && err.message.includes('no data'),
  );
});

test('a rejected generation request throws', async (t) => {
  stubFetch(t, () => jsonResponse(409, { error: 'model is locked' }));
  await assert.rejects(
    generateEstimates(10377, fakeClock()),
    err => err instanceof EstimatesError && err.message.includes('model is locked'),
  );
});

test('generation gives up at its deadline instead of polling forever', async (t) => {
  stubFetch(t, (_url, _init, n) => (
    n === 1
      ? jsonResponse(202, { jobId: 42, status: 'PENDING' })
      : jsonResponse(200, { jobId: 42, status: 'RUNNING' })
  ));
  const clock = fakeClock();

  await assert.rejects(
    generateEstimates(10377, clock),
    err => err instanceof EstimatesError && err.message.includes('timed out after 300s'),
  );
  // 300 s budget, 10 s between polls.
  assert.equal(clock.slept.length, 30);
});

test('generation polling the wrong job is an error', async (t) => {
  stubFetch(t, (_url, _init, n) => (
    n === 1
      ? jsonResponse(202, { jobId: 42, status: 'PENDING' })
      : jsonResponse(200, { jobId: 43, status: 'OK' })
  ));
  await assert.rejects(
    generateEstimates(10377, fakeClock()),
    err => err instanceof EstimatesError && err.message.includes('wrong job (expected 42, got 43)'),
  );
});
