#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateSitemapDate } from './refresh-company-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function markHistoricalCompany(html, entry, today = new Date().toISOString().slice(0, 10)) {
  if (!/^reports\/[a-z0-9-]+-equity-report\.html$/.test(entry.file || '') || !entry.message || !entry.label || !/^https:\/\//.test(entry.source || '')) {
    throw new Error('Invalid historical company review');
  }
  if (/valuatum-page-mode/i.test(html) || !html.includes(`<link rel="canonical" href="${SITE}/${entry.file}">`)) throw new Error(`${entry.file}: not a matching company overview`);
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)];
  const pages = scripts.map((match) => { try { return { match, page: JSON.parse(match[1])['@graph']?.find((node) => node['@type'] === 'WebPage' && node.mainEntity) }; } catch { return null; } }).filter((item) => item?.page);
  const existing = /<strong>\s*Company status:\s*<\/strong>/i.test(html);
  if (pages.length !== 1 || pages[0].page.url !== `${SITE}/${entry.file}`) throw new Error(`${entry.file}: company identity does not match review`);
  const company = pages[0].page.mainEntity;
  if (!existing || entry.isin || entry.ticker) {
    if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(entry.isin || '') || !/^[A-Z0-9.-]+$/.test(entry.ticker || '') || company.name !== entry.name || company.identifier !== entry.isin || company.tickerSymbol !== entry.ticker) throw new Error(`${entry.file}: company identity does not match review`);
  }
  if (entry.successor && (!/^\/reports\/[a-z0-9-]+-equity-report\.html$/.test(entry.successor) || !entry.successorLabel)) throw new Error(`${entry.file}: invalid successor`);
  if (entry.additionalSource && (!/^https:\/\//.test(entry.additionalSource) || ((!existing || entry.isin) && !entry.additionalLabel))) throw new Error(`${entry.file}: invalid additional source`);
  if (existing) {
    if (!html.includes(esc(entry.message)) || !html.includes(esc(entry.source)) || /data-generate-report/i.test(html) || (entry.successor && !html.includes(`href="${entry.successor}"`)) || (entry.additionalSource && !html.includes(esc(entry.additionalSource)))) throw new Error(`${entry.file}: existing status differs from review`);
    const oldStatusLink = '<a href="#generate" class="btn btn-gold">View company status</a>';
    const statusLink = '<a href="#overview" class="btn btn-gold">View company status</a>';
    if (html.split(oldStatusLink).length === 2) return updateSchemaDate(html.replace(oldStatusLink, statusLink), pages[0].match[0], today, entry.file);
    if (html.split(statusLink).length !== 2) throw new Error(`${entry.file}: missing company status link`);
    return html;
  }
  const name = esc(company.name);
  const suffix = ` ${name} is covered by Valuatum but does not yet have a published AI equity report. Generate a fresh report to get `;
  const overview = html.match(/<section class="report-full-section" id="overview">[\s\S]*?<\/section>/g);
  if (overview?.length !== 1 || !overview[0].includes(suffix)) throw new Error(`${entry.file}: unexpected overview`);
  const shortened = overview[0].replace(new RegExp(` ${escapeRegex(name)} is covered by Valuatum but does not yet have a published AI equity report\\. Generate a fresh report to get [^<]*?\\.<\\/p>`), '</p>');
  if (shortened === overview[0]) throw new Error(`${entry.file}: cannot remove old report claim`);
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  const link = `<a href="${esc(entry.source)}">${esc(entry.label)}</a>`;
  const successor = entry.successor ? ` <a href="${entry.successor}">${esc(entry.successorLabel)}</a>.` : '';
  const additional = entry.additionalSource ? `; <a href="${esc(entry.additionalSource)}">${esc(entry.additionalLabel)}</a>` : '';
  const status = `<p><strong>Company status:</strong> ${esc(entry.message)} ${link}${additional}.${successor}</p>`;
  let result = html.replace(overview[0], shortened.replace(/\s*<\/section>$/, `${newline}          ${status}${newline}        </section>`));
  const sections = [...result.matchAll(/<section class="report-full-section" id="generate">[\s\S]*?<\/section>/g)];
  if (sections.length !== 1 || !/data-generate-report/.test(sections[0][0])) throw new Error(`${entry.file}: unexpected order section`);
  result = result.replace(sections[0][0], `<section class="report-full-section" id="generate">${newline}          <h2>Report availability</h2>${newline}          <p>A new report cannot be ordered from this historical company page.</p>${newline}        </section>`);
  const oldLink = '<a href="#generate" class="btn btn-gold">Generate fresh report &mdash; &euro;50.00</a>';
  if (result.split(oldLink).length !== 2) throw new Error(`${entry.file}: unexpected order link`);
  result = result.replace(oldLink, '<a href="#overview" class="btn btn-gold">View company status</a>');
  if (/data-generate-report|Generate fresh report &mdash; &euro;50\.00/.test(result)) throw new Error(`${entry.file}: order link remains`);
  return updateSchemaDate(result, pages[0].match[0], today, entry.file);
}

export async function markHistoricalCompanies({ review, rootDir = ROOT, write = false, today = new Date().toISOString().slice(0, 10) }) {
  if (!Array.isArray(review?.pages) || !review.pages.length) throw new Error('A historical company review is required');
  const prepared = [];
  const seen = new Set();
  for (const entry of review.pages) {
    if (seen.has(entry.file)) throw new Error(`Duplicate page: ${entry.file}`);
    seen.add(entry.file);
    if (!/^reports\/[a-z0-9-]+-equity-report\.html$/.test(entry.file || '')) throw new Error('Invalid historical company path');
    const file = path.join(rootDir, ...entry.file.split('/'));
    const previous = await fs.readFile(file, 'utf8');
    const next = markHistoricalCompany(previous, entry, today);
    if (entry.successor) await fs.access(path.join(rootDir, entry.successor.slice(1)));
    prepared.push({ entry, file, previous, next });
  }
  const changed = prepared.filter((page) => page.previous !== page.next);
  const sitemapPath = path.join(rootDir, 'sitemap.xml');
  const sitemap = await fs.readFile(sitemapPath, 'utf8');
  let nextSitemap = sitemap;
  for (const page of changed) nextSitemap = updateSitemapDate(nextSitemap, `${SITE}/${page.entry.file}`, today);
  if (write) {
    for (const page of changed) if (await fs.readFile(page.file, 'utf8') !== page.previous) throw new Error(`${page.entry.file}: page changed during review`);
    if (await fs.readFile(sitemapPath, 'utf8') !== sitemap) throw new Error('Sitemap changed during review');
    for (const page of changed) await fs.writeFile(page.file, page.next);
    if (nextSitemap !== sitemap) await fs.writeFile(sitemapPath, nextSitemap);
  }
  return changed.map((page) => page.entry.file);
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function updateSchemaDate(html, script, today, file) {
  const oldDate = /"dateModified":\s*"\d{4}-\d{2}-\d{2}"/;
  if (!oldDate.test(script) || !html.includes(script)) throw new Error(`${file}: missing schema modification date`);
  return html.replace(script, script.replace(oldDate, `"dateModified": "${today}"`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf('--manifest');
    const manifestPath = index < 0 ? null : args[index + 1];
    if (!manifestPath || args.filter((arg) => arg === '--manifest').length !== 1 || args.some((arg, i) => arg !== '--write' && arg !== '--manifest' && i !== index + 1)) throw new Error('Usage: npm run mark:historical-companies -- --manifest <path> [--write]');
    const review = JSON.parse(await fs.readFile(path.resolve(ROOT, manifestPath), 'utf8'));
    const changed = await markHistoricalCompanies({ review, write: args.includes('--write') });
    console.log(JSON.stringify({ changed }, null, 2));
  } catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
}
