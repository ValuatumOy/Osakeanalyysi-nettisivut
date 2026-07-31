import fs from 'node:fs/promises';
import path from 'node:path';
import { companyDisplayName, pageSlug } from './render-company-page.mjs';

const DEFAULT_SITE_ORIGIN = 'https://www.aiequityreports.com';

export async function publishCompanyDiscovery({
  companies,
  catalogPath,
  sitemapPath,
  generatedOn = new Date(),
  siteOrigin = DEFAULT_SITE_ORIGIN,
}) {
  if (!Array.isArray(companies) || companies.length === 0) return;
  const replacedUrls = await updateCompanyCatalog(catalogPath, companies);
  await updateSitemap(sitemapPath, companies, generatedOn, siteOrigin, replacedUrls);
}

export async function updateCompanyCatalog(catalogPath, companies) {
  const source = await fs.readFile(catalogPath, 'utf8');
  const match = source.match(/window\.COMPANY_PAGE_CATALOG\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error(`Could not parse company page catalog ${catalogPath}`);

  const existing = JSON.parse(match[1]);
  const incomingTickers = new Set(companies.map((company) => normalizeTicker(company.ticker)).filter(Boolean));
  const incomingUrls = new Set(companies.map((company) => normalizeUrl(`reports/${pageSlug(company)}.html`)));
  const replacedUrls = [];
  const byUrl = new Map();
  for (const entry of existing) {
    const key = normalizeUrl(entry?.url);
    const ticker = normalizeTicker(entry?.ticker);
    if (ticker && incomingTickers.has(ticker) && !incomingUrls.has(key)) {
      replacedUrls.push(entry.url);
      continue;
    }
    if (key && !byUrl.has(key)) byUrl.set(key, entry);
  }

  for (const company of companies) {
    const url = `reports/${pageSlug(company)}.html`;
    const key = normalizeUrl(url);
    const previous = byUrl.get(key) || {};
    byUrl.set(key, {
      ...previous,
      name: companyDisplayName(company),
      ticker: company.ticker,
      exchange: previous.exchange || company.exchange || exchangeFromTicker(company.ticker),
      url,
      description: company.profile,
    });
  }

  const catalog = [...byUrl.values()].sort((left, right) =>
    String(left.name || '').localeCompare(String(right.name || ''), 'en', { sensitivity: 'base' }));
  const output = `// Generated company pages available for direct search and report-card descriptions.\nwindow.COMPANY_PAGE_CATALOG = ${JSON.stringify(catalog, null, 2)};\n`;
  await writeFileAtomically(catalogPath, output);
  return replacedUrls;
}

export async function updateSitemap(
  sitemapPath,
  companies,
  generatedOn,
  siteOrigin = DEFAULT_SITE_ORIGIN,
  replacedUrls = [],
) {
  let xml = await fs.readFile(sitemapPath, 'utf8');
  const lastmod = toIsoDate(generatedOn);
  const origin = String(siteOrigin || DEFAULT_SITE_ORIGIN).replace(/\/+$/, '');

  for (const replacedUrl of replacedUrls) {
    const loc = `${origin}/${String(replacedUrl || '').replace(/^\/+/, '')}`;
    const blockPattern = sitemapBlockPattern(loc);
    xml = xml.replace(blockPattern, '');
  }

  for (const company of companies) {
    const loc = `${origin}/reports/${pageSlug(company)}.html`;
    const blockPattern = sitemapBlockPattern(loc);
    const existingBlock = xml.match(blockPattern)?.[0];

    if (existingBlock) {
      const updatedBlock = /<lastmod>[^<]*<\/lastmod>/i.test(existingBlock)
        ? existingBlock.replace(/<lastmod>[^<]*<\/lastmod>/i, `<lastmod>${lastmod}</lastmod>`)
        : existingBlock.replace(/<\/url>/i, `  <lastmod>${lastmod}</lastmod>\n  </url>`);
      xml = xml.replace(blockPattern, updatedBlock);
      continue;
    }

    const block = [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      '    <changefreq>monthly</changefreq>',
      '    <priority>0.8</priority>',
      '  </url>',
    ].join('\n');
    xml = xml.replace(/\s*<\/urlset>\s*$/i, `\n${block}\n</urlset>\n`);
  }

  await writeFileAtomically(sitemapPath, xml);
}

function exchangeFromTicker(ticker) {
  const suffix = String(ticker || '').toUpperCase().split('.').pop();
  const exchanges = {
    HE: 'Helsinki',
    ST: 'Stockholm',
    CO: 'Copenhagen',
    OL: 'Oslo',
    L: 'London',
    DE: 'Frankfurt',
    PA: 'Paris',
    AS: 'Amsterdam',
    MI: 'Milan',
    MC: 'Madrid',
    SW: 'Switzerland',
    TO: 'Toronto',
    AX: 'Australia',
    US: 'United States',
  };
  return exchanges[suffix] || 'Listed';
}

function normalizeUrl(value) {
  return String(value || '').replace(/^\/+/, '').trim().toLowerCase();
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function sitemapBlockPattern(loc) {
  return new RegExp(`\\s*<url>\\s*<loc>${escapeRegExp(loc)}<\\/loc>[\\s\\S]*?<\\/url>`, 'i');
}

function toIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('generatedOn must be a valid date');
  return date.toISOString().slice(0, 10);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writeFileAtomically(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}
