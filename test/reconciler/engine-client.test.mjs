import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// engine-client.js reads its config at module load time and signs every call
// with aws4fetch, which hands the signed Request to the global fetch. So each
// case loads it with a fresh env and dummy keys, and swaps the global fetch for
// a stub that records the request — nothing leaves the machine.
const require = createRequire(import.meta.url);
const ENGINE_ID = require.resolve('../../server/engine-client.js');

const ENV = {
  PDF_ENGINE_URL: 'https://engine.test',
  AWS_INVOKER_ACCESS_KEY_ID: 'AKIDTEST',
  AWS_INVOKER_SECRET_ACCESS_KEY: 'secret',
};

function loadEngine(t) {
  const savedEnv = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, ENV);
  const requests = [];
  globalThis.fetch = async (request) => {
    requests.push({ url: request.url, method: request.method, body: await request.text() });
    return new Response(JSON.stringify({ jobId: 'job_child' }), { status: 202 });
  };
  t.after(() => {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[ENGINE_ID];
  });
  delete require.cache[ENGINE_ID];
  return { engine: require(ENGINE_ID), requests };
}

test('submitRevision sends endUserEmail with an estimates revision', async (t) => {
  const { engine, requests } = loadEngine(t);

  const result = await engine.submitRevision({ parentJobId: 'job_base', comments: 'raise 2027 sales', endUserEmail: 'buyer@example.com' });

  assert.deepEqual(result, { jobId: 'job_child' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://engine.test/jobs/job_base/revisions');
  assert.equal(requests[0].method, 'POST');
  const body = JSON.parse(requests[0].body);
  assert.equal(body.scope, 'estimates');
  assert.equal(body.endUserEmail, 'buyer@example.com');
  assert.equal(body.comments, 'raise 2027 sales');
});

test('submitRevision leaves endUserEmail out when there is none', async (t) => {
  const { engine, requests } = loadEngine(t);

  await engine.submitRevision({ parentJobId: 'job_base', comments: 'raise 2027 sales' });
  await engine.submitRevision({ parentJobId: 'job_base', comments: 'raise 2027 sales', endUserEmail: '' });

  for (const request of requests) {
    assert.equal('endUserEmail' in JSON.parse(request.body), false);
  }
});

test('submitRevision leaves endUserEmail out of revisions that write no model', async (t) => {
  const { engine, requests } = loadEngine(t);

  await engine.submitRevision({
    parentJobId: 'job_base', comments: 'write it on my assumptions', scope: 'narrative',
    valuationOverrides: { 'robotaxi|bull': { probabilityPct: 40 } }, endUserEmail: 'buyer@example.com',
  });
  await engine.submitRevision({ parentJobId: 'job_base', comments: 'tighten the summary', scope: 'content', endUserEmail: 'buyer@example.com' });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal('endUserEmail' in JSON.parse(request.body), false);
  }
});
