#!/usr/bin/env node
// Generates static, indexable head-to-head comparison pages ("X vs Y stock comparison")
// for every pair of same-sector companies that have extracted report content.
// "X vs Y" pages capture the highest share of AI/SEO citations — fully templated, data-only, so they scale.
// Run: node scripts/build-comparison-pages.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLiveCatalog } from './live-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const CONTENT_DIR = path.join(ROOT, 'report-content');
const OUT_DIR = path.join(ROOT, 'compare');
const TODAY = '2026-06-08';

const EXCLUDE = new Set(['nuholdings-02062026']);

// Force the nav into its solid/readable state on these pages (don't rely on the
// transparent-over-dark-hero scroll trick — guarantees the links are visible at the top).
const NAV_SOLID_CSS = `    .nav{background:rgba(255,255,255,0.97);backdrop-filter:blur(12px);border-bottom-color:var(--color-border);}
    .nav .nav-logo-wordmark{color:var(--charcoal);}
    .nav .nav-logo-sub{color:var(--gray-steel);}
    .nav .nav-link{color:var(--gray-steel);}
    .nav .nav-link:hover{color:var(--charcoal);}`;

// ── helpers (kept in sync with scripts/report-pages/render.mjs) ───────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (s) => esc(s);
const shortName = (n) => String(n).replace(/,?\s+(Inc\.?|Oyj|Ltd\.?|plc|Corporation|Corp\.?|AB|ASA|N\.V\.|S\.A\.|Group|Holdings?)$/i, '').trim();
const firstNum = (s) => { const m = String(s).match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const recClass = (r) => ({ BUY: 'pos', SELL: 'neg', HOLD: '' }[String(r || '').toUpperCase()] ?? '');
const cmpStem = (name) => shortName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const compareSlug = (a, b) => [cmpStem(a), cmpStem(b)].sort().join('-vs-') + '-stock-comparison';

async function loadCatalog() {
  const byId = {};
  for (const r of await fetchLiveCatalog()) byId[r.id] = r;
  return byId;
}

function navHtml() {
  return `  <header class="nav scrolled" id="nav">
    <div class="nav-inner">
      <a href="/index.html" class="nav-logo">
        <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
        <div class="nav-logo-text">
          <span class="nav-logo-wordmark" style="color:var(--charcoal);">Valuatum</span>
          <span class="nav-logo-sub" style="color:var(--gray-steel);">AI Equity Reports</span>
        </div>
      </a>
      <nav class="nav-links" aria-label="Main navigation">
        <a href="/reports.html" class="nav-link">Reports</a>
        <a href="/report-store.html" class="nav-link">Store</a>
        <a href="/pricing.html" class="nav-link">Pricing</a>
        <a href="/analysts.html" class="nav-link">Analysts</a>
        <details class="nav-more">
          <summary class="nav-link">More</summary>
          <div class="nav-more-menu">
            <a href="/methodology.html" class="nav-link">Methodology</a>
            <a href="/about.html" class="nav-link">About</a>
            <a href="/faq.html" class="nav-link">FAQ</a>
            <a href="/blog.html" class="nav-link">Blog</a>
          </div>
        </details>
      </nav>
      <a href="/members.html" class="nav-signin">Sign in</a>
      <a href="/reports.html" class="nav-cta">Browse reports</a>
      <button class="nav-hamburger" aria-label="Open menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>
    <div class="nav-mobile-menu" id="mobileMenu" style="display:none;">
      <a href="/index.html" class="nav-mobile-link">Home</a>
      <a href="/reports.html" class="nav-mobile-link">Reports</a>
      <a href="/report-store.html" class="nav-mobile-link">Store</a>
      <a href="/pricing.html" class="nav-mobile-link">Pricing</a>
      <a href="/methodology.html" class="nav-mobile-link">Methodology</a>
      <a href="/about.html" class="nav-mobile-link">About</a>
      <a href="/faq.html" class="nav-mobile-link">FAQ</a>
      <a href="/blog.html" class="nav-mobile-link">Blog</a>
      <a href="/analysts.html" class="nav-mobile-link">Analysts</a>
      <a href="/members.html" class="nav-mobile-link">Sign in</a>
    </div>
  </header>`;
}

function footerHtml() {
  return `  <footer class="footer">
    <div class="container">
      <div class="footer-bottom" style="border:0;">
        <span class="footer-copyright">© 2026 Valuatum Oy · Helsinki, Finland · Est. 2000</span>
        <span class="footer-disclaimer">Reports are AI-generated research materials for informational purposes only. Not investment advice.</span>
      </div>
    </div>
  </footer>`;
}

// CTA per company: free report -> read full; paid -> preview + buy.
function companyCta(d, cat) {
  const sn = shortName(d.companyName);
  if (cat.isFree) {
    return `<a href="/reports/${d.slug}.html" class="btn btn-primary">Read the free ${esc(sn)} report</a>`;
  }
  const price = cat.price ? `€${Number(cat.price).toFixed(2)}` : '';
  return `<a href="/reports/${d.slug}.html" class="btn btn-outline">Preview ${esc(sn)} report</a>
            <a href="/reports.html#report-${esc(d.id)}" class="btn btn-primary">Buy ${esc(sn)} report${price ? ` — ${price}` : ''}</a>`;
}

function poolBars(pools) {
  if (!Array.isArray(pools) || !pools.length) return '<p style="color:var(--gray-steel); font-size:var(--text-sm);">See the report for the segment-value breakdown.</p>';
  const colors = ['var(--green)', 'var(--green-light)', 'var(--green-deep)', 'var(--charcoal-mid)', 'var(--gray-steel)', 'var(--forest)'];
  return `<div class="segment-value-chart" style="margin:0.5rem 0 0;">${pools.slice(0, 5).map((p, i) => {
    const pct = firstNum(p.share);
    if (pct === null) return '';
    return `<div class="pool-row"><span class="pool-name" style="min-width:160px;">${esc(p.name)}</span><div class="pool-track"><div class="pool-fill" style="width:${Math.max(0, Math.min(100, pct))}%; background:${colors[i % colors.length]};"></div></div><span class="pool-pct">${esc(String(p.share).split('·')[0].trim())}</span></div>`;
  }).join('')}</div>`;
}

function metricRow(label, a, b, opts = {}) {
  const cell = (v) => {
    if (v == null || v === '' || v === 'undefined') return '<td class="num">—</td>';
    if (opts.raw) return `<td class="num">${v}</td>`;
    const cls = opts.cls ? opts.cls(v) : '';
    return `<td class="num ${cls}">${esc(v)}</td>`;
  };
  return `<tr><td>${esc(label)}</td>${cell(a)}${cell(b)}</tr>`;
}

const upsideCls = (v) => { const n = firstNum(v); return n == null ? '' : (n < 0 ? 'neg' : 'pos'); };

function comparisonTable(A, B) {
  const ha = A.d.headline || {}, hb = B.d.headline || {};
  const rows = [
    metricRow('Recommendation',
      `<span class="num ${recClass(ha.recommendation)}">${esc(ha.recommendation || '—')}</span>`,
      `<span class="num ${recClass(hb.recommendation)}">${esc(hb.recommendation || '—')}</span>`,
      { raw: true }),
    metricRow('12-month price target', ha.targetPrice, hb.targetPrice),
    metricRow('Current price', ha.currentPrice, hb.currentPrice),
    metricRow('Implied upside', ha.impliedUpside, hb.impliedUpside, { cls: upsideCls }),
    metricRow('Market cap', ha.marketCap, hb.marketCap),
    metricRow('Enterprise value', ha.enterpriseValue, hb.enterpriseValue),
  ];
  // Union of multiple labels, in A's order then any extra from B.
  const ma = A.d.multiples || [], mb = B.d.multiples || [];
  const labels = [...ma.map(m => m.label)];
  for (const m of mb) if (!labels.includes(m.label)) labels.push(m.label);
  const valOf = (arr, label) => { const f = arr.find(m => m.label === label); return f ? f.value : null; };
  for (const label of labels) rows.push(metricRow(label, valOf(ma, label), valOf(mb, label)));
  // header cells use the recommendation strings, not escaped HTML — build manually
  const head = `<tr><th>Metric</th><th class="num">${esc(shortName(A.d.companyName))} (${esc(A.d.ticker)})</th><th class="num">${esc(shortName(B.d.companyName))} (${esc(B.d.ticker)})</th></tr>`;
  return `<div class="cp-scroll"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`;
}

// Neutral, factual verdict generated from the data (no hand-written opinion).
function verdict(A, B) {
  const sa = shortName(A.d.companyName), sb = shortName(B.d.companyName);
  const ua = firstNum((A.d.headline || {}).impliedUpside), ub = firstNum((B.d.headline || {}).impliedUpside);
  const ra = (A.d.headline || {}).recommendation, rb = (B.d.headline || {}).recommendation;
  let s = `On Valuatum's current AI equity reports, ${sa} (${A.d.ticker}) is rated ${ra || 'n/a'} and ${sb} (${B.d.ticker}) is rated ${rb || 'n/a'}. `;
  if (ua != null && ub != null) {
    if (ua === ub) s += `Both screen with a similar ${ua}% implied upside to the 12-month price target. `;
    else {
      const win = ua > ub ? sa : sb, hi = Math.max(ua, ub), lo = Math.min(ua, ub);
      s += `${win} screens with the higher implied upside to its price target (${hi}% versus ${lo}%). `;
    }
  }
  s += `The full reasoning — segment-value allocation, reverse valuation, financial forecasts, risks and catalysts — is in each company's report below. This is AI-generated research for information only, not investment advice.`;
  return s;
}

function faqHtml(A, B) {
  const sa = shortName(A.d.companyName), sb = shortName(B.d.companyName);
  const ha = A.d.headline || {}, hb = B.d.headline || {};
  const ua = firstNum(ha.impliedUpside), ub = firstNum(hb.impliedUpside);
  const better = (ua != null && ub != null) ? (ua === ub ? null : (ua > ub ? sa : sb)) : null;
  const faqs = [
    { q: `${sa} vs ${sb}: which stock has more upside?`, a: better
        ? `${better} currently screens with the higher implied upside to Valuatum's 12-month price target. See the comparison table above for both targets, recommendations and valuation multiples.`
        : `Both ${sa} and ${sb} screen with a similar implied upside on Valuatum's current price targets. See the comparison table above for the full breakdown.` },
    { q: `Is ${sa} (${A.d.ticker}) a buy or a sell?`, a: `Valuatum's latest AI equity report rates ${sa} ${ha.recommendation || 'n/a'}${ha.targetPrice ? `, with a ${ha.targetPrice} 12-month price target` : ''}${ha.currentPrice ? ` versus a ${ha.currentPrice} share price` : ''}. Read the ${sa} report for the rationale.` },
    { q: `Is ${sb} (${B.d.ticker}) a buy or a sell?`, a: `Valuatum's latest AI equity report rates ${sb} ${hb.recommendation || 'n/a'}${hb.targetPrice ? `, with a ${hb.targetPrice} 12-month price target` : ''}${hb.currentPrice ? ` versus a ${hb.currentPrice} share price` : ''}. Read the ${sb} report for the rationale.` },
    { q: `How are ${sa} and ${sb} valued?`, a: `Both companies are valued with Valuatum's segment-value analysis and a reverse valuation (a DCF-style framework), with segment financial estimates, key ratios, risks and catalysts in each report.` },
  ];
  return { html: faqs.map(f => `
        <div style="border-bottom:1px solid var(--color-border); padding:1.1rem 0;">
          <h3 style="font-size:var(--text-md); margin:0 0 0.4rem;">${esc(f.q)}</h3>
          <p style="margin:0;">${esc(f.a)}</p>
        </div>`).join(''), faqs };
}

function jsonLd(A, B, url, desc, faqs) {
  const sa = shortName(A.d.companyName), sb = shortName(B.d.companyName);
  const graph = [
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Reports', item: `${SITE}/reports.html` },
        { '@type': 'ListItem', position: 3, name: `${sa} vs ${sb}`, item: url },
      ],
    },
    {
      '@type': 'Article',
      '@id': url + '#article',
      headline: `${sa} (${A.d.ticker}) vs ${sb} (${B.d.ticker}): Stock Comparison`,
      description: desc,
      datePublished: TODAY,
      dateModified: TODAY,
      inLanguage: 'en',
      author: { '@type': 'Organization', name: 'Valuatum', url: 'https://valuatum.com' },
      mainEntityOfPage: url,
      about: [
        { '@type': 'Corporation', name: A.d.companyName, tickerSymbol: A.d.ticker },
        { '@type': 'Corporation', name: B.d.companyName, tickerSymbol: B.d.ticker },
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
  ];
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2);
}

