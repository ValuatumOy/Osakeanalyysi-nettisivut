#!/usr/bin/env node
// Generates static, indexable per-report landing pages from report-content/*.json + js/reportsData.js.
// Free reports expose the full analysis (max SEO surface). Paid reports expose a citable teaser + a buy gate.
// Run: node scripts/build-report-pages.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const CONTENT_DIR = path.join(ROOT, 'report-content');
const OUT_DIR = path.join(ROOT, 'reports');

// Reports whose PDF content does not match their catalog identity — do not publish.
const EXCLUDE = new Set(['nuholdings-02062026']);

// ── helpers ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (s) => esc(s);
const shortName = (n) => String(n).replace(/,?\s+(Inc\.?|Oyj|Ltd\.?|plc|Corporation|Corp\.?|AB|ASA|N\.V\.|S\.A\.|Group|Holdings?)$/i, '').trim();
const firstPct = (s) => { const m = String(s).match(/-?\d+(?:\.\d+)?/); return m ? Math.max(0, Math.min(100, parseFloat(m[0]))) : null; };
const recClass = (r) => ({ BUY: 'pos', SELL: 'neg', HOLD: '' }[String(r || '').toUpperCase()] ?? '');

function loadCatalog() {
  // Source of truth: snapshot of the live catalog API (report-content/_catalog.json),
  // falling back to the bundled js/reportsData.js if the snapshot is absent.
  const snap = path.join(CONTENT_DIR, '_catalog.json');
  let cat;
  if (fs.existsSync(snap)) {
    cat = JSON.parse(fs.readFileSync(snap, 'utf8'));
  } else {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'reportsData.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    cat = Function(src + '\n;return REPORTS_CATALOG;')();
  }
  const byId = {};
  for (const r of cat) byId[r.id] = r;
  return byId;
}

function pdfHrefOf(cat) {
  if (!cat || !cat.pdfUrl) return null;
  return /^https?:\/\//.test(cat.pdfUrl) ? cat.pdfUrl : '/' + String(cat.pdfUrl).replace(/^\//, '');
}

