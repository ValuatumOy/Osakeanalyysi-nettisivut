#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WisdomClient, normalizeTicker } from './company-pages/wisdom-client.mjs';
import { normalizeCompanyData, selectPrimaryModel } from './company-pages/normalize-company.mjs';
import { getCompanyProfile } from './company-pages/profile-provider.mjs';
import { publishCompanyDiscovery } from './company-pages/publish-company-page.mjs';
import { isFinancialCompany, pageSlug, renderCompanyPage } from './company-pages/render-company-page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPORT_CATALOG_PATH = path.join(ROOT, 'report-content', '_catalog.json');
const DEFAULT_COMPANY_CATALOG_PATH = path.join(ROOT, 'js', 'companyPagesData.js');
const DEFAULT_SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');

export async function generateCompanyPages(options) {
  const outputDir = options.outputDir || path.join(ROOT, 'reports');
  const profileDir = options.profileDir || path.join(ROOT, 'company-content', 'profiles');
  const readyReports = options.readyReports || await loadReadyReports(options.reportCatalogPath || DEFAULT_REPORT_CATALOG_PATH);
  const freshness = options.freshness || (options.freshnessPath ? await loadModelFreshness(options.freshnessPath) : new Map());
  const client = options.client || new WisdomClient({
    baseUrl: options.apiBase || process.env.WISDOM_API_BASE || 'https://wisdom.valuatum.com/rest',
    token: options.apiToken || process.env.WISDOM_API_TOKEN,
  });

  const companies = [];
  const failures = [];

  for (const ticker of uniqueTickers(options.tickers)) {
    try {
      options.onProgress?.(`fetch  ${ticker}`);
      const sourceCompany = await client.findCompanyByTicker(ticker);
      const models = await client.getLatestActualModels(sourceCompany);
      const company = normalizeCompanyData(sourceCompany, selectPrimaryModel(models));

      if (isFinancialCompany(company)) {
        options.onProgress?.(`skip   ${ticker}: financial company, models do not apply`);
        continue;
      }

      options.onProgress?.(`profile ${ticker}`);
      const profileResult = await getCompanyProfile({
        company,
        cacheDir: profileDir,
        refresh: options.refreshAi,
        skipAi: options.skipAi,
        providerName: options.providerName,
        model: options.model,
        provider: options.profileProvider,
      });
      companies.push({
        ...company,
        profile: profileResult.profile,
        profileSource: profileResult.source,
        dataUpdated: freshness.get(normalizeTicker(company.ticker)) || null,
      });
    } catch (error) {
      failures.push({ ticker, error });
      options.onProgress?.(`error  ${ticker}: ${error.message}`);
    }
  }

  if (companies.length > 0) {
    await fs.mkdir(outputDir, { recursive: true });
    for (const company of companies) {
      const outputPath = path.join(outputDir, `${pageSlug(company)}.html`);
      const html = renderCompanyPage(company, companies, options.generatedOn || new Date(), {
        readyReport: findReadyReport(company, readyReports),
      });
      await writeFileAtomically(outputPath, html);
      options.onProgress?.(`wrote  ${path.relative(ROOT, outputPath)} (${company.profileSource})`);
    }
    if (options.updateDiscovery !== false) {
      await publishCompanyDiscovery({
        companies,
        catalogPath: options.companyCatalogPath || DEFAULT_COMPANY_CATALOG_PATH,
        sitemapPath: options.sitemapPath || DEFAULT_SITEMAP_PATH,
        generatedOn: options.generatedOn || new Date(),
        siteOrigin: options.siteOrigin,
      });
      options.onProgress?.('updated company catalog and sitemap');
    }
  }

  return { companies, failures };
}

function parseArgs(argv) {
  const options = { tickers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--refresh-ai') options.refreshAi = true;
    else if (arg === '--skip-ai') options.skipAi = true;
    else if (arg === '--skip-discovery') options.updateDiscovery = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--model') options.model = requiredOptionValue(argv, ++index, '--model');
    else if (arg.startsWith('--model=')) options.model = arg.slice('--model='.length);
    else if (arg === '--provider') options.providerName = requiredOptionValue(argv, ++index, '--provider');
    else if (arg.startsWith('--provider=')) options.providerName = arg.slice('--provider='.length);
    else if (arg === '--output-dir') options.outputDir = path.resolve(requiredOptionValue(argv, ++index, '--output-dir'));
    else if (arg.startsWith('--output-dir=')) options.outputDir = path.resolve(arg.slice('--output-dir='.length));
    else if (arg === '--freshness') options.freshnessPath = path.resolve(requiredOptionValue(argv, ++index, '--freshness'));
    else if (arg.startsWith('--freshness=')) options.freshnessPath = path.resolve(arg.slice('--freshness='.length));
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else options.tickers.push(...arg.split(','));
  }
  return options;
}

function requiredOptionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`);
  return value;
}

function uniqueTickers(tickers) {
  return [...new Set((tickers || []).map(normalizeTicker).filter(Boolean))];
}

async function loadReadyReports(catalogPath) {
  try {
    const raw = await readReportCatalog(catalogPath);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(report => report && report.availability !== 'hidden')
      .filter(report => report.pdfUrl || report.fileName)
      .filter(report => report.reportType !== 'fresh')
      .filter(report => Number(report.price) > 0 || report.isFree === true)
      .sort((a, b) => String(b.reportDate || '').localeCompare(String(a.reportDate || '')));
  } catch {
    return [];
  }
}

// Reads a tab-separated export with TICKER and model_updated columns and returns a
// Map from normalized ticker to the data freshness date (YYYY-MM-DD). The model
// version/freshness is not available from the Wisdom REST API, so it is supplied
// out of band via this file.
async function loadModelFreshness(freshnessPath) {
  const lines = (await fs.readFile(freshnessPath, 'utf8')).split(/\r?\n/).filter((line) => line.trim());
  const header = (lines[0] || '').split('\t');
  const tickerCol = header.indexOf('TICKER');
  const updatedCol = header.indexOf('model_updated');
  if (tickerCol === -1 || updatedCol === -1) {
    throw new Error(`Freshness file ${freshnessPath} must have TICKER and model_updated columns`);
  }
  const freshness = new Map();
  for (const line of lines.slice(1)) {
    const columns = line.split('\t');
    const ticker = normalizeTicker(columns[tickerCol]);
    const date = String(columns[updatedCol] || '').trim().slice(0, 10);
    if (ticker && /^\d{4}-\d{2}-\d{2}$/.test(date)) freshness.set(ticker, date);
  }
  return freshness;
}

async function readReportCatalog(catalogPath) {
  return JSON.parse(await fs.readFile(catalogPath, 'utf8'));
}

function findReadyReport(company, readyReports) {
  const companyTicker = normalizeTicker(company.ticker);
  const companyCode = normalizeName(company.companyName);
  return readyReports.find((report) => {
    if (companyTicker && normalizeTicker(report.ticker) === companyTicker) return true;
    return companyCode && normalizeName(report.companyName || report.name) === companyCode;
  }) || null;
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function writeFileAtomically(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}

function printHelp() {
  console.log(`Usage: node scripts/generate-company-pages.mjs [options] TICKER [TICKER ...]

Options:
  --model MODEL       Codex model (default: AI_MODEL or gpt-5.4-mini)
  --provider NAME     AI provider (default: AI_PROVIDER or codex)
  --refresh-ai        Regenerate cached company profiles
  --skip-ai           Use cache or Wisdom background without calling AI
  --skip-discovery    Do not update companyPagesData.js or sitemap.xml
  --output-dir PATH   HTML output directory (default: reports)
  --freshness PATH    TSV with TICKER and model_updated columns for data freshness
  -h, --help          Show this help

Environment:
  WISDOM_API_BASE     Wisdom REST base URL
  WISDOM_API_TOKEN    Wisdom bearer token (required)
  AI_PROVIDER         Profile provider (currently codex)
  AI_MODEL            Codex model override
  AI_REASONING_EFFORT Codex reasoning effort (default: low)
  CODEX_BIN           Codex CLI executable (default: codex)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exitCode = 0;
    } else if (options.tickers.length === 0) {
      printHelp();
      process.exitCode = 1;
    } else {
      const result = await generateCompanyPages({ ...options, onProgress: console.log });
      console.log(`\nGenerated ${result.companies.length} page(s); ${result.failures.length} failed.`);
      process.exitCode = result.failures.length > 0 ? 1 : 0;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
