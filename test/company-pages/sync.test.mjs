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

test('changed model figures are written, and a second run changes nothing', async () => {
  const dir = await site(page());
  const changed = { ...base, ebit: -19.842, ns: 100.926 };
  const first = await syncCompanyPages({ client: client(changed), rootDir: dir, write: true, now: NOW });
  assert.equal(first.results[0].status, 'update');
  const html = await read(dir, 'reports/test-equity-report.html');
  assert.match(html, /Valuatum's model shows revenue of EUR 101m and operating profit of EUR -19.8m/);
  assert.match(html, /Operating profit<\/span><span class="cp-v">EUR -19.8m/);
  assert.match(html, /Figures updated from Valuatum's financial model on 2026-11-12\./);
  assert.match(html, /"dateModified": "2026-11-12"/);
  assert.match(await read(dir, 'sitemap.xml'), /<lastmod>2026-11-12<\/lastmod>/);
  const second = await syncCompanyPages({ client: client(changed), rootDir: dir, write: true, now: NOW });
  assert.equal(second.results[0].status, 'unchanged');
});

test('a filing-reviewed page returns to the model figures and source', async () => {
  const reviewed = page()
    .replace(/For financial year 2025, Valuatum's model shows [^.]*\.\d*[^.]*\./, 'For financial year 2025, Test Oyj reported revenue of EUR 1,201.5m and operating profit of EUR 108.2m; the year-end share price was 12.34 EUR and market capitalisation was EUR 2,500.1m.')
    .replace(/<p class="cp-updated">[^<]*<\/p>/, '<p class="cp-updated">Figures checked against the annual report on 2026-11-11. Share price and market capitalisation are for the end of FY 2025.</p>')
    .replace(/<p>Financial figures are sourced from[^<]*?(?= See the)/, '<p>Available financial figures for FY 2025, including any year-end share price and market capitalisation, are sourced from Test Oyj\'s <a href="https://example.com/ar.pdf">annual report</a>. The auditor noted something.')
    .replace(/financial overview for 2025:[^"]*?\./g, 'financial overview for 2025: revenue and EBIT.');
  const dir = await site(reviewed);
  await syncCompanyPages({ client: client(base), rootDir: dir, write: true, now: NOW });
  const html = await read(dir, 'reports/test-equity-report.html');
  assert.match(html, /Valuatum's model shows revenue of EUR 1,200m/);
  assert.doesNotMatch(html, /annual report|auditor/);
  assert.match(html, /<p>Financial figures are sourced from Valuatum's financial model for Test and represent financial year 2025\. See the/);
  assert.equal([...html.matchAll(/financial overview for 2025: revenue, EBIT, net earnings, book value, year-end share price and market capitalisation\./g)].length >= 3, true);
});

test('risky updates are skipped, not written', async () => {
  const cases = [
    [client(base, { isin: 'SE0000000000' }), /differs from page ISIN/],
    [client(base, { year: 2025 }), /older than page year/],
    [client(base, { year: 2027 }), /may not have ended/],
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

test('a new year is taken only once it has ended and results are out', async () => {
  const dir = await site(page());
  const early = await syncCompanyPages({ client: client(base, { year: 2027 }), rootDir: dir, now: new Date('2027-02-10T06:00:00Z') });
  assert.match(early.results[0].reason, /may not have ended/);
  const later = await syncCompanyPages({ client: client(base, { year: 2027 }), rootDir: dir, now: new Date('2027-03-02T06:00:00Z') });
  assert.equal(later.results[0].status, 'update');
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