function metaDescription(d) {
  const h = d.headline || {};
  const parts = [`${shortName(d.companyName)} (${d.ticker}) AI equity report: Valuatum rates it ${h.recommendation}`];
  if (h.targetPrice) parts.push(`with a ${h.targetPrice} 12-month target`);
  if (h.currentPrice) parts.push(`vs ${h.currentPrice}`);
  let s = parts.join(' ') + `. Value-pool analysis, reverse valuation, financials & risks.`;
  return s.replace(/\s+/g, ' ').trim();
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
        <a href="/index.html" class="nav-link">Home</a>
        <a href="/reports.html" class="nav-link" style="color:var(--green);">Reports</a>
        <a href="/pricing.html" class="nav-link">Pricing</a>
        <a href="/methodology.html" class="nav-link">Methodology</a>
        <a href="/about.html" class="nav-link">About</a>
        <a href="/faq.html" class="nav-link">FAQ</a>
        <a href="/blog.html" class="nav-link">Blog</a>
      </nav>
      <a href="/reports.html" class="nav-cta">Browse reports</a>
    </div>
  </header>`;
}

function footerHtml() {
  return `  <footer class="footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a href="/index.html" class="nav-logo" style="margin-bottom:1rem; display:inline-flex;">
            <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
            <div class="nav-logo-text">
              <span class="nav-logo-wordmark">Valuatum</span>
              <span class="nav-logo-sub">AI Equity Reports</span>
            </div>
          </a>
          <p>Professional AI-generated equity research reports. Browse available reports, open free samples, or order a fresh report delivered by email.</p>
        </div>
        <div>
          <div class="footer-col-label">Reports</div>
          <div class="footer-links">
            <a href="/reports.html" class="footer-link">Browse reports</a>
            <a href="/reports.html#order-fresh" class="footer-link">Order fresh report</a>
            <a href="/pricing.html" class="footer-link">Pricing</a>
            <a href="/methodology.html" class="footer-link">Methodology</a>
          </div>
        </div>
        <div>
          <div class="footer-col-label">Company</div>
          <div class="footer-links">
            <a href="/about.html" class="footer-link">About Valuatum</a>
            <a href="https://valuatum.com" class="footer-link" target="_blank" rel="noopener">Valuatum.com</a>
            <a href="mailto:contact26@valuatum.com" class="footer-link">Support</a>
          </div>
        </div>
        <div>
          <div class="footer-col-label">Legal</div>
          <div class="footer-links">
            <a href="/disclaimer.html" class="footer-link">Disclaimer</a>
            <a href="/disclaimer.html#terms" class="footer-link">Terms of use</a>
            <a href="/disclaimer.html#privacy" class="footer-link">Privacy policy</a>
          </div>
        </div>
      </div>
      <div class="footer-bottom">
        <span class="footer-copyright">© 2026 Valuatum Oy · Helsinki, Finland · Est. 2000</span>
        <span class="footer-disclaimer">Reports are AI-generated research materials for informational purposes only. Not investment advice.</span>
      </div>
    </div>
  </footer>`;
}

function metricsBand(h) {
  const cells = [
    ['Recommendation', `<span class="num ${recClass(h.recommendation)}">${esc(h.recommendation)}</span>`, h.horizon || '12-month horizon'],
    ['Target price', esc(h.targetPrice), '12-month fundamental'],
    ['Current price', esc(h.currentPrice), 'as of report date'],
    ['Implied upside', `<span class="num ${firstPct(h.impliedUpside) === null ? '' : (String(h.impliedUpside).trim().startsWith('-') || String(h.impliedUpside).includes('−') ? 'neg' : 'pos')}">${esc(h.impliedUpside)}</span>`, 'vs. current price'],
    ['Market cap', esc(h.marketCap), 'shares × price'],
    ['Enterprise value', esc(h.enterpriseValue), 'mcap + net debt'],
  ].filter(([, v]) => v && v !== 'undefined' && !/>undefined</.test(v));
  return `<div class="cp-grid">${cells.map(([l, v, s]) =>
    `<div class="cp-cell"><span class="cp-l">${esc(l)}</span><span class="cp-v">${v}</span>${s ? `<span class="cp-sub">${esc(s)}</span>` : ''}</div>`).join('')}</div>`;
}

function multiplesGrid(multiples) {
  if (!Array.isArray(multiples) || !multiples.length) return '';
  return `<div class="cp-grid" style="margin-top:0.6rem;">${multiples.map(m =>
    `<div class="cp-cell"><span class="cp-l">${esc(m.label)}</span><span class="cp-v">${esc(m.value)}</span></div>`).join('')}</div>`;
}

function thesisHtml(thesis) {
  if (!Array.isArray(thesis) || !thesis.length) return '';
  return thesis.map(t => `
        <div style="background:var(--off-white); border-radius:var(--r-lg); padding:1.25rem 1.5rem; margin-bottom:1rem; border-left:3px solid var(--green);">
          <div style="display:flex; align-items:baseline; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.4rem;">
            <span style="font-size:var(--text-xs); font-weight:700; color:var(--green);">${esc(t.num || '')}</span>
            <strong style="color:var(--charcoal); font-size:var(--text-md);">${esc(t.title)}</strong>
            ${t.metric ? `<span class="num" style="margin-left:auto; font-weight:700; color:var(--charcoal);">${esc(t.metric)}</span>` : ''}
          </div>
          <p style="margin:0;">${esc(t.text)}</p>
        </div>`).join('');
}

function valuePoolsHtml(pools) {
  if (!Array.isArray(pools) || !pools.length) return '';
  const bars = pools.map((p, i) => {
    const pct = firstPct(p.share);
    const colors = ['var(--green)', 'var(--green-light)', 'var(--green-deep)', 'var(--charcoal-mid)', 'var(--gray-steel)', 'var(--forest)'];
    const bar = pct === null ? '' :
      `<div class="pool-row"><span class="pool-name" style="min-width:200px;">${esc(p.name)}</span><div class="pool-track"><div class="pool-fill" style="width:${pct}%; background:${colors[i % colors.length]};"></div></div><span class="pool-pct">${esc(p.share)}</span></div>`;
    return bar;
  }).join('');
  const detail = pools.map(p => `
        <h3>${esc(p.name)}${p.share ? ` <span style="font-weight:400; color:var(--gray-steel); font-size:var(--text-sm);">— ${esc(p.share)}</span>` : ''}</h3>
        ${p.economics ? `<p style="font-size:var(--text-xs); color:var(--gray-steel); margin-bottom:0.4rem;">${esc(p.economics)}</p>` : ''}
        <p>${esc(p.text)}</p>`).join('');
  return `${bars ? `<div class="value-pool-chart" style="margin:1rem 0 2rem;">${bars}</div>` : ''}${detail}`;
}

function scenarioTable(rv) {
  if (!rv || !Array.isArray(rv.scenarios) || !rv.scenarios.length) return '';
  const cols = Array.isArray(rv.scenarioColumns) ? rv.scenarioColumns : Object.keys(rv.scenarios[0].cols || {});
  const hasImplied = rv.scenarios.some(s => s.impliedValueOrUpside);
  const head = `<tr><th>Scenario</th>${cols.map(c => `<th class="num">${esc(c)}</th>`).join('')}${hasImplied ? '<th class="num">Implied value</th>' : ''}</tr>`;
  const body = rv.scenarios.map(s => {
    const cls = s.scenario === 'Bull' ? 'pos' : s.scenario === 'Bear' ? 'neg' : '';
    return `<tr><td><strong>${esc(s.scenario)}</strong></td>${cols.map(c => `<td class="num ${cls}">${esc((s.cols || {})[c] ?? '—')}</td>`).join('')}${hasImplied ? `<td class="num ${cls}">${esc(s.impliedValueOrUpside ?? '—')}</td>` : ''}</tr>`;
  }).join('');
  return `<div class="cp-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function finTable(t) {
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return '';
  const head = `<tr><th></th>${t.columns.map(c => `<th class="num">${esc(c)}</th>`).join('')}</tr>`;
  const body = t.rows.map(r => `<tr><td>${esc(r.label)}</td>${(r.values || []).map(v => `<td class="num">${esc(v)}</td>`).join('')}</tr>`).join('');
  return `<div class="cp-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function financialsHtml(f) {
  if (!f) return '';
  const order = [['incomeStatement', 'Income Statement'], ['balanceSheet', 'Balance Sheet'], ['cashFlow', 'Cash Flow'], ['ratios', 'Key Ratios & Multiples']];
  const tables = order.filter(([k]) => f[k]).map(([k, title]) => `<h3 style="margin-top:2rem;">${esc(title)}</h3>${finTable(f[k])}`).join('');
  if (!tables) return '';
  return `${f.note ? `<p style="font-size:var(--text-xs); color:var(--gray-steel); margin-bottom:1.5rem;">${esc(f.note)}</p>` : ''}${tables}`;
}

function listSection(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<ul style="padding-left:1.2rem;">${items.map(i => `<li style="margin-bottom:0.6rem;">${esc(i)}</li>`).join('')}</ul>`;
}

