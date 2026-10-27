// A market-first report (no rating, no target price by design) must reach the site as a real
// report page — not be rejected by the extraction gate, not degrade to a coverage page — and
// nothing on that page may read as a Valuatum rating or target. The analysts' consensus
// target may appear, always attributed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../../scripts/report-pages/render.mjs';
import { gate, extractedSummary } from '../../scripts/report-pages/extract.mjs';
import { buildMessages, isMarketFirstText } from '../../scripts/report-pages/prompt.mjs';
import { toReportContent } from '../../scripts/report-pages/schema.mjs';
import { reportDescription } from '../../scripts/seo-description.mjs';

const DOC = {
  id: 'storaenso-26102026',
  slug: 'stora-enso-equity-report',
  reportKind: 'market-first',
  companyName: 'Stora Enso Oyj',
  ticker: 'STERV.HE',
  exchange: 'NASDAQ Helsinki',
  country: 'Finland',
  sector: 'Packaging & Containers',
  currency: 'EUR',
  reportDate: '2026-10-26',
  profile: 'makes packaging materials from wood fibre and manages forests.',
  headline: { currentPrice: '10.1 EUR', marketCap: 'EUR 8 bn', enterpriseValue: 'EUR 11.6 bn' },
  otherClaims: { label: 'Debt and other claims, less cash', value: '-1.7 EUR per share' },
  consensusTarget: { value: '11.5 EUR', analysts: '16', range: '9.0-13.5 EUR', source: 'MarketScreener' },
  multiples: [{ label: 'EV/EBIT 2026', value: '18x' }, { label: 'P/E 2026', value: '35x' }],
  priceStats: { week52High: '12.3 EUR', week52Low: '8.7 EUR', oneYearChange: '-0.9%' },
  summary: ['Stora Enso Oyj (STERV.HE, NASDAQ Helsinki) makes packaging materials.', 'Forests are most of the price.', 'Watch Oulu.'],
  thesis: [{ num: '01', title: 'What you pay for', metric: '8.1 EUR', text: 'Most of the share price is the forests.' }],
  valuePools: [
    { name: 'Forests', share: '8.1 EUR per share', economics: '75% of reported value', text: 'Forest text.' },
    { name: 'Packaging materials', share: '3.7 EUR per share', economics: '9.6x 2028 operating profit', text: 'Packaging text.' },
  ],
  coreAnalysis: [{ heading: 'What the price pays for', text: 'Analysis text.' }],
  risks: ['Oulu ramp-up (Packaging materials): slower volumes.'],
  catalysts: ['Forest separation (near-term, Forests): shows the value.'],
  financials: { note: 'EUR millions.', incomeStatement: { columns: ['2026E'], rows: [{ label: 'Net sales', values: ['9,000'] }] } },
  faqs: [{ q: 'What is the Stora Enso share price made of?', a: 'Mostly forests.' }],
  sources: ['Primary data: Valuatum market report on Stora Enso Oyj dated 26 October 2026.'],
};

const FREE = { id: DOC.id, isFree: true, pdfUrl: 'https://files.aiequityreports.com/reports/pdfs/StoraEnso_26102026.pdf' };
const PAID = { id: DOC.id, isFree: false, price: 20 };

