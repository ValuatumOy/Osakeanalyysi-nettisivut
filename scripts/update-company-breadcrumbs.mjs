#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directoryBreadcrumbHtml, directoryBreadcrumbItems } from './company-pages/directory-breadcrumb.mjs';
import { updateLastmods } from './seo-sitemap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAV = /<nav\s+aria-label="Breadcrumb"[^>]*>[\s\S]*?<\/nav>/i;
const JSON_LD = /(<script\s+type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/gi;

function decodeHtml(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value) => {
    if (value[0] !== '#') return named[value.toLowerCase()];
    const code = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

export function updateCompanyPage(html, file = 'company page') {
  const nav = html.match(NAV);
  const label = nav?.[0].match(/<span(?:\s[^>]*)?>([^<]+)<\/span>/i)?.[1];
  const url = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
  if (!nav || !label || !url) throw new Error(`${file}: missing breadcrumb name or canonical URL`);
  const name = decodeHtml(label);
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  let foundBreadcrumb = false;
  const next = html.replace(NAV, () => directoryBreadcrumbHtml(name).replace(/\n/g, newline)).replace(JSON_LD, (block, open, json, close) => {
    const data = JSON.parse(json);
    const graph = Array.isArray(data['@graph']) ? data['@graph'] : [data];
    const breadcrumb = graph.find((item) => item['@type'] === 'BreadcrumbList');
    if (!breadcrumb) return block;
    if (foundBreadcrumb) throw new Error(`${file}: multiple breadcrumb blocks`);
    foundBreadcrumb = true;
    breadcrumb.itemListElement = directoryBreadcrumbItems(name, url);
    for (const item of graph) {
      if (item['@type'] === 'AnalysisNewsArticle') delete item.isAccessibleForFree;
    }
    const formatted = JSON.stringify(data, null, 2).replace(/</g, '\\u003c').replace(/\n/g, newline);
    return `${open}${newline}${formatted}${newline}  ${close}`;
  });
  if (!foundBreadcrumb) throw new Error(`${file}: missing BreadcrumbList JSON-LD`);
  return next;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const dir = path.join(ROOT, 'reports');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.html'));
  const changes = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const current = fs.readFileSync(full, 'utf8');
    const updated = updateCompanyPage(current, file);
    if (updated !== current) {
      const loc = decodeHtml(updated.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)[1]);
      changes.push({ full, updated, loc });
    }
  }
  if (!check && changes.length) {
    for (const { full, updated } of changes) fs.writeFileSync(full, updated);
    const sitemapFile = path.join(ROOT, 'sitemap.xml');
    const xml = fs.readFileSync(sitemapFile, 'utf8');
    const updated = updateLastmods(xml, changes.map(({ loc }) => loc), new Date().toISOString().slice(0, 10));
    if (updated !== xml) fs.writeFileSync(sitemapFile, updated);
  }
  console.log(`${check ? '[check] ' : ''}${files.length} company pages, ${changes.length} ${check ? 'out of date' : 'updated'}`);
  if (check && changes.length) process.exitCode = 1;
}
