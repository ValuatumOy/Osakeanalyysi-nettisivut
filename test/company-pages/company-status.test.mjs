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
