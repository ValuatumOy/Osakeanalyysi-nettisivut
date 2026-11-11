import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { refreshCompanyPages, refreshHtml } from '../../scripts/refresh-company-pages.mjs';
import { renderCompanyPage } from '../../scripts/company-pages/render-company-page.mjs';
import { updateCompanyPage } from '../../scripts/update-company-breadcrumbs.mjs';

const now = new Date('2026-11-11T12:00:00Z');
const isin = 'FI4000369608';
const entry = {
  path: 'reports/example-equity-report.html', ticker: 'EXAMPLE.HE', pageTicker: 'EXAMPLE', isin,
  financialYear: 2025, currency: 'EUR', marketCurrency: 'EUR',
  sourceUrl: 'https://example.com/annual-report.pdf',
  values: { bookValue: 16.503, sharePrice: 10.65, revenue: 39.639, ebit: 2.97, netEarnings: 2.313, marketCap: 41.7 },
  modelSnapshot: { bookValue: 16.503, sharePrice: 10.65, revenue: 39.639, ebit: 3.009, netEarnings: 2.313, marketCap: 40.695141 },
};
const manifest = { version: 1, checkedOn: '2026-11-11', pages: [entry] };
const company = {
  companyName: 'Example Oyj', companyCode: isin, companyId: 5, ticker: 'EXAMPLE',
  currency: 'EUR', marketCurrency: 'EUR', industry: 'Industrials', financialYear: 2024,
  profile: 'Example company profile.', dataUpdated: '2025-06-13',
  metrics: { bookValue: 15, sharePrice: 10, revenue: 35, ebit: 3, netEarnings: 2, marketCap: 40 },
};
const related = { companyName: 'Related Oyj', ticker: 'RELATED.HE', industry: 'Industrials', currency: 'EUR' };
const mockClient = {
  async findCompanyByTicker(ticker) {
    return { companyId: 5, companyName: 'Example Oyj', companyCode: isin, ticker, industry: 'Industrials' };
  },
  async getLatestActualModels() {
    return [{ followedModelId: 10, companyId: 5, orderNo: 1, currentYear: 2026, currency: 'EUR',
      dataMap: { 2025: { bv: 16.503, adj_share_price_a: 10.65, ns: 39.639, ebit: 3.009, net_earnings: 2.313, market_cap_ye: 40.695141 } } }];
  },
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-refresh-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'reports'));
  const html = renderCompanyPage(company, [company, related], new Date('2026-07-24'));
  await fs.writeFile(path.join(root, entry.path), html);
  await fs.writeFile(path.join(root, 'sitemap.xml'), `<urlset>\n  <url>\n    <loc>https://www.aiequityreports.com/${entry.path}</loc>\n    <lastmod>2026-07-24</lastmod>\n  </url>\n</urlset>\n`);
  return { root, html };
}

test('reviewed refresh preserves the page and related links, uses the filing, and is idempotent', async (t) => {
  const { root, html } = await fixture(t);
  const pagePath = path.join(root, entry.path);
  const result = await refreshCompanyPages({ manifest, client: mockClient, rootDir: root, now });
  assert.deepEqual(result[0].differences, ['ebit', 'marketCap']);
  assert.equal(await fs.readFile(pagePath, 'utf8'), html, 'validation must not write');

  await refreshCompanyPages({ manifest, client: mockClient, rootDir: root, now, write: true });
  const updated = await fs.readFile(pagePath, 'utf8');
  assert.match(updated, /financial overview for 2025/);
  assert.match(updated, /revenue of EUR 39\.64m and operating profit of EUR 2\.97m/);
  assert.match(updated, /market capitalisation was EUR 41\.7m/);
  assert.match(updated, /Share price and market capitalisation are for the end of FY 2025/);
  assert.match(updated, /href="https:\/\/example\.com\/annual-report\.pdf"/);
  assert.match(updated, /href="\/reports\/related-equity-report\.html"/);
  assert.match(updated, /data-generate-report data-company="Example Oyj"/);
  assert.match(updated, /"tickerSymbol": "EXAMPLE"/);
  assert.match(updated, /"dateModified": "2026-11-11"/);
  assert.doesNotMatch(updated, /latest completed financial year/);
  assert.match(await fs.readFile(path.join(root, 'sitemap.xml'), 'utf8'), /<lastmod>2026-11-11<\/lastmod>/);
  const second = await refreshCompanyPages({ manifest, client: mockClient, rootDir: root, now: new Date('2026-11-12'), write: true });
  assert.equal(second[0].changed, false);
  assert.equal(await fs.readFile(pagePath, 'utf8'), updated);
});

