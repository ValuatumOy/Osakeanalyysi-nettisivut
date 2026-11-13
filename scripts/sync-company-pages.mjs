#!/usr/bin/env node
// Keeps the financial figures on company overview pages equal to Valuatum's Wisdom model,
// the same data a generated report uses. Only the overview sentence, the metrics grid, the
// source line, the financial descriptions and the page's lastmod change; profile, URL, calls
// to action and status notes are left as they are. A page whose figures already match is
// not touched, so a run without model changes writes nothing.
//
// Reviewed pages, unavailable values and large changes require a person before they are
// published. This keeps a model correction or split adjustment from silently replacing
// verified filing values. All skips are listed in the run summary.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WisdomClient } from './company-pages/wisdom-client.mjs';
import { normalizeCompanyData, selectPrimaryModel } from './company-pages/normalize-company.mjs';
import {
  FINANCIAL_FIELDS,
  financialSentence,
  isFinancialCompany,
  metricDefinitions,
  sourcesSentence,
} from './company-pages/render-company-page.mjs';
import { updateSitemapDate } from './refresh-company-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const CONCURRENCY = 4;
// More failed Wisdom lookups than this share points at an API or token problem, not at
// individual companies: stop without writing anything.
const MAX_ERROR_SHARE = 0.2;
const MAX_RELATIVE_CHANGE = 0.2;
const { isCoveredTicker } = createRequire(import.meta.url)('../server/search');