function renderPage(A, B) {
  const sa = shortName(A.d.companyName), sb = shortName(B.d.companyName);
  const slug = compareSlug(A.d.companyName, B.d.companyName);
  const url = `${SITE}/compare/${slug}.html`;
  const title = `${sa} vs ${sb} (${A.d.ticker} vs ${B.d.ticker}) Stock Comparison — Ratings, Price Targets & Valuation | Valuatum`;
  const desc = `${sa} (${A.d.ticker}) vs ${sb} (${B.d.ticker}) stock comparison: AI equity ratings, 12-month price targets, implied upside, valuation multiples and segment-value analysis side by side.`;
  const ha = A.d.headline || {}, hb = B.d.headline || {};
  const { html: faqs, faqs: faqList } = faqHtml(A, B);
  const intro = `Compare ${sa} (${A.d.exchange ? A.d.exchange + ': ' : ''}${A.d.ticker}) and ${sb} (${B.d.exchange ? B.d.exchange + ': ' : ''}${B.d.ticker}) side by side. Both are ${A.d.sector || ''} stocks covered by Valuatum's AI equity research. This comparison puts their recommendations, 12-month price targets, implied upside, valuation multiples and segment-value allocation in one view.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${attr(desc)}">
  <link rel="canonical" href="${url}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta property="og:title" content="${attr(title)}">
  <meta property="og:description" content="${attr(desc)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE}/images/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-HSRL85C0K5"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-HSRL85C0K5');</script>
  <script type="application/ld+json">
${jsonLd(A, B, url, desc, faqList)}
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <style>
    .cp-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
    .cp-scroll table{white-space:nowrap;min-width:100%;}
    .vs-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem;}
    @media(max-width:640px){.vs-grid{grid-template-columns:1fr;}}
${NAV_SOLID_CSS}
  </style>
</head>
<body>
${navHtml()}

  <main class="report-full-page">
    <section class="report-company-header">
      <div class="container">
        <nav aria-label="Breadcrumb" style="font-size:var(--text-xs); color:rgba(255,255,255,0.6); margin-bottom:1rem;">
          <a href="/" style="color:rgba(255,255,255,0.7);">Home</a> ›
          <a href="/reports.html" style="color:rgba(255,255,255,0.7);">Reports</a> ›
          <span>${esc(sa)} vs ${esc(sb)}</span>
        </nav>
        <div class="company-header-inner">
          <div class="company-ident">
            <h1 class="company-name">${esc(sa)} vs ${esc(sb)}: Stock Comparison &amp; AI Equity Analysis</h1>
            <div class="company-meta">
              <span class="company-meta-chip">${esc(A.d.exchange)} / ${esc(B.d.exchange)}</span>
              <span class="company-meta-sep"></span>
              <span class="company-meta-chip">${esc(A.d.sector)}</span>
            </div>
          </div>
          <div class="company-header-actions">
            <a href="/reports.html" class="btn btn-outline" style="border-color:rgba(255,255,255,0.3); color:white; font-size:var(--text-xs);">Browse all reports</a>
            <a href="/index.html#hero" class="btn btn-outline" style="border-color:rgba(255,255,255,0.3); color:white; font-size:var(--text-xs);">Generate a report</a>
          </div>
        </div>
      </div>
    </section>

    <div class="container" style="max-width:880px; padding-top:2.5rem; padding-bottom:3rem;">
      <div class="report-full-content">
        <section class="report-full-section" id="overview">
          <h2>${esc(sa)} vs ${esc(sb)} — overview</h2>
          <p>${esc(intro)}</p>
        </section>

        <section class="report-full-section" id="comparison">
          <h2>Ratings, price targets &amp; valuation — side by side</h2>
          ${comparisonTable(A, B)}
        </section>

        <section class="report-full-section" id="segment-values">
          <h2>Value driver comparison</h2>
          <p>How each company's enterprise value is allocated across its businesses, from Valuatum's <a href="/methodology.html">segment value analysis</a>.</p>
          <div class="vs-grid">
            <div><h3 style="margin-top:0;">${esc(sa)}</h3>${poolBars(A.d.valuePools)}</div>
            <div><h3 style="margin-top:0;">${esc(sb)}</h3>${poolBars(B.d.valuePools)}</div>
          </div>
        </section>

        <section class="report-full-section" id="verdict">
          <h2>${esc(sa)} or ${esc(sb)}: which is the better buy?</h2>
          <p>${esc(verdict(A, B))}</p>
          <div class="vs-grid">
            <div style="display:flex; flex-direction:column; gap:0.6rem;">${companyCta(A.d, A.cat)}</div>
            <div style="display:flex; flex-direction:column; gap:0.6rem;">${companyCta(B.d, B.cat)}</div>
          </div>
        </section>

        <section class="report-full-section" id="faq">
          <h2>${esc(sa)} vs ${esc(sb)} — frequently asked questions</h2>
          ${faqs}
        </section>

        <section class="report-full-section" id="sources">
          <h2>Methodology</h2>
          <p>Ratings, price targets and value drivers are from Valuatum's AI equity research framework — a structured enterprise-value and segment value methodology with reverse valuation, built on 25+ years of equity research practice. See the <a href="/methodology.html">methodology</a>.</p>
          <div style="background:var(--off-white); border-radius:var(--r-lg); padding:1.25rem 1.5rem; margin-top:1.25rem; border-left:3px solid var(--gray-steel);">
            <p style="font-size:var(--text-sm); color:var(--gray-steel); margin:0;"><strong>Disclaimer:</strong> AI-generated research for informational purposes only. Not investment advice. Valuatum Oy, Helsinki, Finland.</p>
          </div>
        </section>
      </div>
    </div>
  </main>

${footerHtml()}
  <script src="/js/script.js"></script>
</body>
</html>
`;
}

