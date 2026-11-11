import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareEsefQueue } from '../../scripts/company-pages/esef-compare-queue.mjs';

const lei = '213800QRC7LNX935OZ09';
const isin = 'FI0009000681';
const namespaces = {
  standard: 'https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full',
  iso: 'http://www.xbrl.org/2003/iso4217', lei: 'http://standards.iso.org/iso/17442', custom: 'https://example.com/company',
};
const annual = '2025-01-01T00:00:00/2026-01-01T00:00:00';
const names = ['Revenue', 'Operating profit', 'Net earnings', 'Book value'];
const concepts = ['Revenue', 'ProfitLossFromOperatingActivities', 'ProfitLossAttributableToOwnersOfParent', 'EquityAttributableToOwnersOfParent'];
function document({ values = ['100000000', '20000000', '-3000000', '50000000'], duration = annual, overrides = {} } = {}) {
  const facts = Object.fromEntries(concepts.map((concept, i) => [concept, {
    value: values[i], dimensions: { concept: `standard:${concept}`, entity: `lei:${lei}`, period: i === 3 ? duration.split('/')[1] : duration, unit: 'iso:EUR', ...overrides },
  }]));
  return { documentInfo: { documentType: 'https://xbrl.org/2021/xbrl-json', namespaces }, facts };
}
function html({ year = 2025, ticker = 'TEST.HE', values = ['EUR 100m', 'EUR 20.0m', 'EUR -3.00m', 'EUR 50m'] } = {}) {
  const schema = { '@graph': [{ '@type': 'WebPage', mainEntity: { identifier: isin, tickerSymbol: ticker } }] };
  return `<script type="application/ld+json">${JSON.stringify(schema)}</script>` + names.map((name, i) => `<div class="cp-cell"><span class="cp-l">${name}</span><span class="cp-v">${values[i]}</span><span class="cp-sub">FY ${year}</span></div>`).join('');
}
function filing(overrides = {}) {
  const prefix = `https://filings.xbrl.org/${lei}/2025-12-31/ESEF/FI/0/test-2025`;
  return { id: '1', periodEnd: '2025-12-31', jsonUrl: `${prefix}.json`, reportUrl: `${prefix}.xhtml`, errorCount: 0, warningCount: 0, ...overrides };
}
async function setup(t, page = html()) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'esef-compare-test-'));
  assert.ok(rootDir.startsWith(path.join(os.tmpdir(), 'esef-compare-test-')));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDir, 'reports'));
  const pagePath = path.join(rootDir, 'reports/test-equity-report.html');
  await fs.writeFile(pagePath, page);
  const candidate = { file: 'test-equity-report.html', ticker: 'TEST.HE', isin, lei, pageYear: 2025, auditStatus: 'same_or_older', statusRecorded: false, filings: [filing()] };
  const queue = { matchedPages: 1, candidates: [candidate] };
  return { rootDir, pagePath, candidate, queue };
}
const response = body => async () => ({ ok: true, json: async () => body });
const noFetch = async () => { assert.fail('Network access should not occur'); };
const compare = (fixture, fetchImpl = response(document())) => compareEsefQueue({ queue: fixture.queue, rootDir: fixture.rootDir, year: 2025, fetchImpl });

test('compares displayed precision, retains raw values and never writes the page', async t => {
  const fixture = await setup(t);
  const before = await fs.readFile(fixture.pagePath);
  const result = await compare(fixture, response(document({ values: ['100499999', '20100000', '-3004999', '50000000'] })));
  const row = result.results[0];
  assert.equal(row.status, 'variance_candidate');
  assert.equal(row.fields.revenue.status, 'match');
  assert.equal(row.fields.ebit.status, 'variance');
  assert.equal(row.fields.netEarnings.status, 'match');
  assert.equal(row.fields.ebit.sourceRaw, '20100000');
  assert.equal(row.fields.revenue.displayed, 'EUR 100m');
  assert.match(result.note, /Unreviewed leads only/);
  assert.equal(result.marketValuesChecked, false);
  assert.deepEqual(await fs.readFile(fixture.pagePath), before);
});

test('keeps unresolved and changed identities separate without fetching', async t => {
  const fixture = await setup(t);
  for (const status of ['identity_mismatch', 'lookup_failed']) {
    fixture.candidate.auditStatus = status;
    assert.equal((await compare(fixture, noFetch)).results[0].status, 'identity_review');
  }
  fixture.candidate.auditStatus = 'same_or_older';
  await fs.writeFile(fixture.pagePath, html({ ticker: 'DIFFERENT.HE' }));
  assert.equal((await compare(fixture, noFetch)).results[0].status, 'identity_review');
});

