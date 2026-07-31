import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateCompanyPages } from '../../scripts/generate-company-pages.mjs';
import { companyDisplayName, pageSlug, isFinancialCompany } from '../../scripts/company-pages/render-company-page.mjs';

test('company display names and slugs remove legal suffixes and preserve Nordic letters', () => {
  assert.equal(companyDisplayName({ companyName: 'Evolution AB (publ)', ticker: 'EVO.ST' }), 'Evolution');
  assert.equal(companyDisplayName({ companyName: 'Ørsted A/S', ticker: 'ORSTED.CO' }), 'Ørsted');
  assert.equal(pageSlug({ companyName: 'Ørsted A/S', ticker: 'ORSTED.CO' }), 'orsted-equity-report');
  assert.equal(pageSlug({ companyName: 'Metso Outotec', ticker: 'METSO.HE' }), 'metso-equity-report');
  assert.equal(pageSlug({ companyName: 'Investor AB (publ)', ticker: 'INVE-B.ST' }), 'investor-ab-equity-report');
});

test('generator writes a Fortum-style HTML page from live-shaped data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-generator-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = {
    async findCompanyByTicker(ticker) {
      return {
        companyId: 5,
        companyName: 'Example Oyj',
        companyCode: 'FI123',
        ticker,
        industry: 'Industrials',
        models: [{ followedModelId: 10 }],
      };
    },
    async getLatestActualModels() {
      return [{
        followedModelId: 10,
        companyId: 5,
        currentYear: 2026,
        orderNo: 1,
        currency: 'EUR',
        dataMap: { 2025: { bv: 400, adj_share_price_a: 12.34, ns: 1_200, ebit: 110, net_earnings: 80, market_cap_ye: 2_500 } },
      }];
    },
  };
  const profileProvider = {
    name: 'test',
    model: 'test-model',
    async generate() {
      return 'Example designs and manufactures industrial equipment for business customers across Europe. Its main activities include production systems, maintenance services, spare parts, and software used to monitor installed machinery. The company serves manufacturing and infrastructure operators through direct sales and local service teams, generating revenue from both new equipment and recurring aftermarket support.';
    },
  };
  const catalogPath = path.join(root, 'companyPagesData.js');
  const sitemapPath = path.join(root, 'sitemap.xml');
  await fs.writeFile(catalogPath, `// Generated company pages available for direct search and report-card descriptions.
window.COMPANY_PAGE_CATALOG = [
  {
    "name": "Example Oyj",
    "ticker": "EXAMPLE",
    "exchange": "Helsinki",
    "url": "reports/example-oyj-equity-report.html",
    "description": "Old entry"
  }
];
`);
  await fs.writeFile(sitemapPath, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.aiequityreports.com/reports/example-oyj-equity-report.html</loc>
    <lastmod>2026-07-01</lastmod>
  </url>
</urlset>
`);

  const result = await generateCompanyPages({
    tickers: ['EXAMPLE'],
    client,
    profileProvider,
    outputDir: path.join(root, 'reports'),
    profileDir: path.join(root, 'profiles'),
    companyCatalogPath: catalogPath,
    sitemapPath,
    generatedOn: new Date('2026-07-10T00:00:00Z'),
  });

  assert.equal(result.failures.length, 0);
  const html = await fs.readFile(path.join(root, 'reports', 'example-equity-report.html'), 'utf8');
  assert.match(html, /Example \(EXAMPLE\) Stock Analysis &amp; AI Equity Report/);
  assert.match(html, /class="report-full-content coverage-cols"/);
  assert.match(html, /max-width:1760px/);
  assert.match(html, /Example \(EXAMPLE\) overview/);
  assert.match(html, /Key metrics &amp; valuation multiples/);
  assert.match(html, /EUR 1,200m/);
  assert.match(html, /12\.34 EUR/);
  assert.match(html, /Example designs and manufactures industrial equipment/);

  const catalog = await fs.readFile(catalogPath, 'utf8');
  assert.match(catalog, /"name": "Example"/);
  assert.match(catalog, /"url": "reports\/example-equity-report\.html"/);
  assert.doesNotMatch(catalog, /example-oyj-equity-report/);
  assert.match(catalog, /"description": "Example designs and manufactures industrial equipment/);

  const sitemap = await fs.readFile(sitemapPath, 'utf8');
  assert.match(sitemap, /https:\/\/www\.aiequityreports\.com\/reports\/example-equity-report\.html/);
  assert.doesNotMatch(sitemap, /example-oyj-equity-report/);
  assert.match(sitemap, /<lastmod>2026-07-10<\/lastmod>/);
});

function freshnessTestClient() {
  return {
    async findCompanyByTicker(ticker) {
      return {
        companyId: 5, companyName: 'Example Oyj', companyCode: 'FI123', ticker,
        industry: 'Industrials', models: [{ followedModelId: 10 }],
      };
    },
    async getLatestActualModels() {
      return [{
        followedModelId: 10, companyId: 5, currentYear: 2026, orderNo: 1, currency: 'EUR',
        dataMap: { 2025: { bv: 400, adj_share_price_a: 12.34, ns: 1_200, ebit: 110, net_earnings: 80, market_cap_ye: 2_500 } },
      }];
    },
  };
}

const freshnessTestProfileProvider = {
  name: 'test', model: 'test-model',
  async generate() {
    return 'Example designs and manufactures industrial equipment for business customers across Europe. Its main activities include production systems, maintenance services, spare parts, and software used to monitor installed machinery. The company serves manufacturing and infrastructure operators through direct sales and local service teams, generating revenue from both new equipment and recurring aftermarket support.';
  },
};

test('data freshness line is rendered from a TSV freshness file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-generator-fresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const freshnessPath = path.join(root, 'freshness.tsv');
  await fs.writeFile(freshnessPath, [
    'tier\tcountry\tCOMPANYID\tNAME\tTICKER\tISIN\tmodel_updated\tmodel_version',
    '1\tFI\t5\tExample Oyj\tEXAMPLE\tFI123\t2026-05-06 15:33:27.7680\t1778081607768',
  ].join('\n') + '\n');

  const result = await generateCompanyPages({
    tickers: ['EXAMPLE'],
    client: freshnessTestClient(),
    profileProvider: freshnessTestProfileProvider,
    outputDir: path.join(root, 'reports'),
    profileDir: path.join(root, 'profiles'),
    freshnessPath,
    updateDiscovery: false,
  });

  assert.equal(result.failures.length, 0);
  assert.equal(result.companies[0].dataUpdated, '2026-05-06');
  const html = await fs.readFile(path.join(root, 'reports', 'example-equity-report.html'), 'utf8');
  assert.match(html, /Figures updated on 2026-05-06\. Data will be refreshed during report generation\./);
});

test('data freshness line is omitted when no freshness is available for the ticker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-generator-nofresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await generateCompanyPages({
    tickers: ['EXAMPLE'],
    client: freshnessTestClient(),
    profileProvider: freshnessTestProfileProvider,
    outputDir: path.join(root, 'reports'),
    profileDir: path.join(root, 'profiles'),
    updateDiscovery: false,
  });

  assert.equal(result.companies[0].dataUpdated, null);
  const html = await fs.readFile(path.join(root, 'reports', 'example-equity-report.html'), 'utf8');
  assert.doesNotMatch(html, /Figures updated on/);
});

test('financial companies are detected by ticker and industry keyword', () => {
  assert.equal(isFinancialCompany({ ticker: 'NDA-FI.HE', industry: '' }), true);
  assert.equal(isFinancialCompany({ ticker: 'INVE-B.ST', industry: '' }), true);
  assert.equal(isFinancialCompany({ ticker: 'XYZ.HE', industry: 'Diversified Banks' }), true);
  assert.equal(isFinancialCompany({ ticker: 'XYZ.HE', industry: 'Property & Casualty Insurance' }), true);
  assert.equal(isFinancialCompany({ ticker: 'KNEBV.HE', industry: 'Industrial Machinery' }), false);
});

test('generator skips financial companies entirely (no page, no failure)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-generator-fin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = {
    async findCompanyByTicker(ticker) {
      return {
        companyId: 7, companyName: 'Example Bank', companyCode: 'FI9', ticker,
        industry: 'Diversified Banks', models: [{ followedModelId: 11 }],
      };
    },
    async getLatestActualModels() {
      return [{
        followedModelId: 11, companyId: 7, currentYear: 2026, orderNo: 1, currency: 'EUR',
        dataMap: { 2025: { bv: 30_000, adj_share_price_a: 10.5, ns: 25_525, ebit: 6_548, net_earnings: 5_059, market_cap_ye: 36_761 } },
      }];
    },
  };
  const profileProvider = {
    name: 'test', model: 'test-model',
    async generate() { throw new Error('profile should not be generated for a financial company'); },
  };

  const result = await generateCompanyPages({
    tickers: ['XYZ.HE'],
    client,
    profileProvider,
    outputDir: path.join(root, 'reports'),
    profileDir: path.join(root, 'profiles'),
    updateDiscovery: false,
  });

  assert.equal(result.companies.length, 0);
  assert.equal(result.failures.length, 0);
  await assert.rejects(fs.readFile(path.join(root, 'reports', 'example-bank-equity-report.html'), 'utf8'));
});