// Hub page listing every comparison — gives the nav "Compare" link a destination and a crawlable index.
function renderHub(items) {
  const url = `${SITE}/comparisons.html`;
  const title = `Stock Comparisons — AI Equity Ratings & Price Targets Side by Side | Valuatum`;
  const desc = `Compare listed companies side by side: AI equity recommendations, 12-month price targets, valuation multiples and segment-value analysis. Free head-to-head stock comparisons from Valuatum.`;
  const cards = items.map(it => `
          <a href="/compare/${it.slug}.html" style="display:block; text-decoration:none; border:1px solid var(--color-border); border-radius:var(--r-lg); padding:1.25rem 1.5rem; background:#fff;">
            <div style="font-size:var(--text-xs); text-transform:uppercase; letter-spacing:0.05em; color:var(--gray-steel); margin-bottom:0.35rem;">${esc(it.sector || 'Stock comparison')}</div>
            <div style="font-size:var(--text-md); font-weight:600; color:var(--charcoal);">${esc(it.sa)} vs ${esc(it.sb)}</div>
            <div style="font-size:var(--text-sm); color:var(--gray-steel); margin-top:0.2rem;">${esc(it.ta)} vs ${esc(it.tb)} — ratings, price targets &amp; valuation →</div>
          </a>`).join('');
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Stock comparisons', item: url },
      ] },
      { '@type': 'CollectionPage', name: 'Stock comparisons', description: desc, url,
        hasPart: items.map(it => ({ '@type': 'WebPage', name: `${it.sa} vs ${it.sb}`, url: `${SITE}/compare/${it.slug}.html` })) },
    ],
  }, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${attr(desc)}">
  <link rel="canonical" href="${url}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta property="og:title" content="${attr(title)}">
  <meta property="og:description" content="${attr(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE}/images/og-image.png">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-HSRL85C0K5"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-HSRL85C0K5');</script>
  <script type="application/ld+json">