const OVERVIEW_SENTENCE = /For (?:the latest completed financial year, |financial year )\d{4}, (?:[^<]*? revenue of (?:N\/A|[A-Z]{3} [-\d,.]+m)|[^<]*? has no comparable revenue figure)(?: and (?:reported )?operating profit of (?:N\/A|[A-Z]{3} [-\d,.]+m))?(?:; (?:the year-end share price was (?:N\/A|[-\d,.]+ [A-Z]{3})(?: and market capitalisation was (?:N\/A|[A-Z]{3} [-\d,.]+m))?|market capitalisation was (?:N\/A|[A-Z]{3} [-\d,.]+m)))?\./g;
const GRID = /<div class="cp-grid">[\s\S]*?<\/div><\/div>(?=\s*(?:<p class="cp-updated"|<\/section>))/g;
const UPDATED_LINE = /<p class="cp-updated">[\s\S]*?<\/p>/g;
const SOURCES_PARAGRAPH = /<p>(?:Financial figures (?:are sourced from|for FY |checked against )|Available financial figures for FY )[\s\S]*?(?= See the <a href="\/methodology\.html">)/g;
const DESCRIPTION = /financial overview for \d{4}:[^"\r\n]*?\./g;
const SCHEMA_SCRIPT = /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g;

export async function syncCompanyPages({ client, rootDir = ROOT, write = false, now = new Date(), only = null }) {
  const today = now.toISOString().slice(0, 10);
  const reportsDir = path.join(rootDir, 'reports');
  let files = (await fs.readdir(reportsDir)).filter((file) => file.endsWith('-equity-report.html')).sort();
  if (only) files = files.filter((file) => only.includes(file));

  const { aliases, reviewedPages } = await wisdomReviews(rootDir);
  const results = [];
  const pages = [];
  for (const file of files) {
    const html = await fs.readFile(path.join(reportsDir, file), 'utf8');
    const page = readPage(file, html);
    if (!page.skip && reviewedPages.has(file)) page.skip = 'filing-reviewed page needs a person';
    if (!page.skip && !page.modelWording) page.skip = 'non-model source needs a person';
    if (!page.skip && !isCoveredTicker(page.ticker)) page.skip = 'listing is outside current coverage';
    if (page.skip) results.push({ file, status: 'skipped', reason: page.skip });
    else pages.push(page);
  }

  let errors = 0;
  await mapLimit(pages, CONCURRENCY, async (page) => {
    let company;
    try {
      const source = await client.findCompanyByTicker(aliases.get(page.file) || page.ticker);
      company = normalizeCompanyData(source, selectPrimaryModel(await client.getLatestActualModels(source)));
    } catch (error) {
      errors += 1;
      results.push({ file: page.file, ticker: page.ticker, status: 'error', reason: error.message });
      return;
    }
    const reason = skipReason(page, company);
    if (reason) {
      results.push({ file: page.file, ticker: page.ticker, status: 'skipped', reason });
      return;
    }
    const cells = metricDefinitions(company).map((metric) => metric.value);
    const riskyChange = unsafeCellChange(page.cells, cells);
    if (riskyChange) {
      results.push({ file: page.file, ticker: page.ticker, status: 'skipped', reason: riskyChange });
      return;
    }
    if (page.modelWording && company.financialYear === page.year && cells.every((value, index) => value === page.cells[index])) {
      results.push({ file: page.file, ticker: page.ticker, status: 'unchanged' });
      return;
    }
    results.push({
      file: page.file,
      ticker: page.ticker,
      status: 'update',
      from: { year: page.year, cells: page.cells },
      to: { year: company.financialYear, cells },
      next: updateHtml(page, company, today),
    });
  });

  results.sort((a, b) => a.file.localeCompare(b.file));
  const aborted = pages.length > 0 && errors / pages.length > MAX_ERROR_SHARE;
  const updates = results.filter((result) => result.status === 'update');
  if (write && !aborted && updates.length) {
    const sitemapPath = path.join(rootDir, 'sitemap.xml');
    let sitemap = await fs.readFile(sitemapPath, 'utf8');
    for (const update of updates) {
      await fs.writeFile(path.join(reportsDir, update.file), update.next, 'utf8');
      try { sitemap = updateSitemapDate(sitemap, `${SITE}/reports/${update.file}`, today); }
      catch { /* a page missing from the sitemap keeps its figures updated; the SEO guard reports it */ }
    }
    await fs.writeFile(sitemapPath, sitemap, 'utf8');
  }
  return { aborted, results: results.map(({ next, ...result }) => result) };
}

function unsafeCellChange(oldCells, newCells) {
  const labels = ['book value', 'share price', 'revenue', 'operating profit', 'net earnings', 'market capitalisation'];
  for (let i = 0; i < oldCells.length; i += 1) {
    if (oldCells[i] === newCells[i]) continue;
    if (oldCells[i] === 'N/A' || newCells[i] === 'N/A') return `${labels[i]} changes to or from N/A; check by hand`;
    // The live model recalculated net earnings for many FY2025 Nordic pages.
    // Even small changes can disagree with filings, so hold the entire page
    // until the model calculation has been reconciled.
    if (i === 4) return 'net earnings differs; check the model calculation';
    const previous = parseCell(oldCells[i]);
    const next = parseCell(newCells[i]);
    if (!previous || !next || previous.currency !== next.currency || previous.unit !== next.unit) {
      return `${labels[i]} has an unrecognised or changed unit; check by hand`;
    }
    const delta = Math.abs(next.value - previous.value);
    if ((previous.value === 0 && delta !== 0) || (previous.value !== 0 && delta / Math.abs(previous.value) > MAX_RELATIVE_CHANGE)) {
      return `${labels[i]} changes by more than 20%; check by hand`;
    }
  }
  return null;
}

function parseCell(cell) {
  const match = /^\s*(?:([A-Z]{3})\s+)?(-?[\d,]+(?:\.\d+)?)(m)?(?:\s+([A-Z]{3}))?\s*$/.exec(cell);
  if (!match || Boolean(match[1]) === Boolean(match[4])) return null;
  const value = Number(match[2].replaceAll(',', ''));
  if (!Number.isFinite(value)) return null;
  return { value, currency: match[1] || match[4], unit: match[3] || '' };
}

export function readPage(file, html) {
  if (/valuatum-page-mode/i.test(html)) return { skip: 'full report page' };
  if (/<strong>\s*Company status:\s*<\/strong>/i.test(html)) return { skip: 'company status page' };
  if (!/\bdata-generate-report\b/.test(html)) return { skip: 'no report order' };
  const schema = findSchema(html);
  const entity = schema?.node.mainEntity;
  if (!entity?.tickerSymbol || !entity.identifier) return { skip: 'no company identity in schema' };
  const sentence = [...html.matchAll(OVERVIEW_SENTENCE)];
  const grid = [...html.matchAll(GRID)];
  if (sentence.length !== 1 || grid.length !== 1) return { skip: 'unrecognised page layout' };
  const year = Number(sentence[0][0].match(/\d{4}/)[0]);
  const cells = [...grid[0][0].matchAll(/<span class="cp-v">([^<]*)<\/span>/g)].map((match) => match[1]);
  if (cells.length !== 6) return { skip: 'unrecognised metrics grid' };
  // A page whose figures came from a filing review says so; it returns to the model wording
  // even when the rounded figures happen to agree.
  const modelWording = sentence[0][0].includes("Valuatum's model shows") && !/checked against the|Available financial figures for FY/.test(html);
  return { file, html, ticker: entity.tickerSymbol, isin: String(entity.identifier).toUpperCase(), name: entity.name, year, cells, modelWording };
}

function skipReason(page, company) {
  if (isFinancialCompany(company)) return 'financial company';
  if (company.companyCode.toUpperCase() !== page.isin) return `Wisdom ISIN ${company.companyCode} differs from page ISIN ${page.isin}`;
  if (company.financialYear < page.year) return `Wisdom year ${company.financialYear} is older than page year ${page.year}`;
  // currentYear - 1 does not prove when a company's own fiscal year ended or
  // that its annual filing is published. Do not infer completion from a date.
  if (company.financialYear > page.year) return `Wisdom moves to FY ${company.financialYear}; verify the filing before updating`;
  if (company.metrics.revenue === null) return 'Wisdom has no revenue';
  return null;
}

export function updateHtml(page, company, today) {
  const name = page.name || company.companyName;
  let next = page.html.replace(OVERVIEW_SENTENCE, financialSentence(company));
  const grid = `<div class="cp-grid">${metricDefinitions(company).map((metric) => `<div class="cp-cell"><span class="cp-l">${metric.label}</span><span class="cp-v">${metric.value}</span><span class="cp-sub">${metric.sub}</span></div>`).join('')}</div>`;
  const line = `<p class="cp-updated">Figures updated from Valuatum's financial model on ${today}.</p>`;
  next = next.replace(GRID, grid);
  const metrics = next.match(/<section class="report-full-section" id="metrics">[\s\S]*?<\/section>/);
  const section = /<p class="cp-updated">/.test(metrics[0])
    ? metrics[0].replace(UPDATED_LINE, line)
    : metrics[0].replace(grid, `${grid}\n          ${line}`);
  next = next.replace(metrics[0], section);
  next = next.replace(SOURCES_PARAGRAPH, `<p>${sourcesSentence(company, name)}`);
  next = next.replace(DESCRIPTION, `financial overview for ${company.financialYear}: ${FINANCIAL_FIELDS}.`);
  const schema = findSchema(next);
  const dated = schema.raw.replace(/("@type": "WebPage",[\s\S]*?"dateModified": ")\d{4}-\d{2}-\d{2}(")/, `$1${today}$2`);
  return next.replace(schema.raw, dated);
}

// Some older pages show a ticker without its exchange suffix (AALLON for AALLON.HE). The filing
// reviews recorded the Wisdom ticker for those pages; the ISIN check still guards the match.
async function wisdomReviews(rootDir) {
  const aliases = new Map();
  const reviewedPages = new Set();
  const dir = path.join(rootDir, 'company-content', 'reviews');
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    const review = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    for (const entry of Array.isArray(review.pages) ? review.pages : []) {
      if (entry.path && entry.values && typeof entry.values === 'object') reviewedPages.add(path.basename(entry.path));
      if (entry.ticker && entry.pageTicker && entry.ticker !== entry.pageTicker && entry.path) {
        aliases.set(path.basename(entry.path), entry.ticker);
      }
    }
  }
  return { aliases, reviewedPages };
}

