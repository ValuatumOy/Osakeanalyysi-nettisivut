#!/usr/bin/env node
// MOCKUP generator for the mass-generated company page.
// Design: uses the real site components (nav, report-company-header hero, metrics-grid,
// locked-section gate, btn-gold, footer) from css/style.css — matches the live site.
// Freemium: only templated FACTS are public (identity, key figures, rating+target, rating
// history, report library, FAQ). The analysis (thesis, value pools, reverse valuation,
// financials) is GATED behind locked-sections → buy / download / generate.
// Text is 100% templated from data — no per-company prose — so it scales to thousands.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.aiequityreports.com';
const CONTENT_DIR = path.join(ROOT, 'report-content');
const OUT_DIR = path.join(ROOT, 'mockups');
const YEAR = '2026';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shortName = (n) => String(n).replace(/,?\s+(Inc\.?|Oyj|Ltd\.?|plc|Plc|Corporation|Corp\.?|Abp|AB|ASA|N\.V\.|S\.A\.|Group|Holdings?)$/i, '').replace(/,?\s+(Oyj|Abp)$/i, '').trim();
const isNeg = (s) => /(^|\s)[-−]/.test(String(s)) || String(s).includes('−');
const firstNum = (s) => { const m = String(s).match(/-?\d+(?:[.,]\d+)?/); return m ? parseFloat(m[0].replace(',', '.')) : null; };
const recClass = (r) => ({ BUY: 'pos', SELL: 'neg', HOLD: 'mid' }[String(r || '').toUpperCase()] ?? '');
const recColor = (r) => ({ BUY: '#6DBFA0', SELL: '#E8A07A', HOLD: '#E8B96A' }[String(r || '').toUpperCase()] ?? '#fff');
const slugify = (n) => shortName(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const eur = (p) => `€${Number(p).toFixed(2)}`;

const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

function loadCatalog() { return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, '_catalog.json'), 'utf8')); }
function loadContent(id) { const p = path.join(CONTENT_DIR, `${id}.json`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }

function NAV() {
  return `<header class="nav scrolled" id="nav">
    <div class="nav-inner">
      <a href="/index.html" class="nav-logo">
        <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
        <div class="nav-logo-text"><span class="nav-logo-wordmark" style="color:var(--charcoal);">Valuatum</span><span class="nav-logo-sub" style="color:var(--gray-steel);">AI Equity Reports</span></div>
      </a>
      <nav class="nav-links" aria-label="Main navigation">
        <a href="/index.html" class="nav-link">Home</a>
        <a href="/reports.html" class="nav-link">Reports</a>
        <a href="/pricing.html" class="nav-link">Pricing</a>
        <a href="/methodology.html" class="nav-link">Methodology</a>
        <a href="/about.html" class="nav-link">About</a>
        <a href="/faq.html" class="nav-link">FAQ</a>
      </nav>
      <a href="/index.html#hero" class="nav-cta">Generate report</a>
    </div>
  </header>`;
}

function FOOTER() {
  return `<footer class="footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a href="/index.html" class="nav-logo" style="margin-bottom:1rem; display:inline-flex;">
            <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
            <div class="nav-logo-text"><span class="nav-logo-wordmark">Valuatum</span><span class="nav-logo-sub">AI Equity Reports</span></div>
          </a>
          <p>Professional AI-generated equity research reports for any listed company.</p>
        </div>
        <div><div class="footer-col-label">Reports</div><div class="footer-links"><a href="/reports.html" class="footer-link">Browse reports</a><a href="/index.html#hero" class="footer-link">Generate report</a><a href="/pricing.html" class="footer-link">Pricing</a><a href="/methodology.html" class="footer-link">Methodology</a></div></div>
        <div><div class="footer-col-label">Company</div><div class="footer-links"><a href="/about.html" class="footer-link">About Valuatum</a><a href="https://valuatum.com" class="footer-link" target="_blank" rel="noopener">Valuatum.com</a><a href="mailto:contact26@valuatum.com" class="footer-link">Support</a></div></div>
        <div><div class="footer-col-label">Legal</div><div class="footer-links"><a href="/disclaimer.html" class="footer-link">Disclaimer</a><a href="/disclaimer.html#terms" class="footer-link">Terms of use</a><a href="/disclaimer.html#privacy" class="footer-link">Privacy policy</a></div></div>
      </div>
      <div class="footer-bottom"><span class="footer-copyright">© 2026 Valuatum Oy · Helsinki, Finland · Est. 2000</span><span class="footer-disclaimer">AI-generated research for informational purposes only. Not investment advice.</span></div>
    </div>
  </footer>`;
}

// ── templated text (facts only) ──────────────────────────────────────────────
function introText(c, d) {
  const sn = shortName(c.companyName || c.name);
  const where = c.country ? ` based in ${c.country}` : '';
  const h = (d && d.headline) || {};
  let s = `${c.companyName || c.name} (${c.exchange}: ${c.ticker}) is a ${c.sector || 'listed'} company${where}. `;
  if (h.recommendation) {
    s += `Valuatum's latest AI equity report, published ${c.reportDateLabel || c.reportDate}, rates ${sn} ${h.recommendation} with a 12-month price target of ${h.targetPrice} — ${h.impliedUpside} versus the ${h.currentPrice} share price. Unlock the full report below for the investment thesis, value-pool breakdown, reverse valuation and financial estimates.`;
  } else {
    s += `Generate a fresh AI equity report on ${sn} for the full investment thesis, value-pool breakdown, reverse valuation and financial estimates.`;
  }
  return s;
}

function templatedFaqs(c, d) {
  const sn = shortName(c.companyName || c.name);
  const h = (d && d.headline) || {};
  const out = [];
  if (h.recommendation) {
    out.push({ q: `Is ${sn} a buy or a sell?`, a: `Valuatum's latest AI equity report (${c.reportDateLabel || c.reportDate}) rates ${sn} (${c.ticker}) ${h.recommendation}, with a 12-month price target of ${h.targetPrice} versus a ${h.currentPrice} share price (${h.impliedUpside}).` });
    out.push({ q: `What is ${sn}'s price target?`, a: `The current Valuatum 12-month price target for ${sn} (${c.ticker}) is ${h.targetPrice}, implying ${h.impliedUpside} against the ${h.currentPrice} price at the report date.` });
  }
  out.push({ q: `Where can I get the ${sn} equity report?`, a: `Download or buy the latest ${sn} AI equity report in the report library below, or generate a fresh report for ${sn} — or any listed company — instantly.` });
  return out;
}

// ── public sections ──────────────────────────────────────────────────────────
function metricsGrid(d) {
  const h = (d && d.headline) || {};
  const m = (d && d.multiples) || [];
  const ps = (d && d.priceStats) || {};
  const cells = [];
  if (h.currentPrice) cells.push(['Share price', h.currentPrice]);
  if (h.marketCap) cells.push(['Market cap', h.marketCap]);
  if (h.enterpriseValue) cells.push(['Enterprise value', h.enterpriseValue]);
  for (const x of m) cells.push([x.label, x.value]);
  if (ps.week52Low && ps.week52High) cells.push(['52-week range', `${String(ps.week52Low).replace(/\s*[A-Za-z]+$/, '')} – ${ps.week52High}`]);
  if (!cells.length) return '';
  return `<div class="cp-grid">${cells.map(([l, v]) => `<div class="cp-cell"><span class="cp-l">${esc(l)}</span><span class="cp-v">${esc(v)}</span></div>`).join('')}</div>`;
}

function ratingHistory(reports) {
  const rows = reports.map((r) => {
    const h = (r.content && r.content.headline) || {};
    const action = r.isFree ? `<a class="footer-link" style="color:var(--green)" href="#reports">Free</a>` : `<a class="footer-link" style="color:var(--gold)" href="#reports">Buy</a>`;
    return `<tr><td>${esc(r.reportDateLabel || r.reportDate)}</td><td><strong class="num ${recClass(h.recommendation)}">${esc(h.recommendation || '—')}</strong></td><td class="num">${esc(h.targetPrice || '—')}</td><td class="num">${esc(h.currentPrice || '—')}</td><td class="num ${isNeg(h.impliedUpside) ? 'neg' : 'pos'}">${esc(h.impliedUpside || '—')}</td><td>${action}</td></tr>`;
  }).join('');
  return `<div class="cp-scroll"><table><thead><tr><th>Report date</th><th>Rating</th><th class="num">Target</th><th class="num">Price then</th><th class="num">Implied upside</th><th>Report</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p style="font-size:var(--text-xs); color:var(--gray-steel); margin-top:1rem;">This rating &amp; price-target history grows automatically each time a new report on this company is published.</p>`;
}

function reportLibrary(sn, reports) {
  return `<div class="cp-grid" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr));">${reports.map((r) => {
    const h = (r.content && r.content.headline) || {};
    const cta = r.isFree
      ? `<a class="btn btn-primary btn-sm" style="width:100%; justify-content:center; margin-top:0.9rem;" href="${esc(r.pdfUrl)}" target="_blank" rel="noopener" download>Download free PDF</a>`
      : `<a class="btn btn-gold btn-sm" style="width:100%; justify-content:center; margin-top:0.9rem;" href="${SITE}/reports.html#report-${esc(r.id)}">Buy — ${eur(r.price)}</a>`;
    return `<div class="cp-cell">
      <span class="cp-l">${esc(r.reportDateLabel || r.reportDate)}</span>
      <span style="font-weight:600; color:var(--charcoal); margin:0.1rem 0 0.4rem;">AI Equity Report · ${esc(r.ticker)}</span>
      <span style="font-size:var(--text-xs); color:var(--gray-steel);">${h.recommendation ? `<strong class="num ${recClass(h.recommendation)}">${esc(h.recommendation)}</strong> · target ${esc(h.targetPrice || '—')}` : 'Report'}</span>
      ${cta}
    </div>`;
  }).join('')}</div>`;
}

function lockedSection(title, desc, teaser, ctaLabel) {
  return `<div class="locked-section">
    <div class="locked-section-inner">
      ${teaser ? `<div class="locked-preview"><p class="locked-preview-text">${esc(teaser)}</p><div class="locked-gate"></div></div>` : ''}
      <div class="locked-section-header">
        <div class="locked-icon">${LOCK_SVG}</div>
        <div><div class="locked-section-title">${esc(title)}</div><div class="locked-section-desc">${esc(desc)}</div></div>
      </div>
      <a class="locked-cta" href="#reports">${LOCK_SVG}${esc(ctaLabel)}</a>
    </div>
  </div>`;
}

function peers(company, list) {
  if (!list.length) return '';
  return `<div class="cp-grid" style="grid-template-columns:repeat(auto-fill,minmax(195px,1fr));">${list.map((p) => {
    const h = (p.content && p.content.headline) || {};
    return `<a class="cp-cell cp-card-link" href="/mockups/${slugify(p.companyName || p.name)}.html">
      <span class="cp-l" style="color:var(--green);">${esc(p.ticker)}</span>
      <span style="font-weight:600; color:var(--charcoal); margin:0.1rem 0 0.35rem;">${esc(shortName(p.companyName || p.name))}</span>
      <span style="font-size:var(--text-xs); color:var(--gray-steel);">${h.recommendation ? `${esc(h.recommendation)} · ${esc(h.targetPrice || '')}` : 'View company'}</span>
    </a>`;
  }).join('')}</div>`;
}

// ── full (unlocked) renderers — used when the company's report is FREE ────────
function thesisFull(thesis, breaker) {
  if (!Array.isArray(thesis) || !thesis.length) return '';
  return thesis.map((t) => `<div style="background:var(--off-white); border-radius:var(--r-lg); padding:1.25rem 1.5rem; margin-bottom:1rem; border-left:3px solid var(--green);">
      <div style="display:flex; align-items:baseline; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.4rem;"><span style="font-size:var(--text-xs); font-weight:700; color:var(--green);">${esc(t.num || '')}</span><strong style="color:var(--charcoal);">${esc(t.title)}</strong>${t.metric ? `<span class="num" style="margin-left:auto; font-weight:700; color:var(--charcoal);">${esc(t.metric)}</span>` : ''}</div>
      <p style="margin:0;">${esc(t.text)}</p></div>`).join('') + (breaker ? `<p style="margin-top:1rem;"><strong>Thesis breaker:</strong> ${esc(breaker)}</p>` : '');
}

function valuePoolsFull(pools) {
  if (!Array.isArray(pools) || !pools.length) return '';
  const colors = ['var(--green)', 'var(--green-light)', 'var(--green-deep)', 'var(--charcoal-mid)', 'var(--gray-steel)', 'var(--forest)'];
  const bars = pools.map((p, i) => {
    const pct = firstNum(p.share);
    return `<div class="pool-row"><span class="pool-name" style="min-width:190px;">${esc(p.name)}</span><div class="pool-track"><div class="pool-fill" style="width:${pct == null ? 0 : Math.min(100, Math.max(2, pct))}%; background:${colors[i % colors.length]};"></div></div><span class="pool-pct">${esc(p.share)}</span></div>`;
  }).join('');
  const detail = pools.map((p) => `<h3>${esc(p.name)}</h3>${p.economics ? `<p style="font-size:var(--text-xs); color:var(--gray-steel); margin-bottom:0.4rem;">${esc(p.economics)}</p>` : ''}<p>${esc(p.text)}</p>`).join('');
  return `<div class="value-pool-chart" style="margin:1rem 0 2rem;">${bars}</div>${detail}`;
}

function scenarioTableFull(rv) {
  if (!rv || !Array.isArray(rv.scenarios) || !rv.scenarios.length) return '';
  const cols = Array.isArray(rv.scenarioColumns) ? rv.scenarioColumns : Object.keys(rv.scenarios[0].cols || {});
  const hasImp = rv.scenarios.some((s) => s.impliedValueOrUpside);
  const head = `<tr><th>Scenario</th>${cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}${hasImp ? '<th class="num">Implied value</th>' : ''}</tr>`;
  const body = rv.scenarios.map((s) => {
    const cls = s.scenario === 'Bull' ? 'pos' : s.scenario === 'Bear' ? 'neg' : '';
    return `<tr><td><strong>${esc(s.scenario)}</strong></td>${cols.map((c) => `<td class="num ${cls}">${esc((s.cols || {})[c] ?? '—')}</td>`).join('')}${hasImp ? `<td class="num ${cls}">${esc(s.impliedValueOrUpside ?? '—')}</td>` : ''}</tr>`;
  }).join('');
  return `${rv.intro ? `<p>${esc(rv.intro)}</p>` : ''}<div class="cp-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function finFull(f) {
  if (!f) return '';
  const order = [['incomeStatement', 'Income statement'], ['ratios', 'Key ratios & multiples']];
  const tables = order.filter(([k]) => f[k] && f[k].columns).map(([k, title]) => {
    const t = f[k];
    return `<h3 style="margin-top:1.5rem;">${esc(title)}</h3><div class="cp-scroll"><table><thead><tr><th></th>${t.columns.map((c) => `<th class="num">${esc(c)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr><td>${esc(r.label)}</td>${(r.values || []).map((v) => `<td class="num">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }).join('');
  return `${f.note ? `<p style="font-size:var(--text-xs); color:var(--gray-steel); margin-bottom:1rem;">${esc(f.note)}</p>` : ''}${tables}`;
}

// Company profile (public, SEO). Renders system/report `profile` text when present.
// Placeholder shown in mockup until the report/system profile field is wired in.
function profileSection(c, d) {
  const sn = shortName(c.companyName || c.name);
  const profile = (d && d.profile) || c.profile;
  if (profile) return `<section class="report-full-section"><h2>About ${esc(sn)}</h2><p>${esc(profile)}</p></section>`;
  return `<section class="report-full-section"><h2>About ${esc(sn)}</h2>
    <div style="background:var(--gold-faint); border:1px dashed rgba(200,150,62,0.4); border-radius:var(--r-lg); padding:1.25rem 1.5rem;">
      <p style="margin:0; color:#7a5a18; font-size:var(--text-sm);"><strong>Company profile slot</strong> — a templated business description (sector, operations, segments, geography) will render here, sourced from the new company-profile section of your reports / system. Public &amp; indexable: unique SEO content per company and the substance for no-report pages.</p>
    </div></section>`;
}

function jsonLd(c, d, slug, desc, reports) {
  const url = `${SITE}/equity-research/${slug}/`;
  const graph = [
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Equity research', item: `${SITE}/equity-research/` },
      { '@type': 'ListItem', position: 3, name: shortName(c.companyName || c.name), item: url },
    ] },
    { '@type': 'Corporation', '@id': url + '#company', name: c.companyName || c.name, tickerSymbol: c.ticker, ...(c.country ? { address: { '@type': 'PostalAddress', addressCountry: c.country } } : {}) },
  ];
  for (const r of reports) {
    const h = (r.content && r.content.headline) || {};
    graph.push({ '@type': 'AnalysisNewsArticle', headline: `${shortName(c.companyName || c.name)} (${c.ticker}) AI Equity Report`, datePublished: r.reportDate, author: { '@type': 'Organization', name: 'Valuatum' }, about: { '@id': url + '#company' }, isAccessibleForFree: !!r.isFree, ...(h.recommendation ? { abstract: `${h.recommendation}, target ${h.targetPrice}` } : {}) });
  }
  const faqs = templatedFaqs(c, d);
  if (faqs.length) graph.push({ '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2);
}

function renderCompany(c, d, allEntries) {
  const sn = shortName(c.companyName || c.name);
  const slug = slugify(c.companyName || c.name);
  const url = `${SITE}/equity-research/${slug}/`;
  const h = (d && d.headline) || {};
  const hasReport = !!h.recommendation;
  const desc = introText(c, d).slice(0, 300);
  const title = `${sn} (${c.ticker}) Stock Analysis & AI Equity Report ${YEAR} | Valuatum`;

  const reports = allEntries.filter((e) => e.cat.ticker === c.ticker).map((e) => ({ ...e.cat, content: e.content }))
    .sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)));
  const latest = reports[0];
  const isFree = !!(latest && latest.isFree);
  let peerList = allEntries.filter((e) => e.cat.ticker !== c.ticker && e.cat.sector && c.sector && e.cat.sector === c.sector).map((e) => ({ ...e.cat, content: e.content }));
  if (peerList.length < 4) peerList = peerList.concat(allEntries.filter((e) => e.cat.ticker !== c.ticker && !peerList.find((p) => p.ticker === e.cat.ticker)).map((e) => ({ ...e.cat, content: e.content })));
  peerList = peerList.slice(0, 4);

  // hero CTAs
  const reportCta = latest
    ? (latest.isFree
      ? `<a class="btn btn-primary" href="${esc(latest.pdfUrl)}" target="_blank" rel="noopener" download>Download free report</a>`
      : `<a class="btn btn-gold" href="#reports">Buy report — ${eur(latest.price)}</a>`)
    : '';
  const generateCta = `<a class="btn btn-outline" href="/index.html#hero" style="border-color:rgba(255,255,255,0.35); color:#fff;">Generate fresh report</a>`;

  // hero call stats (facts, the hook)
  const callStats = hasReport ? `
        <div style="display:flex; gap:2rem; flex-wrap:wrap; margin-top:1.5rem;">
          <div><div style="font-size:var(--text-xs); color:rgba(255,255,255,0.55); text-transform:uppercase; letter-spacing:0.06em;">Rating</div><div style="font-size:1.5rem; font-weight:700; color:${recColor(h.recommendation)};">${esc(h.recommendation)}</div></div>
          <div><div style="font-size:var(--text-xs); color:rgba(255,255,255,0.55); text-transform:uppercase; letter-spacing:0.06em;">12-month target</div><div style="font-size:1.5rem; font-weight:700; color:#fff;">${esc(h.targetPrice)}</div></div>
          <div><div style="font-size:var(--text-xs); color:rgba(255,255,255,0.55); text-transform:uppercase; letter-spacing:0.06em;">Current price</div><div style="font-size:1.5rem; font-weight:700; color:#fff;">${esc(h.currentPrice)}</div></div>
          <div><div style="font-size:var(--text-xs); color:rgba(255,255,255,0.55); text-transform:uppercase; letter-spacing:0.06em;">Implied upside</div><div style="font-size:1.5rem; font-weight:700; color:${isNeg(h.impliedUpside) ? '#E8A07A' : '#6DBFA0'};">${esc(h.impliedUpside)}</div></div>
        </div>` : '';

  const sections = [];

  // intro (templated facts)
  sections.push(`<section class="report-full-section"><h2>${esc(sn)} (${esc(c.ticker)}) overview</h2><p>${esc(introText(c, d))}</p></section>`);

  // company profile (public, SEO) — system/report sourced
  sections.push(profileSection(c, d));

  // key figures (public)
  const mg = metricsGrid(d);
  if (mg) sections.push(`<section class="report-full-section" id="figures"><h2>Key figures</h2>${mg}</section>`);

  // upsell bar — only when the report is paid (free reports show everything)
  if (hasReport && !isFree) {
    sections.push(`<div class="upsell-bar"><div class="upsell-bar-text"><div class="upsell-bar-title">Full ${esc(sn)} investment case</div><div class="upsell-bar-desc">Thesis, value pools, reverse valuation and financials — in the report.</div></div>${reportCta || `<a class="btn btn-primary" href="/index.html#hero">Generate report</a>`}</div>`);
  }

  // ANALYSIS — free report: fully unlocked; paid report: gated previews
  if (hasReport) {
    if (isFree) {
      if (Array.isArray(d.summary) && d.summary.length) sections.push(`<section class="report-full-section"><h2>Executive summary</h2>${d.summary.map((p) => `<p>${esc(p)}</p>`).join('')}</section>`);
      if (Array.isArray(d.thesis) && d.thesis.length) sections.push(`<section class="report-full-section"><h2>Investment thesis &amp; rating rationale</h2>${thesisFull(d.thesis, d.thesisBreaker)}</section>`);
      if (Array.isArray(d.valuePools) && d.valuePools.length) sections.push(`<section class="report-full-section"><h2>Value pool analysis</h2>${valuePoolsFull(d.valuePools)}</section>`);
      if (d.reverseValuation) sections.push(`<section class="report-full-section"><h2>Reverse valuation</h2>${scenarioTableFull(d.reverseValuation)}</section>`);
      const fin = finFull(d.financials);
      if (fin) sections.push(`<section class="report-full-section"><h2>Financials &amp; estimates</h2>${fin}</section>`);
    } else {
      const thesisTeaser = (d.thesis && d.thesis[0] && d.thesis[0].text) || (d.summary && d.summary[0]) || '';
      sections.push(`<section class="report-full-section"><h2>Investment thesis &amp; rating rationale</h2>${lockedSection('Why Valuatum rates ' + sn + ' ' + h.recommendation, `The three pillars behind the ${h.recommendation} call plus the thesis-breaker scenario.`, thesisTeaser, 'Unlock with the full report')}</section>`);

      const poolTeaser = (d.valuePools && d.valuePools[0] && d.valuePools[0].text) || '';
      const nPools = (d.valuePools || []).length;
      sections.push(`<section class="report-full-section"><h2>Value pool analysis</h2>${lockedSection(sn + ' enterprise-value breakdown', `Full split of enterprise value across ${nPools || 'each'} business pool${nPools === 1 ? '' : 's'} with segment revenue, EBIT and EV economics.`, poolTeaser, 'Unlock the value pool breakdown')}</section>`);

      const rvTeaser = (d.reverseValuation && d.reverseValuation.intro) || '';
      sections.push(`<section class="report-full-section"><h2>Reverse valuation</h2>${lockedSection('What the market is pricing into ' + sn, 'The bull / base / bear scenario model and the growth and margins implied by the current share price.', rvTeaser, 'Unlock the reverse valuation')}</section>`);

      const finCols = d.financials && d.financials.incomeStatement && d.financials.incomeStatement.columns;
      const lastYear = finCols ? finCols[finCols.length - 1] : '';
      sections.push(`<section class="report-full-section"><h2>Financials &amp; estimates</h2>${lockedSection(sn + ' financial model', `Income statement, margins and forecasts${lastYear ? ' through ' + lastYear : ''}, with key valuation ratios.`, (d.financials && d.financials.note) || '', 'Unlock the financial model')}</section>`);
    }
  }

  // rating history (public facts)
  sections.push(`<section class="report-full-section" id="rating-history"><h2>${esc(sn)} rating &amp; price-target history</h2>${ratingHistory(reports)}</section>`);

  // report library (download/buy)
  sections.push(`<section class="report-full-section" id="reports"><h2>${esc(sn)} reports</h2><p style="color:var(--gray-steel); margin-bottom:1.25rem;">Download the free sample or buy any report. Need the latest data? Generate a fresh report on demand.</p>${reportLibrary(sn, reports)}
    <div style="margin-top:1.5rem; display:flex; gap:0.75rem; flex-wrap:wrap;"><a class="btn btn-primary" href="/index.html#hero">Generate fresh ${esc(sn)} report</a><a class="btn btn-outline-dark" href="/pricing.html">See pricing</a></div>
  </section>`);

  // FAQ (templated facts)
  const faqs = templatedFaqs(c, d);
  if (faqs.length) sections.push(`<section class="report-full-section"><h2>${esc(sn)} — frequently asked questions</h2>${faqs.map((f) => `<div style="border-bottom:1px solid var(--color-border); padding:1.1rem 0;"><h3 style="font-size:var(--text-md); margin:0 0 0.4rem;">${esc(f.q)}</h3><p style="margin:0;">${esc(f.a)}</p></div>`).join('')}</section>`);

  // peers
  sections.push(`<section class="report-full-section"><h2>Related companies</h2>${peers(c, peerList)}</section>`);

  // disclaimer
  sections.push(`<section class="report-full-section"><div style="background:var(--off-white); border-radius:var(--r-lg); padding:1.25rem 1.5rem; border-left:3px solid var(--gray-steel);"><p style="font-size:var(--text-sm); color:var(--gray-steel); margin:0;"><strong>Disclaimer:</strong> AI-generated research for informational purposes only. Not investment advice. Valuatum Oy, Helsinki, Finland.</p></div></section>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="profile"><meta property="og:url" content="${url}"><meta property="og:image" content="${SITE}/images/og-image.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/style.css">
<style>
  /* Self-contained grid: transparent container (no grey empty cells), bordered cells, no empty tracks. */
  .cp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:0.6rem;margin-top:0.25rem;}
  .cp-cell{background:#fff;border:1px solid var(--color-border);border-radius:var(--r-md);padding:0.85rem 1rem;display:flex;flex-direction:column;gap:0.2rem;min-width:0;}
  .cp-l{font-size:var(--text-xs);text-transform:uppercase;letter-spacing:0.05em;color:var(--gray-steel);line-height:1.25;}
  .cp-v{font-size:1rem;font-weight:600;color:var(--charcoal);line-height:1.3;overflow-wrap:break-word;}
  .cp-card-link{text-decoration:none;color:inherit;transition:border-color .15s;}
  .cp-card-link:hover{border-color:var(--green);}
  /* Wide tables scroll instead of wrapping numbers out of frame. */
  .cp-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
  .cp-scroll table{white-space:nowrap;min-width:100%;}
  @media(max-width:520px){.cp-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));}}
</style>
<script type="application/ld+json">
${jsonLd(c, d, slug, desc, reports)}
</script>
</head>
<body>
<div style="background:var(--gold-faint); border-bottom:1px solid rgba(200,150,62,0.3); color:#7a5a18; font-size:0.8rem; padding:0.5rem 1rem; text-align:center;">MOCKUP · mass-generated company page · text templated from data · final URL: /equity-research/${esc(slug)}/</div>
${NAV()}

<main class="report-full-page">
  <section class="report-company-header">
    <div class="container">
      <nav aria-label="Breadcrumb" style="font-size:var(--text-xs); color:rgba(255,255,255,0.6); margin-bottom:1rem;"><a href="/" style="color:rgba(255,255,255,0.7);">Home</a> › <a href="/reports.html" style="color:rgba(255,255,255,0.7);">Equity research</a> › ${esc(sn)}</nav>
      <div class="company-header-inner">
        <div class="company-ident">
          <div style="display:flex; align-items:center; gap:1rem; margin-bottom:0.5rem; flex-wrap:wrap;">
            <span class="company-ticker">${esc(c.ticker)}</span>
            <span class="company-status-badge"><span class="company-status-dot"></span>${hasReport ? 'Report available' : 'Coverage'} · Updated ${esc(c.reportDateLabel || c.reportDate || YEAR)}</span>
          </div>
          <h1 class="company-name">${esc(sn)} (${esc(c.ticker)}) Stock Analysis &amp; AI Equity Report</h1>
          <div class="company-meta"><span class="company-meta-chip">${esc(c.exchange)}</span><span class="company-meta-sep"></span><span class="company-meta-chip">${esc(c.country || '')}</span><span class="company-meta-sep"></span><span class="company-meta-chip">${esc(c.sector || '')}</span></div>
          ${callStats}
        </div>
        <div class="company-header-actions">${reportCta}${generateCta}</div>
      </div>
    </div>
  </section>

  <div class="container" style="max-width:920px; padding-top:2.5rem; padding-bottom:3rem;">
    <div class="report-full-content">
${sections.join('\n')}
    </div>
  </div>
</main>

${FOOTER()}
<script src="/js/script.js"></script>
</body>
</html>`;
}

