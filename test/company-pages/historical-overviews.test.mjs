import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderCompanyPage } from '../../scripts/company-pages/render-company-page.mjs';
import { clarifyHistoricalOverview, clarifyHistoricalPages } from '../../scripts/clarify-historical-overviews.mjs';
import { updateCompanyPage } from '../../scripts/update-company-breadcrumbs.mjs';

const company = {
  companyName: 'Example Oyj', companyCode: 'FI4000369608', ticker: 'EXAMPLE.HE',
  financialYear: 2024, currency: 'EUR', marketCurrency: 'EUR', industry: 'Industrials',
  metrics: { revenue: 35.1, ebit: 3.1, bookValue: 15.9, netEarnings: 2.4, sharePrice: 10, marketCap: 40 },
  profile: 'A company.', dataUpdated: '2025-06-13',
};
const date = '2026-11-11';
const oldPage = () => renderCompanyPage(company, [], new Date('2026-07-24'))
  .replace("For financial year 2024, Valuatum's model shows revenue of", 'For the latest completed financial year, 2024, Example reported revenue of')
  .replace('represent financial year 2024.', 'represent the latest completed financial year (2024).')
  .replace('Financial model updated on 2025-06-13.', 'Figures updated on 2025-06-13. Data will be refreshed during report generation.');

test('historical pages retain all figures and links while correcting unsupported claims', () => {
  const before = oldPage().replace(/\n/g, '\r\n');
  const result = clarifyHistoricalOverview(before, 2024, date);
  assert.match(result.html, /For financial year 2024, Valuatum's model shows revenue of EUR 35\.1m/);
  assert.match(result.html, /historical figures may not reflect the most recent results/);
  assert.match(result.html, /Financial model updated on 2025-06-13/);
  assert.doesNotMatch(result.html, /latest completed financial year|refreshed during report generation/);
  const grid = (html) => html.match(/<div class="cp-grid">.*<\/div>/)[0];
  assert.equal(grid(result.html), grid(before));
  assert.match(result.html, /"dateModified": "2026-11-11"/);
  assert.equal(updateCompanyPage(result.html), result.html);
  assert.equal(clarifyHistoricalOverview(result.html, 2024, date), null);
  assert.equal(clarifyHistoricalOverview(before, 2023, date), null);
  assert.equal(clarifyHistoricalOverview(`${before}<meta name="valuatum-page-mode">`, 2024, date), null);
});

test('a missing source description prevents writes to every page in the batch', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'historical-overviews-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'reports'));
  const first = oldPage();
  await fs.writeFile(path.join(root, 'reports', 'a.html'), first);
  await fs.writeFile(path.join(root, 'reports', 'b.html'), first.replace('represent the latest completed financial year (2024).', 'missing source text.'));
  await fs.writeFile(path.join(root, 'sitemap.xml'), '<urlset></urlset>');
  await assert.rejects(clarifyHistoricalPages({ rootDir: root, cutoffYear: 2024, changedOn: date, write: true }), /b.html: Expected exactly one financial summary/);
  assert.equal(await fs.readFile(path.join(root, 'reports', 'a.html'), 'utf8'), first);
});
