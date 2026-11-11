import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('reviewed historical companies explain their status and cannot be ordered from their old page', async () => {
  const review = JSON.parse(await fs.readFile(path.join(root, 'company-content/reviews/2026-11-11-company-status.json'), 'utf8'));
  for (const page of review.pages) {
    const html = await fs.readFile(path.join(root, page.file), 'utf8');
    assert.ok(html.includes(page.message), page.file);
    assert.ok(html.includes(page.source.replace(/&/g, '&amp;')), page.file);
    assert.doesNotMatch(html, /data-generate-report|Generate fresh report &mdash; &euro;50\.00/, page.file);
    assert.ok(html.includes('href="#overview" class="btn btn-gold">View company status'), page.file);
    if (page.successor) assert.ok(html.includes(`href="${page.successor}"`), page.file);
    if (page.additionalSource) assert.ok(html.includes(page.additionalSource.replace(/&/g, '&amp;')), page.file);
    if (page.isin) {
      assert.ok(html.includes(`"identifier": "${page.isin}"`), page.file);
      assert.ok(html.includes(`"tickerSymbol": "${page.ticker}"`), page.file);
    }
    if (page.financialReview) assert.ok(html.includes(page.financialReview.sourceUrl), page.file);
  }
});

test('Tikkurila historical figures use the consolidated annual report in euros', async () => {
  const html = await fs.readFile(path.join(root, 'reports/tikkurila-equity-report.html'), 'utf8');
  for (const value of ['EUR 581.97m', 'EUR 61.08m', 'EUR 43.08m', 'EUR 181.36m']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /GBP 0\.[0125]m/);
});

test('Airthings uses the audited 2025 consolidated figures in Norwegian kroner', async () => {
  const html = await fs.readFile(path.join(root, 'reports/airthings-equity-report.html'), 'utf8');
  for (const value of ['NOK 346.12m', 'NOK -130.84m', 'NOK -172.59m', 'NOK 254.79m']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /USD 38\.5m|USD -13\.7m|FY 2024/);
});

test('Kyoto uses the audited 2025 consolidated figures rather than lease income as revenue', async () => {
  const html = await fs.readFile(path.join(root, 'reports/kyoto-group-as-equity-report.html'), 'utf8');
  for (const value of ['EUR 1.05m', 'EUR -8.12m', 'EUR -8.15m', 'EUR 9.95m']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /EUR 0m|EUR -7\.6m|FY 2023/);
});

test('Dovre shows the audited 2025 figures alongside the bankruptcy notice', async () => {
  const html = await fs.readFile(path.join(root, 'reports/dovre-group-equity-report.html'), 'utf8');
  for (const value of ['EUR 91.86m', 'EUR -66.33m', 'EUR -53.46m', 'EUR -48.01m', '0.0734 EUR', 'EUR 7.9m']) assert.ok(html.includes(value));
  assert.match(html, /declared bankrupt on 2 November 2026/);
  assert.doesNotMatch(html, /FY 2024|EUR 99\.3m/);
});

test('KDventures uses the 2025 investment entity figures and identifies its new name', async () => {
  const html = await fs.readFile(path.join(root, 'reports/karolinska-development-equity-report.html'), 'utf8');
  for (const value of ['SEK 1.67m', 'SEK -194.12m', 'SEK -193.86m', 'SEK 1,044.87m']) assert.ok(html.includes(value));
  assert.match(html, /previously named Karolinska Development/);
  assert.match(html, /IFRS 10 investment entity/);
  assert.doesNotMatch(html, /FY 2024|SEK -9\.2m/);
});

test('GPX identifies Neola and removes figures associated with a conflicting ISIN', async () => {
  const html = await fs.readFile(path.join(root, 'reports/gpx-medical-equity-report.html'), 'utf8');
  assert.match(html, /"identifier": "SE0014829255"/);
  assert.match(html, /href="\/reports\/neola-medical-equity-report\.html"/);
  assert.doesNotMatch(html, /SE0006965158|SEK 40\.6m|SEK 0\.6m|SEK -6\.7m/);
});