const meta = (html, name) => (html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`)) || [])[1];
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');

test('the gate accepts a market-first document without a rating', () => {
  assert.doesNotThrow(() => gate(DOC));
});

test('the gate still rejects an unrated document that is not market-first', () => {
  const { reportKind, ...unrated } = DOC;
  assert.throws(() => gate(unrated), /expected BUY\/HOLD\/SELL/);
});

test('the gate rejects market-first prose that states a Valuatum target or rating', () => {
  for (const bad of ['Our target price is 12 EUR.', 'The implied upside is 14%.', 'Valuatum rates it HOLD.']) {
    assert.throws(() => gate({ ...DOC, summary: [bad] }), /states a rating or target/, bad);
  }
  // The consensus, attributed, is allowed.
  assert.doesNotThrow(() => gate({ ...DOC, summary: ["The mean of 16 analysts' 12-month price target is 11.5 EUR (MarketScreener)."] }));
});

test('a free market-first report renders as a full free page, not a coverage page', () => {
  const html = renderPage(DOC, FREE, [DOC]);
  assert.equal(meta(html, 'valuatum-page-mode'), 'free');
  assert.equal(meta(html, 'valuatum-report-id'), DOC.id);
  assert.match(html, /What the share price is made of/);
  assert.match(html, /The report in three points/);
  assert.match(html, /Download free PDF/);
  assert.doesNotMatch(html, /Generate the Stora Enso report/);
});

test('a paid market-first report renders the teaser and the buy gate', () => {
  const html = renderPage(DOC, PAID, [DOC]);
  assert.equal(meta(html, 'valuatum-page-mode'), 'paid');
  assert.match(html, /Unlock the Stora Enso ready report/);
});

test('nothing on a market-first page reads as a Valuatum rating or target', () => {
  for (const cat of [FREE, PAID]) {
    const html = renderPage(DOC, cat, [DOC]);
    const body = text(html);
    assert.doesNotMatch(html, /<title>[^<]*Price Target/i);
    assert.doesNotMatch(meta(html, 'description'), /price target/i);
    assert.doesNotMatch(body, /12-month fundamental|Implied upside|Recommendation|Reverse valuation/);
    assert.doesNotMatch(body, /Valuatum rates/);
    // The consensus target appears only with who it belongs to.
    for (const m of body.matchAll(/11\.5 EUR/g)) {
      const around = body.slice(Math.max(0, m.index - 120), m.index + 160);
      assert.match(around, /analysts'|consensus/, around);
    }
  }
});

test('the price bridge runs from the businesses through debt to the share price', () => {
  const html = renderPage(DOC, FREE, [DOC]);
  // Bars against the businesses' total: 8.1 / 11.8 = 68.6%, 3.7 / 11.8 = 31.4%,
  // debt 1.7 / 11.8 = 14.4%, share price 10.1 / 11.8 = 85.6%.
  for (const w of ['68.6', '31.4', '14.4', '85.6']) assert.match(html, new RegExp(`width:${w.replace('.', '\\.')}%`));
  assert.match(html, /Debt and other claims, less cash/);
  assert.match(html, /<span class="pool-name"[^>]*>Share price<\/span>/);
});

test('key metrics are one even grid, the consensus explained in a footnote', () => {
  const html = renderPage(DOC, FREE, [DOC]);
  const [, cols, grid] = html.match(/<div class="cp-grid cp-grid-even cp-cols-(\d)">([\s\S]*?)<\/div><p/);
  assert.equal((grid.match(/class="cp-cell"/g) || []).length % Number(cols), 0);
  assert.match(grid, /Analysts' consensus target\*/);
  assert.match(html, /\* Mean of 16 analysts' targets, range 9\.0-13\.5 EUR, source: MarketScreener\. Other analysts' figure, not Valuatum's/);
});

test('the overview names the company, its ticker, and the price as that day’s', () => {
  const html = renderPage(DOC, FREE, [DOC]);
  assert.match(html, /Stora Enso \(NASDAQ Helsinki: STERV\.HE\) makes packaging materials/);
  assert.match(html, /share price of 10\.1 EUR on that day/);
});

test('sections sit in fixed columns with a reading order for narrow screens', () => {
  const html = renderPage(DOC, FREE, [DOC]);
  const ids = [...html.matchAll(/<section class="report-full-section" id="([a-z-]+)" style="order:(\d+);">/g)]
    .sort((a, b) => a[2] - b[2]).map((m) => m[1]);
  assert.deepEqual(ids.slice(0, 5), ['overview', 'metrics', 'summary', 'thesis', 'segment-values']);
  assert.match(html, /class="report-full-content mf-cols"/);
});

test('a market-first page without its share card uses the default card', () => {
  const ogOf = (html) => (html.match(/<meta property="og:image" content="([^"]*)"/) || [])[1];
  assert.match(ogOf(renderPage(DOC, FREE, [DOC])), /\/images\/og\/stora-enso-equity-report\.png$/);
  const noCard = { ...DOC, slug: 'no-such-company-equity-report' };
  assert.match(ogOf(renderPage(noCard, FREE, [noCard])), /\/images\/og-image\.png$/);
});

test('only a market-first page carries the market-report banner; a rated header is untouched', () => {
  assert.match(renderPage(DOC, FREE, [DOC]), /Market report · no rating · no target price/);
  const { reportKind, consensusTarget, otherClaims, ...rest } = DOC;
  const rated = { ...rest, headline: { ...DOC.headline, recommendation: 'HOLD', targetPrice: '10.10 EUR' } };
  const html = renderPage(rated, FREE, [rated]);
  assert.doesNotMatch(html, /Market report · no rating/);
  // The banner slot must leave no trace on a rated page: a stray blank line would rebuild
  // every rated page on the next sync.
  assert.match(html, /<\/div>\n {10}<\/div>\n {10}<div class="company-header-actions">/);
});

test('the market-first description promises no price target', () => {
  const d = reportDescription({ name: 'Stora Enso', ticker: 'STERV.HE', marketFirst: true });
  assert.ok(d.length <= 160, d);
  assert.doesNotMatch(d, /target|reverse valuation/i);
});

test('toReportContent tags the kind and drops a null consensus', () => {
  const doc = toReportContent({ companyName: 'X', consensusTarget: null, headline: {} }, { id: 'x-01012026', slug: 'x', reportKind: 'market-first' });
  assert.equal(doc.reportKind, 'market-first');
  assert.ok(!('consensusTarget' in doc));
  assert.ok(!('reportKind' in toReportContent({ headline: {} }, { id: 'y', slug: 'y' })));
});

test('market-first detection and prompt', () => {
  assert.equal(isMarketFirstText('WHAT THE 10.1 IS MADE OF ... It gives no target price, no view'), true);
  assert.equal(isMarketFirstText('Recommendation HOLD Target price 10.10 EUR'), false);
  const mf = buildMessages({ reportText: 'x', marketFirst: true })[1].content[0].text;
  assert.match(mf, /consensusTarget/);
  assert.doesNotMatch(mf, /BUY, HOLD or SELL as printed|reverseValuation/);
});

test('the sync log names a market report as one, not "undefined, target undefined"', () => {
  assert.equal(extractedSummary({ reportKind: 'market-first', headline: { currentPrice: '€10.0' } }), 'market report, no rating, price €10.0');
  assert.equal(extractedSummary({ reportKind: null, headline: { recommendation: 'HOLD', targetPrice: '22.30 EUR' } }), 'HOLD, target 22.30 EUR');
});
