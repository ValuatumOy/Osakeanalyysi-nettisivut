// Renders every catalog-derived byte the sync owns: per-report landing pages
// (reports/<slug>.html), the baked card grid + ItemList JSON-LD in reports.html, and the
// sitemap entries for both. Free reports expose the full analysis (max SEO surface); paid
// reports expose a citable teaser + a buy gate; companies with no live report get a coverage
// page that keeps the URL and sells generating a fresh report.
//
// Each landing page carries two machine-readable meta tags (valuatum-report-id,
// valuatum-page-mode) so check.mjs can verify a built page against the page-owner rule
// without re-rendering it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SITE = 'https://www.aiequityreports.com';

// Starting price for generating a fresh report on a covered-but-not-yet-reported company.
const NEW_REPORT_PRICE = 50;

// ── helpers ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (s) => esc(s);
export const shortName = (n) => String(n).replace(/,?\s+(Inc\.?|Oyj|Ltd\.?|plc|Corporation|Corp\.?|AB|ASA|N\.V\.|S\.A\.|Group|Holdings?)$/i, '').trim();
const firstPct = (s) => { const m = String(s).match(/-?\d+(?:\.\d+)?/); return m ? Math.max(0, Math.min(100, parseFloat(m[0]))) : null; };
const recClass = (r) => ({ BUY: 'pos', SELL: 'neg', HOLD: '' }[String(r || '').toUpperCase()] ?? '');
const indefiniteArticle = (s) => /^[aeiou]/i.test(String(s).trim()) ? 'An' : 'A';

export const formatReportDate = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** The generated company-page catalog (js/companyPagesData.js), for card names/descriptions. */
export function loadCompanyPageCatalog() {
  const file = path.join(ROOT, 'js', 'companyPagesData.js');
  if (!fs.existsSync(file)) return [];
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('[');
  const end = src.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  return JSON.parse(src.slice(start, end + 1));
}

function pdfHrefOf(cat) {
  if (!cat || !cat.pdfUrl) return null;
  return /^https?:\/\//.test(cat.pdfUrl) ? cat.pdfUrl : '/' + String(cat.pdfUrl).replace(/^\//, '');
}

/**
 * A company whose reports have all left the catalog degrades to a coverage page: the URL and
 * its search ranking survive, the stale figures and the dead unlock link go. Company identity
 * comes from the newest historical content file — the one place it survives — but none of the
 * analysis does.
 */
export function coverageDocFrom(doc) {
  return {
    id: doc.id,
    slug: doc.slug,
    companyName: doc.companyName,
    ticker: doc.ticker,
    exchange: doc.exchange,
    country: doc.country,
    sector: doc.sector,
    currency: doc.currency,
    reportDate: doc.reportDate,
    headline: {},
    ...(doc.profile ? { profile: doc.profile } : {}),
  };
}

function metaDescription(d) {
  const h = d.headline || {};
  const sn = shortName(d.companyName);
  if (!h.recommendation) {
    return `${sn} (${d.ticker}) stock overview: share price, market cap and company profile. Generate a fresh Valuatum AI equity report for ${sn} — segment-value analysis, reverse valuation, financials, risks & catalysts.`.replace(/\s+/g, ' ').trim();
  }
  const parts = [`${sn} (${d.ticker}) stock analysis & AI equity report: Valuatum rates ${d.ticker} ${h.recommendation}`];
  if (h.targetPrice) parts.push(`with a ${h.targetPrice} price target`);
  if (h.currentPrice) parts.push(`vs ${h.currentPrice}`);
  let s = parts.join(' ') + `. Share price forecast, valuation, segment-value analysis, reverse valuation, financials, risks & catalysts.`;
  return s.replace(/\s+/g, ' ').trim();
}

