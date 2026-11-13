import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import search from '../../server/search.js';
import { renderCompanyPage } from '../../scripts/company-pages/render-company-page.mjs';

const company = {
  companyName: 'Example N.V.', ticker: 'EXAMPLE.MI', industry: 'Industrials',
  currency: 'EUR', financialYear: 2025, metrics: {}, profile: 'Example company.',
};

test('an unsupported listing offers coverage instead of selling a fresh report', () => {
  const html = renderCompanyPage(company);
  assert.doesNotMatch(html, /data-generate-report/);
  assert.match(html, /href="#generate" class="btn btn-gold">Request coverage<\/a>/);
  assert.match(html, /href="\/reports\.html\?search=Example%2C%20EXAMPLE\.MI#coverage-request"/);
  const generate = html.match(/<section class="report-full-section" id="generate">([\s\S]*?)<\/section>/)[1];
  assert.match(generate, /Fresh report generation is not currently available for this listing/);
  assert.doesNotMatch(generate, /Delivered by email|&euro;|Order one now/);
  const overview = html.match(/<section class="report-full-section" id="overview">([\s\S]*?)<\/section>/)[1];
  assert.doesNotMatch(overview, /Generate a fresh report to get|is covered by Valuatum/);
});

test('supported US and Nordic listings keep the fresh report button', () => {
  for (const ticker of ['EXAMPLE', 'EXAMPLE.HE']) {
    const html = renderCompanyPage({ ...company, ticker });
    assert.match(html, /data-generate-report data-company="Example N.V."/);
    assert.match(html, /Generate fresh report &mdash; &euro;50\.00/);
  }
});

test('published company pages do not offer direct fresh checkout for excluded listings', async () => {
  const reports = new URL('../../reports/', import.meta.url);
  const violations = [];
  for (const file of await fs.readdir(reports)) {
    if (!file.endsWith('-equity-report.html')) continue;
    const html = await fs.readFile(new URL(file, reports), 'utf8');
    for (const tag of html.matchAll(/<[^>]+\bdata-generate-report\b[^>]*>/g)) {
      const ticker = tag[0].match(/\bdata-ticker="([^"]+)"/)?.[1];
      if (!ticker || !search.isCoveredTicker(ticker)) violations.push(`${file}: ${ticker || 'missing ticker'}`);
    }
  }
  assert.deepEqual(violations, []);
});
