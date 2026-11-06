import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { directoryBucket, directoryPath } from '../../scripts/company-pages/directory-bucket.mjs';
import { renderCompanyPage } from '../../scripts/company-pages/render-company-page.mjs';
import { updateCompanyPage } from '../../scripts/update-company-breadcrumbs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const site = 'https://www.aiequityreports.com';
const schema = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];

test('Nordic and numerical names link to the same A–Z group as the directory', () => {
  for (const [name, letter, target] of [
    ['Ørsted', 'O', '/companies/o.html'],
    ['Össur', 'O', '/companies/o.html'],
    ['Ålandsbanken', 'A', '/companies/a.html'],
    ['Æsir', 'A', '/companies/a.html'],
    ['4C Group', '0-9', '/companies/0-9.html'],
  ]) {
    assert.equal(directoryBucket(name), letter);
    assert.equal(directoryPath(name), target);
  }
});

test('a newly generated company page has a matching visible and structured breadcrumb', () => {
  const company = {
    companyName: 'Ørsted A/S', ticker: 'ORSTED.CO', companyCode: 'DK0060094928',
    currency: 'DKK', financialYear: 2025, metrics: {}, profile: 'An energy company.',
  };
  const html = renderCompanyPage(company, [], new Date('2026-11-06'));
  assert.match(html, /href="\/companies\/o\.html"[^>]*>O<\/a>/);
  const crumb = schema(html).find((item) => item['@type'] === 'BreadcrumbList');
  assert.deepEqual(crumb.itemListElement.map((item) => item.name), ['Home', 'Companies', 'O', 'Ørsted']);
  assert.equal(crumb.itemListElement[2].item, `${site}/companies/o.html`);
  assert.equal(crumb.itemListElement[3].item, `${site}/reports/orsted-equity-report.html`);
  assert.equal(updateCompanyPage(html), html);
});

test('breadcrumb migration preserves replacement tokens in company names', () => {
  const company = {
    companyName: 'Example $& Company', ticker: 'EXM', companyCode: 'EXM',
    currency: 'USD', financialYear: 2025, metrics: {}, profile: 'A company.',
  };
  const html = renderCompanyPage(company, [], new Date('2026-11-06'));
  const updated = updateCompanyPage(html);
  assert.equal(updated, html);
  assert.equal((updated.match(/<nav aria-label="Breadcrumb"/g) || []).length, 1);
  assert.match(updated, /Example \$&amp; Company/);
});

test('every published company page links to its own directory entry and matching schema', () => {
  const dir = path.join(root, 'reports');
  const pages = fs.readdirSync(dir).filter((file) => file.endsWith('.html'));
  const directories = new Map();
  for (const file of pages) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    if (/<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/i.test(html)) continue;
    const nav = html.match(/<nav aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/)[1];
    const target = nav.match(/href="(\/companies\/(?:[a-z]|0-9)\.html)"/)[1];
    const crumb = schema(html).find((item) => item['@type'] === 'BreadcrumbList');
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
    assert.equal(crumb.itemListElement.length, 4, file);
    assert.equal(crumb.itemListElement[2].item, `${site}${target}`, file);
    assert.equal(crumb.itemListElement[3].item, canonical, file);
    if (!directories.has(target)) directories.set(target, fs.readFileSync(path.join(root, target.slice(1)), 'utf8'));
    assert.ok(directories.get(target).includes(`href="/reports/${file}"`), `${file} missing from ${target}`);
  }
});
