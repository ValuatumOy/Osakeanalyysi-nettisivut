import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { markHistoricalCompany, markHistoricalCompanies } from '../../scripts/mark-historical-company-pages.mjs';

const entry = {
  file: 'reports/example-equity-report.html', name: 'Example', ticker: 'EXAMPLE.HE', isin: 'FI4000369608',
  message: 'Example was delisted on 1 January 2025.', source: 'https://example.com/notice?a=1&b=2', label: 'Delisting notice',
  successor: '/reports/successor-equity-report.html', successorLabel: 'View successor',
};
const html = `<html><link rel="canonical" href="https://www.aiequityreports.com/${entry.file}"><script type="application/ld+json">{"@graph":[{"@type":"WebPage","url":"https://www.aiequityreports.com/${entry.file}","dateModified":"2025-01-01","mainEntity":{"name":"Example","identifier":"${entry.isin}","tickerSymbol":"${entry.ticker}"}}]}</script>
<a href="#generate" class="btn btn-gold">Generate fresh report &mdash; &euro;50.00</a>
<section class="report-full-section" id="overview"><h2>Example</h2><p>For financial year 2024, Example reported revenue of EUR 2m. Example is covered by Valuatum but does not yet have a published AI equity report. Generate a fresh report to get Example's valuation.</p></section>
<section class="report-full-section" id="generate"><a data-generate-report>Order</a></section></html>`;

test('historical status preserves the figures, removes ordering and checks identity on replay', () => {
  const updated = markHistoricalCompany(html, entry, '2026-11-11');
  assert.match(updated, /revenue of EUR 2m/);
  assert.match(updated, /href="#overview" class="btn btn-gold">View company status/);
  assert.match(updated, /notice\?a=1&amp;b=2/);
  assert.match(updated, /dateModified": "2026-11-11"/);
  assert.doesNotMatch(updated, /data-generate-report|Generate a fresh report/);
  assert.equal(markHistoricalCompany(updated, entry, '2026-11-12'), updated);
  assert.throws(() => markHistoricalCompany(updated, { ...entry, isin: 'FI0009000681' }), /identity/);
  assert.throws(() => markHistoricalCompany(updated, { ...entry, successor: '/reports/other-equity-report.html' }), /existing status/);
  assert.throws(() => markHistoricalCompany(html.replace('<html>', '<html>valuatum-page-mode'), entry), /not a matching company overview/);
});

test('an invalid later company prevents every page in the batch from being written', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'historical-pages-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'reports'));
  const other = { ...entry, file: 'reports/other-equity-report.html', isin: 'FI0009000681' };
  await fs.writeFile(path.join(root, entry.file), html);
  await fs.writeFile(path.join(root, other.file), html.replaceAll(entry.file, other.file));
  await fs.writeFile(path.join(root, 'reports/successor-equity-report.html'), 'successor');
  await fs.writeFile(path.join(root, 'sitemap.xml'), '<urlset></urlset>');
  await assert.rejects(markHistoricalCompanies({ review: { pages: [entry, other] }, rootDir: root, write: true, today: '2026-11-11' }), /identity/);
  assert.equal(await fs.readFile(path.join(root, entry.file), 'utf8'), html);
});
