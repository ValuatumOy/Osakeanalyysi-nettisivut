import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dispatchReportPages } = require('../../server/report-page-dispatch.js');
const TOKEN = 'mock-dispatch-token';
const URL = 'https://api.github.com/repos/ValuatumOy/Osakeanalyysi-nettisivut/actions/workflows/report-pages-sync.yml/dispatches';
const forbidden = () => { throw new Error('Unexpected external call'); };

test('an unconfigured environment skips without touching AWS or GitHub', async () => {
  assert.deepEqual(await dispatchReportPages({ env: {}, ssmClient: { send: forbidden }, fetchImpl: forbidden }), {
    dispatched: false, reason: 'unconfigured',
  });
});

for (const [stage, ref] of [['prod', 'main'], ['test', 'staging']]) {
  test(`${stage} dispatch uses only the matching branch and the exact repository workflow`, async () => {
    const result = await dispatchReportPages({
      env: { STAGE: stage, REPORT_PAGES_DISPATCH_TOKEN: TOKEN },
      ssmClient: { send: forbidden },
      fetchImpl: async (url, options) => {
        assert.equal(url, URL);
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(options.headers.Accept, 'application/vnd.github+json');
        assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
        assert.deepEqual(JSON.parse(options.body), { ref });
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        return { ok: true, status: 204 };
      },
    });
    assert.deepEqual(result, { dispatched: true, ref });
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  });
}

test('SSM reads only the dispatch SecureString lazily, accepting GitHub 200 success', async () => {
  let lookups = 0;
  const result = await dispatchReportPages({
    env: { STAGE: 'test', SECRETS_SSM_PREFIX: '/aiequityreports/test/' },
    ssmClient: { send: async (command, options) => {
      lookups++;
      assert.deepEqual(command.input, { Name: '/aiequityreports/test/report-pages-dispatch-token', WithDecryption: true });
      assert.equal(options.abortSignal.aborted, false);
      return { Parameter: { Value: TOKEN } };
    } },
    fetchImpl: async (_url, options) => {
      assert.equal(lookups, 1);
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(result, { dispatched: true, ref: 'staging' });
});

test('missing or empty SSM tokens skip GitHub with a clear result', async () => {
  for (const send of [
    async () => { throw Object.assign(new Error(TOKEN), { name: 'ParameterNotFound' }); },
    async () => ({}),
    async () => ({ Parameter: { Value: ' ' } }),
  ]) {
    assert.deepEqual(await dispatchReportPages({
      env: { SECRETS_SSM_PREFIX: '/aiequityreports/prod' }, ssmClient: { send }, fetchImpl: forbidden,
    }), { dispatched: false, reason: 'missing-token' });
  }
});

test('SSM failures expose neither SDK messages nor the token', async () => {
  await assert.rejects(dispatchReportPages({
    env: { SECRETS_SSM_PREFIX: '/aiequityreports/prod' },
    ssmClient: { send: async () => { throw new Error(TOKEN); } }, fetchImpl: forbidden,
  }), { message: 'Report page dispatch failed (SSM token lookup).' });
});

test('GitHub failures expose only status, without reading a potentially sensitive body', async () => {
  for (const status of [401, 403, 404, 422, 500]) {
    await assert.rejects(dispatchReportPages({
      env: { REPORT_PAGES_DISPATCH_TOKEN: TOKEN },
      fetchImpl: async () => ({ ok: false, status, text: forbidden, json: forbidden }),
    }), { message: `Report page dispatch failed (GitHub HTTP ${status}).` });
  }
});

test('network failures expose neither request headers nor upstream messages', async () => {
  await assert.rejects(dispatchReportPages({
    env: { REPORT_PAGES_DISPATCH_TOKEN: TOKEN },
    fetchImpl: async () => { throw new Error(`Authorization: Bearer ${TOKEN}`); },
  }), { message: 'Report page dispatch failed (GitHub request).' });
});

test('the timeout bounds both the SSM lookup and GitHub request', async () => {
  const untilAborted = signal => new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(new Error(TOKEN));
    signal.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true });
  });
  await assert.rejects(dispatchReportPages({
    env: { SECRETS_SSM_PREFIX: '/aiequityreports/test' }, timeoutMs: 20,
    ssmClient: { send: (_command, options) => untilAborted(options.abortSignal) }, fetchImpl: forbidden,
  }), { message: 'Report page dispatch timed out.' });
  await assert.rejects(dispatchReportPages({
    env: { REPORT_PAGES_DISPATCH_TOKEN: TOKEN }, timeoutMs: 20,
    fetchImpl: (_url, options) => untilAborted(options.signal),
  }), { message: 'Report page dispatch timed out.' });
});

test('an unknown stage cannot accidentally dispatch production', async () => {
  await assert.rejects(dispatchReportPages({
    env: { STAGE: 'staging', REPORT_PAGES_DISPATCH_TOKEN: TOKEN }, fetchImpl: forbidden,
  }), { message: 'Report page dispatch: unsupported stage.' });
});
