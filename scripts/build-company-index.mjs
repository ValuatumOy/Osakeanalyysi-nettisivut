#!/usr/bin/env node
// Build /companies.html and /companies/<letter>.html — a crawlable index of every page
// under /reports/.
//
// reports.html is a storefront: it lists the ~16 ready reports that can be bought, and is
// right to. That left the other 1,158 company pages with no hub linking to them at all —
// 373 of them had no inbound link from anywhere on the site, so Google could only reach
// them through sitemap.xml. A sitemap tells a crawler a URL exists; it passes no context
// and no weight.
//
// The index is split by first letter so no single page carries 1,156 links, which would
// dilute each one to nothing. Crawl depth from the homepage is three clicks.
//
//   node scripts/build-company-index.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertUrl } from './seo-sitemap.mjs';

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
    const desc = dec((html.match(/<meta name="description" content="([\s\S]*?)">/) || [])[1] || '');
    const r = desc.match(/rates\s+\S+\s+([A-Z]+)\s+with a\s+([\d.,]+\s*[A-Z]{3})\s+price target/);
    out.push({
      slug: f.replace(/\.html$/, ''),
      name: m[1].trim(),
      ticker: m[2].trim(),
      mode: (html.match(/valuatum-page-mode" content="([a-z]+)"/) || [])[1] || 'company',
      rating: r ? r[1] : null,
      target: r ? r[2].replace(/\s+/g, ' ') : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** Group key: A–Z, or "0–9" for anything that does not start with a letter. */
const bucketOf = (name) => {
  const c = name.trim()[0]?.toUpperCase() ?? '#';
  return /[A-Z]/.test(c) ? c : '0-9';
};

// ── shared chrome, lifted from the built pages so the index matches the site ──
const source = fs.readFileSync(path.join(ROOT, 'reports', 'tesla-equity-report.html'), 'utf8');
const chunk = (re, label) => {
  const m = source.match(re);
  if (!m) throw new Error(`could not lift ${label} out of the report template`);
  return m[0];
};
const HEAD_LINKS = (source.match(/<link rel="stylesheet"[^>]*>/g) || []).join('\n  ');
const GA = chunk(/<script async src="https:\/\/www\.googletagmanager\.com[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/, 'analytics');
const NAV = chunk(/<header[\s\S]*?<\/header>/, 'header');
const FOOTER = chunk(/<footer[\s\S]*?<\/footer>/, 'footer');
const BODY_SCRIPTS = (source.match(/<script src="[^"]*"[^>]*><\/script>/g) || []).join('\n  ');

function page({ url, title, description, breadcrumbName, h1, intro, bodyHtml, extraJsonLd = [] }) {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Companies', item: `${SITE}/companies.html` },
          ...(breadcrumbName ? [{ '@type': 'ListItem', position: 3, name: breadcrumbName, item: url }] : []),
        ],
      },
      ...extraJsonLd,
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
    .idx-alpha { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 var(--gap-xl, 3rem); padding: 0; list-style: none; }
    .idx-alpha a, .idx-alpha span {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 2.4rem; padding: .45rem .6rem; border: 1px solid var(--gray-mist, #dfe3e8);
      border-radius: 4px; text-decoration: none; font-weight: 500; font-size: .95rem;
    }
    .idx-alpha span { color: var(--gray-mist, #b9c0c8); border-style: dashed; }
    .idx-group { margin-bottom: var(--gap-xl, 3rem); }
    .idx-group h2 { font-size: 1.5rem; font-weight: 400; margin: 0 0 .9rem; }
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
  const b = bucketOf(c.name);
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b).push(c);
}
const letters = [...buckets.keys()].sort((a, b) => (a === '0-9' ? -1 : b === '0-9' ? 1 : a.localeCompare(b)));
const slugOf = (l) => (l === '0-9' ? '0-9' : l.toLowerCase());

const alphaNav = (current) => `      <ul class="idx-alpha">
${letters.map((l) => (l === current
    ? `        <li><span aria-current="page">${esc(l)}</span></li>`
    : `        <li><a href="/companies/${slugOf(l)}.html">${esc(l)}</a></li>`)).join('\n')}
      </ul>`;

const files = new Map();

// hub
files.set('companies.html', page({
  url: `${SITE}/companies.html`,
  title: `Company Index — ${n(companies.length)} Listed Companies | Valuatum`.slice(0, 60),
  description: `Every listed company with an AI equity analysis page on Valuatum: ${n(companies.length)} companies across the Nordics, Europe and the US, each with share price, valuation metrics and a report available on demand.`,
  breadcrumbName: '',
  h1: 'Every company on this site',
  intro: `${n(companies.length)} listed companies have an analysis page here, each with share price, valuation metrics, a company profile and a fresh AI equity report available on demand. Pick a letter to browse, or <a href="/reports.html">see the reports ready to buy today</a>.`,
  bodyHtml: `${alphaNav(null)}
      <div class="idx-group">
${letters.map((l) => `        <p style="margin:.2rem 0;"><a href="/companies/${slugOf(l)}.html"><strong>${esc(l)}</strong></a> <span class="idx-tk">${buckets.get(l).length} ${buckets.get(l).length === 1 ? 'company' : 'companies'}</span></p>`).join('\n')}
      </div>`,
  extraJsonLd: [{
    '@type': 'CollectionPage',
    '@id': `${SITE}/companies.html#index`,
    name: 'Company index',
    description: `Index of ${n(companies.length)} listed companies with AI equity analysis pages.`,
    isPartOf: { '@type': 'WebSite', name: 'Valuatum AI Equity Reports', url: `${SITE}/` },
  }],
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
    intro: `${list.length} ${list.length === 1 ? 'company' : 'companies'} with an analysis page. Every page carries share price, valuation metrics and a company profile, and can generate a fresh AI equity report on demand.`,
    bodyHtml: `${alphaNav(l)}
      <div class="idx-group">
        <h2>${esc(l)}</h2>
        <ul class="idx-list">
${list.map(item).join('\n')}
        </ul>
      </div>`,
    extraJsonLd: [{
      '@type': 'CollectionPage',
      '@id': `${SITE}/companies/${slugOf(l)}.html#index`,
      name: `Companies starting with ${l}`,
      isPartOf: { '@type': 'WebSite', name: 'Valuatum AI Equity Reports', url: `${SITE}/` },
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: list.length,
        itemListElement: list.map((c, i) => ({
          '@type': 'ListItem', position: i + 1, name: `${c.name} (${c.ticker})`,
          url: `${SITE}/reports/${c.slug}.html`,
        })),
      },
    }],
  }));
}

let stale = 0;
fs.mkdirSync(path.join(ROOT, 'companies'), { recursive: true });
for (const [rel, html] of files) {
  const abs = path.join(ROOT, rel);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (current === html) continue;
  stale++;
  if (!CHECK) fs.writeFileSync(abs, html);
}

// ── sitemap ─────────────────────────────────────────────────────────────────
// The hub outranks the letter pages in usefulness to a crawler, so it gets the higher
// priority; both are above a single company page but below the storefront.
const sitemapFile = path.join(ROOT, 'sitemap.xml');
let xml = fs.readFileSync(sitemapFile, 'utf8');
xml = upsertUrl(xml, `${SITE}/companies.html`, { changefreq: 'weekly', priority: '0.8' });
for (const l of letters) {
  xml = upsertUrl(xml, `${SITE}/companies/${slugOf(l)}.html`, { changefreq: 'weekly', priority: '0.7' });
}
const sitemapStale = xml !== fs.readFileSync(sitemapFile, 'utf8');
if (sitemapStale && !CHECK) fs.writeFileSync(sitemapFile, xml);

console.log(`${CHECK ? '[check] ' : ''}${files.size} index pages (${letters.length} letters, ${companies.length} companies), ${stale} ${CHECK ? 'out of date' : 'written'}${sitemapStale ? `, sitemap ${CHECK ? 'out of date' : 'updated'}` : ''}`);
if (CHECK && (stale || sitemapStale)) {
  console.error('Company index is out of date — run: node scripts/build-company-index.mjs');
  process.exit(1);
}
