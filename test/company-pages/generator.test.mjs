import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateCompanyPages } from '../../scripts/generate-company-pages.mjs';

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

  const result = await generateCompanyPages({
    tickers: ['EXAMPLE'],
    client,
    profileProvider,
    outputDir: path.join(root, 'reports'),
    profileDir: path.join(root, 'profiles'),
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
});