function faqHtml(faqs) {
  if (!Array.isArray(faqs) || !faqs.length) return '';
  return faqs.map(f => `
        <div style="border-bottom:1px solid var(--color-border); padding:1.1rem 0;">
          <h3 style="font-size:var(--text-md); margin:0 0 0.4rem;">${esc(f.q)}</h3>
          <p style="margin:0;">${esc(f.a)}</p>
        </div>`).join('');
}

function relatedHtml(current, all) {
  const others = all.filter(x => x.slug !== current.slug);
  if (!others.length) return '';
  return `<div style="display:flex; flex-wrap:wrap; gap:0.6rem;">${others.map(o =>
    `<a class="company-meta-chip" style="text-decoration:none; padding:0.5rem 0.9rem;" href="/reports/${o.slug}.html">${esc(shortName(o.companyName))} (${esc(o.ticker)}) report →</a>`).join('')}</div>`;
}

function jsonLd(d, cat, desc) {
  const url = `${SITE}/reports/${d.slug}.html`;
  const graph = [
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Reports', item: `${SITE}/reports.html` },
        { '@type': 'ListItem', position: 3, name: `${shortName(d.companyName)} equity report`, item: url },
      ],
    },
    {
      '@type': 'AnalysisNewsArticle',
      '@id': url + '#article',
      headline: `${shortName(d.companyName)} (${d.ticker}) AI Equity Report`,
      description: desc,
      datePublished: d.reportDate,
      dateModified: d.reportDate,
      inLanguage: 'en',
      author: { '@type': 'Organization', name: 'Valuatum', url: 'https://valuatum.com' },
      publisher: { '@id': `${SITE}/#organization` },
      mainEntityOfPage: url,
      about: {
        '@type': 'Corporation',
        name: d.companyName,
        tickerSymbol: d.ticker,
      },
      isAccessibleForFree: !!cat?.isFree,
    },
  ];
  if (Array.isArray(d.faqs) && d.faqs.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: d.faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2);
}