${ld}
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <style>
${NAV_SOLID_CSS}
  </style>
</head>
<body>
${navHtml()}

  <main class="report-full-page">
    <section class="report-company-header">
      <div class="container">
        <nav aria-label="Breadcrumb" style="font-size:var(--text-xs); color:rgba(255,255,255,0.6); margin-bottom:1rem;">
          <a href="/" style="color:rgba(255,255,255,0.7);">Home</a> ›
          <span>Stock comparisons</span>
        </nav>
        <h1 class="company-name" style="margin:0;">Stock comparisons</h1>
        <p style="color:rgba(255,255,255,0.8); font-weight:300; margin-top:0.75rem; max-width:640px;">Free head-to-head comparisons of AI equity ratings, 12-month price targets, valuation multiples and value drivers.</p>
      </div>
    </section>

    <div class="container" style="max-width:880px; padding-top:2.5rem; padding-bottom:3rem;">
      <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:1rem;">
${cards}
      </div>
    </div>
  </main>

${footerHtml()}
  <script src="/js/script.js"></script>
</body>
</html>
`;
}

// ── run ───────────────────────────────────────────────────────────────────────
const catalog = await loadCatalog();
const docs = [];
for (const [id, cat] of Object.entries(catalog)) {
  if (EXCLUDE.has(id)) continue;
  if (cat.availability && cat.availability !== 'available') continue;
  const cf = path.join(CONTENT_DIR, `${id}.json`);
  if (!fs.existsSync(cf)) continue;
  docs.push({ d: JSON.parse(fs.readFileSync(cf, 'utf8')), cat });
}

// Pair every two same-sector companies.
const bySector = {};
for (const x of docs) (bySector[x.d.sector] ??= []).push(x);
const pairs = [];
for (const group of Object.values(bySector)) {
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++)
      pairs.push([group[i], group[j]]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const written = [];
const hubItems = [];
for (const [A, B] of pairs) {
  // Stable ordering: alphabetical by stem so the page is deterministic.
  const [X, Y] = cmpStem(A.d.companyName) <= cmpStem(B.d.companyName) ? [A, B] : [B, A];
  const slug = compareSlug(A.d.companyName, B.d.companyName);
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.html`), renderPage(X, Y));
  written.push(slug);
  hubItems.push({ slug, sa: shortName(X.d.companyName), ta: X.d.ticker, sb: shortName(Y.d.companyName), tb: Y.d.ticker, sector: X.d.sector });
  console.log(`wrote  compare/${slug}.html`);
}

// Hub / index page (also the nav "Compare" destination).
fs.writeFileSync(path.join(ROOT, 'comparisons.html'), renderHub(hubItems));
console.log('wrote  comparisons.html (hub)');

const frag = written.map(slug =>
  `  <url>\n    <loc>${SITE}/compare/${slug}.html</loc>\n    <lastmod>${TODAY}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`).join('\n');
fs.writeFileSync(path.join(ROOT, 'scripts', 'sitemap-comparisons.xml'), frag + '\n');
console.log(`\n${written.length} comparison pages written. Sitemap fragment -> scripts/sitemap-comparisons.xml`);
