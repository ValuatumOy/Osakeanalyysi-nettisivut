// Regression guard: the catalog client must actually reach the live catalog API.
// It previously short-circuited to a bundled static list, which silently served a
// stale catalog in production while the live-fetch code below it was never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getCatalogReport, getCatalogReports, recordCatalogPurchase } = require('../../server/catalog-client.js');

// recordCatalogPurchase lazy-requires server/email.js only on final failure to
// send the admin alert; stub it so tests never touch SES.
const EMAIL_ID = require.resolve('../../server/email.js');
const adminAlerts = [];
require.cache[EMAIL_ID] = {
  id: EMAIL_ID,
  filename: EMAIL_ID,
  loaded: true,
  exports: { sendAdminAlert: async (subject, lines) => { adminAlerts.push({ subject, lines }); } },
};

const LIVE_REPORT = {
  id: 'puuilooyj-29072026',
  companyName: 'Puuilo Oyj',
  name: 'Puuilo Oyj',
  ticker: 'PUUILO.HE',
  exchange: 'Helsinki',
  reportDate: '2026-07-29',
  reportDateLabel: '29 July 2026',
  fileName: 'PuuiloOyj_29072026.pdf',
  pdfUrl: 'https://files.valuatum.com/reports/pdfs/PuuiloOyj_29072026.pdf',
  reportType: 'existing',
  availability: 'available',
  price: 4.99,
};

function withCatalogApi(handler, run) {
  const previousFetch = globalThis.fetch;
  const previousBase = process.env.CATALOG_API_URL;
  const previousSecret = process.env.CATALOG_SYNC_SECRET;
  const calls = [];

  process.env.CATALOG_API_URL = 'https://files.valuatum.com';
  process.env.CATALOG_SYNC_SECRET = 'test-sync-secret';
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };

  return (async () => {
    try {
      return await run(calls);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBase === undefined) delete process.env.CATALOG_API_URL;
      else process.env.CATALOG_API_URL = previousBase;
      if (previousSecret === undefined) delete process.env.CATALOG_SYNC_SECRET;
      else process.env.CATALOG_SYNC_SECRET = previousSecret;
    }
  })();
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test('getCatalogReports calls the live catalog API', async () => {
  await withCatalogApi(
    () => jsonResponse({ reports: [LIVE_REPORT] }),
    async (calls) => {
      const reports = await getCatalogReports();
      assert.deepEqual(calls.map(call => call.url), ['https://files.valuatum.com/api/reports']);
      assert.equal(reports.length, 1);
      assert.equal(reports[0].id, 'puuilooyj-29072026');
      assert.equal(reports[0].pdfUrl, LIVE_REPORT.pdfUrl);
    },
  );
});

test('getCatalogReport calls the live catalog API for a single report', async () => {
  await withCatalogApi(
    () => jsonResponse({ report: LIVE_REPORT }),
    async (calls) => {
      const report = await getCatalogReport('puuilooyj-29072026');
      assert.deepEqual(calls.map(call => call.url), ['https://files.valuatum.com/api/reports/puuilooyj-29072026']);
      assert.equal(report.id, 'puuilooyj-29072026');
      assert.equal(report.ticker, 'PUUILO.HE');
    },
  );
});

test('a failing live catalog falls back locally instead of throwing', async () => {
  await withCatalogApi(
    () => jsonResponse({ error: 'boom' }, false, 500),
    async () => {
      const reports = await getCatalogReports();
      assert.ok(Array.isArray(reports), 'expected an array rather than a thrown error');
    },
  );
});

test('a paid purchase syncs to the catalog API with the sync bearer', async () => {
  await withCatalogApi(
    () => jsonResponse({ ok: true }),
    async (calls) => {
      await recordCatalogPurchase({ type: 'fresh', sessionId: 'cs_1', companyName: 'Neste' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://files.valuatum.com/api/report-purchases');
      assert.equal(calls[0].options.headers.Authorization, 'Bearer test-sync-secret');
    },
  );
});

// The plan §2.3 companion fix: a failing purchase sync must be LOUD. The old
// behavior silently fell back to Vercel's ephemeral disk, losing paid fresh
// orders with only a console.warn.
test('a failing purchase sync retries, alerts the admin, and throws — no silent fallback', async () => {
  adminAlerts.length = 0;
  await withCatalogApi(
    () => jsonResponse({ error: 'backend down' }, false, 502),
    async (calls) => {
      await assert.rejects(
        () => recordCatalogPurchase({ type: 'fresh', sessionId: 'cs_2', companyName: 'Neste' }),
        /Catalog purchase sync failed after 3 attempts/,
      );
      assert.equal(calls.length, 3, 'sync is retried before giving up');
      assert.equal(adminAlerts.length, 1, 'admin is alerted on final failure');
      assert.match(adminAlerts[0].subject, /Purchase sync/i);
    },
  );
});

test('reports from the live catalog keep the ready-report price', async () => {
  await withCatalogApi(
    () => jsonResponse({ reports: [LIVE_REPORT, { ...LIVE_REPORT, id: 'free-01062026', price: 0 }] }),
    async () => {
      const [paid, free] = await getCatalogReports();
      assert.equal(paid.price, 20);
      assert.equal(paid.isFree, false);
      assert.equal(free.price, 0);
      assert.equal(free.isFree, true);
    },
  );
});
