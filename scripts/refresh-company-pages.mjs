#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WisdomClient } from './company-pages/wisdom-client.mjs';
import { normalizeCompanyData, selectPrimaryModel } from './company-pages/normalize-company.mjs';
import { isFinancialCompany } from './company-pages/render-company-page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const KEYS = ['bookValue', 'sharePrice', 'revenue', 'ebit', 'netEarnings', 'marketCap'];

// The reviewed filing is authoritative; the model snapshot prevents a review
// from silently being reused after the underlying Wisdom data has changed.
export async function refreshCompanyPages({ manifest, client, rootDir = ROOT, write = false, now = new Date() }) {
  const today = isoDate(now);
  validateManifest(manifest, today);
  const prepared = [];
  const seen = new Set();

  for (const entry of manifest.pages) {
    if (seen.has(entry.path) || seen.has(entry.isin)) throw new Error(`Duplicate page or ISIN: ${entry.path}`);
    seen.add(entry.path);
    seen.add(entry.isin);
    const source = await client.findCompanyByTicker(entry.ticker);
    const company = normalizeCompanyData(source, selectPrimaryModel(await client.getLatestActualModels(source)));
    if (isFinancialCompany(company)) throw new Error(`${entry.ticker}: financial company requires a separate review`);
    if (company.companyCode.toUpperCase() !== (entry.modelIsin || entry.isin).toUpperCase()) {
      throw new Error(`${entry.ticker}: Wisdom ISIN does not match the reviewed company`);
    }
    if (company.financialYear !== (entry.modelFinancialYear || entry.financialYear) || company.currency !== entry.currency || company.marketCurrency !== entry.marketCurrency) {
      throw new Error(`${entry.ticker}: Wisdom year or currency changed; a new review is needed`);
    }
    for (const key of KEYS) {
      const expected = entry.modelSnapshot[key];
      const actual = company.metrics[key];
      if (expected === null ? actual !== null : actual === null || Math.abs(actual - expected) > 0.000001) {
        throw new Error(`${entry.ticker}: Wisdom ${key} changed; a new review is needed`);
      }
    }
    const file = path.join(rootDir, ...entry.path.split('/'));
    const previous = await fs.readFile(file, 'utf8');
    const next = refreshHtml(previous, entry, manifest.checkedOn, today);
    prepared.push({ entry, file, previous, next });
  }

  const changed = prepared.filter((page) => page.next !== page.previous);
  let sitemap;
  if (changed.length) {
    const sitemapPath = path.join(rootDir, 'sitemap.xml');
    const original = await fs.readFile(sitemapPath, 'utf8');
    let updated = original;
    for (const page of changed) updated = updateSitemapDate(updated, `${SITE}/${page.entry.path}`, today);
    sitemap = { file: sitemapPath, previous: original, next: updated };
  }

  if (write) {
    for (const page of changed) {
      if (await fs.readFile(page.file, 'utf8') !== page.previous) throw new Error(`${page.entry.path}: page changed during review`);
    }
    if (sitemap && await fs.readFile(sitemap.file, 'utf8') !== sitemap.previous) throw new Error('Sitemap changed during review');
    for (const page of changed) await writeAtomically(page.file, page.next);
    if (sitemap && sitemap.next !== sitemap.previous) await writeAtomically(sitemap.file, sitemap.next);
  }

  return prepared.map(({ entry, previous, next }) => ({
    path: entry.path,
    ticker: entry.ticker,
    financialYear: entry.financialYear,
    changed: previous !== next,
    differences: KEYS.filter((key) => entry.values[key] !== null && entry.values[key] !== entry.modelSnapshot[key]),
    unavailable: KEYS.filter((key) => entry.values[key] === null),
  }));
}

