#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractEsefCandidate } from './esef-candidate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAY = 86_400_000;
const FIELDS = { Revenue: 'revenue', ProfitLossFromOperatingActivities: 'ebit', ProfitLossAttributableToOwnersOfParent: 'netEarnings', EquityAttributableToOwnersOfParent: 'bookValue' };
const LABELS = { Revenue: 'revenue', 'Operating profit': 'ebit', 'Net earnings': 'netEarnings', 'Book value': 'bookValue' };

function midnight(value) {
  if (!/^\d{4}-\d{2}-\d{2}(?:T00:00:00Z?)?$/.test(value || '')) return null;
  const day = value.slice(0, 10);
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : null;
}

function standardConcept(dimensions, namespaces) {
  const match = /^([^:]+):(.+)$/.exec(dimensions?.concept || '');
  return match && /^https?:\/\/xbrl\.ifrs\.org\/taxonomy\/[^/]+\/ifrs-full$/.test(namespaces?.[match[1]] || '') ? match[2] : null;
}

function annualStart(document, periodEnd) {
  const finish = midnight(periodEnd) + DAY;
  const starts = new Set();
  for (const fact of Object.values(document?.facts || {})) {
    const d = fact?.dimensions;
    if (!d || Object.keys(d).some(key => !['concept', 'entity', 'period', 'unit'].includes(key))) continue;
    const concept = standardConcept(d, document?.documentInfo?.namespaces);
    if (!Object.hasOwn(FIELDS, concept) || concept === 'EquityAttributableToOwnersOfParent') continue;
    const parts = String(d.period || '').split('/');
    if (parts.length !== 2) continue;
    const start = midnight(parts[0]);
    const end = midnight(parts[1]);
    if (start !== null && end === finish && (end - start) / DAY >= 350 && (end - start) / DAY <= 380) starts.add(parts[0].slice(0, 10));
  }
  if (starts.size !== 1) throw new Error('Expected one unambiguous annual period start');
  return [...starts][0];
}

function pageFigures(html, candidate, year) {
  const entities = [];
  for (const match of html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)) {
    const graph = JSON.parse(match[1])?.['@graph'];
    if (Array.isArray(graph)) entities.push(...graph.filter(node => node && typeof node === 'object' && node['@type'] === 'WebPage' && node.mainEntity).map(node => node.mainEntity));
  }
  if (entities.length !== 1 || entities[0].identifier !== candidate.isin || entities[0].tickerSymbol !== candidate.ticker) throw new Error('Current page identity does not match the queue');
  const values = {};
  let currency;
  for (const cell of html.matchAll(/<div class="cp-cell">([\s\S]*?)<\/div>/g)) {
    const label = cell[1].match(/<span class="cp-l">([^<]+)<\/span>/)?.[1];
    const field = Object.hasOwn(LABELS, label) ? LABELS[label] : null;
    if (!field) continue;
    if (Object.hasOwn(values, field)) throw new Error(`Duplicate page metric: ${field}`);
    const sub = cell[1].match(/<span class="cp-sub">([^<]+)<\/span>/)?.[1];
    if (sub !== `FY ${year}`) throw new Error(`Page metric year does not match: ${field}`);
    const displayed = cell[1].match(/<span class="cp-v">([^<]+)<\/span>/)?.[1];
    if (displayed === 'N/A') { values[field] = { displayed, value: null, tolerance: null }; continue; }
    const amount = /^([A-Z]{3}) (-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)m$/.exec(displayed || '');
    if (!amount || (currency && currency !== amount[1])) throw new Error(`Invalid or inconsistent page currency: ${field}`);
    currency = amount[1];
    const number = amount[2].replaceAll(',', '');
    if (!Number.isFinite(Number(number))) throw new Error(`Non-finite page value: ${field}`);
    const decimals = (number.split('.')[1] || '').length;
    values[field] = { displayed, value: Number(number), tolerance: 0.5 * 10 ** -decimals };
  }
  if (!currency || Object.keys(values).length !== 4) throw new Error('Expected four page metrics with a reporting currency');
  return { currency, values };
}

function validateFiling(filing, lei, year) {
  if (midnight(filing.periodEnd) === null || filing.periodEnd.length !== 10 || !filing.periodEnd.startsWith(`${year}-`)) throw new Error('Filing period does not match the requested year');
  for (const key of ['errorCount', 'warningCount']) if (!Number.isInteger(filing[key]) || filing[key] < 0) throw new Error('Missing or invalid filing validation count');
  for (const key of ['jsonUrl', 'reportUrl']) {
    const url = new URL(filing[key]);
    if (url.origin !== 'https://filings.xbrl.org' || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(`/${lei}/${filing.periodEnd}/`) || /%|\\/.test(url.pathname)) throw new Error('Unsafe or mismatched filing URL');
  }
}