function buyGate(d, cat) {
  const price = cat?.price ? `€${Number(cat.price).toFixed(2)}` : null;
  return `
        <section class="report-full-section" id="unlock">
          <div style="background:var(--forest); border-radius:var(--r-xl); padding:2rem; color:white;">
            <h2 style="color:white; margin-top:0;">Unlock the full ${esc(shortName(d.companyName))} report</h2>
            <p style="color:rgba(255,255,255,0.8); font-weight:300;">The full PDF adds the complete reverse-valuation scenario model, segment financial statements and estimates, the full risk &amp; catalyst analysis, and the institutional one-page snapshot.${price ? ` Instant download for ${price}.` : ''}</p>
            <div style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-top:1.25rem;">
              <a href="/reports.html#report-${esc(d.id)}" class="btn btn-primary btn-lg">${price ? `Buy full report — ${price}` : 'Get the full report'}</a>
              <a href="/pricing.html" class="btn btn-outline" style="border-color:rgba(255,255,255,0.3); color:white;">See pricing</a>
            </div>
          </div>
        </section>`;
}

// ── page template ───────────────────────────────────────────────────────────
function renderPage(d, cat, all) {
  const isFree = !!cat?.isFree;
  const url = `${SITE}/reports/${d.slug}.html`;
  const desc = metaDescription(d);
  const sn = shortName(d.companyName);
  const title = `${sn} (${d.ticker}) AI Equity Report — Valuation & Target Price | Valuatum`;
  const updated = d.reportDate;
  const pdfHref = pdfHrefOf(cat);
  const downloadCta = isFree && pdfHref
    ? `<a href="${attr(pdfHref)}" target="_blank" rel="noopener" class="btn btn-primary" download>Download free PDF</a>`
    : `<a href="#unlock" class="btn btn-primary">Get the full report${cat?.price ? ` — €${Number(cat.price).toFixed(2)}` : ''}</a>`;

  const sections = [];

  // Executive summary
  sections.push(`
        <section class="report-full-section" id="summary">
          <h2>Executive summary</h2>
          ${(d.summary || []).map(p => `<p>${esc(p)}</p>`).join('\n          ')}
        </section>`);

  // Key metrics / multiples
  sections.push(`
        <section class="report-full-section" id="metrics">
          <h2>Key metrics &amp; valuation multiples</h2>
          ${metricsBand(d.headline || {})}
          ${multiplesGrid(d.multiples)}
          ${d.priceStats ? `<p style="font-size:var(--text-xs); color:var(--gray-steel); margin-top:1rem;">52-week range ${esc(d.priceStats.week52Low)} – ${esc(d.priceStats.week52High)} · 1-year change ${esc(d.priceStats.oneYearChange)} · 3-year change ${esc(d.priceStats.threeYearChange)}.</p>` : ''}
        </section>`);

  // Thesis
  if (Array.isArray(d.thesis) && d.thesis.length) {
    sections.push(`
        <section class="report-full-section" id="thesis">
          <h2>Investment thesis — three reasons</h2>
          ${thesisHtml(d.thesis)}
          ${d.thesisBreaker ? `<p style="margin-top:1rem;"><strong>Thesis breaker:</strong> ${esc(d.thesisBreaker)}</p>` : ''}
        </section>`);
  }

  // Value pools
  if (Array.isArray(d.valuePools) && d.valuePools.length) {
    sections.push(`
        <section class="report-full-section" id="value-pools">
          <h2>Value pool analysis — enterprise-value allocation</h2>
          <p>The value pool analysis decomposes ${esc(sn)}'s enterprise value into the distinct businesses and options the market is paying for, each shown with its share of total EV and segment economics.</p>
          ${valuePoolsHtml(d.valuePools)}
        </section>`);
  }

  if (isFree) {
    // Reverse valuation
    if (d.reverseValuation) {
      sections.push(`
        <section class="report-full-section" id="reverse-valuation">
          <h2>Reverse valuation</h2>
          ${d.reverseValuation.intro ? `<p>${esc(d.reverseValuation.intro)}</p>` : ''}
          ${scenarioTable(d.reverseValuation)}
        </section>`);
    }
    // Core analysis
    if (Array.isArray(d.coreAnalysis) && d.coreAnalysis.length) {
      sections.push(`
        <section class="report-full-section" id="analysis">
          <h2>Core investment analysis</h2>
          ${d.coreAnalysis.map(c => `<h3>${esc(c.heading)}</h3>\n          <p>${esc(c.text)}</p>`).join('\n          ')}
        </section>`);
    }
    // Risks & catalysts
    if ((d.risks && d.risks.length) || (d.catalysts && d.catalysts.length)) {
      sections.push(`
        <section class="report-full-section" id="risks">
          <h2>Risks &amp; catalysts</h2>
          ${d.risks && d.risks.length ? `<h3>Downside risks</h3>${listSection(d.risks)}` : ''}
          ${d.catalysts && d.catalysts.length ? `<h3>Upside catalysts</h3>${listSection(d.catalysts)}` : ''}
        </section>`);
    }
    // Financials
    const fin = financialsHtml(d.financials);
    if (fin) {
      sections.push(`
        <section class="report-full-section" id="financials">
          <h2>Financial statements &amp; estimates</h2>
          ${fin}
        </section>`);
    }
    // PDF download
    if (pdfHref) {
      sections.push(`
        <section class="report-full-section" id="download">
          <div style="background:var(--forest); border-radius:var(--r-xl); padding:2rem; text-align:center;">
            <p style="font-size:var(--text-md); font-weight:300; color:white; margin-bottom:1rem;">Download the full ${esc(sn)} report as a formatted PDF — free.</p>
            <a href="${attr(pdfHref)}" target="_blank" rel="noopener" class="btn btn-primary btn-lg" download>Download free PDF</a>
          </div>
        </section>`);
    }
  } else {
    sections.push(buyGate(d, cat));
  }

  // FAQ
  if (Array.isArray(d.faqs) && d.faqs.length) {
    sections.push(`
        <section class="report-full-section" id="faq">
          <h2>${esc(sn)} equity report — FAQ</h2>
          ${faqHtml(d.faqs)}
        </section>`);
  }

  // Sources & methodology
  sections.push(`
        <section class="report-full-section" id="sources">
          <h2>Sources &amp; methodology</h2>
          ${(d.sources && d.sources.length) ? listSection(d.sources) : ''}
          <p>This report was generated using Valuatum's AI equity research framework — a structured enterprise-value and value-pool methodology built on 25+ years of professional equity research practice. See the <a href="/methodology.html">methodology</a> for the full approach.</p>
          <div style="background:var(--off-white); border-radius:var(--r-lg); padding:1.25rem 1.5rem; margin-top:1.25rem; border-left:3px solid var(--gray-steel);">
            <p style="font-size:var(--text-sm); color:var(--gray-steel); margin:0;"><strong>Disclaimer:</strong> This is an AI-generated research material for informational purposes only. It is not investment advice or a buy/sell recommendation. Always perform your own analysis. Valuatum Oy, Helsinki, Finland.</p>
          </div>
        </section>`);

  // Related reports
  const related = relatedHtml(d, all);
  if (related) {
    sections.push(`
        <section class="report-full-section" id="related">
          <h2>More AI equity reports</h2>
          ${related}
        </section>`);
  }

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
  <meta property="article:published_time" content="${esc(updated)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${attr(sn + ' (' + d.ticker + ') AI Equity Report')}">
  <meta name="twitter:description" content="${attr(desc)}">
  <meta name="twitter:image" content="${SITE}/images/og-image.png">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-HSRL85C0K5"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-HSRL85C0K5');</script>
  <script type="application/ld+json">
${jsonLd(d, cat, desc)}
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <style>
    .cp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:0.6rem;margin-top:0.25rem;}
    .cp-cell{background:#fff;border:1px solid var(--color-border);border-radius:var(--r-md);padding:0.85rem 1rem;display:flex;flex-direction:column;gap:0.2rem;min-width:0;}
    .cp-l{font-size:var(--text-xs);text-transform:uppercase;letter-spacing:0.05em;color:var(--gray-steel);line-height:1.25;}
    .cp-v{font-size:1rem;font-weight:600;color:var(--charcoal);line-height:1.3;overflow-wrap:break-word;}
    .cp-sub{font-size:var(--text-xs);color:var(--gray-steel);font-weight:400;}
    .cp-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
    .cp-scroll table{white-space:nowrap;min-width:100%;}
    @media(max-width:520px){.cp-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));}}
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
          <span>${esc(sn)}</span>
        </nav>
        <div class="company-header-inner">
          <div class="company-ident">
            <div style="display:flex; align-items:center; gap:1rem; margin-bottom:0.5rem; flex-wrap:wrap;">
              <span class="company-ticker">${esc(d.ticker)}</span>
              <span class="company-status-badge"><span class="company-status-dot"></span>${isFree ? 'Free report' : 'Sample preview'} · Updated ${esc(updated)}</span>
            </div>
            <h1 class="company-name">${esc(sn)} (${esc(d.ticker)}) AI Equity Report</h1>
            <div class="company-meta">
              <span class="company-meta-chip">${esc(d.exchange)}</span>
              <span class="company-meta-sep"></span>
              <span class="company-meta-chip">${esc(d.country)}</span>
              <span class="company-meta-sep"></span>
              <span class="company-meta-chip">${esc(d.sector)}</span>
            </div>
          </div>
          <div class="company-header-actions">
            ${downloadCta}
            <a href="/index.html#hero" class="btn btn-outline" style="border-color:rgba(255,255,255,0.3); color:white; font-size:var(--text-xs);">Generate a report</a>
          </div>
        </div>
      </div>
    </section>

    <div class="container" style="max-width:880px; padding-top:2.5rem; padding-bottom:3rem;">
      <div class="report-full-content">
