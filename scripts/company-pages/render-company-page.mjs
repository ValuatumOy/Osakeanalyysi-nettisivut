const SITE = 'https://www.aiequityreports.com';
const NEW_REPORT_PRICE = 50;
const DISPLAY_NAME_OVERRIDES = new Map([
  ['NDA-FI.HE', 'Nordea'],
  ['METSO.HE', 'Metso'],
  ['INVE-B.ST', 'Investor AB'],
  ['VOLV-B.ST', 'Volvo'],
  ['ERIC-B.ST', 'Ericsson'],
  ['VWS.CO', 'Vestas'],
  ['MAERSK-B.CO', 'Maersk'],
  ['ASML', 'ASML'],
]);

// Valuatum's models don't fit financial companies (banks, insurers, investment/
// holding companies): Wisdom's `ns`/`ebit`/etc. are meaningless or mislabelled for
// them, so we never build pages for them at all (see generate-company-pages.mjs) and
// never link to them from related lists. Auto-detected by industry; the ticker list
// is a safety net for names whose industry string is unclear.
const FINANCIAL_TICKERS = new Set(['NDA-FI.HE', 'SAMPO.HE', 'INVE-B.ST']);
const FINANCIAL_INDUSTRY = /bank|insur|financ|capital market|asset manage|holding|investment/i;

export function isFinancialCompany(company) {
  const ticker = String(company?.ticker || '').trim().toUpperCase();
  if (FINANCIAL_TICKERS.has(ticker)) return true;
  return FINANCIAL_INDUSTRY.test(String(company?.industry || ''));
}

export function pageSlug(company) {
  return `${slugify(companyDisplayName(company))}-equity-report`;
}

export function renderCompanyPage(company, relatedCompanies = [], generatedOn = new Date(), options = {}) {
  const name = companyDisplayName(company);
  const slug = pageSlug(company);
  const url = `${SITE}/reports/${slug}.html`;
  const date = toIsoDate(generatedOn);
  const readyReport = options.readyReport || null;
  const description = `${name} (${company.ticker}) financial overview for ${company.financialYear}: revenue, EBIT, net earnings, book value, year-end share price and market capitalisation.`;
  const metrics = metricDefinitions(company);
  const relatedScore = (item) =>
    (item.industry && item.industry === company.industry ? 8 : 0) +
    (item.currency && item.currency === company.currency ? 3 : 0);
  const related = relatedCompanies
    .filter((item) => item.ticker !== company.ticker && !isFinancialCompany(item))
    .sort((a, b) => relatedScore(b) - relatedScore(a) || String(a.companyName).localeCompare(String(b.companyName)))
    .slice(0, 4);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Reports', item: `${SITE}/reports.html` },
          { '@type': 'ListItem', position: 3, name: `${name} overview`, item: url },
        ],
      },
      {
        '@type': 'WebPage',
        '@id': `${url}#page`,
        name: `${name} (${company.ticker}) Stock Analysis & AI Equity Report`,
        description,
        dateModified: date,
        inLanguage: 'en',
        url,
        mainEntity: {
          '@type': 'Corporation',
          name,
          tickerSymbol: company.ticker,
          identifier: company.companyCode || undefined,
          description: company.profile,
        },
      },
    ],
  };
  const jsonLdText = JSON.stringify(jsonLd, jsonReplacer, 2).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(name)} (${esc(company.ticker)}) Stock Analysis &amp; AI Equity Report &mdash; Price Target &amp; Valuation | Valuatum</title>
  <meta name="description" content="${attr(description)}">
  <link rel="canonical" href="${attr(url)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta property="og:title" content="${attr(`${name} (${company.ticker}) Stock Analysis & AI Equity Report - Price Target & Valuation | Valuatum`)}">
  <meta property="og:description" content="${attr(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${attr(url)}">
  <meta property="og:image" content="${SITE}/images/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${attr(`${name} (${company.ticker}) AI Equity Report`)}">
  <meta name="twitter:description" content="${attr(description)}">
  <meta name="twitter:image" content="${SITE}/images/og-image.png">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-HSRL85C0K5"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-HSRL85C0K5');</script>
  <script type="application/ld+json">