test('validates source URLs and counts, preserves warnings and skips filing errors', async t => {
  const fixture = await setup(t);
  for (const url of ['https://example.com/source.json', `https://filings.xbrl.org/${lei}/2024-12-31/source.json`, `https://filings.xbrl.org/${lei}/2025-12-31/%2e%2e/source.json`]) {
    fixture.candidate.filings = [filing({ jsonUrl: url })];
    const row = (await compare(fixture, noFetch)).results[0];
    assert.equal(row.status, 'source_review');
    assert.equal(row.filings[0].status, 'invalid_filing');
  }
  fixture.candidate.filings = [filing({ errorCount: 1, warningCount: 9 })];
  const skipped = (await compare(fixture, noFetch)).results[0];
  assert.equal(skipped.status, 'no_comparable_filing');
  assert.equal(skipped.filings[0].warningCount, 9);
  fixture.candidate.filings = [filing(), filing({ id: '2', errorCount: 1 })];
  assert.equal((await compare(fixture, noFetch)).results[0].status, 'source_review');
  fixture.candidate.filings = [filing({ warningCount: 3 })];
  const warned = (await compare(fixture)).results[0];
  assert.equal(warned.status, 'no_variance_candidate_with_warnings');
  assert.equal(warned.warningsRequireReview, true);
  assert.equal(warned.filings[0].jsonUrl, filing().jsonUrl);
});

test('requires the current metric year and a matching filing period', async t => {
  const fixture = await setup(t, html({ year: 2024 }));
  assert.match((await compare(fixture, noFetch)).results[0].error, /metric year/);
  await fs.writeFile(fixture.pagePath, html());
  fixture.candidate.filings = [filing({ periodEnd: '2024-12-31' })];
  assert.equal((await compare(fixture, noFetch)).results[0].status, 'source_review');
  fixture.candidate.pageYear = 2024;
  assert.equal((await compare(fixture, noFetch)).results[0].status, 'different_financial_year');
});

test('never chooses the first of multiple plausible filings', async t => {
  const fixture = await setup(t);
  fixture.candidate.filings.push(filing({ id: '2', jsonUrl: filing().jsonUrl.replace('/0/', '/1/') }));
  const row = (await compare(fixture, noFetch)).results[0];
  assert.equal(row.status, 'ambiguous_filing');
  assert.equal(row.filings.length, 2);
  assert.equal(row.fields, undefined);
});

test('derives a non-calendar annual duration and rejects quarters or conflicting starts', async t => {
  const fixture = await setup(t);
  fixture.candidate.filings = [filing({ periodEnd: '2025-06-30', jsonUrl: filing().jsonUrl.replaceAll('2025-12-31', '2025-06-30'), reportUrl: filing().reportUrl.replaceAll('2025-12-31', '2025-06-30') })];
  const duration = '2024-07-01T00:00:00/2025-07-01T00:00:00';
  const row = (await compare(fixture, response(document({ duration })))).results[0];
  assert.equal(row.status, 'no_variance_candidate');
  assert.deepEqual(row.period, { start: '2024-07-01', end: '2025-06-30' });
  const quarter = document({ duration: '2025-04-01T00:00:00/2025-07-01T00:00:00' });
  assert.match((await compare(fixture, response(quarter))).results[0].error, /annual period start/);
  const conflict = document({ duration });
  conflict.facts.Revenue.dimensions.period = '2024-07-05T00:00:00/2025-07-01T00:00:00';
  assert.match((await compare(fixture, response(conflict))).results[0].error, /annual period start/);
});

test('keeps unsupported facts unavailable and rejects wrong source identity or currency', async t => {
  const fixture = await setup(t);
  const body = document();
  body.facts.ProfitLossFromOperatingActivities.dimensions.concept = 'custom:AdjustedProfit';
  const row = (await compare(fixture, response(body))).results[0];
  assert.equal(row.fields.ebit.status, 'not_comparable');
  assert.equal(row.fields.ebit.reason, 'no_supported_source_fact');
  assert.equal(row.fields.ebit.source, null);
  assert.equal(row.status, 'partial_comparison');
  const unavailable = (await compare(fixture, response(document({ values: [null, null, null, null] })))).results[0];
  assert.equal(unavailable.status, 'no_comparable_fields');
  assert.equal(unavailable.fields.revenue.status, 'not_comparable');
  for (const overrides of [{ entity: 'lei:12345678901234567890' }, { unit: 'iso:SEK' }]) {
    const result = (await compare(fixture, response(document({ overrides })))).results[0];
    assert.equal(result.status, 'parse_or_source_error');
    assert.match(result.error, /unexpected filing entity|unexpected reporting currency/);
  }
});

test('ignores unrelated null structured data without losing the company identity', async t => {
  const fixture = await setup(t, '<script type="application/ld+json">null</script>' + html());
  assert.equal((await compare(fixture)).results[0].status, 'no_variance_candidate');
});

test('rejects truncated queues and unsafe filenames before reading local files', async t => {
  const fixture = await setup(t);
  fixture.queue.matchedPages = 2;
  await assert.rejects(compare(fixture, noFetch), /complete queue/);
  fixture.queue.matchedPages = 1;
  fixture.candidate.file = '../secret-equity-report.html';
  await assert.rejects(compare(fixture, noFetch), /filename/);
});