// run
const catalog = loadCatalog();
const entries = catalog.map((cat) => ({ cat, content: loadContent(cat.id) })).filter((e) => !['nuholdings-02062026'].includes(e.cat.id));
fs.mkdirSync(OUT_DIR, { recursive: true });
const idx = [];
for (const e of entries) {
  const slug = slugify(e.cat.companyName || e.cat.name);
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.html`), renderCompany(e.cat, e.content, entries));
  idx.push({ slug, name: shortName(e.cat.companyName || e.cat.name), free: !!e.cat.isFree });
  console.log(`wrote  mockups/${slug}.html  ${e.cat.isFree ? '(free report)' : '(paid)'}`);
}
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Company page mockups</title><link rel="stylesheet" href="/css/style.css"></head><body style="max-width:680px;margin:3rem auto;padding:0 1.5rem;font-family:var(--font);"><h1 style="font-size:var(--text-xl);">Company page mockups</h1><p style="color:var(--gray-steel);">Mass-generated company pages — facts public, analysis gated. Click to view.</p>${idx.map((i) => `<a class="footer-link" style="display:flex;justify-content:space-between;padding:0.85rem 0;border-bottom:1px solid var(--color-border);color:var(--charcoal);text-decoration:none;" href="/mockups/${i.slug}.html"><span>${i.name}</span><span style="color:${i.free ? 'var(--green)' : 'var(--gold)'};font-size:var(--text-xs);">${i.free ? 'FREE REPORT' : 'PAID'} →</span></a>`).join('')}</body></html>`);
console.log(`\n${idx.length} company mockups -> mockups/`);