/** Produce review leads only. This function never writes files. */
export async function compareEsefQueue({ queue, year, rootDir = ROOT, fetchImpl = fetch, now = new Date() }) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('An explicit financial year is required');
  if (!Array.isArray(queue?.candidates) || queue.matchedPages !== queue.candidates.length) throw new Error('A complete queue is required; generate it with --limit 0');
  const seen = new Set();
  const results = [];
  for (const candidate of queue.candidates) {
    if (!/^[a-z0-9-]+-equity-report\.html$/.test(candidate.file || '') || seen.has(candidate.file)) throw new Error('Invalid or duplicate queue filename');
    seen.add(candidate.file);
    const row = { file: candidate.file, ticker: candidate.ticker, isin: candidate.isin, lei: candidate.lei, auditStatus: candidate.auditStatus, filings: [] };
    results.push(row);
    if (['identity_mismatch', 'lookup_failed'].includes(candidate.auditStatus)) { row.status = 'identity_review'; continue; }
    if (candidate.statusRecorded) { row.status = 'company_status_review'; continue; }
    if (candidate.pageYear !== year) { row.status = 'different_financial_year'; continue; }
    try {
      if (!/^[A-Z0-9]{20}$/.test(candidate.lei || '') || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(candidate.isin || '') || !Array.isArray(candidate.filings)) throw new Error('Invalid candidate identity or filings');
      const html = await fs.readFile(path.join(rootDir, 'reports', candidate.file), 'utf8');
      row.pageSha256 = createHash('sha256').update(html).digest('hex');
      row.page = pageFigures(html, candidate, year);
      if (/<strong>\s*Company status:\s*<\/strong>/i.test(html)) { row.status = 'company_status_review'; continue; }
      for (const filing of candidate.filings) {
        const record = { ...filing };
        row.filings.push(record);
        try {
          validateFiling(filing, candidate.lei, year);
          record.status = filing.errorCount ? 'filing_validation_errors' : 'candidate';
        } catch (error) { record.status = 'invalid_filing'; record.error = error.message; }
      }
      const plausible = row.filings.filter(filing => filing.status === 'candidate');
      if (row.filings.some(filing => filing.status === 'invalid_filing')) { row.status = 'source_review'; continue; }
      if (plausible.length && row.filings.some(filing => filing.status === 'filing_validation_errors')) { row.status = 'source_review'; continue; }
      if (plausible.length > 1) { row.status = 'ambiguous_filing'; continue; }
      if (!plausible.length) { row.status = 'no_comparable_filing'; continue; }
      const filing = plausible[0];
      const response = await fetchImpl(filing.jsonUrl, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (!response.ok) throw new Error(`Filing request returned HTTP ${response.status}`);
      const document = await response.json();
      const periodStart = annualStart(document, filing.periodEnd);
      const extracted = extractEsefCandidate(document, { lei: candidate.lei, currency: row.page.currency, periodStart, periodEnd: filing.periodEnd });
      row.period = { start: periodStart, end: filing.periodEnd };
      row.fields = {};
      row.warningsRequireReview = filing.warningCount > 0;
      for (const field of Object.values(FIELDS)) {
        const sourceRaw = extracted.valuesInCurrencyUnits[field];
        const page = row.page.values[field];
        const source = sourceRaw === null ? null : Number(sourceRaw) / 1e6;
        if (source !== null && !Number.isFinite(source)) throw new Error(`Non-finite source value: ${field}`);
        const item = { page: page.value, displayed: page.displayed, sourceRaw, source, tolerance: page.tolerance };
        if (source === null || page.value === null) {
          item.status = 'not_comparable';
          item.reason = source === null ? 'no_supported_source_fact' : 'page_value_unavailable';
        } else {
          item.delta = source - page.value;
          item.status = Math.abs(item.delta) <= page.tolerance + 1e-8 ? 'match' : 'variance';
        }
        row.fields[field] = item;
      }
      const fields = Object.values(row.fields);
      row.status = fields.some(field => field.status === 'variance') ? 'variance_candidate'
        : fields.every(field => field.status === 'match') ? 'no_variance_candidate'
          : fields.some(field => field.status === 'match') ? 'partial_comparison' : 'no_comparable_fields';
      if (row.warningsRequireReview) row.status += '_with_warnings';
    } catch (error) {
      row.status = error.message === 'Current page identity does not match the queue' ? 'identity_review' : 'parse_or_source_error';
      row.error = error.message;
    }
  }
  const summary = {};
  for (const row of results) summary[row.status] = (summary[row.status] || 0) + 1;
  return { version: 1, generatedAt: now.toISOString(), year, note: 'Unreviewed leads only. Independently verify identity, listing status, annual filing, accounting scope and every figure before publication.', marketValuesChecked: false, summary, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || new Set([args[0], args[2]]).size !== 2) throw new Error('Usage: node scripts/company-pages/esef-compare-queue.mjs --queue <complete-queue.json> --year <YYYY>');
    const options = { [args[0]]: args[1], [args[2]]: args[3] };
    if (!options['--queue'] || !/^\d{4}$/.test(options['--year'] || '')) throw new Error('Missing or unrecognised argument');
    const queue = JSON.parse((await fs.readFile(options['--queue'], 'utf8')).replace(/^\uFEFF/, ''));
    console.log(JSON.stringify(await compareEsefQueue({ queue, year: Number(options['--year']) }), null, 2));
  } catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
}