${sections.join('\n')}
      </div>
    </div>
  </main>

${footerHtml()}
  <script src="/js/script.js"></script>
</body>
</html>
`;
}

// ── run ─────────────────────────────────────────────────────────────────────
const catalog = loadCatalog();
// Generate one page per LIVE catalog entry that has extracted content.
const docs = [];
for (const [id, cat] of Object.entries(catalog)) {
  if (EXCLUDE.has(id)) { console.log(`skip   ${id} (excluded — content/identity mismatch)`); continue; }
  if (cat.availability && cat.availability !== 'available') { console.log(`skip   ${id} (availability=${cat.availability})`); continue; }
  const cf = path.join(CONTENT_DIR, `${id}.json`);
  if (!fs.existsSync(cf)) { console.log(`skip   ${id} (no extracted content yet)`); continue; }
  const d = JSON.parse(fs.readFileSync(cf, 'utf8'));
  docs.push({ d, cat });
}
const all = docs.map(x => x.d);
fs.mkdirSync(OUT_DIR, { recursive: true });
const written = [];
const slugMap = {};
for (const { d, cat } of docs) {
  const html = renderPage(d, cat, all);
  fs.writeFileSync(path.join(OUT_DIR, `${d.slug}.html`), html);
  written.push({ slug: d.slug, free: !!cat?.isFree });
  slugMap[d.id] = d.slug;
  console.log(`wrote  reports/${d.slug}.html  (${cat?.isFree ? 'free/full' : 'paid/teaser'})`);
}

// Emit id->slug map for the JS catalog to deep-link cards to landing pages.
fs.writeFileSync(path.join(ROOT, 'js', 'reportSlugs.js'),
  `// Auto-generated by scripts/build-report-pages.mjs — maps report id -> landing-page slug.\nwindow.REPORT_SLUGS = ${JSON.stringify(slugMap, null, 2)};\n`);

// Emit sitemap fragment for the report pages
const today = '2026-06-08';
const frag = written.map(w =>
  `  <url>\n    <loc>${SITE}/reports/${w.slug}.html</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>`).join('\n');
fs.writeFileSync(path.join(ROOT, 'scripts', 'sitemap-fragment.xml'), frag + '\n');
console.log(`\n${written.length} pages written. Slug map -> js/reportSlugs.js. Sitemap fragment -> scripts/sitemap-fragment.xml`);