// Keyword-rich public overview paragraph (templated; safe to show on paid pages).
function overviewIntro(d) {
  const h = d.headline || {};
  const sn = shortName(d.companyName);
  let s = `${sn} (${d.exchange ? d.exchange + ': ' : ''}${d.ticker}) stock analysis and AI equity research. `;
  if (h.currentPrice) s += `${sn} shares trade at ${h.currentPrice}; `;
  if (h.recommendation) {
    s += `Valuatum rates ${d.ticker} ${h.recommendation}`;
    if (h.targetPrice) s += ` with a ${h.targetPrice} 12-month price target`;
    if (h.impliedUpside) s += ` (${h.impliedUpside} vs the current share price)`;
    s += `. This ${d.sector ? d.sector + ' ' : ''}equity research report covers ${sn}'s valuation, segment-value analysis, reverse valuation, financial forecasts, key ratios, risks and catalysts.`;
  } else {
    s += `${sn} is covered by Valuatum but does not yet have a published AI equity report. Generate a fresh report to get ${sn}'s valuation, segment-value analysis, reverse valuation, financial forecasts, key ratios, risks and catalysts.`;
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Paid FAQ: factual + keyword-rich, reveals nothing that is gated. Free uses the full extracted FAQ.
function templatedFaqs(d) {
  const h = d.headline || {};
  const sn = shortName(d.companyName);
  const t = d.ticker;
  const out = [];
  if (h.recommendation) {
    out.push({ q: `Is ${sn} (${t}) a buy or a sell?`, a: `Valuatum's latest AI equity report rates ${sn} (${t}) ${h.recommendation}${h.targetPrice ? `, with a 12-month price target of ${h.targetPrice}` : ''}${h.currentPrice ? ` versus a ${h.currentPrice} share price` : ''}${h.impliedUpside ? ` (${h.impliedUpside})` : ''}. The full report explains the rationale behind the rating.` });
    if (h.targetPrice) out.push({ q: `What is the ${sn} (${t}) share price target?`, a: `The current Valuatum 12-month price target for ${sn} is ${h.targetPrice}${h.impliedUpside ? `, implying ${h.impliedUpside} versus the current share price` : ''}. Unlock the report for the valuation behind the target.` });
    out.push({ q: `How is ${sn} (${t}) valued?`, a: `The ${sn} AI equity report values the company using segment-value analysis and a reverse valuation (a DCF-style framework), with segment financial estimates, key ratios, risks and catalysts. Buy the report to read the full valuation.` });
    out.push({ q: `Where can I get the ${sn} (${t}) equity research report?`, a: `Buy the ${sn} (${t}) AI equity report PDF on this page for instant download, or generate a fresh report for any listed company.` });
  } else {
    out.push({ q: `Does Valuatum have an AI equity report on ${sn} (${t})?`, a: `${sn} is on Valuatum's coverage list, but a full AI equity report has not been published yet. Generate a fresh report on demand to get the rating, price target, segment-value analysis and reverse valuation.` });
    out.push({ q: `How is ${sn} (${t}) valued?`, a: `${indefiniteArticle(sn)} ${sn} AI equity report would value the company using segment-value analysis and a reverse valuation (a DCF-style framework), with segment financial estimates, key ratios, risks and catalysts.` });
    out.push({ q: `How long does it take to generate ${indefiniteArticle(sn).toLowerCase()} ${sn} (${t}) report?`, a: `A fresh ${sn} AI equity report is delivered by email — typically within one business day of ordering.` });
  }
  return out;
}

function faqsFor(d, cat) {
  return cat?.isFree ? (Array.isArray(d.faqs) ? d.faqs : []) : templatedFaqs(d);
}

function valuePoolBars(pools) {
  if (!Array.isArray(pools) || !pools.length) return '';
  const colors = ['var(--green)', 'var(--green-light)', 'var(--green-deep)', 'var(--charcoal-mid)', 'var(--gray-steel)', 'var(--forest)'];
  const bars = pools.map((p, i) => {
    const pct = firstPct(p.share);
    return pct === null ? '' : `<div class="pool-row"><span class="pool-name" style="min-width:200px;">${esc(p.name)}</span><div class="pool-track"><div class="pool-fill" style="width:${pct}%; background:${colors[i % colors.length]};"></div></div><span class="pool-pct">${esc(p.share)}</span></div>`;
  }).join('');
  return bars ? `<div class="segment-value-chart" style="margin:1rem 0 1.5rem;">${bars}</div>` : '';
}

function thesisTeaserList(thesis) {
  return `<div style="margin-bottom:1.25rem;">${thesis.map(t => `<div style="display:flex; gap:0.6rem; align-items:baseline; padding:0.6rem 0; border-bottom:1px solid var(--color-border);"><span style="font-weight:700; color:var(--green); font-size:var(--text-xs);">${esc(t.num || '')}</span><strong style="color:var(--charcoal);">${esc(t.title)}</strong>${t.metric ? `<span class="num" style="margin-left:auto; font-weight:700; color:var(--charcoal);">${esc(t.metric)}</span>` : ''}</div>`).join('')}</div>`;
}

function navHtml() {
  return `  <header class="nav scrolled nav-report" id="nav">
    <div class="nav-inner">
      <a href="/index.html" class="nav-logo">
        <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
        <div class="nav-logo-text">
          <span class="nav-logo-wordmark">Valuatum</span>
          <span class="nav-logo-sub">AI Equity Reports</span>
        </div>
      </a>
      <nav class="nav-links" aria-label="Main navigation">
        <a href="/index.html" class="nav-link">Home</a>
        <a href="/reports.html" class="nav-link is-active" aria-current="page">Reports</a>
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
          <p>Professional AI-generated equity research reports for listed companies. Built on financial data, structured methodology, and 25+ years of analysis expertise.</p>
        </div>
        <div>
          <div class="footer-col-label">Reports</div>
          <div class="footer-links">
            <a href="/reports.html" class="footer-link">Browse reports</a>
            <a href="/reports.html#free" class="footer-link">Free reports</a>
            <a href="/reports.html#coverage-request" class="footer-link">Request coverage</a>
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
            <a href="mailto:contact26@valuatum.com" class="footer-link">Enterprise sales</a>
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
    h.recommendation ? ['Recommendation', `<span class="num ${recClass(h.recommendation)}">${esc(h.recommendation)}</span>`, h.horizon || '12-month horizon'] : null,
    ['Target price', esc(h.targetPrice), '12-month fundamental'],
    ['Current price', esc(h.currentPrice), 'as of report date'],
    h.impliedUpside ? ['Implied upside', `<span class="num ${firstPct(h.impliedUpside) === null ? '' : (String(h.impliedUpside).trim().startsWith('-') || String(h.impliedUpside).includes('−') ? 'neg' : 'pos')}">${esc(h.impliedUpside)}</span>`, 'vs. current price'] : null,
    ['Market cap', esc(h.marketCap), 'shares × price'],
    ['Enterprise value', esc(h.enterpriseValue), 'mcap + net debt'],
  ].filter((c) => c && c[1] && c[1] !== 'undefined' && !/>undefined</.test(c[1]));
  if (!cells.length) return '';
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
  return `${bars ? `<div class="segment-value-chart" style="margin:1rem 0 2rem;">${bars}</div>` : ''}${detail}`;
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

const chip = (href, label) => `<a style="display:inline-block; text-decoration:none; padding:0.55rem 1rem; border:1px solid var(--color-border); border-radius:var(--r-pill); font-size:var(--text-sm); color:var(--charcoal); background:#fff;" href="${attr(href)}">${esc(label)}</a>`;

function relatedHtml(current, all) {
  const others = all.filter(x => x.slug !== current.slug);
  if (!others.length) return '';
  const score = (candidate) =>
    (candidate.sector && candidate.sector === current.sector ? 8 : 0) +
    (candidate.exchange && candidate.exchange === current.exchange ? 4 : 0) +
    (candidate.country && candidate.country === current.country ? 2 : 0);
  const ordered = others
    .sort((a, b) =>
      score(b) - score(a) ||
      new Date(b.reportDate || 0) - new Date(a.reportDate || 0) ||
      String(a.companyName).localeCompare(String(b.companyName))
    )
    .slice(0, 4);
  const reportChips = ordered.map(o => chip(`/reports/${o.slug}.html`, `${shortName(o.companyName)} (${o.ticker}) report →`)).join('');
  return `<div style="display:flex; flex-wrap:wrap; gap:0.6rem;">${reportChips}</div>`;
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
  const faqs = faqsFor(d, cat);
  if (faqs.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
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

// No report published yet on this (covered) company — sell generating one instead of unlocking one.
function generateGate(d) {
  const sn = shortName(d.companyName);
  return `
        <section class="report-full-section" id="generate">
          <div style="background:var(--forest); border-radius:var(--r-xl); padding:2rem; color:white;">
            <h2 style="color:white; margin-top:0;">Generate the ${esc(sn)} report</h2>
            <p style="color:rgba(255,255,255,0.8); font-weight:300;">${esc(sn)} is on Valuatum's coverage list, but a full AI equity report hasn't been generated yet. Order one now for the complete company value map, reverse valuation, risk &amp; catalyst analysis, and financial statements and estimates — plus a downloadable PDF.</p>
            <div style="display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-top:1.25rem;">
              <a href="#" onclick="return false;" class="btn btn-gold btn-lg">Generate fresh report — €${NEW_REPORT_PRICE.toFixed(2)}</a>
              <span style="font-size:var(--text-xs); color:rgba(255,255,255,0.6);">Delivered by email, typically within 1 business day</span>
            </div>
          </div>
        </section>`;
}

const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
function lockedSection(title, desc, teaser, ctaLabel, reportId) {
  return `<div class="locked-section"><div class="locked-section-inner">
            ${teaser ? `<div class="locked-preview"><p class="locked-preview-text">${esc(teaser)}</p><div class="locked-gate"></div></div>` : ''}
            <div class="locked-section-header"><div class="locked-icon">${LOCK_SVG}</div><div><div class="locked-section-title">${esc(title)}</div><div class="locked-section-desc">${esc(desc)}</div></div></div>
            <a class="locked-cta" href="/reports.html#report-${esc(reportId)}">${LOCK_SVG}${esc(ctaLabel)}</a>
          </div></div>`;
}

// ── page template ───────────────────────────────────────────────────────────
/**
 * One landing page. `cat` is the live catalog entry of the page-owner report, or null for a
 * coverage page. `all` is every company's page doc, for the related-reports chips.
 */
export function renderPage(d, cat, all) {
  const isFree = !!cat?.isFree;
  const hasReport = !!(d.headline && d.headline.recommendation);
  const mode = !hasReport ? 'coverage' : isFree ? 'free' : 'paid';
  const url = `${SITE}/reports/${d.slug}.html`;
  const desc = metaDescription(d);
  const sn = shortName(d.companyName);
  const title = `${sn} (${d.ticker}) Stock Analysis & AI Equity Report — Price Target & Valuation | Valuatum`;
  const updated = d.reportDate;
  const pdfHref = pdfHrefOf(cat);
  const downloadCta = isFree && pdfHref
    ? `<a href="${attr(pdfHref)}" target="_blank" rel="noopener" class="btn btn-primary" download>Download free PDF</a>`
    : hasReport
      ? `<a href="#unlock" class="btn btn-primary">Get the full report${cat?.price ? ` — €${Number(cat.price).toFixed(2)}` : ''}</a>`
      : `<a href="#generate" class="btn btn-gold">Generate fresh report — €${NEW_REPORT_PRICE.toFixed(2)}</a>`;

  const sections = [];
  const price = cat?.price ? `€${Number(cat.price).toFixed(2)}` : '';
  const unlockLabel = price ? `Unlock with the full report — ${price}` : 'Unlock with the full report';

  // Overview (public, keyword-rich, templated — safe on paid)
  sections.push(`
        <section class="report-full-section" id="overview">
          <h2>${esc(sn)} (${esc(d.ticker)}) overview</h2>
          <p>${esc(overviewIntro(d))}</p>
        </section>`);

  // Key metrics / multiples (public facts — the hook). A degraded coverage page has none.
  const metrics = metricsBand(d.headline || {});
  const multiples = multiplesGrid(d.multiples);
  if (metrics || multiples || d.priceStats) {
    sections.push(`
        <section class="report-full-section" id="metrics">
          <h2>Key metrics &amp; valuation multiples</h2>
          ${metrics}
          ${multiples}
          ${d.priceStats ? `<p style="font-size:var(--text-xs); color:var(--gray-steel); margin-top:1rem;">52-week range ${esc(d.priceStats.week52Low)} – ${esc(d.priceStats.week52High)} · 1-year change ${esc(d.priceStats.oneYearChange)} · 3-year change ${esc(d.priceStats.threeYearChange)}.</p>` : ''}
        </section>`);
  }

  // Company profile (public, SEO) — "what the company does", when the content has it.
  if (d.profile) {
    sections.push(`
        <section class="report-full-section" id="about">
          <h2>About ${esc(sn)}</h2>
          <p>${esc(d.profile)}</p>
        </section>`);
  }

  if (!hasReport) {
    // Covered, no report yet — sell generating one instead of the (nonexistent) unlock/thesis/valuation teasers.
    sections.push(generateGate(d));
  } else if (!isFree) {
    // PAID — reveal a readable lead, then lock the deep analysis to drive purchase.
    const sumLead = (d.summary || [])[0] || '';
    const sumRest = (d.summary || []).slice(1).join(' ');
    sections.push(`
        <section class="report-full-section" id="summary">
          <h2>Executive summary</h2>
          ${sumLead ? `<p>${esc(sumLead)}</p>` : ''}
          ${lockedSection(`Full ${sn} investment summary`, `The complete investment case, valuation conclusion and recommendation rationale for ${sn} (${d.ticker}).`, sumRest || sumLead, unlockLabel, d.id)}
        </section>`);
    if (Array.isArray(d.thesis) && d.thesis.length) {
      sections.push(`
        <section class="report-full-section" id="thesis">
          <h2>Investment thesis — three reasons</h2>
          ${thesisTeaserList(d.thesis)}
          ${lockedSection(`Full thesis reasoning for ${sn}`, `The detailed analysis behind each of the three pillars, plus the thesis-breaker scenario.`, (d.thesis[0] && d.thesis[0].text) || '', unlockLabel, d.id)}
        </section>`);
    }
    if (Array.isArray(d.valuePools) && d.valuePools.length) {
      sections.push(`
        <section class="report-full-section" id="segment-values">
          <h2>Segment value analysis — enterprise-value allocation</h2>
          <p>The <a href="/methodology.html">segment value analysis</a> decomposes ${esc(sn)}'s enterprise value into the distinct businesses and options the market is paying for. The allocation across each segment is shown below; the full segment economics are in the report.</p>
          ${valuePoolBars(d.valuePools)}
          ${lockedSection(`Full ${sn} segment-value breakdown`, `Per-segment revenue, EBIT and EV economics with the implied valuation of each business.`, (d.valuePools[0] && d.valuePools[0].text) || '', unlockLabel, d.id)}
        </section>`);
    }
    if (d.reverseValuation) {
      sections.push(`
        <section class="report-full-section" id="reverse-valuation">
          <h2>Reverse valuation</h2>
          ${d.reverseValuation.intro ? `<p>${esc(d.reverseValuation.intro)}</p>` : ''}
          ${lockedSection(`Full reverse-valuation model for ${sn}`, `The bull / base / bear scenario table and the revenue growth and margins implied by the current ${sn} share price.`, '', unlockLabel, d.id)}
        </section>`);
    }
    if (financialsHtml(d.financials)) {
      sections.push(`
        <section class="report-full-section" id="financials">
          <h2>${esc(sn)} financial statements &amp; estimates</h2>
          ${lockedSection(`${sn} financial model & forecasts`, `Income statement, revenue and EBIT forecasts, margins and key valuation ratios for ${sn} (${d.ticker}).`, (d.financials && d.financials.note) || '', unlockLabel, d.id)}
        </section>`);
    }
    sections.push(buyGate(d, cat));
  } else {
    // FREE — everything open.
    sections.push(`
        <section class="report-full-section" id="summary">
          <h2>Executive summary</h2>
          ${(d.summary || []).map(p => `<p>${esc(p)}</p>`).join('\n          ')}
        </section>`);
    if (Array.isArray(d.thesis) && d.thesis.length) {
      sections.push(`
        <section class="report-full-section" id="thesis">
          <h2>Investment thesis — three reasons</h2>
          ${thesisHtml(d.thesis)}
          ${d.thesisBreaker ? `<p style="margin-top:1rem;"><strong>Thesis breaker:</strong> ${esc(d.thesisBreaker)}</p>` : ''}
        </section>`);
    }
    if (Array.isArray(d.valuePools) && d.valuePools.length) {
      sections.push(`
        <section class="report-full-section" id="segment-values">
          <h2>Segment value analysis — enterprise-value allocation</h2>
          <p>The <a href="/methodology.html">segment value analysis</a> decomposes ${esc(sn)}'s enterprise value into the distinct businesses and options the market is paying for, each shown with its share of total EV and segment economics.</p>
          ${valuePoolsHtml(d.valuePools)}
        </section>`);
    }
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
  }

  // FAQ
  if (Array.isArray(d.faqs) && d.faqs.length) {
    sections.push(`
        <section class="report-full-section" id="faq">
          <h2>${esc(sn)} (${esc(d.ticker)}) stock — frequently asked questions</h2>
          ${faqHtml(faqsFor(d, cat))}
        </section>`);
  }

  // Sources & methodology
  sections.push(`
        <section class="report-full-section" id="sources">
          <h2>Sources &amp; methodology</h2>
          ${(d.sources && d.sources.length) ? listSection(d.sources) : ''}
          <p>This report was generated using Valuatum's AI equity research framework — a structured enterprise-value and segment value methodology built on 25+ years of professional equity research practice. See the <a href="/methodology.html">methodology</a> for the full approach.</p>
          <div style="background:var(--off-white); border-radius:var(--r-lg); padding:1.25rem 1.5rem; margin-top:1.25rem; border-left:3px solid var(--gray-steel);">
            <p style="font-size:var(--text-sm); color:var(--gray-steel); margin:0;"><strong>Disclaimer:</strong> This is an AI-generated research material for informational purposes only. It is not investment advice or a buy/sell recommendation. Always perform your own analysis. Valuatum Oy, Helsinki, Finland.</p>
          </div>
        </section>`);

  // Related reports
  const related = relatedHtml(d, all);
  if (related) {
    sections.push(`
        <section class="report-full-section" id="related">
          <h2>Related AI equity reports</h2>
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
  <meta name="valuatum-report-id" content="${attr(hasReport ? d.id : '')}">
  <meta name="valuatum-page-mode" content="${attr(mode)}">
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
    .report-full-content.coverage-cols{column-count:2;column-gap:2.5rem;}
    .report-full-content.coverage-cols .report-full-section{break-inside:avoid;-webkit-column-break-inside:avoid;margin-bottom:1.5rem;}
    @media(max-width:960px){.report-full-content.coverage-cols{column-count:1;}}
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
            <h1 class="company-name">${esc(sn)} (${esc(d.ticker)}) Stock Analysis &amp; AI Equity Report</h1>
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
            ${hasReport ? `<a href="#" class="btn btn-outline" data-generate-report data-company="${attr(d.companyName)}" data-ticker="${attr(d.ticker)}" style="border-color:rgba(255,255,255,0.3); color:white; font-size:var(--text-xs);">Generate a fresh report</a>` : ''}
          </div>
        </div>
      </div>
    </section>

    <div class="container" style="max-width:1760px; padding-top:2.5rem; padding-bottom:3rem;">
      <div class="report-full-content coverage-cols">
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

// ── reports.html listing ────────────────────────────────────────────────────
const CARDS_BEGIN = '<!-- BEGIN report-cards — auto-generated by scripts/report-pages/sync.mjs; do not edit by hand -->';
const CARDS_END = '<!-- END report-cards -->';
const ITEMLIST_BEGIN = '<!-- BEGIN report-itemlist -->';
const ITEMLIST_END = '<!-- END report-itemlist -->';

/**
 * One card per company, page owners only, newest first — the baked replacement for the old
 * client-side buildReadyReports(). Markup matches the card the browser used to build, plus
 * data attributes the (much thinner) client script filters and sorts on.
 */
export function renderCards(companies, companyPageCatalog) {
  const byTicker = new Map();
  for (const c of companyPageCatalog) {
    const key = String(c.ticker || '').trim().toLowerCase();
    if (key && !byTicker.has(key)) byTicker.set(key, c);
  }

  const owners = [...companies.values()]
    .filter((c) => c.owner)
    .sort((a, b) => String(b.owner.cat.reportDateIso || b.owner.cat.reportDate || '')
      .localeCompare(String(a.owner.cat.reportDateIso || a.owner.cat.reportDate || '')));

  const cards = owners.map(({ owner, slug }) => {
    const { doc, cat } = owner;
    const company = byTicker.get(String(cat.ticker || doc.ticker || '').trim().toLowerCase()) || null;
    const isFree = !!cat.isFree;
    const pageUrl = `reports/${slug}.html`;
    const name = company?.name || cat.companyName || doc.companyName;
    const ticker = company?.ticker || cat.ticker || doc.ticker;
    const exchange = company?.exchange || cat.exchange || doc.exchange;
    const sector = cat.sector || doc.sector || '';
    const dateIso = String(cat.reportDateIso || cat.reportDate || doc.reportDate).slice(0, 10);
    const description = company?.description || cat.description || '';
    const tags = (cat.tags || []).slice(0, 4).map((t) => `<span class="rc-tag">${esc(t)}</span>`).join('');
    const pdfUrl = pdfHrefOf(cat) || '';
    const price = isFree ? 'Free' : `€${Number(cat.price || 20).toFixed(0)}`;
    const primaryCta = isFree
      ? `<a class="btn btn-primary" href="${attr(pdfUrl)}" target="_blank" rel="noopener" download>Download free PDF</a>`
      : `<button class="btn btn-primary" data-buy-report="${attr(doc.id)}">Buy ready report</button>`;
    return `<article class="report-card" role="listitem" id="report-${attr(doc.id)}" data-page-url="/${attr(pageUrl)}" data-name="${attr(name)}" data-ticker="${attr(ticker)}" data-exchange="${attr(exchange)}" data-sector="${attr(sector)}" data-date="${attr(dateIso)}" data-free="${isFree ? '1' : ''}" tabindex="0" aria-label="Open ${attr(name)} report page">
          <div>
            <div class="rc-eyebrow"><span class="rc-badge${isFree ? ' rc-badge-free' : ''}">${isFree ? 'Free report' : 'Ready report'}</span><span class="rc-date">${esc(formatReportDate(dateIso))}</span></div>
            <h3 class="rc-company-name"><a href="/${attr(pageUrl)}">${esc(name)}</a></h3>
            <div class="rc-company-meta"><span class="rc-ticker">${esc(ticker)}</span><span>·</span><span>${esc(exchange)}</span><span>·</span><span>${esc(sector)}</span></div>
            <p class="rc-desc">${esc(description)}</p>
            <div class="rc-tags">${tags}</div>
          </div>
          <div class="rc-actions">
            <div><div class="rc-price">${esc(price)}</div><div class="rc-price-note">${isFree ? 'Instant PDF download' : 'Existing PDF report'}</div></div>
            ${primaryCta}
            <button class="btn btn-outline-dark" data-generate-company="${attr(name)}" data-generate-ticker="${attr(ticker)}">Generate fresh report</button>
            <a class="btn btn-ghost" style="justify-content:center;color:var(--gray-steel);" href="/${attr(pageUrl)}">Open report page</a>
          </div>
        </article>`;
  });

  const itemList = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Valuatum AI equity reports',
    numberOfItems: owners.length,
    itemListElement: owners.map(({ owner, slug }, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: `${shortName(owner.doc.companyName)} (${owner.doc.ticker}) AI Equity Report`,
      url: `${SITE}/reports/${slug}.html`,
    })),
  }, null, 2);

  return { cardsHtml: cards.join('\n        '), itemListJsonLd: itemList, count: owners.length };
}

