import test from 'node:test';
import assert from 'node:assert/strict';

test('fresh catalog fetches bypass cached URLs and preserve production/test selection', async t => {
  const oldStage = process.env.REPORT_PAGES_STAGE;
  t.after(() => {
    if (oldStage === undefined) delete process.env.REPORT_PAGES_STAGE;
    else process.env.REPORT_PAGES_STAGE = oldStage;
  });

  for (const [stage, host] of [['prod', 'www.aiequityreports.com'], ['test', 'test.aiequityreports.com']]) {
    process.env.REPORT_PAGES_STAGE = stage;
    const { fetchLiveCatalog, CATALOG_API_URL } = await import(`../../scripts/live-catalog.mjs?test=${stage}`);
    assert.equal(CATALOG_API_URL, `https://${host}/api/reports`);
    const urls = [];
    const reports = [{ id: 'newly-delivered' }];
    const mock = t.mock.method(globalThis, 'fetch', async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, `https://${host}`);
      assert.equal(url.pathname, '/api/reports');
      assert.ok(url.searchParams.get('_report_pages_fresh'));
      assert.equal(options.cache, 'no-store');
      urls.push(input);
      return { ok: true, json: async () => ({ reports }) };
    });
    assert.deepEqual(await fetchLiveCatalog(), reports);
    assert.deepEqual(await fetchLiveCatalog(), reports);
    assert.notEqual(urls[0], urls[1]);
    mock.mock.restore();
  }
});

test('catalog HTTP errors and malformed data still fail instead of baking stale pages', async t => {
  const { fetchLiveCatalog } = await import('../../scripts/live-catalog.mjs');
  const mock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(fetchLiveCatalog(), /Catalog fetch failed \(HTTP 503\)/);
  mock.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ reports: null }) }));
  await assert.rejects(fetchLiveCatalog(), /Unexpected catalog payload/);
  mock.mock.mockImplementation(async () => ({ ok: true, json: async () => [{ id: 'array-payload' }] }));
  assert.deepEqual(await fetchLiveCatalog(), [{ id: 'array-payload' }]);
});
