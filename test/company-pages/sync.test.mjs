import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderCompanyPage } from '../../scripts/company-pages/render-company-page.mjs';
import { syncCompanyPages } from '../../scripts/sync-company-pages.mjs';

const NOW = new Date('2026-11-12T06:00:00Z');
const ISIN = 'FI0009000000';
const base = { bv: 400, adj_share_price_a: 12.34, ns: 1_200, ebit: 110, net_earnings: 80, market_cap_ye: 2_500 };

function client(data, { year = 2026, isin = ISIN } = {}) {
  return {
    async findCompanyByTicker(ticker) {
      if (ticker !== 'TEST.HE') throw new Error(`No exact Wisdom company match found for ticker ${ticker}`);
      return { companyId: 1, companyName: 'Test Oyj', companyCode: isin, ticker, industry: 'Machinery', models: [{ followedModelId: 10 }] };
    },
    async getLatestActualModels() {
      return [{ companyId: 1, followedModelId: 10, orderNo: 1, currency: 'EUR', currentYear: year, dataMap: { [year - 1]: data } }];
    },
  };
}

async function site(html) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'company-sync-'));
  await fs.mkdir(path.join(dir, 'reports'));
  await fs.mkdir(path.join(dir, 'company-content', 'reviews'), { recursive: true });
  await fs.writeFile(path.join(dir, 'reports', 'test-equity-report.html'), html);
  await fs.writeFile(path.join(dir, 'sitemap.xml'), '<urlset><url><loc>https://www.aiequityreports.com/reports/test-equity-report.html</loc><lastmod>2026-01-01</lastmod></url></urlset>');
  return dir;
}

function page(data = base, extra = {}) {
  const metrics = { bookValue: data.bv, sharePrice: data.adj_share_price_a, revenue: data.ns, ebit: data.ebit, netEarnings: data.net_earnings, marketCap: data.market_cap_ye };
  return renderCompanyPage({
    companyName: 'Test Oyj', companyCode: ISIN, ticker: 'TEST.HE', industry: 'Machinery', currency: 'EUR', marketCurrency: 'EUR',
    financialYear: 2025, metrics, profile: 'Test makes machines.', dataUpdated: '2026-07-01', ...extra,
  }, [], new Date('2026-07-01'), { readyReport: { reportDate: '2026-07-01', isFree: true } });
}

const read = (dir, file) => fs.readFile(path.join(dir, file), 'utf8');

test('a page that already shows the model figures is left untouched', async () => {
  const dir = await site(page());
  const before = await read(dir, 'reports/test-equity-report.html');
  const { results } = await syncCompanyPages({ client: client(base), rootDir: dir, write: true, now: NOW });
  assert.equal(results[0].status, 'unchanged');
  assert.equal(await read(dir, 'reports/test-equity-report.html'), before);
});

