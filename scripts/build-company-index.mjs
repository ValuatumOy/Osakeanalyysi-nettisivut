#!/usr/bin/env node
// Build /companies.html and /companies/<letter>.html — a crawlable index of every page
// under /reports/.
//
// The hub previews each letter; letter pages link to every indexable company page
// with ordinary HTML links, independently of JavaScript search.
//
//   node scripts/build-company-index.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameText } from './same-text.mjs';
import { headlineOf } from './report-headline.mjs';
import { upsertUrl } from './seo-sitemap.mjs';
import { directoryBucket } from './company-pages/directory-bucket.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const CHECK = process.argv.includes('--check');
const n = (x) => x.toLocaleString('en-US');

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');

// ── collect ─────────────────────────────────────────────────────────────────
function collect() {
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'reports')).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, 'reports', f), 'utf8');
    if (/noindex/i.test((html.match(/<meta name="robots" content="([^"]*)"/) || [])[1] || '')) continue;
    const title = dec((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const m = title.match(/^(.*?)\s*\(([^)]+)\)\s*(?:Stock|Valuation)/);
    if (!m) continue;
    const h = headlineOf(html);
    out.push({
      slug: f.replace(/\.html$/, ''),
      name: m[1].trim(),
      ticker: m[2].trim(),
      mode: (html.match(/valuatum-page-mode" content="([a-z]+)"/) || [])[1] || 'company',
      rating: h ? h.recommendation : null,
      target: h && h.targetPrice ? String(h.targetPrice).replace(/\s+/g, ' ') : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

// ── shared chrome, lifted from the built pages so the index matches the site ──
const source = fs.readFileSync(path.join(ROOT, 'reports', 'tesla-equity-report.html'), 'utf8');
const chunk = (re, label) => {
  const m = source.match(re);
  if (!m) throw new Error(`could not lift ${label} out of the report template`);
  return m[0];
};
const HEAD_LINKS = (source.match(/<link rel="stylesheet"[^>]*>/g) || []).join('\n  ');
const GA = chunk(/<script async src="https:\/\/www\.googletagmanager\.com[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/, 'analytics');
// The report template marks Reports as the current page; these pages belong under Companies.
const NAV = chunk(/<header[\s\S]*?<\/header>/, 'header')
  .replace(/ is-active" aria-current="page">/g, '">')
  .replace(/(href="\/companies\.html" class="nav(?:-mobile)?-link)">/g, '$1 is-active" aria-current="page">');
const FOOTER = chunk(/<footer[\s\S]*?<\/footer>/, 'footer');
// analyst-reports.js is for a page about one company and no-ops anywhere else; an index
// page has no mount for it, so it is not worth the request.
const BODY_SCRIPTS = (source.match(/<script src="[^"]*"[^>]*><\/script>/g) || [])
  .filter((tag) => !tag.includes('analyst-reports.js'))
  .join('\n  ');

function page({ url, title, description, breadcrumbName, h1, intro, bodyHtml, listItems }) {
  const breadcrumbs = [
    { name: 'Home', url: `${SITE}/` },
    { name: 'Companies', url: `${SITE}/companies.html` },
    ...(breadcrumbName ? [{ name: breadcrumbName, url }] : []),
  ];
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: breadcrumbs.map((b, i) => ({
          '@type': 'ListItem', position: i + 1, name: b.name, item: b.url,
        })),
      },
      {
        '@type': 'CollectionPage',
        '@id': `${url}#index`,
        url,
        name: h1,
        description,
        breadcrumb: { '@id': `${url}#breadcrumb` },
        isPartOf: { '@type': 'WebSite', name: 'Valuatum AI Equity Reports', url: `${SITE}/` },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: listItems.length,
          itemListElement: listItems.map((item, i) => ({ '@type': 'ListItem', position: i + 1, ...item })),
        },
      },
    ],
  }, null, 2).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${attr(description)}">
  <link rel="canonical" href="${attr(url)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta property="og:title" content="${attr(title)}">
  <meta property="og:description" content="${attr(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${attr(url)}">
  <meta property="og:image" content="${SITE}/images/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${attr(title)}">
  <meta name="twitter:description" content="${attr(description)}">
  <meta name="twitter:image" content="${SITE}/images/og-image.png">
  ${GA}
  <script type="application/ld+json">
${jsonLd}
  </script>
  ${HEAD_LINKS}
  <style>
    .idx-wrap { max-width: 1100px; margin: 0 auto; padding: 0 var(--gap-lg, 1.5rem); }
    .idx-hero { padding: calc(var(--gap-xl, 3rem) * 1.2) 0 var(--gap-lg, 1.5rem); }
    .idx-hero p { max-width: 62ch; color: var(--gray-steel, #5b6570); }
    .idx-breadcrumb { display: flex; flex-wrap: wrap; gap: .5rem; padding: 0; margin: 0 0 1rem; list-style: none; font-size: .9rem; }
    .idx-breadcrumb li + li::before { content: '/'; margin-right: .5rem; color: var(--gray-steel, #5b6570); }
    .idx-alpha { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 var(--gap-xl, 3rem); padding: 0; list-style: none; }
    .idx-alpha a, .idx-alpha span {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 2.4rem; padding: .45rem .6rem; border: 1px solid var(--gray-mist, #dfe3e8);
      border-radius: 4px; text-decoration: none; font-weight: 500; font-size: .95rem;
    }
    .idx-alpha span { color: var(--gray-mist, #b9c0c8); border-style: dashed; }
    .idx-group { margin-bottom: var(--gap-xl, 3rem); }
    .idx-group h2 { font-size: 1.5rem; font-weight: 400; margin: 0 0 .9rem; }
    .idx-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0 1.5rem; }
    .idx-groups .idx-list { display: block; }
    .idx-list { list-style: none; margin: 0; padding: 0;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: .35rem 1.5rem; }
    .idx-list li { padding: .3rem 0; border-bottom: 1px solid var(--gray-mist, #eef1f4); }
    .idx-list a { text-decoration: none; }
    .idx-tk { color: var(--gray-steel, #7a828b); font-size: .85rem; margin-left: .4rem; }
    .idx-badge { font-size: .7rem; letter-spacing: .04em; text-transform: uppercase;
      padding: .1rem .35rem; border-radius: 3px; margin-left: .4rem; vertical-align: 1px; }
    .idx-badge.free { background: #e7f3ea; color: #1f6b34; }
    .idx-badge.rated { background: #eef1f6; color: #3c4a63; }
    @media (max-width: 640px) { .idx-list { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  ${NAV}
  <main>
    <section class="idx-wrap idx-hero">
      <nav aria-label="Breadcrumb">
        <ol class="idx-breadcrumb">
${breadcrumbs.map((b, i) => `          <li>${i === breadcrumbs.length - 1 ? `<span aria-current="page">${esc(b.name)}</span>` : `<a href="${attr(b.url.replace(SITE, '') || '/')}">${esc(b.name)}</a>`}</li>`).join('\n')}
        </ol>
      </nav>
      <h1 class="section-headline">${esc(h1)}</h1>
      <p>${intro}</p>
    </section>
    <section class="idx-wrap">
${bodyHtml}
    </section>
  </main>
  ${FOOTER}
  ${BODY_SCRIPTS}
</body>
</html>
`;
}

const item = (c) => {
  const badge = c.mode === 'free'
    ? '<span class="idx-badge free">Free report</span>'
    : c.rating ? `<span class="idx-badge rated">${esc(c.rating)}</span>` : '';
  return `        <li><a href="/reports/${attr(c.slug)}.html">${esc(c.name)}</a><span class="idx-tk">${esc(c.ticker)}</span>${badge}</li>`;
};

// ── build ───────────────────────────────────────────────────────────────────
const companies = collect();
const buckets = new Map();
for (const c of companies) {
  const b = directoryBucket(c.name);
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b).push(c);
}
const letters = [...buckets.keys()].sort((a, b) => (a === '0-9' ? -1 : b === '0-9' ? 1 : a.localeCompare(b)));
const slugOf = (l) => (l === '0-9' ? '0-9' : l.toLowerCase());

const alphaNav = (current) => `      <nav aria-label="Company initials">
      <ul class="idx-alpha">
${letters.map((l) => (l === current
    ? `        <li><span aria-current="page">${esc(l)}</span></li>`
    : `        <li><a href="/companies/${slugOf(l)}.html">${esc(l)}</a></li>`)).join('\n')}
      </ul>
      </nav>`;

const files = new Map();

// hub
files.set('companies.html', page({
  url: `${SITE}/companies.html`,
  title: `Company Index — ${n(companies.length)} Listed Companies | Valuatum`.slice(0, 60),
  description: `Every listed company with an AI equity analysis page on Valuatum: ${n(companies.length)} companies across the Nordics, Europe and the US, each with share price, valuation metrics and a report available on demand.`,
  breadcrumbName: '',
  h1: 'Company stock analysis A–Z',
  intro: `${n(companies.length)} listed companies have an analysis page here, each with share price, valuation metrics, a company profile and a fresh AI equity report available on demand. Pick a letter to browse, or <a href="/reports.html">see the reports ready to buy today</a>.`,
  bodyHtml: `${alphaNav(null)}
      <div class="idx-groups">
${letters.map((l) => `        <section class="idx-group">
          <h2>${esc(l)}</h2>
          <ul class="idx-list">
${buckets.get(l).slice(0, 3).map(item).join('\n')}
          </ul>
          <p><a href="/companies/${slugOf(l)}.html">All ${buckets.get(l).length} ${buckets.get(l).length === 1 ? 'company' : 'companies'} starting with ${esc(l)}</a></p>
        </section>`).join('\n')}
      </div>`,
  listItems: letters.map((l) => ({
    name: `All ${buckets.get(l).length} ${buckets.get(l).length === 1 ? 'company' : 'companies'} starting with ${l}`,
    url: `${SITE}/companies/${slugOf(l)}.html`,
  })),
}));

// one page per letter
for (const l of letters) {
  const list = buckets.get(l);
  files.set(path.join('companies', `${slugOf(l)}.html`), page({
    url: `${SITE}/companies/${slugOf(l)}.html`,
    title: `Companies starting with ${l} — Stock Analysis | Valuatum`.slice(0, 60),
    description: `${list.length} listed companies starting with ${l}, each with an AI equity analysis page: share price, valuation metrics, company profile and a report available on demand.`,
    breadcrumbName: l,
    h1: `Companies starting with ${l}`,
    intro: `${list.length} ${list.length === 1 ? 'company' : 'companies'} with an analysis page. Every page carries share price, valuation metrics and a company profile, and can generate a fresh AI equity report on demand.${list.some((c) => c.name.trim()[0].toUpperCase() !== l) && l !== '0-9' ? ' Names with accented or Nordic initials appear under their A–Z equivalent.' : ''}`,
    bodyHtml: `${alphaNav(l)}
      <div class="idx-group">
        <ul class="idx-list">
${list.map(item).join('\n')}
        </ul>
      </div>`,
    listItems: list.map((c) => ({ name: `${c.name} (${c.ticker})`, url: `${SITE}/reports/${c.slug}.html` })),
  }));
}

let stale = 0;
const changedFiles = new Set();
fs.mkdirSync(path.join(ROOT, 'companies'), { recursive: true });
for (const [rel, html] of files) {
  const abs = path.join(ROOT, rel);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (current !== null && sameText(current, html)) continue;
  stale++;
  changedFiles.add(rel);
  if (!CHECK) fs.writeFileSync(abs, html);
}

// ── sitemap ─────────────────────────────────────────────────────────────────
// The hub outranks the letter pages in usefulness to a crawler, so it gets the higher
// priority; both are above a single company page but below the storefront.
const sitemapFile = path.join(ROOT, 'sitemap.xml');
let xml = fs.readFileSync(sitemapFile, 'utf8');
const today = new Date().toISOString().slice(0, 10);
const lastmod = (rel) => !CHECK && changedFiles.has(rel) ? today : null;
xml = upsertUrl(xml, `${SITE}/companies.html`, { lastmod: lastmod('companies.html'), changefreq: 'weekly', priority: '0.8' });
for (const l of letters) {
  const rel = path.join('companies', `${slugOf(l)}.html`);
  xml = upsertUrl(xml, `${SITE}/companies/${slugOf(l)}.html`, { lastmod: lastmod(rel), changefreq: 'weekly', priority: '0.7' });
}
const sitemapStale = !sameText(xml, fs.readFileSync(sitemapFile, 'utf8'));
if (sitemapStale && !CHECK) fs.writeFileSync(sitemapFile, xml);

console.log(`${CHECK ? '[check] ' : ''}${files.size} index pages (${letters.length} letters, ${companies.length} companies), ${stale} ${CHECK ? 'out of date' : 'written'}${sitemapStale ? `, sitemap ${CHECK ? 'out of date' : 'updated'}` : ''}`);
if (CHECK && (stale || sitemapStale)) {
  console.error('Company index is out of date — run: node scripts/build-company-index.mjs');
  process.exit(1);
}
