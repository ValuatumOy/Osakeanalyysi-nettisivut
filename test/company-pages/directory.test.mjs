import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { directoryIdentity } from '../../scripts/company-pages/directory-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const site = 'https://www.aiequityreports.com';
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const letterFiles = fs.readdirSync(path.join(root, 'companies')).filter((file) => file.endsWith('.html'));
const companyLinks = (html) => [...html.matchAll(/<a href="(\/reports\/[^"#]+\.html)">/g)].map((match) => match[1]);
const decode = (text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

test('a long title without a ticker uses the company heading for discovery', () => {
  assert.deepEqual(
    directoryIdentity('An exceptionally long company name Stock Analysis', 'An exceptionally long company name (EXM) Stock Analysis & AI Equity Report'),
    { name: 'An exceptionally long company name', ticker: 'EXM' },
  );
});

test('every indexable company page has exactly one crawlable directory entry', () => {
  const links = letterFiles.flatMap((file) => companyLinks(read(`companies/${file}`)));
  const expected = fs.readdirSync(path.join(root, 'reports'))
    .filter((file) => file.endsWith('.html') && !/<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/i.test(read(`reports/${file}`)))
    .map((file) => `/reports/${file}`);
  assert.equal(new Set(links).size, links.length, 'a company must appear in only one letter list');
  assert.deepEqual([...links].sort(), expected.sort());
});

test('Nordic company initials appear under O rather than numbers', () => {
  for (const slug of ['orsted-equity-report', 'ossur-hf-equity-report']) {
    assert.ok(companyLinks(read('companies/o.html')).includes(`/reports/${slug}.html`));
    assert.ok(!companyLinks(read('companies/0-9.html')).includes(`/reports/${slug}.html`));
  }
  assert.match(read('companies/o.html'), /Names with accented or Nordic initials appear under their A–Z equivalent/);
});

test('the hub previews up to three companies from each letter with direct HTML links', () => {
  const hub = read('companies.html');
  const groups = [...hub.matchAll(/<section class="idx-group">([\s\S]*?)<\/section>/g)];
  assert.equal(groups.length, letterFiles.length);
  for (const [, group] of groups) {
    const letterUrl = group.match(/href="(\/companies\/[^"#]+\.html)"/)[1];
    const allLinks = companyLinks(read(letterUrl.slice(1)));
    assert.deepEqual(companyLinks(group), allLinks.slice(0, 3));
  }
  assert.ok(companyLinks(hub).length > 0);
});

test('collection and breadcrumb schema describe visible links on each directory page', () => {
  for (const file of ['companies.html', ...letterFiles.map((file) => `companies/${file}`)]) {
    const html = read(file);
    const url = `${site}/${file}`;
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
    const collection = graph.find((item) => item['@type'] === 'CollectionPage');
    const breadcrumb = graph.find((item) => item['@type'] === 'BreadcrumbList');
    assert.equal(collection.url, url, file);
    assert.equal(collection.breadcrumb['@id'], breadcrumb['@id'], file);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), file);
    const visibleBreadcrumb = html.match(/<nav aria-label="Breadcrumb">([\s\S]*?)<\/nav>/)[1];
    assert.equal((visibleBreadcrumb.match(/<li>/g) || []).length, breadcrumb.itemListElement.length, file);
    for (const [i, item] of breadcrumb.itemListElement.entries()) {
      assert.equal(item.position, i + 1, file);
      assert.ok(decode(visibleBreadcrumb).includes(item.name), file);
      if (i < breadcrumb.itemListElement.length - 1) {
        assert.ok(visibleBreadcrumb.includes(`href="${new URL(item.item).pathname}"`), file);
      }
    }
    const list = collection.mainEntity;
    assert.equal(list['@type'], 'ItemList', file);
    assert.equal(list.numberOfItems, list.itemListElement.length, file);
    if (file !== 'companies.html') assert.equal(list.numberOfItems, companyLinks(html).length, file);
    for (const [i, item] of list.itemListElement.entries()) {
      assert.equal(item.position, i + 1, file);
      assert.ok(item.url.startsWith(`${site}/`), file);
      assert.ok(html.includes(`href="${new URL(item.url).pathname}"`), `${file}: ${item.url} has a visible link`);
      assert.ok(fs.existsSync(path.join(root, new URL(item.url).pathname.slice(1))), item.url);
    }
  }
});