function findSchema(html) {
  for (const match of html.matchAll(SCHEMA_SCRIPT)) {
    try {
      const node = JSON.parse(match[1])['@graph']?.find((item) => item['@type'] === 'WebPage' && item.mainEntity);
      if (node) return { node, raw: match[1] };
    } catch { /* other JSON-LD blocks */ }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++]);
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const reportIndex = args.indexOf('--report');
  const onlyIndex = args.indexOf('--only');
  try {
    const client = new WisdomClient({
      baseUrl: process.env.WISDOM_API_BASE || 'https://wisdom.valuatum.com/rest',
      token: process.env.WISDOM_API_TOKEN,
    });
    const { aborted, results } = await syncCompanyPages({
      client,
      write,
      only: onlyIndex >= 0 ? args[onlyIndex + 1].split(',') : null,
    });
    const count = (status) => results.filter((result) => result.status === status).length;
    for (const result of results.filter((r) => r.status === 'update')) {
      console.log(`update  ${result.file}: FY ${result.from.year} [${result.from.cells.join(' | ')}] -> FY ${result.to.year} [${result.to.cells.join(' | ')}]`);
    }
    for (const result of results.filter((r) => r.status === 'skipped' || r.status === 'error')) {
      console.log(`${result.status.padEnd(7)} ${result.file}: ${result.reason}`);
    }
    console.log(`\n${count('update')} to update, ${count('unchanged')} unchanged, ${count('skipped')} skipped, ${count('error')} errors.${write ? '' : ' Dry run: no files written.'}`);
    if (reportIndex >= 0) await fs.writeFile(args[reportIndex + 1], `${JSON.stringify(results, null, 2)}\n`);
    if (aborted) throw new Error(`more than ${MAX_ERROR_SHARE * 100}% of Wisdom lookups failed; nothing written`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