test('small model changes are written, and a second run changes nothing', async () => {
  const dir = await site(page());
  const changed = { ...base, ebit: 115, ns: 1_210 };
  const first = await syncCompanyPages({ client: client(changed), rootDir: dir, write: true, now: NOW });
  assert.equal(first.results[0].status, 'update');
  const html = await read(dir, 'reports/test-equity-report.html');
  assert.match(html, /Valuatum's model shows revenue of EUR 1,210m and operating profit of EUR 115m/);
  assert.match(html, /Operating profit<\/span><span class="cp-v">EUR 115m/);
  assert.match(html, /Figures updated from Valuatum's financial model on 2026-11-12\./);
  assert.match(html, /"dateModified": "2026-11-12"/);
  assert.match(await read(dir, 'sitemap.xml'), /<lastmod>2026-11-12<\/lastmod>/);
  const second = await syncCompanyPages({ client: client(changed), rootDir: dir, write: true, now: NOW });
  assert.equal(second.results[0].status, 'unchanged');
});

test('a filing-reviewed page and its source are not overwritten by model figures', async () => {
  const reviewed = page()
    .replace(/For financial year 2025, Valuatum's model shows [^.]*\.\d*[^.]*\./, 'For financial year 2025, Test Oyj reported revenue of EUR 1,201.5m and operating profit of EUR 108.2m; the year-end share price was 12.34 EUR and market capitalisation was EUR 2,500.1m.')
    .replace(/<p class="cp-updated">[^<]*<\/p>/, '<p class="cp-updated">Figures checked against the annual report on 2026-11-11. Share price and market capitalisation are for the end of FY 2025.</p>')
    .replace(/<p>Financial figures are sourced from[^<]*?(?= See the)/, '<p>Available financial figures for FY 2025, including any year-end share price and market capitalisation, are sourced from Test Oyj\'s <a href="https://example.com/ar.pdf">annual report</a>. The auditor noted something.')
    .replace(/financial overview for 2025:[^"]*?\./g, 'financial overview for 2025: revenue and EBIT.');
  const dir = await site(reviewed);
  const { results } = await syncCompanyPages({ client: client(base), rootDir: dir, write: true, now: NOW });
  const html = await read(dir, 'reports/test-equity-report.html');
  assert.equal(results[0].status, 'skipped');
  assert.equal(results[0].reason, 'non-model source needs a person');
  assert.equal(html, reviewed);
});

test('a reviewed manifest protects the page even when the page uses model wording', async () => {
  const dir = await site(page());
  const reviewDir = path.join(dir, 'company-content', 'reviews');
  await fs.mkdir(reviewDir, { recursive: true });
  await fs.writeFile(path.join(reviewDir, 'review.json'), JSON.stringify({ pages: [{ path: 'reports/test-equity-report.html', values: { ebit: 110 } }] }));
  const before = await read(dir, 'reports/test-equity-report.html');
  const { results } = await syncCompanyPages({ client: client({ ...base, ebit: 115 }), rootDir: dir, write: true, now: NOW });
  assert.equal(results[0].reason, 'filing-reviewed page needs a person');
  assert.equal(await read(dir, 'reports/test-equity-report.html'), before);
});

test('large changes and N/A transitions are left for review', async () => {
  const cases = [
    { html: page(), model: { ...base, adj_share_price_a: 25 }, reason: /share price changes by more than 20%/ },
    { html: page(), model: { ...base, ebit: -110 }, reason: /operating profit changes by more than 20%/ },
    { html: page(), model: { ...base, net_earnings: 81 }, reason: /net earnings differs; check the model calculation/ },
    { html: page({ ...base, ebit: null }), model: base, reason: /operating profit changes to or from N\/A/ },
    { html: page(), model: { ...base, market_cap_ye: null }, reason: /market capitalisation changes to or from N\/A/ },
    { html: page({ ...base, ebit: 0 }), model: { ...base, ebit: 1 }, reason: /operating profit changes by more than 20%/ },
  ];
  for (const { html, model, reason } of cases) {
    const dir = await site(html);
    const { results } = await syncCompanyPages({ client: client(model), rootDir: dir, write: true, now: NOW });
    assert.equal(results[0].status, 'skipped');
    assert.match(results[0].reason, reason);
    assert.equal(await read(dir, 'reports/test-equity-report.html'), html);
  }
});

test('a listing outside current coverage is not updated', async () => {
  // Simulate a legacy page with a fresh-order button from before coverage gating.
  const html = page(base, { ticker: 'TEST.DE' }).replace('id="generate"', 'id="generate" data-generate-report');
  const dir = await site(html);
  const { results } = await syncCompanyPages({ client: client(base), rootDir: dir, write: true, now: NOW });
  assert.equal(results[0].reason, 'listing is outside current coverage');
  assert.equal(await read(dir, 'reports/test-equity-report.html'), html);
});

test('risky updates are skipped, not written', async () => {
  const cases = [
    [client(base, { isin: 'SE0000000000' }), /differs from page ISIN/],
    [client(base, { year: 2025 }), /older than page year/],
    [client(base, { year: 2027 }), /verify the filing/],
    [client({ ...base, ns: null }), /no revenue/],
  ];
  for (const [wisdom, reason] of cases) {
    const dir = await site(page());
    const before = await read(dir, 'reports/test-equity-report.html');
    const { results } = await syncCompanyPages({ client: wisdom, rootDir: dir, write: true, now: NOW });
    assert.equal(results[0].status, 'skipped');
    assert.match(results[0].reason, reason);
    assert.equal(await read(dir, 'reports/test-equity-report.html'), before);
  }
});

test('a new year needs a verified filing even after March', async () => {
  const dir = await site(page());
  const early = await syncCompanyPages({ client: client(base, { year: 2027 }), rootDir: dir, now: new Date('2027-02-10T06:00:00Z') });
  assert.match(early.results[0].reason, /verify the filing/);
  const later = await syncCompanyPages({ client: client(base, { year: 2027 }), rootDir: dir, now: new Date('2027-03-02T06:00:00Z') });
  assert.equal(later.results[0].status, 'skipped');
  assert.match(later.results[0].reason, /verify the filing/);
});

test('status pages are never touched', async () => {
  const historical = page().replace('<section class="report-full-section" id="metrics">', '<p><strong>Company status:</strong> Delisted.</p>\n<section class="report-full-section" id="metrics">');
  const dir = await site(historical);
  const { results } = await syncCompanyPages({ client: client({ ...base, ebit: 1 }), rootDir: dir, write: true, now: NOW });
  assert.equal(results[0].reason, 'company status page');
  assert.equal(await read(dir, 'reports/test-equity-report.html'), historical);
});

test('too many failed lookups abort the run without writing', async () => {
  const dir = await site(page().replaceAll('TEST.HE', 'MISSING.HE'));
  const before = await read(dir, 'reports/test-equity-report.html');
  const { aborted, results } = await syncCompanyPages({ client: client(base), rootDir: dir, write: true, now: NOW });
  assert.equal(aborted, true);
  assert.equal(results[0].status, 'error');
  assert.equal(await read(dir, 'reports/test-equity-report.html'), before);
});