test('changed model data, wrong identity or newer year abort before writing', async (t) => {
  const { root, html } = await fixture(t);
  const bad = { ...manifest, pages: [{ ...entry, modelSnapshot: { ...entry.modelSnapshot, ebit: 2.97 } }] };
  await assert.rejects(refreshCompanyPages({ manifest: bad, client: mockClient, rootDir: root, now, write: true }), /Wisdom ebit changed/);
  const wrongIdentity = { ...mockClient, async findCompanyByTicker() { return { ...company, companyCode: 'FI0000000000' }; } };
  await assert.rejects(refreshCompanyPages({ manifest, client: wrongIdentity, rootDir: root, now, write: true }), /Wisdom ISIN does not match/);
  const newer = { ...mockClient, async getLatestActualModels() { return [{ followedModelId: 10, currentYear: 2027, currency: 'EUR', dataMap: { 2026: {} } }]; } };
  await assert.rejects(refreshCompanyPages({ manifest, client: newer, rootDir: root, now, write: true }), /year or currency changed/);
  assert.equal(await fs.readFile(path.join(root, entry.path), 'utf8'), html);
});

test('a failure in a later page does not write an earlier page', async (t) => {
  const { root, html } = await fixture(t);
  const secondIsin = 'FI4000251830';
  const second = { ...entry, path: 'reports/second-equity-report.html', ticker: 'SECOND.HE', pageTicker: 'SECOND', isin: secondIsin,
    modelSnapshot: { ...entry.modelSnapshot, ebit: 2.97 } };
  const secondHtml = renderCompanyPage({ ...company, companyName: 'Second Oyj', companyCode: secondIsin, ticker: 'SECOND' }, [related], now);
  await fs.writeFile(path.join(root, second.path), secondHtml);
  const client = { ...mockClient, async findCompanyByTicker(ticker) {
    return { companyId: 5, companyName: ticker, companyCode: ticker === second.ticker ? secondIsin : isin, ticker, industry: 'Industrials' };
  } };
  await assert.rejects(refreshCompanyPages({ manifest: { ...manifest, pages: [entry, second] }, client, rootDir: root, now, write: true }), /SECOND.HE: Wisdom ebit changed/);
  assert.equal(await fs.readFile(path.join(root, entry.path), 'utf8'), html);
  assert.equal(await fs.readFile(path.join(root, second.path), 'utf8'), secondHtml);
});

test('a full report or a different page identity cannot be overwritten', () => {
  const html = renderCompanyPage(company, [related], now);
  assert.throws(() => refreshHtml(`${html}\n<meta name="valuatum-page-mode" content="report">`, entry, '2026-11-11', '2026-11-11'), /full report pages/);
  assert.throws(() => refreshHtml(html, { ...entry, isin: 'FI0000000000' }, '2026-11-11', '2026-11-11'), /page ISIN does not match/);
  assert.throws(() => refreshHtml(html, { ...entry, pageTicker: 'OTHER' }, '2026-11-11', '2026-11-11'), /existing ticker does not match/);
  assert.throws(() => refreshHtml(html.replace('href="https://www.aiequityreports.com/reports/example-equity-report.html"', 'href="https://www.aiequityreports.com/reports/other.html"'), entry, '2026-11-11', '2026-11-11'), /canonical URL does not match/);
  assert.throws(() => refreshHtml(html.replace('property="og:description"', 'property="og:other"'), entry, '2026-11-11', '2026-11-11'), /missing financial description metadata/);
});

test('refresh preserves CRLF and remains compatible with breadcrumb updates', () => {
  const html = renderCompanyPage(company, [related], now).replace(/\n/g, '\r\n');
  const updated = refreshHtml(html, entry, '2026-11-11', '2026-11-11');
  assert.doesNotMatch(updated, /(?<!\r)\n/);
  assert.equal(updateCompanyPage(updated), updated);
});

test('invalid review, missing section and missing sitemap entry abort safely', async (t) => {
  const { root, html } = await fixture(t);
  await assert.rejects(refreshCompanyPages({ manifest: { ...manifest, checkedOn: '2026-02-31' }, client: mockClient, rootDir: root, now, write: true }), /valid past or current date/);
  assert.throws(() => refreshHtml(html.replace('id="sources"', 'id="missing"'), entry, '2026-11-11', '2026-11-11'), /section sources/);
  await fs.writeFile(path.join(root, 'sitemap.xml'), '<urlset></urlset>');
  await assert.rejects(refreshCompanyPages({ manifest, client: mockClient, rootDir: root, now, write: true }), /expected exactly one matching section/);
  assert.equal(await fs.readFile(path.join(root, entry.path), 'utf8'), html);
});