${jsonLdText}
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300;0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <style>
    .cp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:0.6rem;margin-top:0.25rem;}
    .cp-cell{background:#fff;border:1px solid var(--color-border);border-radius:var(--r-md);padding:0.85rem 1rem;display:flex;flex-direction:column;gap:0.2rem;min-width:0;}
    .cp-l{font-size:var(--text-xs);text-transform:uppercase;letter-spacing:0.05em;color:var(--gray-steel);line-height:1.25;}
    .cp-v{font-size:1rem;font-weight:600;color:var(--charcoal);line-height:1.3;overflow-wrap:break-word;}
    .cp-sub{font-size:var(--text-xs);color:var(--gray-steel);font-weight:400;}
    .cp-updated{font-size:var(--text-xs);color:var(--gray-steel);margin:0.85rem 0 0;line-height:1.4;}
    .cp-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
    .cp-scroll table{white-space:nowrap;min-width:100%;}
    @media(max-width:520px){
      .cp-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));}
      .report-full-content{padding:1rem 0;}
      .report-full-section{padding:1.5rem;}
      .company-generate-card{padding:1.25rem!important;}
      .report-full-section .btn-lg{width:100%;max-width:100%;white-space:normal;text-align:center;line-height:1.25;justify-content:center;padding-left:1rem;padding-right:1rem;font-size:var(--text-sm);}
    }
    .report-full-content.coverage-cols{column-count:2;column-gap:2.5rem;}
    .report-full-content.coverage-cols .report-full-section{break-inside:avoid;-webkit-column-break-inside:avoid;margin-bottom:1.5rem;}
    .report-full-content.coverage-cols #ready-report{break-before:column;-webkit-column-break-before:always;}
    .report-full-content.coverage-cols[data-ready-report="false"] #generate{break-before:column;-webkit-column-break-before:always;}
    @media(max-width:960px){.report-full-content.coverage-cols{column-count:1;}}
    @media(max-width:960px){.report-full-content.coverage-cols #ready-report{break-before:auto;-webkit-column-break-before:auto;}}
    @media(max-width:960px){.report-full-content.coverage-cols[data-ready-report="false"] #generate{break-before:auto;-webkit-column-break-before:auto;}}
  </style>
</head>
<body>
${navHtml()}

  <main class="report-full-page">
    <section class="report-company-header">
      <div class="container">
        <nav aria-label="Breadcrumb" style="font-size:var(--text-xs); color:rgba(255,255,255,0.6); margin-bottom:1rem;">
          <a href="/" style="color:rgba(255,255,255,0.7);">Home</a> &rsaquo;
          <a href="/reports.html" style="color:rgba(255,255,255,0.7);">Reports</a> &rsaquo;
          <span>${esc(name)}</span>
        </nav>
        <div class="company-header-inner">
          <div class="company-ident">
            <h1 class="company-name">${esc(name)} (${esc(company.ticker)}) Stock Analysis &amp; AI Equity Report</h1>
            <div class="company-meta">
              ${company.industry ? `<span class="company-meta-chip">${esc(company.industry)}</span><span class="company-meta-sep"></span>` : ''}
              <span class="company-meta-chip">${esc(company.marketCurrency || company.currency)}</span>
              <a class="company-meta-cta" href="/reports.html#free">Explore free reports</a>
            </div>
          </div>
          <div class="company-header-actions">
            ${readyReport ? headerReportCta(readyReport) : ''}
            <a href="#generate" class="btn btn-gold">Generate fresh report &mdash; &euro;${NEW_REPORT_PRICE.toFixed(2)}</a>
          </div>
        </div>
      </div>
    </section>

    <div class="container" style="max-width:1760px; padding-top:2.5rem; padding-bottom:3rem;">
      <div class="report-full-content coverage-cols" data-ready-report="${readyReport ? 'true' : 'false'}">
        <section class="report-full-section" id="overview">
          <h2>${esc(name)} (${esc(company.ticker)}) overview</h2>
          <p>${esc(companyOverview(company, name, readyReport))}</p>
        </section>

        <section class="report-full-section" id="metrics">
          <h2>Key metrics &amp; valuation multiples</h2>
          <div class="cp-grid">${metrics.map(metricCell).join('')}</div>
          ${company.dataUpdated ? `<p class="cp-updated">Figures updated on ${esc(company.dataUpdated)}. Data will be refreshed during report generation.</p>` : ''}
        </section>

        <section class="report-full-section" id="about">
          <h2>About ${esc(name)}</h2>
          <p>${esc(company.profile)}</p>
        </section>

        ${readyReport ? sourcesSection(company) : ''}

        ${readyReportSection(name, readyReport)}

        <section class="report-full-section" id="generate">
          <div class="company-generate-card" style="background:var(--forest); border-radius:var(--r-xl); padding:2rem; color:white;">
            <h2 style="color:white; margin-top:0;">${readyReport ? 'Or generate new' : 'Generate the'} ${esc(name)} report</h2>
            <p style="color:rgba(255,255,255,0.8); font-weight:300;">${readyReport ? `Generate a new ${esc(name)} report with the latest available data for a refreshed company value map, reverse valuation, risk &amp; catalyst analysis, and financial statements and estimates &mdash; plus a downloadable PDF.` : `${esc(name)} is on Valuatum's coverage list, but a full AI equity report hasn't been generated yet. Order one now for the complete company value map, reverse valuation, risk &amp; catalyst analysis, and financial statements and estimates &mdash; plus a downloadable PDF.`}</p>
            <div style="display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-top:1.25rem;">
              <a href="#" class="btn btn-gold btn-lg" data-generate-report data-company="${attr(company.companyName)}" data-ticker="${attr(company.ticker)}">Generate fresh report &mdash; &euro;${NEW_REPORT_PRICE.toFixed(2)}</a>
              <span style="font-size:var(--text-xs); color:rgba(255,255,255,0.6);">Delivered by email, typically within about 30 minutes</span>
            </div>
          </div>
        </section>

        ${readyReport ? '' : sourcesSection(company)}

        ${relatedSection(related)}
      </div>
    </div>
  </main>

${footerHtml()}
  <script src="/js/script.js"></script>
</body>
</html>
`.replace(/[ \t]+$/gm, '');
}

function metricDefinitions(company) {
  const { metrics, currency, financialYear } = company;
  const marketCurrency = company.marketCurrency || currency;
  return [
    { label: 'Book value', value: formatMillions(metrics.bookValue, currency), sub: `FY ${financialYear}` },
    { label: 'Share price', value: formatPrice(metrics.sharePrice, marketCurrency), sub: `FY ${financialYear} year end` },
    { label: 'Revenue', value: formatMillions(metrics.revenue, currency), sub: `FY ${financialYear}` },
    { label: 'Operating profit', value: formatMillions(metrics.ebit, currency), sub: `FY ${financialYear}` },
    { label: 'Net earnings', value: formatMillions(metrics.netEarnings, currency), sub: `FY ${financialYear}` },
    { label: 'Market capitalisation', value: formatMillions(metrics.marketCap, marketCurrency), sub: `FY ${financialYear} year end` },
  ];
}

function companyOverview(company, name, readyReport = null) {
  const revenue = formatMillions(company.metrics.revenue, company.currency);
  const ebit = formatMillions(company.metrics.ebit, company.currency);
  const marketCurrency = company.marketCurrency || company.currency;
  const sharePrice = formatPrice(company.metrics.sharePrice, marketCurrency);
  const marketCap = formatMillions(company.metrics.marketCap, marketCurrency);
  const reportText = readyReport
    ? `A completed ${name} AI equity report is available from ${readyReport.reportDateLabel || formatReportDate(readyReport.reportDate)}; you can ${readyReport.isFree ? 'download the ready PDF for free' : 'buy the ready PDF'} or generate a fresh report with the latest available data.`
    : `${name} is covered by Valuatum but does not yet have a published AI equity report. Generate a fresh report to get ${name}'s valuation, segment value analysis, reverse valuation, financial forecasts, key ratios, risks and catalysts.`;
  return `${name} (${company.ticker}) stock analysis and AI equity research. For the latest completed financial year, ${company.financialYear}, ${name} reported revenue of ${revenue} and operating profit of ${ebit}; the year-end share price was ${sharePrice} and market capitalisation was ${marketCap}. ${reportText}`;
}

function metricCell(metric) {
  return `<div class="cp-cell"><span class="cp-l">${esc(metric.label)}</span><span class="cp-v">${esc(metric.value)}</span><span class="cp-sub">${esc(metric.sub)}</span></div>`;
}

function formatMillions(value, currency) {
  if (!Number.isFinite(value)) return 'N/A';
  return `${currency} ${formatNumber(value, value === 0 || Math.abs(value) >= 100 ? 0 : 1)}m`;
}

function formatPrice(value, currency) {
  if (!Number.isFinite(value)) return 'N/A';
  return `${formatNumber(value, 2)} ${currency}`;
}

function formatNumber(value, fractionDigits) {
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function relatedSection(companies) {
  if (!companies.length) return '';
  const links = companies.map((company) => {
    const name = companyDisplayName(company);
    return `<a style="display:inline-block; text-decoration:none; padding:0.55rem 1rem; border:1px solid var(--color-border); border-radius:var(--r-pill); font-size:var(--text-sm); color:var(--charcoal); background:#fff;" href="/reports/${pageSlug(company)}.html">${esc(name)} (${esc(company.ticker)}) report &rarr;</a>`;
  }).join('');
  return `<section class="report-full-section" id="related"><h2>Related AI equity reports</h2><div style="display:flex; flex-wrap:wrap; gap:0.6rem;">${links}</div></section>`;
}

function sourcesSection(company) {
  const name = companyDisplayName(company);
  return `<section class="report-full-section" id="sources">
          <h2>Sources &amp; methodology</h2>
          <p>Financial figures are sourced from Valuatum's financial model for ${esc(name)} and represent the latest completed financial year (${company.financialYear}). See the <a href="/methodology.html">methodology</a> for the full Valuatum AI equity research framework.</p>
          <div style="background:var(--off-white); border-radius:var(--r-lg); padding:1.25rem 1.5rem; margin-top:1.25rem; border-left:3px solid var(--gray-steel);">
            <p style="font-size:var(--text-sm); color:var(--gray-steel); margin:0;"><strong>Disclaimer:</strong> This is an AI-generated research material for informational purposes only. It is not investment advice or a buy/sell recommendation. Always perform your own analysis. Valuatum Oy, Helsinki, Finland.</p>
          </div>
        </section>`;
}

function readyReportSection(companyName, report) {
  if (!report) return '';
  const isFree = report.isFree === true || Number(report.price || 0) === 0;
  const price = Number(report.price || 0).toFixed(2);
  const reportDate = report.reportDateLabel || formatReportDate(report.reportDate);
  const reportHref = isFree && report.pdfUrl
    ? (/^https?:\/\//.test(String(report.pdfUrl))
        ? String(report.pdfUrl)
        : `/${String(report.pdfUrl).replace(/^\/+/, '')}`)
    : `/reports.html#report-${attr(report.id)}`;
  const ctaText = isFree ? 'Download free report' : `Buy ready report &mdash; &euro;${price}`;
  return `<section class="report-full-section" id="ready-report">
          <div style="background:var(--forest); border-radius:var(--r-xl); padding:2rem; color:white;">
            <h2 style="color:white; margin-top:0;">${isFree ? 'Download the free' : 'Buy the ready'} ${esc(companyName)} report</h2>
            <p style="color:rgba(255,255,255,0.8); font-weight:300;">A completed ${esc(companyName)} AI equity report is available from ${esc(reportDate)}. ${isFree ? 'Download the ready PDF now for free, or generate a new report below if you want a fresh run with the latest available data.' : 'Buy the ready PDF now, or generate a new report below if you want a fresh run with the latest available data.'}</p>
            <div style="display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-top:1.25rem;">
              <a href="${attr(reportHref)}" class="btn btn-primary btn-lg"${isFree ? ' target="_blank" rel="noopener" download' : ''}>${ctaText}</a>
              <span style="font-size:var(--text-xs); color:rgba(255,255,255,0.6);">Report date: ${esc(reportDate)}</span>
            </div>
          </div>
        </section>`;
}

function headerReportCta(report) {
  const isFree = report.isFree === true || Number(report.price || 0) === 0;
  if (isFree && report.pdfUrl) {
    return `<a href="/${attr(String(report.pdfUrl).replace(/^\/+/, ''))}" class="btn btn-primary" target="_blank" rel="noopener" download>Download free report</a>`;
  }
  return `<a href="/reports.html#report-${attr(report.id)}" class="btn btn-primary">Buy ready report &mdash; &euro;${Number(report.price || 0).toFixed(2)}</a>`;
}

function formatReportDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function navHtml() {
  return `  <header class="nav scrolled nav-report" id="nav">
    <div class="nav-inner">
      <a href="/index.html" class="nav-logo">
        <img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum">
        <div class="nav-logo-text"><span class="nav-logo-wordmark">Valuatum</span><span class="nav-logo-sub">AI Equity Reports</span></div>
      </a>
      <nav class="nav-links" aria-label="Main navigation">
        <a href="/index.html" class="nav-link">Home</a><a href="/reports.html" class="nav-link" style="color:var(--green);">Reports</a><a href="/pricing.html" class="nav-link">Pricing</a><a href="/methodology.html" class="nav-link">Methodology</a><a href="/about.html" class="nav-link">About</a><a href="/faq.html" class="nav-link">FAQ</a><a href="/blog.html" class="nav-link">Blog</a>
      </nav>
      <a href="/reports.html" class="nav-cta">Browse reports</a>
    </div>
  </header>`;
}

function footerHtml() {
  return `  <footer class="footer"><div class="container"><div class="footer-grid">
    <div class="footer-brand"><a href="/index.html" class="nav-logo" style="margin-bottom:1rem;display:inline-flex;"><img src="/images/logo.svg" class="nav-logo-img" alt="Valuatum"><div class="nav-logo-text"><span class="nav-logo-wordmark">Valuatum</span><span class="nav-logo-sub">AI Equity Reports</span></div></a><p>Professional AI-generated equity research reports. Browse available reports, open free samples, or generate a fresh report delivered by email.</p></div>
    <div><div class="footer-col-label">Reports</div><div class="footer-links"><a href="/reports.html" class="footer-link">Browse reports</a><a href="/reports.html#order-fresh" class="footer-link">Generate fresh report</a><a href="/pricing.html" class="footer-link">Pricing</a><a href="/methodology.html" class="footer-link">Methodology</a></div></div>
    <div><div class="footer-col-label">Company</div><div class="footer-links"><a href="/about.html" class="footer-link">About Valuatum</a><a href="https://valuatum.com" class="footer-link" target="_blank" rel="noopener">Valuatum.com</a><a href="mailto:contact26@valuatum.com" class="footer-link">Support</a></div></div>
    <div><div class="footer-col-label">Legal</div><div class="footer-links"><a href="/disclaimer.html" class="footer-link">Disclaimer</a><a href="/disclaimer.html#terms" class="footer-link">Terms of use</a><a href="/disclaimer.html#privacy" class="footer-link">Privacy policy</a></div></div>
  </div><div class="footer-bottom"><span class="footer-copyright">&copy; 2026 Valuatum Oy &middot; Helsinki, Finland &middot; Est. 2000</span><span class="footer-disclaimer">Reports are AI-generated research materials for informational purposes only. Not investment advice.</span></div></div></footer>`;
}

export function companyDisplayName(company) {
  const ticker = String(company?.ticker || '').trim().toUpperCase();
  return DISPLAY_NAME_OVERRIDES.get(ticker) || shortName(company?.companyName);
}

function shortName(name) {
  return String(name || '')
    .replace(/\s+\(publ\)$/i, '')
    .replace(/,?\s+(Oyj\s+Abp|Inc\.?|Oyj|Ltd\.?|plc|Corporation|Corp\.?|Abp|AB|ASA|A\/S|AG|N\.V\.|S\.A\.)$/i, '')
    .trim();
}

function slugify(value) {
  return String(value)
    .replace(/[Øø]/g, 'o')
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Ðð]/g, 'd')
    .replace(/[Þþ]/g, 'th')
    .replace(/[Łł]/g, 'l')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const attr = esc;

function toIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function jsonReplacer(_key, value) {
  return value === undefined ? undefined : value;
}