function replaceBetween(html, begin, end, replacement, file) {
  const from = html.indexOf(begin);
  const to = html.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${file}: expected the ${begin.slice(0, 40)}… / ${end} markers.`);
  }
  return html.slice(0, from + begin.length) + '\n        ' + replacement + '\n        ' + html.slice(to);
}

/** Replace the marked card-grid and ItemList JSON-LD regions of reports.html. */
export function injectListing(html, { cardsHtml, itemListJsonLd }) {
  let out = replaceBetween(html, CARDS_BEGIN, CARDS_END, cardsHtml, 'reports.html');
  out = replaceBetween(
    out,
    ITEMLIST_BEGIN,
    ITEMLIST_END,
    `<script type="application/ld+json">\n${itemListJsonLd}\n  </script>`,
    'reports.html',
  );
  return out;
}

/** The baked cards currently in reports.html, parsed for the guard. */
export function parseListingCards(html) {
  const from = html.indexOf(CARDS_BEGIN);
  const to = html.indexOf(CARDS_END);
  if (from === -1 || to === -1) return null;
  const region = html.slice(from, to);
  const cards = [];
  for (const m of region.matchAll(/<article class="report-card"[^>]*>/g)) {
    const tag = m[0];
    const get = (name) => (tag.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] ?? '';
    cards.push({
      id: get('id').replace(/^report-/, ''),
      pageUrl: get('data-page-url'),
      free: get('data-free') === '1',
      date: get('data-date'),
    });
  }
  return cards;
}

// ── sitemap ─────────────────────────────────────────────────────────────────
/**
 * Upsert one <url> block in sitemap.xml. Passing lastmod=null keeps the existing lastmod (or
 * stamps today when the block is new) so an unchanged page never dirties the sitemap.
 */
export function upsertSitemapEntry(xml, loc, lastmod, today) {
  const escapedLoc = loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`  <url>\\s*<loc>${escapedLoc}</loc>[\\s\\S]*?</url>\\n`, '');
  const existing = xml.match(blockRe);
  const currentLastmod = existing ? (existing[0].match(/<lastmod>([^<]*)<\/lastmod>/) || [])[1] : null;
  const stamp = lastmod || currentLastmod || today;
  const block = `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${stamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>\n`;
  if (existing) return xml.replace(blockRe, block);
  return xml.replace(/<\/urlset>/, `${block}</urlset>`);
}
