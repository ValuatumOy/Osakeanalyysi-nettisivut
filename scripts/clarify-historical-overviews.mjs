#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateLastmods } from './seo-sitemap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function clarifyHistoricalOverview(html, cutoffYear, changedOn) {
  if (/valuatum-page-mode/i.test(html)) return null;
  const match = html.match(/For the latest completed financial year, (\d{4}), /);
  if (!match || Number(match[1]) > cutoffYear) return null;
  const year = Number(match[1]);
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  let updated = replaceOne(html,
    new RegExp(`For the latest completed financial year, ${year}, [^<]*? reported revenue of`, 'g'),
    `For financial year ${year}, Valuatum's model shows revenue of`);
  updated = replaceOne(updated,
    new RegExp(`represent the latest completed financial year \\(${year}\\)\\.`, 'g'),
    `represent financial year ${year}. These historical figures may not reflect the most recent results.`);
  updated = updated.replace(/Figures updated on (\d{4}-\d{2}-\d{2})\. Data will be refreshed during report generation\./g,
    'Financial model updated on $1.');

  const scripts = [...updated.matchAll(/(<script type="application\/ld\+json">\s*)([\s\S]*?)(\s*<\/script>)/g)];
  const matches = scripts.filter((script) => {
    try { return JSON.parse(script[2])['@graph']?.some((node) => node['@type'] === 'WebPage' && node.mainEntity); }
    catch { return false; }
  });
  if (matches.length !== 1) throw new Error('Expected one company WebPage schema');
  const schema = JSON.parse(matches[0][2]);
  const page = schema['@graph'].find((node) => node['@type'] === 'WebPage' && node.mainEntity);
  const canonical = updated.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  if (!canonical || page.url !== canonical) throw new Error('Canonical URL does not match the company schema');
  page.dateModified = changedOn;
  const formatted = JSON.stringify(schema, null, 2).replace(/</g, '\\u003c').replace(/\n/g, newline);
  updated = updated.replace(matches[0][0], `${matches[0][1]}${formatted}${matches[0][3]}`);
  return { html: updated, canonical, year };
}

function replaceOne(text, pattern, replacement) {
  if ([...text.matchAll(pattern)].length !== 1) throw new Error('Expected exactly one financial summary');
  return text.replace(pattern, replacement);
}

export async function clarifyHistoricalPages({ rootDir = ROOT, cutoffYear, changedOn, write = false }) {
  if (!Number.isInteger(cutoffYear) || !/^\d{4}-\d{2}-\d{2}$/.test(changedOn || '')) throw new Error('A cutoff year and change date are required');
  const dir = path.join(rootDir, 'reports');
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.html')).sort();
  const changes = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const original = await fs.readFile(file, 'utf8');
    try {
      const result = clarifyHistoricalOverview(original, cutoffYear, changedOn);
      if (result) changes.push({ file, original, ...result });
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    }
  }
  const sitemapPath = path.join(rootDir, 'sitemap.xml');
  const originalSitemap = await fs.readFile(sitemapPath, 'utf8');
  for (const change of changes) {
    if (!originalSitemap.includes(`<loc>${change.canonical}</loc>`)) throw new Error(`Missing sitemap URL ${change.canonical}`);
  }
  const sitemap = updateLastmods(originalSitemap, changes.map((change) => change.canonical), changedOn);
  if (write) {
    for (const change of changes) {
      if (await fs.readFile(change.file, 'utf8') !== change.original) throw new Error(`Page changed during review: ${change.file}`);
    }
    if (await fs.readFile(sitemapPath, 'utf8') !== originalSitemap) throw new Error('Sitemap changed during review');
    for (const change of changes) await writeAtomically(change.file, change.html);
    if (sitemap !== originalSitemap) await writeAtomically(sitemapPath, sitemap);
  }
  return changes.map(({ file, year }) => ({ file, year }));
}

async function writeAtomically(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--write')) throw new Error('Usage: node scripts/clarify-historical-overviews.mjs [--write]');
    const now = new Date();
    const changedOn = now.toISOString().slice(0, 10);
    const cutoffYear = now.getUTCFullYear() - 2;
    const changes = await clarifyHistoricalPages({ cutoffYear, changedOn, write: args.includes('--write') });
    console.log(`${changes.length} historical overview(s) through FY ${cutoffYear} ${args.includes('--write') ? 'clarified' : 'would be clarified'}; financial figures are unchanged.`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