export function refreshHtml(html, entry, checkedOn, today) {
  if (/valuatum-page-mode/i.test(html)) throw new Error(`${entry.path}: full report pages cannot be refreshed as overviews`);
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  const scriptPattern = /(<script type="application\/ld\+json">\s*)([\s\S]*?)(\s*<\/script>)/g;
  const scripts = [...html.matchAll(scriptPattern)];
  const matching = scripts.filter((match) => {
    try { return JSON.parse(match[2])['@graph']?.some((node) => node['@type'] === 'WebPage' && node.mainEntity); }
    catch { return false; }
  });
  if (matching.length !== 1) throw new Error(`${entry.path}: expected one company WebPage schema`);
  const schema = JSON.parse(matching[0][2]);
  const page = schema['@graph'].find((node) => node['@type'] === 'WebPage' && node.mainEntity);
  if (String(page.mainEntity.identifier || '').toUpperCase() !== entry.isin.toUpperCase()) {
    throw new Error(`${entry.path}: existing page ISIN does not match the reviewed company`);
  }
  const expectedUrl = `${SITE}/${entry.path}`;
  if (page.url !== expectedUrl || !html.includes(`<link rel="canonical" href="${expectedUrl}">`)) {
    throw new Error(`${entry.path}: canonical URL does not match the existing page`);
  }
  const yearMatch = html.match(/For (?:the latest completed financial year, |financial year )(\d{4}), /);
  if (!yearMatch || Number(yearMatch[1]) > entry.financialYear) {
    throw new Error(`${entry.path}: current financial year is missing or newer than the review`);
  }
  for (const attribute of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
    const pattern = new RegExp(`<meta ${attribute} content="[^\"]*financial overview for \\d{4}:[^\"]*">`, 'g');
    if ([...html.matchAll(pattern)].length !== 1) throw new Error(`${entry.path}: missing financial description metadata`);
  }
  if (!/financial overview for \d{4}:/.test(page.description || '')) throw new Error(`${entry.path}: missing schema financial description`);
  const name = page.mainEntity.name;
  if (!name || !page.mainEntity.tickerSymbol) throw new Error(`${entry.path}: missing company identity`);
  if (page.mainEntity.tickerSymbol !== entry.pageTicker || !html.includes(`data-ticker="${entry.pageTicker}"`)) {
    throw new Error(`${entry.path}: existing ticker does not match the reviewed page`);
  }
  const { values: v, currency: c, marketCurrency: mc, financialYear: year } = entry;
  const sourceLabel = entry.sourceType === 'year-end-report' ? 'year-end report' : 'annual report';
  const fields = ['revenue'];
  if (v.ebit !== null) fields.push('EBIT');
  if (v.netEarnings !== null) fields.push('net earnings');
  if (v.bookValue !== null) fields.push('book value');
  if (v.sharePrice !== null) fields.push('year-end share price');
  if (v.marketCap !== null) fields.push('market capitalisation');
  const fieldList = fields.length === 1 ? fields[0] : `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}`;
  const profitSummary = v.ebit === null ? '' : ` and operating profit of ${money(v.ebit, c)}`;
  const marketFacts = [];
  if (v.sharePrice !== null) marketFacts.push(`the year-end share price was ${price(v.sharePrice, mc)}`);
  if (v.marketCap !== null) marketFacts.push(`market capitalisation was ${money(v.marketCap, mc)}`);
  const marketSummary = marketFacts.length ? `; ${marketFacts.join(' and ')}` : '';
  let next = html.replace(/financial overview for \d{4}:[^"\r\n]*?\./g, `financial overview for ${year}: ${fieldList}.`);
  next = replaceSection(next, 'overview', (section) => replaceOne(section,
    /For (?:the latest completed financial year, |financial year )\d{4}, [^<]*? revenue of (?:N\/A|[A-Z]{3} [-\d,.]+m)(?: and operating profit of (?:N\/A|[A-Z]{3} [-\d,.]+m))?(?:; (?:the year-end share price was (?:N\/A|[-\d,.]+ [A-Z]{3})(?: and market capitalisation was (?:N\/A|[A-Z]{3} [-\d,.]+m))?|market capitalisation was (?:N\/A|[A-Z]{3} [-\d,.]+m)))?\./g,
    `For financial year ${year}, ${esc(name)} reported revenue of ${money(v.revenue, c)}${profitSummary}${marketSummary}.`, entry.path));
  next = replaceSection(next, 'metrics', (section) => {
    const grid = `<div class="cp-grid">${[
      ['Book value', money(v.bookValue, c), `FY ${year}`],
      ['Share price', price(v.sharePrice, mc), `FY ${year} year end`],
      ['Revenue', money(v.revenue, c), `FY ${year}`],
      ['Operating profit', money(v.ebit, c), `FY ${year}`],
      ['Net earnings', money(v.netEarnings, c), `FY ${year}`],
      ['Market capitalisation', money(v.marketCap, mc), `FY ${year} year end`],
    ].map(([label, value, sub]) => `<div class="cp-cell"><span class="cp-l">${label}</span><span class="cp-v">${value}</span><span class="cp-sub">${sub}</span></div>`).join('')}</div>`;
    let updated = replaceOne(section, /<div class="cp-grid">[\s\S]*?<\/div>(?=\s*(?:<p class="cp-updated"|<\/section>))/g, grid, entry.path);
    const line = `<p class="cp-updated">Figures checked against the ${sourceLabel} on ${checkedOn}. Share price and market capitalisation are for the end of FY ${year}.</p>`;
    if (/<p class="cp-updated">/.test(updated)) {
      updated = replaceOne(updated, /<p class="cp-updated">[\s\S]*?<\/p>/g, line, entry.path);
    } else {
      updated = updated.replace(grid, `${grid}${newline}          ${line}`);
    }
    return updated;
  });
  next = replaceSection(next, 'sources', (section) => replaceOne(section,
    /<p>(?:Financial figures (?:are sourced from|for FY )|Available financial figures for FY )[\s\S]*?<\/p>/g,
    `<p>Available financial figures for FY ${year}, including any year-end share price and market capitalisation, are sourced from ${esc(name)}'s <a href="${esc(entry.sourceUrl)}">${sourceLabel}</a>.${entry.sourceNote ? ` ${esc(entry.sourceNote)}` : ''} See the <a href="/methodology.html">methodology</a> for the Valuatum AI equity research framework.</p>`, entry.path));
  if (next === html) return html;

  const updatedScript = [...next.matchAll(scriptPattern)].find((match) => {
    try { return JSON.parse(match[2])['@graph']?.some((node) => node['@type'] === 'WebPage' && node.mainEntity); }
    catch { return false; }
  });
  const updatedSchema = JSON.parse(updatedScript[2]);
  updatedSchema['@graph'].find((node) => node['@type'] === 'WebPage' && node.mainEntity).dateModified = today;
  const formattedSchema = JSON.stringify(updatedSchema, null, 2).replace(/</g, '\\u003c').replace(/\n/g, newline);
  return next.replace(updatedScript[0], `${updatedScript[1]}${formattedSchema}${updatedScript[3]}`);
}

function validateManifest(manifest, today) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.pages) || !manifest.pages.length) throw new Error('A version 1 manifest with reviewed pages is required');
  if (!validDate(manifest.checkedOn) || manifest.checkedOn > today) throw new Error('Manifest checkedOn must be a valid past or current date');
  for (const entry of manifest.pages) {
    if (!/^reports\/[a-z0-9-]+-equity-report\.html$/.test(entry.path || '')) throw new Error(`Invalid overview path: ${entry.path}`);
    if (!/^[A-Z0-9.-]+$/.test(entry.ticker || '') || !/^[A-Z0-9.-]+$/.test(entry.pageTicker || '') || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(entry.isin || '')) throw new Error(`Invalid ticker or ISIN: ${entry.path}`);
    if (entry.modelIsin && (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(entry.modelIsin) || !entry.identitySourceUrl)) throw new Error(`A different model ISIN requires identity evidence: ${entry.path}`);
    if (!Number.isInteger(entry.financialYear) || entry.financialYear > Number(today.slice(0, 4)) || !/^[A-Z]{3}$/.test(entry.currency || '') || !/^[A-Z]{3}$/.test(entry.marketCurrency || '')) throw new Error(`Invalid year or currency: ${entry.path}`);
    if (entry.sourceType !== undefined && !['annual-report', 'year-end-report'].includes(entry.sourceType)) throw new Error(`Invalid source type: ${entry.path}`);
    if (entry.modelFinancialYear !== undefined && (!Number.isInteger(entry.modelFinancialYear) || entry.modelFinancialYear > entry.financialYear)) throw new Error(`Invalid model year: ${entry.path}`);
    let source;
    try { source = new URL(entry.sourceUrl); } catch { throw new Error(`Invalid source URL: ${entry.path}`); }
    if (source.protocol !== 'https:') throw new Error(`Source URL must use HTTPS: ${entry.path}`);
    if (entry.identitySourceUrl) {
      try { if (new URL(entry.identitySourceUrl).protocol !== 'https:') throw new Error(); }
      catch { throw new Error(`Invalid identity source URL: ${entry.path}`); }
    }
    for (const key of KEYS) {
      const reviewed = entry.values?.[key];
      if (!(Number.isFinite(reviewed) || (reviewed === null && key !== 'revenue')) || !(entry.modelSnapshot?.[key] === null || Number.isFinite(entry.modelSnapshot?.[key]))) {
        throw new Error(`${entry.path}: reviewed and model values are required for ${key}`);
      }
    }
  }
}

function replaceSection(html, id, transform) {
  const pattern = new RegExp(`<section class="report-full-section" id="${id}">[\\s\\S]*?<\\/section>`, 'g');
  return replaceOne(html, pattern, (section) => transform(section), `section ${id}`);
}

function replaceOne(text, pattern, replacement, context) {
  if ([...text.matchAll(pattern)].length !== 1) throw new Error(`${context}: expected exactly one matching section`);
  return text.replace(pattern, replacement);
}

function updateSitemapDate(xml, loc, today) {
  const escaped = loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<url>\\s*<loc>${escaped}<\\/loc>[\\s\\S]*?<\\/url>`, 'g');
  return replaceOne(xml, pattern, (block) => replaceOne(block, /<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${today}</lastmod>`, loc), loc);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function isoDate(value) { return new Date(value).toISOString().slice(0, 10); }
function money(value, currency) {
  if (value === null) return 'N/A';
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 6 : 2;
  return `${currency} ${new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: digits }).format(value)}m`;
}
function price(value, currency) { return value === null ? 'N/A' : `${new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value)} ${currency}`; }
function esc(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
async function writeAtomically(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, value, 'utf8');
  await fs.rename(temp, file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      console.log('Usage: npm run refresh:companies -- --manifest PATH [--write]\nWithout --write, validates the complete pilot without changing files.');
    } else {
      const index = args.indexOf('--manifest');
      if (index < 0 || !args[index + 1] || args.some((arg, i) => i !== index && i !== index + 1 && arg !== '--write')) throw new Error('Use --manifest PATH and optionally --write');
      const manifest = JSON.parse(await fs.readFile(path.resolve(args[index + 1]), 'utf8'));
      const client = new WisdomClient({ baseUrl: process.env.WISDOM_API_BASE || 'https://wisdom.valuatum.com/rest', token: process.env.WISDOM_API_TOKEN });
      const results = await refreshCompanyPages({ manifest, client, write: args.includes('--write') });
      for (const result of results) console.log(`${result.changed ? 'update' : 'no change'} ${result.ticker} FY ${result.financialYear}: ${result.path}${result.differences.length ? ` (filing differs from model: ${result.differences.join(', ')})` : ''}${result.unavailable.length ? ` (unverified, shown as N/A: ${result.unavailable.join(', ')})` : ''}`);
      console.log(args.includes('--write') ? 'Reviewed pages written.' : 'Validation only; no files written.');
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
